#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalRole,
  findHouse,
  getActiveAgentDir,
  HOUSE_DIR_NAME,
  isProcessAlive,
  isoNow,
  normalizeCwd,
  processStartTimeSync,
  localStamp,
  sessionStatus,
  readJson,
  resolveHousePath,
  sameRole,
  writeJsonAtomic,
  writeJsonAtomicSync,
  withHouseLock,
} from "./house-lock.mjs";


const HOUSE_TEMPLATE = {
  version: 1,
  roles: [],
  signatures: {},
  participants: [],
  // autoTurnLimit — предел подряд идущих ходов, начатых инъекцией, без слова владельца.
  // После него текст инъекции несёт факт петли (мягкий тормоз: окно всё равно будится,
  // блок не теряется). Считает не частота, а именно длина цепочки: замер 2026-10-08 в
  // живом доме дал 9 блоков за 20 минут — это медленно, патология в незатухании.
  courier: { mode: "notify", cooldownMs: 120_000, retryMs: 30_000, timeoutMs: 300_000, autoTurnLimit: 6 },
  perRole: {},
};


function output(ok, code, message, data = undefined) {
  return { ok, code, message, ...(data === undefined ? {} : { data }) };
}

function cliError(message, code = "HOUSE_ERROR") {
  return output(false, code, message);
}

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args.push(value);
      continue;
    }
    const [key, inlineValue] = value.slice(2).split("=", 2);
    if (inlineValue !== undefined) flags[key] = inlineValue;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) flags[key] = argv[++index];
    else flags[key] = true;
  }
  return { args, flags };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRoles(value) {
  if (value === undefined || value === false) return null;
  const roles = String(value).split(",").map((role) => role.trim()).filter(Boolean);
  return [...new Set(roles)];
}

// Имя сессии для человека: только отображение. В переписке и доставке участвует
// роль, поэтому label не влияет ни на подписи, ни на маршрутизацию.
function normalizeLabel(value) {
  if (value === undefined || value === false) return null;
  const label = String(value).replace(/\s+/g, " ").trim().slice(0, 60);
  return label || null;
}

function signaturesForRoles(roles, existing = {}) {
  const signatures = { ...(existing && typeof existing === "object" ? existing : {}) };
  for (const role of roles) signatures[role] ??= String.raw`\[${escapeRegex(role)}\]`;
  return signatures;
}

// Заголовок сессии живёт в файле отдельными записями (type: "title" и
// "title_change"). Реестр его не видит: имя сессии в sessionManager пусто, пока
// заголовок не задан вручную, а авто-заголовок появляется после первого ответа
// модели, то есть позже последнего события окна. Читаем хвост файла ровно в тот
// момент, когда список нужен человеку: реже, чем тик поллера, и без чтения всего
// JSONL.
const TITLE_TAIL_BYTES = 128 * 1024;
const PREVIEW_HEAD_BYTES = 64 * 1024;

// Заголовка может не быть ещё (модель не успела его сгенерировать), а реестр в этот
// момент хранит описание со старта окна. Тогда показываем первое сообщение человека,
// прочитанное из начала файла: именно по нему он и узнаёт окно.
function sessionPreview(sessionFile) {
  const preview = { title: null, firstUser: null };
  if (!sessionFile || typeof sessionFile !== "string" || !existsSync(sessionFile)) return preview;
  try {
    const size = statSync(sessionFile).size;
    if (!size) return preview;
    const read = (start, length) => {
      const buffer = Buffer.alloc(length);
      const fd = openSync(sessionFile, "r");
      try {
        readSync(fd, buffer, 0, buffer.length, start);
      } finally {
        closeSync(fd);
      }
      return buffer.toString("utf8");
    };
    const headText = read(0, Math.min(size, PREVIEW_HEAD_BYTES));
    for (const line of headText.split("\n")) {
      if (!line.includes('"title"') && !line.includes('"role":"user"')) continue;
      try {
        const entry = JSON.parse(line);
        if ((entry.type === "title" || entry.type === "title_change") && typeof entry.title === "string" && entry.title.trim()) {
          preview.title = entry.title.trim();
        }
        if (preview.firstUser === null && entry.type === "message" && entry.message?.role === "user") {
          const text = entry.message.content?.find?.((part) => part.type === "text")?.text;
          if (typeof text === "string" && text.trim()) preview.firstUser = text.trim().slice(0, 160);
        }
      } catch {}
    }
    // Хвост даёт заголовок новее: файл мог перерасти окно чтения, и title_change
    // остался в начале. Смотрим с конца и берём последний.
    const tailStart = Math.max(0, size - TITLE_TAIL_BYTES);
    const tailLines = read(tailStart, size - tailStart).split("\n");
    for (let index = tailLines.length - 1; index >= 0; index -= 1) {
      const line = tailLines[index];
      // Обрезанная первая строка хвоста не разберётся и будет пропущена.
      if (!line.includes('"title"')) continue;
      try {
        const entry = JSON.parse(line);
        if ((entry.type === "title" || entry.type === "title_change") && typeof entry.title === "string" && entry.title.trim()) {
          preview.title = entry.title.trim();
          break;
        }
      } catch {}
    }
  } catch {}
  return preview;
}

function housePaths(houseDir) {
  return {
    configPath: join(houseDir, "house.json"),
    ownershipPath: join(houseDir, "installed.json"),
    sessionsPath: join(houseDir, "sessions.json"),
    processPath: join(houseDir, "process.json"),
    statePath: join(houseDir, "state.json"),
    conversationPath: join(houseDir, "переписка.md"),
    launcherPath: join(houseDir, "house.mjs"),
  };
}

function projectHouseDir(cwd = process.cwd()) {
  const house = findHouse(cwd);
  return house?.houseDir ?? join(resolve(cwd), HOUSE_DIR_NAME);
}
// В отличие от findHouse этот поиск находит каталог и без house.json: CLI должен
// сказать «дом есть, конфига нет», а не «дома нет». Имя одно, запасного каталога нет.
function locateHouse(cwd = process.cwd()) {
  const found = findHouse(cwd);
  if (found) return found;
  let current = resolve(cwd);
  while (true) {
    const houseDir = join(current, HOUSE_DIR_NAME);
    if (existsSync(houseDir)) return { houseDir, config: null, configPath: join(houseDir, "house.json"), error: null };
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

function effectiveMode(config, role) {
  const mode = config.perRole?.[role]?.mode ?? config.courier?.mode ?? "notify";
  return ["off", "notify", "auto"].includes(mode) ? mode : null;
}

function validateConfig(config) {
  if (!config || typeof config !== "object") return "Конфигурация дома не является объектом";
  if (!Array.isArray(config.roles) || config.roles.some((role) => typeof role !== "string" || !role.trim())) return "В house.json нужен непустой массив roles";
  if (!Array.isArray(config.participants)) return "В house.json нужен массив participants";
  const ids = new Set();
  for (const participant of config.participants) {
    if (!participant || typeof participant !== "object" || !participant.participantId || !participant.role || !participant.profile || !participant.sessionId) return "Каждый participant должен иметь participantId, role, profile и sessionId";
    if (!config.roles.includes(participant.role)) return `Роль участника не объявлена в house.json: ${participant.role}`;
    if (ids.has(participant.participantId)) return `Дублируется participantId: ${participant.participantId}`;
    ids.add(participant.participantId);
  }
  if (!config.courier || !["off", "notify", "auto"].includes(config.courier.mode ?? "notify")) return "Недопустимый courier.mode";
  for (const role of Object.keys(config.perRole ?? {})) {
    if (!config.roles.includes(role) || !["off", "notify", "auto"].includes(config.perRole[role]?.mode ?? "notify")) return `Недопустимый perRole.${role}.mode`;
  }
  if (config.participants.some((participant) => effectiveMode(config, participant.role) === "auto") && !config.courier.profile) return "Для auto-участника нужен courier.profile";
  return null;
}

function expectedHousePaths(houseDir) {
  return Object.values(housePaths(houseDir));
}

function pathKey(path) {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function registeredTargets(cwd, house, ownership) {
  const allowed = new Map(expectedHousePaths(house.houseDir).map((target) => [pathKey(target), target]));
  const seen = new Set();
  return (Array.isArray(ownership?.files) ? ownership.files : []).flatMap((item) => {
    if (!item || typeof item.path !== "string") return [];
    const key = pathKey(resolve(house.houseDir, item.path));
    const target = allowed.get(key);
    if (!target || seen.has(key)) return [];
    seen.add(key);
    return [target];
  });
}

function launcherSource() {
  return `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const candidates = [];
if (process.env.PI_CODING_AGENT_DIR) candidates.push(join(resolve(process.env.PI_CODING_AGENT_DIR), "house", "house.mjs"));
const profileRoot = process.env.OMP_HOUSE_PROFILE_DIR;
if (profileRoot) candidates.push(join(resolve(profileRoot), "house", "house.mjs"));
const source = candidates.find((candidate) => existsSync(candidate));
if (!source) {
  console.error("HOUSE_ERROR: не найден house.mjs активного профиля; задайте PI_CODING_AGENT_DIR");
  process.exit(2);
}
const result = spawnSync(process.execPath, [source, ...args], { stdio: "inherit", cwd: dirname(fileURLToPath(import.meta.url)) });
process.exit(result.status ?? 1);
`;
}

function initializeState(paths) {
  if (!existsSync(paths.statePath)) writeJsonAtomicSync(paths.statePath, { version: 1, updated: isoNow(), lastSentBy: {}, notified: {}, delivered: {}, deliveredBy: {}, autoTurns: {}, open: [] });
  if (!existsSync(paths.sessionsPath)) writeJsonAtomicSync(paths.sessionsPath, { version: 1, sessions: [] });
  if (!existsSync(paths.conversationPath)) writeFileSync(paths.conversationPath, "# House\n\n", "utf8");
}

async function init(scope, cwd, flags = {}) {
  if (scope === "profile") return output(true, "PROFILE_SOURCE", `Profile source directory: ${getActiveAgentDir()}`);
  const houseDir = projectHouseDir(cwd);
  mkdirSync(houseDir, { recursive: true });
  const paths = housePaths(houseDir);
  const requestedRoles = parseRoles(flags.roles);
  if (flags.roles !== undefined && (!requestedRoles || requestedRoles.length === 0)) {
    return cliError("--roles needs at least one role separated by commas", "INVALID_ROLES");
  }
  await withHouseLock(paths.configPath, async () => {
    let config = await readJson(paths.configPath, null);
    if (!config) config = structuredClone(HOUSE_TEMPLATE);
    let configChanged = false;
    if (requestedRoles && (!Array.isArray(config.roles) || config.roles.length === 0)) {
      config.roles = requestedRoles;
      config.signatures = signaturesForRoles(requestedRoles, config.signatures);
      configChanged = true;
    } else if (
      requestedRoles &&
      config.roles.length === requestedRoles.length &&
      requestedRoles.every((role) => config.roles.some((existing) => sameRole(existing, role)))
    ) {
      const signatures = signaturesForRoles(config.roles, config.signatures);
      if (JSON.stringify(signatures) !== JSON.stringify(config.signatures)) {
        config.signatures = signatures;
        configChanged = true;
      }
    }
    if (!existsSync(paths.configPath) || configChanged) await writeJsonAtomic(paths.configPath, config);
    initializeState(paths);
    if (!existsSync(paths.launcherPath)) writeFileSync(paths.launcherPath, launcherSource(), "utf8");
    if (!existsSync(paths.ownershipPath)) {
      await writeJsonAtomic(paths.ownershipPath, {
        version: 1,
        installedBy: "house.mjs",
        scope: "project",
        files: [
          { path: relative(houseDir, paths.configPath), kind: "config" },
          { path: relative(houseDir, paths.launcherPath), kind: "launcher" },
          { path: relative(houseDir, paths.ownershipPath), kind: "ownership" },
        ],
      });
    }
  });
  return output(true, "INITIALIZED", `House initialized: ${houseDir}`, { houseDir, roles: requestedRoles });
}


async function candidates(cwd, asJson = false) {
  const house = findHouse(cwd);
  if (!house || house.error) return cliError("Дом или house.json не найден");
  const paths = housePaths(house.houseDir);
  const registry = await readJson(paths.sessionsPath, { version: 1, sessions: [] });
  const rows = (Array.isArray(registry.sessions) ? registry.sessions : []).map((session) => {
    const preview = sessionPreview(session.sessionFile);
    const title = preview.title ?? session.sessionName ?? null;
    // Описание из реестра может быть заглушкой со старта окна; она хуже, чем
    // первое сообщение человека, прочитанное из файла.
    const registryText = session.candidateDescription && !["описание отсутствует", "no title yet"].includes(session.candidateDescription) ? session.candidateDescription : null;
    return {
      ...session,
      status: sessionStatus(session),
      shortId: String(session.sessionId ?? "").slice(0, 8),
      title,
      // display, это то, что видит человек: заголовок, иначе первое сообщение.
      display: title ?? preview.firstUser ?? registryText ?? "no title yet",
    };
  });
  const data = { config: house.config, profiles: Object.groupBy ? Object.groupBy(rows, (row) => row.profile) : groupByProfile(rows), sessions: rows };
  if (asJson) return output(true, "CANDIDATES", JSON.stringify(data), data);
  return output(true, "CANDIDATES", formatCandidates(data), data);
}

function groupByProfile(rows) {
  return rows.reduce((groups, row) => {
    (groups[row.profile] ??= []).push(row);
    return groups;
  }, {});
}

function formatCandidates(data) {
  if (!data.sessions.length) return "Подтверждённых сессий дома нет.";
  return data.sessions.map((row, index) => `${index + 1}. [${row.status}] ${row.profile || "?"} / ${row.shortId ?? row.sessionId} / ${row.display ?? row.candidateDescription} / ${row.cwd}`).join("\n");
}

async function sendMessage(cwd, flags) {
  const house = findHouse(cwd);
  if (!house || house.error) return cliError("Дом или house.json не найден");
  const roleInput = String(flags.role ?? "").trim();
  const text = String(flags.text ?? "").trim();
  const participantId = flags["participant-id"] ? String(flags["participant-id"]).trim() : "";
  if (!roleInput || !text) return cliError("send требует --role и непустой --text", "INVALID_ARGUMENTS");
  const role = canonicalRole(house.config.roles, roleInput);
  if (!role) return cliError(`Роль не объявлена в house.json: ${roleInput}`, "INVALID_ROLE");
  // Адресат живёт в заголовке блока, а не в state: переписка остаётся единственным
  // источником истины, и доставка пересчитывается из неё при каждом чтении.
  // Пустой список означает прежний broadcast.
  const requestedTargets = flags.to === undefined || flags.to === true
    ? []
    : String(flags.to).split(",").map((value) => value.trim()).filter(Boolean);
  if (flags.to !== undefined && requestedTargets.length === 0) {
    return cliError("send: --to требует хотя бы одну роль-адресата", "INVALID_ARGUMENTS");
  }
  const targets = [];
  for (const target of requestedTargets) {
    const canonical = canonicalRole(house.config.roles, target);
    if (!canonical) return cliError(`Роль-адресат не объявлена в house.json: ${target}`, "INVALID_ROLE");
    if (!targets.includes(canonical)) targets.push(canonical);
  }
  if (targets.includes(role)) return cliError("send: роль-адресат совпадает с автором", "INVALID_ARGUMENTS");
  const paths = housePaths(house.houseDir);
  return withHouseLock(paths.statePath, async () => {
    const config = await readJson(paths.configPath, null);
    const state = await readJson(paths.statePath, null);
    if (!config || !state) return cliError("Не удалось прочитать конфигурацию или состояние дома", "INVALID_CONFIG");
    const participants = (config.participants ?? []).filter((participant) => participant.role === role);
    const participant = participantId
      ? participants.find((item) => item.participantId === participantId)
      : participants.length === 1 ? participants[0] : null;
    if (!participant) {
      const reason = participantId ? `participantId не найден для роли ${role}: ${participantId}` : `для роли ${role} нужно ровно одно выбранное участие`;
      return cliError(reason, "AMBIGUOUS_PARTICIPANT");
    }
    const current = readFileSync(paths.conversationPath, "utf8");
    const timestamp = localStamp();
    const separator = current.length === 0 ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    const header = `## [${timestamp}] [${role}]${targets.length ? ` → ${targets.join(", ")}` : ""}`;
    const block = `${header}\n\n${text}\n`;
    appendFileSync(paths.conversationPath, `${separator}${block}`, "utf8");
    // lastSentBy — «последний раз отправлял», писатель здесь и только он.
    // Читать его как «прочитанное» нельзя: в чужом блоке, пришедшем между
    // чужим сообщением и моим ответом, метка от отправителя съела бы блок.
    state.lastSentBy ??= {};
    state.lastSentBy[participant.participantId] = timestamp;
    state.updated = timestamp;
    await writeJsonAtomic(paths.statePath, state);
    // Норма адресата печатается вместе с подтверждением. Это единственный канал,
    // который автор видит В МОМЕНТ записи блока: агент пишет блоки через CLI, и его
    // stdout возвращается ему как результат инструмента. Признак «нужен ли коллеге
    // этот блок» смысловой — механически его не проверить, поэтому правило живёт
    // текстом там, где автор читает его вовремя, а не только в доке.
    return output(true, "SENT", `Сообщение отправлено от роли ${role}${targets.length ? `, адресаты: ${targets.join(", ")}` : ", блок видят все роли"}. Пиши блок, только если коллеге есть дело; подтверждения, согласия и благодарности не пиши: они разбудят коллегу и вернут тебе ответ.`, { role, participantId: participant.participantId, timestamp, targets, block });
  });
}

// Привязка, чья сессия больше не active, в доме не нужна: курьер честно обходит её
// на каждом тике, метки уходят в никуда, а роли в диалоге двоятся.
//
// Отсутствие записи в реестре — тоже смерть сессии, а не «не знаю»: lease пишется
// хуком на session_start, то есть ДО того, как окно можно привязать (кандидаты в
// setup берутся из того же реестра), и снимается на session_shutdown. Окно, которое
// живёт и привязано, запись обязано иметь и обновляет её на каждом before_agent_start.
// Именно поэтому записи прежней сессии после resume и оставались в доме навсегда.
//
// Исключение — пустой реестр: это не доказательство, а отсутствие данных (файл
// удалён, не записан, сломан). Тогда не вычищаем ничего.
async function pruneDeadParticipants(houseDir, config) {
  const paths = housePaths(houseDir);
  const registry = await readJson(paths.sessionsPath, { version: 1, sessions: [] });
  const sessions = Array.isArray(registry.sessions) ? registry.sessions : [];
  const participants = Array.isArray(config.participants) ? config.participants : [];
  if (!sessions.length) return { kept: participants, pruned: [] };
  const kept = [];
  const pruned = [];
  // Один lease, один ответ: два участника одной сессии не должны разъехаться
  // из-за повторного опроса живости.
  const verdicts = new Map();
  const verdict = (lease) => {
    if (!verdicts.has(lease)) verdicts.set(lease, sessionStatus(lease));
    return verdicts.get(lease);
  };
  for (const participant of participants) {
    // auto-участник окна не имеет по построению: доставку делает headless-агент,
    // которого курьер поднимает сам. Вычищать его по отсутствию живой записи
    // нельзя — это съело бы auto целиком, а он существует ровно для роли без
    // окна. Регресс пойман приёмкой 2026-10-08.
    if (effectiveMode(config, participant.role) === "auto") {
      kept.push(participant);
      continue;
    }
    // Регистр профиля нормализуется: он набирается руками в house.json, и "ALPHA"
    // против "alpha" иначе сочли бы привязку трупом и вычистили живое окно.
    const lease = sessions.find((candidate) => candidate.sessionId === participant.sessionId && String(candidate.profile ?? "").toLowerCase() === String(participant.profile ?? "").toLowerCase());
    if (!lease || verdict(lease) !== "active") pruned.push(participant);
    else kept.push(participant);
  }
  // Имя это отображение, а не привязка: когда мёртвый дубль роли уходит, его
  // ярлык переезжает на живую запись той же роли. Иначе первый же bind любой
  // другой роли стирал имя живого окна.
  for (const dead of pruned) {
    if (!String(dead.label ?? "").trim()) continue;
    const survivor = kept.find(
      (item) => String(item.role).toLowerCase() === String(dead.role).toLowerCase() && !String(item.label ?? "").trim(),
    );
    if (survivor) survivor.label = dead.label;
  }
  return { kept, pruned };
}

// Водяные знаки вычищенных привязок в state.json — тот же класс, что и сами
// привязки: мёртвое живёт не потому, что нужно, а потому что никто не убирает.
// Пока notified и deliveredBy держат метки на окнах, которых нет, любая будущая
// логика, читающая их, увидит доставку в никуда — ровно та ловушка, из-за которой
// мы спорили про метки на трупах.
async function pruneDeadState(houseDir, config) {
  const paths = housePaths(houseDir);
  const registry = await readJson(paths.sessionsPath, { version: 1, sessions: [] });
  const sessions = Array.isArray(registry.sessions) ? registry.sessions : [];
  const participants = Array.isArray(config.participants) ? config.participants : [];
  if (!sessions.length || !participants.length) return [];
  const aliveIds = new Set(participants.map((participant) => participant.participantId ?? participant.role));
  const removed = [];
  await withHouseLock(paths.statePath, async () => {
    const state = await readJson(paths.statePath, null);
    if (!state) return;
    // lastReadBy чистится наравне с остальными и больше не создаётся init. Поле
    // заменено на deliveredBy ещё в 1.1.0, и кода на него не осталось нигде, кроме
    // комментария в house-watch. Мёртвый код и мёртвые данные в одном месте потом
    // не разобрать, поэтому ключи вычищаются вместе с остальными.
    //
    // autoTurns — счётчик ходов, начатых инъекцией (1.2.0). Он привязан к sessionId
    // окна, поэтому мёртвая привязка оставляет в нём тот же мусор, что и в метках:
    // окна нет, а счётчик на нём стоит и ждёт.
    for (const field of ["notified", "delivered", "deliveredBy", "lastSentBy", "lastReadBy", "autoTurns"]) {
      const bucket = state[field];
      if (!bucket || typeof bucket !== "object") continue;
      for (const key of Object.keys(bucket)) {
        // Ключ без привязки, но равный роли, остаётся: роли в state пишутся
        // самостоятельно и переживают смену participantId.
        if (aliveIds.has(key) || (config.roles ?? []).includes(key)) continue;
        delete bucket[key];
        removed.push(`${field}.${key}`);
      }
    }
    if (removed.length) await writeJsonAtomic(paths.statePath, state);
  });
  return removed;
}

const ROLE_MAX_LENGTH = 32;

// Роль участвует в подписи блока `[роль]` и в `/house say <роль>`, поэтому
// пробелы и скобки запрещены: иначе подпись не отличить от текста, а команда
// разберёт аргументы иначе, чем ожидал человек.
function roleNameError(role) {
  if (!role) return "Роль не может быть пустой";
  if (role.length > ROLE_MAX_LENGTH) return `Роль длиннее ${ROLE_MAX_LENGTH} символов`;
  if (/[\s[\]]/.test(role)) return "В роли не должно быть пробелов и квадратных скобок";
  return null;
}

// Явный шаг, а не создание роли внутри bind: опечатка в bind молча завела бы
// мусорную роль. Здесь добавление видно отдельной командой и отдельным ответом.
async function roleAdd(cwd, flags) {
  const house = findHouse(cwd);
  if (!house || house.error) return cliError("Дом или house.json не найден");
  const role = String(flags.role ?? "").trim();
  const nameError = roleNameError(role);
  if (nameError) return cliError(nameError, "INVALID_ROLE");
  const paths = housePaths(house.houseDir);
  return withHouseLock(paths.configPath, async () => {
    const config = await readJson(paths.configPath, null);
    if (!config) return cliError("Не удалось прочитать house.json", "INVALID_CONFIG");
    const lower = role.toLowerCase();
    // Сравнение без регистра: две роли, различающиеся регистром, ломают поиск
    // подписи (там регулярка с флагом i), то есть дают два неразличимых адреса.
    const existing = (config.roles ?? []).find((item) => String(item).toLowerCase() === lower);
    if (existing) return output(true, "ROLE_EXISTS", `Роль уже объявлена: ${existing}`, { role: existing, added: false });
    config.roles = [...(Array.isArray(config.roles) ? config.roles : []), role];
    config.signatures = signaturesForRoles(config.roles, config.signatures);
    const validationError = validateConfig(config);
    if (validationError) return cliError(validationError, "INVALID_CONFIG");
    await writeJsonAtomic(paths.configPath, config);
    return output(true, "ROLE_ADDED", `Роль добавлена: ${role}`, { role, added: true });
  });
}

// Имя это только отображение, поэтому менять его можно отдельно от привязки.
// Роль и sessionId остаются ключом; имя не участвует ни в доставке, ни в подписи.
async function relabel(cwd, flags) {
  const house = findHouse(cwd);
  if (!house || house.error) return cliError("Дом или house.json не найден");
  const roleInput = String(flags.role ?? "").trim();
  if (!roleInput) return cliError("label требует --role", "INVALID_ARGUMENTS");
  if (flags.label === undefined || flags.label === true) return cliError("label требует --label (пустая строка снимает имя: --label=)", "INVALID_ARGUMENTS");
  const label = normalizeLabel(flags.label);
  const sessionId = String(flags["session-id"] ?? "").trim();
  const role = canonicalRole(house.config.roles, roleInput);
  if (!role) return cliError(`Роль не объявлена в house.json: ${roleInput}`, "INVALID_ROLE");
  const paths = housePaths(house.houseDir);
  return withHouseLock(paths.configPath, async () => {
    const config = await readJson(paths.configPath, null);
    if (!config) return cliError("Не удалось прочитать house.json", "INVALID_CONFIG");
    const targets = (config.participants ?? []).filter(
      (participant) => sameRole(participant.role, role) && (!sessionId || participant.sessionId === sessionId),
    );
    if (targets.length === 0) return cliError(`Нет привязки для роли ${role}${sessionId ? ` и сессии ${sessionId}` : ""}`, "NOT_BOUND");
    // Имя одной роли у двух окон неоднозначно: без id непонятно, какому окну.
    if (targets.length > 1) return cliError(`Для роли ${role} несколько привязок, укажи --session-id`, "AMBIGUOUS_PARTICIPANT");
    if (label) targets[0].label = label;
    else delete targets[0].label;
    const validationError = validateConfig(config);
    if (validationError) return cliError(validationError, "INVALID_CONFIG");
    await writeJsonAtomic(paths.configPath, config);
    return output(true, "LABELED", `Имя сессии ${role}: ${label ?? "снято"}`, { participant: targets[0] });
  });
}

async function bind(cwd, flags) {
  const house = findHouse(cwd);
  if (!house || house.error) return cliError("Дом или house.json не найден");
  const roleInput = String(flags.role ?? "").trim();
  const profile = String(flags.profile ?? "").trim();
  const sessionId = String(flags["session-id"] ?? "").trim();
  if (!roleInput || !profile || !sessionId) return cliError("bind требует --role, --profile и --session-id", "INVALID_ARGUMENTS");
  // bind привязывает окно, а не абстрактную сессию: без флага это можно делать
  // только для своего окна. Флаг нужен setup: он привязывает выбранные окна из
  // одного процесса, где PI_SESSION_ID текущего окна отсутствует.
  const allowOther = Boolean(flags["allow-other-session"]);
  const self = String(process.env.PI_SESSION_ID ?? "").trim();
  if (!allowOther) {
    if (!self) return cliError("bind без --allow-other-session требует PI_SESSION_ID текущего окна", "SESSION_MISMATCH");
    if (self !== sessionId) return cliError(`bind без --allow-other-session может привязать только своё окно ${self}, а передана ${sessionId}`, "SESSION_MISMATCH");
  }
  const role = canonicalRole(house.config.roles, roleInput);
  if (!role) return cliError(`Роль не объявлена в house.json: ${roleInput}`, "INVALID_ROLE");
  const participant = {
    participantId: String(flags["participant-id"] ?? role),
    role,
    profile,
    sessionId,
    sessionName: flags["session-name"] ? String(flags["session-name"]) : null,
    // Пустое имя не пишем вовсе: старые house.json остаются без поля.
    ...(normalizeLabel(flags.label) ? { label: normalizeLabel(flags.label) } : {}),
    // cwd самого окна отличается от каталога, из которого вызвана команда: при
    // `setup --all` окно может жить в другом проекте. Пишем его отдельным флагом,
    // чтобы не выдавать каталог команды за каталог сессии.
    cwd: flags["session-cwd"] ? normalizeCwd(String(flags["session-cwd"])) : flags.cwd ? normalizeCwd(flags.cwd) : undefined,
  };
  const paths = housePaths(house.houseDir);
  let pruned = [];
  const result = await withHouseLock(paths.configPath, async () => {
    const config = await readJson(paths.configPath, null);
    if (!config) throw new Error("Не удалось прочитать house.json для bind");
    const registry = await readJson(paths.sessionsPath, { version: 1, sessions: [] });
    const sessions = Array.isArray(registry.sessions) ? registry.sessions : [];
    // Привязывать нечего: prune вычистит её следующим же bind, а до тех пор она
    // засоряет конфиг и роли. Записи в реестре нет — не отказываем: реестр мог не
    // успеть обновиться, и живое окно потеряло бы роль. Роль в auto отказ не
    // касается: у неё окна нет по построению.
    const own = sessions.find((candidate) => candidate.sessionId === sessionId && String(candidate.profile ?? "").toLowerCase() === profile.toLowerCase());
    if (own && effectiveMode(config, role) !== "auto" && sessionStatus(own) !== "active") {
      return cliError(`Сессия ${sessionId} не active (${sessionStatus(own)}), привязка не сохранена`, "SESSION_NOT_ACTIVE");
    }
    const cleanup = await pruneDeadParticipants(house.houseDir, config);
    pruned = cleanup.pruned;
    const participants = cleanup.kept;
    // Роль в доме одна: повторный bind переносит её окно, а не заводит вторую
    // привязку. Живой сбой оставил у роли две записи с разными participantId, и
    // lastSentBy продолжал указывать на старую.
    const sameRole = participants.filter((item) => String(item.role).toLowerCase() === role.toLowerCase());
    const state = (await readJson(paths.statePath, {})) ?? {};
    const lastSentBy = state.lastSentBy && typeof state.lastSentBy === "object" ? state.lastSentBy : {};
    // participantId из lastSentBy это тот, от чьего имени уже писали в переписку:
    // смена id осиротила бы метку, поэтому выживает именно он. Свежая метка
    // важнее старой, поэтому сортировка по времени.
    const stamped = sameRole
      .filter((item) => String(lastSentBy[item.participantId] ?? "").trim())
      .sort((left, right) => String(lastSentBy[right.participantId]).localeCompare(String(lastSentBy[left.participantId])));
    const keep = stamped[0] ?? sameRole.find((item) => item.participantId === participant.participantId) ?? sameRole[0];
    let deduped = 0;
    if (keep) {
      // Имя могло жить на любой из дублирующихся записей: свежая метка указывает
      // на один id, а ярлык остался на другом. Мёртвые дубли сюда уже не попадают:
      // prune перенёс их имена на живые записи до этой точки.
      if (!participant.label) {
        const donor = [keep, ...stamped, ...sameRole].find((item) => String(item?.label ?? "").trim());
        if (donor) participant.label = donor.label;
      }
      participant.participantId = keep.participantId;
      deduped = sameRole.length - 1;
      // Остальные роли на той же сессии сохраняются: фильтр только по роли.
      config.participants = [
        ...participants.filter((item) => String(item.role).toLowerCase() !== role.toLowerCase()),
        participant,
      ];
    } else {
      participants.push(participant);
      config.participants = participants;
    }
    const validationError = validateConfig(config);
    if (validationError) throw new Error(validationError);
    await writeJsonAtomic(paths.configPath, config);
    const dedupeNote = deduped > 0 ? `, убрано дублей роли: ${deduped}` : "";
    return output(true, "BOUND", `Привязка сохранена: ${role} ← ${sessionId}${dedupeNote}${pruned.length ? `, вычищено мёртвых привязок: ${pruned.length}` : ""}`, { participant, pruned: pruned.map((item) => item.participantId), deduped });
  });
  return result;
}


function courierSource(houseDir, config) {
  const configured = config.courier?.source;
  if (configured) return resolveHousePath(houseDir, configured, "courier.mjs");
  const candidates = [];
  if (process.env.PI_CODING_AGENT_DIR) candidates.push(join(resolve(process.env.PI_CODING_AGENT_DIR), "house", "courier.mjs"));
  const activeDir = getActiveAgentDir();
  if (activeDir) candidates.push(join(activeDir, "house", "courier.mjs"));
  candidates.push(join(dirname(fileURLToPath(import.meta.url)), "courier.mjs"));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates.at(-1);
}

async function spawnCourier(houseDir, config) {
  const courier = courierSource(houseDir, config);
  if (!existsSync(courier)) return { error: `Не найден courier.mjs: ${courier}` };
  const token = randomUUID();
  let child;
  try {
    child = spawn(process.execPath, [courier, "--house", houseDir], {
      cwd: houseDir,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, OMP_HOUSE_PROCESS_TOKEN: token, OMP_HOUSE_SESSION_KIND: "headless" },
      windowsHide: true,
    });
  } catch (error) {
    return { error: `Не удалось запустить courier: ${error.message}` };
  }
  if (!child.pid) return { error: "Courier не вернул PID" };
  child.unref();
  let processStartedAt = null;
  for (let attempt = 0; attempt < 10 && !Number.isFinite(processStartedAt); attempt += 1) {
    processStartedAt = processStartTimeSync(child.pid);
    if (!Number.isFinite(processStartedAt)) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return { pid: child.pid, token, startedAt: isoNow(), processStartedAt };
}

function ownsProcess(processInfo) {
  if (!processInfo?.pid || !processInfo?.token || !Number.isFinite(processInfo.processStartedAt)) return false;
  const startedAt = processStartTimeSync(processInfo.pid);
  return Number.isFinite(startedAt) && Math.abs(startedAt - processInfo.processStartedAt) <= 2000;
}
async function start(cwd) {
  const house = findHouse(cwd);
  if (!house || house.error) return cliError("Дом или house.json не найден");
  const paths = housePaths(house.houseDir);
  // Мёртвые привязки вычищаются ДО проверки конфига и спавна: иначе курьер
  // поднимается, честно обходит трупы и метки уходят в никуда, а в конфиге они
  // остаются до следующего bind.
  const cleanup = await withHouseLock(paths.configPath, async () => {
    const config = (await readJson(paths.configPath, null)) ?? house.config;
    const { kept, pruned } = await pruneDeadParticipants(house.houseDir, config);
    if (!pruned.length) return { config, pruned };
    config.participants = kept;
    await writeJsonAtomic(paths.configPath, config);
    return { config, pruned };
  });
  // Водяные знаки вычищенных привязок уходят тем же заходом: пока они лежат в
  // state, любой читающий notified увидит доставку в окно, которого нет.
  const prunedState = await pruneDeadState(house.houseDir, cleanup.config);
  const config = cleanup.config;
  const validationError = validateConfig(config);
  if (validationError) return cliError(validationError, "INVALID_CONFIG");
  if (!(config.participants ?? []).some((participant) => effectiveMode(config, participant.role) !== "off")) {
    return cliError("Нет участников с включённым режимом courier", "NO_ACTIVE_PARTICIPANTS");
  }
  const prunedNote = cleanup.pruned.length ? `, вычищено мёртвых привязок: ${cleanup.pruned.length}` : "";
  const stateNote = prunedState.length ? `, вычищено мёртвых меток: ${prunedState.length}` : "";
  return withHouseLock(paths.processPath, async () => {
    const current = await readJson(paths.processPath, null);
    if (current?.pid && isProcessAlive(current.pid)) {
      if (ownsProcess(current)) return output(true, "ALREADY_RUNNING", `Courier уже работает: PID ${current.pid}${prunedNote}${stateNote}`, { ...current, pruned: cleanup.pruned.map((item) => item.participantId), prunedState });
      return output(false, "FOREIGN_PROCESS", `PID ${current.pid} занят процессом, который нельзя подтвердить как courier`);
    }
    const spawned = await spawnCourier(house.houseDir, config);
    if (spawned.error) return cliError(spawned.error, "SPAWN_FAILED");
    if (!Number.isFinite(spawned.processStartedAt)) {
      try { process.kill(spawned.pid); } catch {}
      return cliError("Не удалось подтвердить время запуска courier", "START_FAILED");
    }
    const processInfo = { version: 1, ...spawned, heartbeatAt: spawned.startedAt, command: "courier" };
    try {
      await writeJsonAtomic(paths.processPath, processInfo);
    } catch (error) {
      try { process.kill(processInfo.pid); } catch {}
      return cliError(`Не удалось записать process.json: ${error.message}`, "START_FAILED");
    }
    return output(true, "STARTED", `Courier запущен: PID ${processInfo.pid}, ${processInfo.startedAt}${prunedNote}${stateNote}`, { ...processInfo, pruned: cleanup.pruned.map((item) => item.participantId), prunedState });
  });
}
async function stop(cwd) {
  const house = findHouse(cwd);
  if (!house || house.error) return cliError("Дом или house.json не найден");
  const paths = housePaths(house.houseDir);
  return withHouseLock(paths.processPath, async () => {
    const processInfo = await readJson(paths.processPath, null);
    if (!processInfo?.pid) return output(true, "STOPPED", "Courier уже остановлен");
    if (!isProcessAlive(processInfo.pid)) {
      await writeJsonAtomic(paths.processPath, { ...processInfo, status: "stale", stoppedAt: isoNow() });
      return output(true, "STOPPED", "Courier уже не работает");
    }
    if (!ownsProcess(processInfo)) return output(false, "FOREIGN_PROCESS", `PID ${processInfo.pid} не подтверждён как courier; процесс не тронут`);
    try {
      process.kill(processInfo.pid);
    } catch (error) {
      return cliError(`Не удалось остановить courier: ${error.message}`, "STOP_FAILED");
    }
    await writeJsonAtomic(paths.processPath, { ...processInfo, status: "stopped", stoppedAt: isoNow() });
    return output(true, "STOPPED", `Courier остановлен: PID ${processInfo.pid}`);
  });
}

async function status(cwd, asJson = false) {
  const house = findHouse(cwd);
  if (!house) return cliError("Дом не найден");
  if (house.error) return cliError("house.json не разбирается", "INVALID_CONFIG");
  const paths = housePaths(house.houseDir);
  const processInfo = await readJson(paths.processPath, null);
  const sessions = await readJson(paths.sessionsPath, { version: 1, sessions: [] });
  const bindings = Array.isArray(house.config.participants) ? house.config.participants : [];
  const bindingRows = bindings.map((binding) => {
    const lease = sessions.sessions?.find((candidate) => candidate.sessionId === binding.sessionId && candidate.profile === binding.profile);
    return { ...binding, status: lease ? sessionStatus(lease) : "unconfirmed" };
  });
  const running = Boolean(processInfo?.pid && isProcessAlive(processInfo.pid) && ownsProcess(processInfo));
  const data = {
    houseDir: house.houseDir,
    config: house.config,
    bindings: bindingRows,
    courier: { ...(processInfo ?? { status: "stopped" }), running },
  };
  const message = formatStatus(data);
  return output(true, "STATUS", asJson ? JSON.stringify(data) : message, data);
}

function formatStatus(data) {
  const courier = data.courier;
  const lines = [`Дом: ${data.houseDir}`, `Переговорщик: ${courier.running ? `работает (PID ${courier.pid})` : "остановлен"}`];
  if (courier.startedAt) lines.push(`Запущен: ${courier.startedAt}`);
  if (courier.heartbeatAt) lines.push(`Heartbeat: ${courier.heartbeatAt}`);
  if (!data.bindings.length) lines.push("Участники: не настроены");
  else {
    lines.push("Участники:");
    for (const binding of data.bindings) {
      // Имя это только метка для человека; роль и короткий id остаются рядом,
      // потому что по ним ищут окно и адресуют сообщения.
      const name = binding.label ? `${binding.role} (${binding.label})` : binding.role;
      lines.push(`- ${name}: ${binding.profile}/${String(binding.sessionId ?? "").slice(0, 8)} [${binding.status}]`);
    }
  }
  return lines.join("\n");
}

async function uninstall(cwd) {
  const house = findHouse(cwd);
  if (!house || house.error) return cliError("Дом или house.json не найден");
  const paths = housePaths(house.houseDir);
  const stopped = await stop(cwd);
  if (!stopped.ok) return stopped;
  const ownership = await readJson(paths.ownershipPath, { files: [] });
  const allowedKinds = new Set(["config", "launcher", "ownership"]);
  const registered = new Set(registeredTargets(cwd, house, ownership));
  for (const item of Array.isArray(ownership.files) ? ownership.files : []) {
    if (!allowedKinds.has(item?.kind)) continue;
    const target = resolve(house.houseDir, item.path);
    if (registered.has(target) && existsSync(target)) rmSync(target, { force: true });
  }
  return output(true, "UNINSTALLED", "Дом снят; данные переписки и state сохранены");
}

async function purge(cwd, yes) {
  if (!yes) return cliError("Purge требует явного --yes", "CONFIRMATION_REQUIRED");
  const house = findHouse(cwd);
  if (!house || house.error) return cliError("Дом или house.json не найден");
  const stopped = await stop(cwd);
  if (!stopped.ok) return stopped;
  const paths = housePaths(house.houseDir);
  const ownership = await readJson(paths.ownershipPath, { files: [] });
  const targets = new Set([
    ...registeredTargets(cwd, house, ownership),
    paths.configPath,
    paths.ownershipPath,
    paths.launcherPath,
    paths.sessionsPath,
    paths.processPath,
    paths.statePath,
    paths.conversationPath,
  ]);
  for (const target of targets) if (existsSync(target)) rmSync(target, { force: true });
  for (const name of ["logs", "quarantine"]) rmSync(join(house.houseDir, name), { recursive: true, force: true });
  return output(true, "PURGED", "Зарегистрированные данные дома удалены");
}

// Сверка источника и профиля одной командой. Правило «md5 проверяется последним
// действием» держилось на том, что человек не забудет, и мы дважды на этом стояли:
// ответ уходил с «стоит в профиле» раньше установки, а потом между сверкой и
// чужим замером проходила правка источника. Команда с кодом возврата делает это
// проверяемым инструментом, а не дисциплиной.
async function verifyProfile(asJson = false) {
  const profileAgent = getActiveAgentDir();
  if (!profileAgent) return cliError("Не удалось определить каталог агента профиля", "NO_AGENT_DIR");
  const manifestPath = join(profileAgent, "house-install.json");
  const manifest = await readJson(manifestPath, null);
  if (!manifest) return cliError(`Нет манифеста установки: ${manifestPath}`, "NO_MANIFEST");
  const sourceRoot = manifest.sourceRoot ?? null;
  const hashOf = (path) => (existsSync(path) ? createHash("md5").update(readFileSync(path)).digest("hex") : null);
  const rows = [];
  for (const entry of manifest.files ?? []) {
    const installed = hashOf(join(profileAgent, entry.file));
    // Путь в src берётся из манифеста, а не угадывается: отображение dest→src живёт
    // в установщике, и дублировать его здесь значило бы со временем разъехаться.
    const source = sourceRoot && entry.src ? hashOf(join(sourceRoot, "src", entry.src)) : null;
    rows.push({
      file: entry.file,
      installed,
      manifest: entry.md5,
      source,
      ok: installed === entry.md5 && (source === null || source === installed),
    });
  }
  const failed = rows.filter((row) => !row.ok);
  const data = { profileAgent, sourceRoot, version: manifest.version, rows };
  const lines = [
    `Профиль: ${profileAgent}`,
    `Источник: ${sourceRoot ?? "не указан в манифесте — поставьте заново, сверка неполная"}`,
    `Версия: ${manifest.version ?? "?"}`,
  ];
  for (const row of rows) {
    lines.push(
      row.ok
        ? `OK   ${row.file}  ${row.installed?.slice(0, 8)}`
        : `DIFF ${row.file}  профиль=${row.installed?.slice(0, 8) ?? "нет"} манифест=${row.manifest?.slice(0, 8) ?? "нет"} источник=${row.source?.slice(0, 8) ?? "нет"}`,
    );
  }
  lines.push(failed.length ? `Расхождений: ${failed.length} из ${rows.length}` : `Совпало: ${rows.length} из ${rows.length}`);
  return output(!failed.length, failed.length ? "MISMATCH" : "VERIFIED", lines.join("\n"), data);
}


async function run(argv) {
  const { args, flags } = parseArgs(argv);
  const command = args[0] ?? "status";
  const cwd = flags.cwd ? resolve(String(flags.cwd)) : process.cwd();
  if (command === "init") return init(String(flags.scope ?? "project"), cwd, flags);
  if (command === "candidates") return candidates(cwd, Boolean(flags.json));
  if (command === "send") return sendMessage(cwd, flags);
  if (command === "role-add") return roleAdd(cwd, flags);
  if (command === "label") return relabel(cwd, flags);
  if (command === "bind") return bind(cwd, flags);
  if (command === "start") return start(cwd);
  if (command === "stop") return stop(cwd);
  if (command === "verify") return verifyProfile(Boolean(flags.json));
  if (command === "status") return status(cwd, Boolean(flags.json));
  if (command === "uninstall") return uninstall(cwd);
  if (command === "purge") return purge(cwd, Boolean(flags.yes));
  return cliError(`Неизвестная команда house: ${command}`, "INVALID_COMMAND");
}

export { formatStatus, run };

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)))) {
  const result = await run(process.argv.slice(2));
  const wantsJson = result.code === "STATUS" && process.argv.includes("--json");
  if (wantsJson && result.data) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
  else {
    const stream = result.ok ? process.stdout : process.stderr;
    stream.write(`${result.message}\n`);
    if (result.code === "STATUS" && result.data) stream.write(`${JSON.stringify(result.data, null, 2)}\n`);
  }
  process.exitCode = result.ok ? 0 : 2;
}
