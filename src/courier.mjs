#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, watch, mkdirSync, appendFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blockTargets, isoNow, localStamp, maxStamp, parseStamp, readJson, roleSignatureRegex, sameRole, sessionStatus, writeJsonAtomic, withHouseLock } from "./house-lock.mjs";

const POLL_MS = 4_000;
const DEFAULT_COOLDOWN_MS = 120_000;
const DEFAULT_RETRY_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const HARD_LIMIT_MS = 360_000;
const activeParticipants = new Set();
const lastAttemptByParticipant = new Map();
const lastOutcomeByParticipant = new Map();
let activeTick;
const COURIER_SIGNATURE = /\[курьер\s*\(авто\)\]/i;

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    if (argv[index + 1] && !argv[index + 1].startsWith("--")) flags[key] = argv[++index];
    else flags[key] = true;
  }
  return flags;
}

function log(houseDir, message) {
  const path = join(houseDir, "logs", "courier.log");
  mkdirSync(join(houseDir, "logs"), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function readConversation(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
const MUTABLE_HOUSE_FILES = new Set(["house.json", "state.json", "sessions.json", "process.json", "переписка.md"]);

export function quarantineCopy(houseDir, name, content) {
  const directory = join(houseDir, "quarantine");
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 10);
  const target = join(directory, `${stamp}-${suffix}-${basename(name)}`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content);
  try {
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return target;
}

function houseInventory(houseDir) {
  const files = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ["logs", "quarantine", "locks"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      const relativePath = relative(houseDir, path).replace(/\\/g, "/");
      if (!entry.isFile() || MUTABLE_HOUSE_FILES.has(relativePath)) continue;
      const content = readFileSync(path);
      files.set(relativePath, { path, content, hash: createHash("sha256").update(content).digest("hex") });
    }
  };
  visit(houseDir);
  return files;
}

function quarantineInventoryChanges(houseDir, before, after, allowed = new Set()) {
  const names = new Set([...before.keys(), ...after.keys()]);
  const changes = [];
  for (const name of names) {
    if (allowed.has(name)) continue;
    const oldFile = before.get(name);
    const newFile = after.get(name);
    if (oldFile?.hash === newFile?.hash) continue;
    const content = newFile?.content ?? oldFile?.content;
    const quarantine = quarantineCopy(houseDir, name, content);
    const change = { path: name, before: oldFile?.hash ?? null, after: newFile?.hash ?? null, quarantine: relative(houseDir, quarantine) };
    changes.push(change);
    log(houseDir, `quarantine ${JSON.stringify(change)}`);
  }
  return changes;
}

function quarantineCourierBlock(houseDir, text, expectedHeading) {
  const block = blocks(text).find((candidate) => candidate.header === expectedHeading && isCourierBlock(candidate));
  if (!block) return null;
  return quarantineCopy(houseDir, "courier-block.md", block.raw);
}

function blockStamp(header) {
  const match = header.match(/^(?:##\s+)?\[([^\]]+)\]/);
  return match ? match[1] : null;
}

function blocks(text) {
  return text.split(/^##\s+\[/m).slice(1).map((raw) => {
    const value = `## [${raw}`;
    const header = value.split("\n", 1)[0] ?? "";
    return { raw: value, header, stamp: blockStamp(header), stampMs: parseStamp(blockStamp(header)) };
  }).filter((block) => block.stampMs !== null);
}

function isCourierBlock(block) {
  return /ОТ\s+КУРЬЕРА/i.test(block.header) || COURIER_SIGNATURE.test(block.raw);
}

export function latestIncoming(text, participant, config, state) {
  const ownRole = participant.role;
  const counterpartRoles = (config.roles ?? []).filter((role) => !sameRole(role, ownRole));
  const signatures = counterpartRoles.map((role) => ({ role, regex: roleSignatureRegex(config, role) }));
  // Водяной знак курьера = «что уже доставлено в окно участника»: delivered пишет
  // сам курьер в auto, deliveredBy — расширение в notify. lastSentBy сюда не входит:
  // это метка отправителя, и она съела бы чужой блок, пришедший между чужим
  // сообщением и моим собственным ответом.
  const handled = maxStamp(
    state.delivered?.[participant.participantId],
    state.delivered?.[participant.role],
    state.deliveredBy?.[participant.participantId],
    state.deliveredBy?.[participant.role],
  );
  let latest = null;
  for (const block of blocks(text)) {
    if (isCourierBlock(block) || handled !== null && block.stampMs <= handled) continue;
    // Подпись роли ищем ТОЛЬКО в заголовке блока. По block.raw блок выдавал себя за
    // чужую роль, если в тексте встречалась подпись: живой пример — отчёт с
    // `notified[architect]=02:59:20` внутри тела пришёл мне же как сообщение от architect.
    const source = signatures.find((entry) => entry.regex.test(block.header));
    if (!source) continue;
    // Адресный блок доставляется только перечисленным ролям. Пустой список это
    // broadcast, то есть прежние блоки читаются без изменений.
    const targets = blockTargets(block.header);
    if (targets.length && !targets.some((target) => sameRole(target, ownRole))) continue;
    if (!latest || block.stampMs > latest.stampMs) latest = { ...block, sourceRole: source.role };
  }
  return latest;
}

function modeFor(config, role) {
  const mode = config.perRole?.[role]?.mode ?? config.courier?.mode ?? "notify";
  return ["off", "notify", "auto"].includes(mode) ? mode : "notify";
}

function statePath(houseDir, config) {
  return join(houseDir, config.stateFile ?? "state.json");
}

function conversationPath(houseDir, config) {
  return join(houseDir, config.logFile ?? "переписка.md");
}

async function updateHeartbeat(houseDir, processPath, token) {
  await withHouseLock(processPath, async () => {
    const info = await readJson(processPath, null);
    if (!info || info.token !== token) return;
    await writeJsonAtomic(processPath, { ...info, heartbeatAt: isoNow() });
  });
}

async function markState(houseDir, config, mutate) {
  const path = statePath(houseDir, config);
  await withHouseLock(path, async () => {
    const state = await readJson(path, { version: 1, lastSentBy: {}, notified: {}, delivered: {}, deliveredBy: {}, open: [] });
    mutate(state);
    state.updated = isoNow();
    await writeJsonAtomic(path, state);
  });
}


function promptFor(houseDir, conversation, participant, incoming, stamp) {
  return [
    "You are a file courier. Do not answer the technical content.",
    `Read ${conversation} and append exactly one delivery block at its end.`,
    `The recipient role is ${participant.role}; the incoming block was written by ${incoming.sourceRole}.`,
    `The appended block MUST start with this exact first line: ## [${stamp}] ОТ КУРЬЕРА → ${participant.role}`,
    "Do not change existing text, state, code, or files outside the house directory.",
    `House directory: ${houseDir}`,
    "Then a line with status `доставлено` and a final line with signature `[курьер (авто)]`.",
    "After the append, answer only DONE and exit.",
  ].join("\n");
}

function spawnAuto(houseDir, config, participant, incoming, stamp) {
  const profile = config.courier?.profile;
  if (!profile) return Promise.resolve({ ok: false, error: "Для auto не задан courier.profile" });
  const command = process.env.OMP_BIN || "omp";
  const args = ["--profile", profile, "--tools", "read,write", "--approval-mode", "write", "-p", promptFor(houseDir, conversationPath(houseDir, config), participant, incoming, stamp)];
  return new Promise((resolvePromise) => {
    let settled = false;
    let timeout;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(result);
    };
    const child = spawn(command, args, {
      cwd: houseDir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: { ...process.env, OMP_HOUSE_SESSION_KIND: "headless", OMP_HOUSE_PROMPT_MARKER: "house courier" },
    });
    // Слушатель error вешается ДО проверки pid: при несуществующем бинаре spawn
    // возвращает child без pid и выстреливает 'error' в следующем тике. Раньше мы
    // выходили по !child.pid раньше, и событие оставалось без слушателя — процесс
    // падал с Unhandled 'error' event вместо строки в логе.
    const stderr = [];
    child.on("error", (error) => finish({ ok: false, error: error.message, stderr: stderr.join("") }));
    if (!child.pid) {
      finish({ ok: false, error: `Не удалось запустить ${command}: ни одного процесса` });
      return;
    }
    const started = Date.now();
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: "auto courier timeout", stderr: stderr.join("") });
    }, Math.min(Number(config.courier?.timeoutMs) || DEFAULT_TIMEOUT_MS, HARD_LIMIT_MS));
    child.on("exit", (code) => finish({ ok: code === 0, code, elapsedMs: Date.now() - started, stderr: stderr.join("") }));
  });
}

// Участник без записи active в реестре сессий — труп. Раньше курьер честно обходил
// всех, кто есть в house.json, и метки уходили в мёртвые окна: в бой не уходит
// ничего, а лог создаёт видимость работы. Реестр сессий — источник живости, и
// агентский слой (`startsWith` по lastSeenAt) здесь не нужен: у нас есть pid.
async function liveParticipantIds(houseDir, config) {
  const registry = await readJson(join(houseDir, "sessions.json"), { version: 1, sessions: [] });
  const sessions = Array.isArray(registry.sessions) ? registry.sessions : [];
  const live = new Set();
  for (const session of sessions) {
    if (sessionStatus(session) === "active") live.add(livenessKey(session));
  }
  return live;
}

// Ключ живости. Профиль приходит из house.json, куда его пишут руками, поэтому
// регистр нормализуется: "ALPHA" против "alpha" иначе дали бы session-not-active
// и молчаливое отсутствие доставки.
function livenessKey(participant) {
  return `${String(participant.profile ?? "").toLowerCase()}:${String(participant.sessionId ?? "").toLowerCase()}`;
}

export async function processParticipant(houseDir, config, participant, text, state, live, spawn = spawnAuto) {

  const mode = modeFor(config, participant.role);
  if (mode === "off") return { ok: true, skipped: true };
  // Гейт живости стоит ТОЛЬКО на notify. В auto доставку делает не окно, а
  // headless-агент, которого курьер сам поднимает, — и auto существует ровно для
  // роли, у которой окна нет. Гейт перед развилкой съедал auto целиком: у
  // закрытого окна он давал skipped и headless не поднимался никогда. Регресс
  // найден приёмкой 2026-10-08, до него auto в smoke не встречался ни разу.
  const isLive = live.has(livenessKey(participant));
  const incoming = latestIncoming(text, participant, config, state);
  if (!incoming) return { ok: true, skipped: true };
  const id = participant.participantId;
  if (mode === "notify") {
    if (!isLive) return { ok: true, skipped: true, reason: "session-not-active" };
    const alreadyNotified = maxStamp(state.notified?.[id]);
    if (alreadyNotified !== null && incoming.stampMs <= alreadyNotified) return { ok: true, skipped: true };
    await markState(houseDir, config, (next) => {
      next.notified ??= {};
      next.notified[id] = incoming.stamp;
    });
    return { ok: true, mode, participantId: id, stamp: incoming.stamp };
  }
  if (activeParticipants.has(id)) return { ok: true, skipped: true, reason: "in-flight" };
  const lastAttempt = lastAttemptByParticipant.get(id) ?? 0;
  const cooldownMs = Number(config.courier?.cooldownMs) || DEFAULT_COOLDOWN_MS;
  const retryMs = Number(config.courier?.retryMs) || DEFAULT_RETRY_MS;
  // Пауза зависит от исхода последней попытки, а не от исторического факта
  // доставки: delivered после первого успеха остаётся навсегда и растягивал
  // retryMs до cooldownMs. Нет исхода, значит попытки ещё не было: retryMs.
  const lastOutcome = lastOutcomeByParticipant.get(id);
  if (Date.now() - lastAttempt < (lastOutcome === "ok" ? cooldownMs : retryMs)) return { ok: true, skipped: true, reason: "cooldown" };
  activeParticipants.add(id);
  lastAttemptByParticipant.set(id, Date.now());
  let outcome = "failed";
  try {
    const stamp = localStamp();
    const conversation = conversationPath(houseDir, config);
    const original = readConversation(conversation);
    if (original === null) return { ok: false, error: `Нет файла переписки: ${conversation}` };
    const before = houseInventory(houseDir);
    const result = await spawn(houseDir, config, participant, incoming, stamp);
    const changedText = readConversation(conversation);
    const expectedHeading = `## [${stamp}] ОТ КУРЬЕРА → ${participant.role}`;
    const suffix = changedText?.startsWith(original) ? changedText.slice(original.length) : "";
    const appended = suffix.includes(expectedHeading) && suffix.includes("[курьер (авто)]");
    const quarantinedBlock = !appended && changedText !== null && changedText !== original
      ? quarantineCourierBlock(houseDir, changedText, expectedHeading)
      : null;
    const after = houseInventory(houseDir);
    const violations = quarantineInventoryChanges(houseDir, before, after);
    if (violations.length) return { ok: false, error: "Изменён файл дома вне разрешённого набора", violations, quarantinedBlock };
    if (!result.ok) return { ...result, participantId: id, mode };
    if (!appended) return { ok: false, error: "auto courier не добавил новый подтверждённый блок", quarantinedBlock, ...result };
    await markState(houseDir, config, (next) => {
      next.delivered ??= {};
      next.delivered[id] = incoming.stamp;
    });
    outcome = "ok";
    return { ok: true, mode, participantId: id, stamp: incoming.stamp };
  } catch (error) {
    outcome = "failed";
    return { ok: false, error: error.message, participantId: id, mode };
  } finally {
    // Исход ставится на всех путях попытки: ok только на успешном возврате,
    // failed на catch и на каждом неуспешном return внутри try.
    lastOutcomeByParticipant.set(id, outcome);
    activeParticipants.delete(id);
  }
}

async function serializedTick(houseDir, config, processPath, token) {
  if (activeTick) return activeTick;
  activeTick = tick(houseDir, config, processPath, token).finally(() => {
    activeTick = undefined;
  });
  return activeTick;
}

async function tick(houseDir, config, processPath, token) {
  const conversation = conversationPath(houseDir, config);
  const text = readConversation(conversation);
  if (text === null) throw new Error(`Нет файла переписки: ${conversation}`);
  const state = await readJson(statePath(houseDir, config), { version: 1, lastSentBy: {}, notified: {}, delivered: {}, deliveredBy: {}, open: [] });
  const live = await liveParticipantIds(houseDir, config);
  const results = [];
  for (const participant of config.participants ?? []) {
    results.push(await processParticipant(houseDir, config, participant, text, state, live));
    await updateHeartbeat(houseDir, processPath, token);
  }
  return results;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const houseDir = resolve(String(flags.house ?? ""));
  const configPath = join(houseDir, "house.json");
  const config = await readJson(configPath, null);
  if (!config) throw new Error(`Нет или неразбираем house.json: ${configPath}`);
  const processPath = join(houseDir, "process.json");
  const token = process.env.OMP_HOUSE_PROCESS_TOKEN;
  const once = Boolean(flags.once);
  const runTick = async () => {
    // Конфиг перечитывается в каждом тике. Привязки оформляются и меняются после
    // старта курьера, а снимок на весь процесс уводил уведомления в мёртвые
    // сессии и молча помечал живые как skipped. Файл маленький, цена копеечная.
    const tickConfig = (await readJson(configPath, null)) ?? config;
    const results = await serializedTick(houseDir, tickConfig, processPath, token);
    log(houseDir, `tick ${JSON.stringify(results)}`);
  };
  // Размер снимаем ДО первого тика: иначе запись, попавшая в окно между чтением
  // переписки и statSync, уже учтена в снимке и молча теряется до следующей правки.
  const conversation = conversationPath(houseDir, config);
  let lastSize = existsSync(conversation) ? statSync(conversation).size : -1;
  await runTick();
  if (once) return;
  // lastSize двигает и watch, и интервал. Иначе на одну запись срабатывают оба
  // триггера, serializedTick отдаёт им один и тот же промис, и в лог падают две
  // идентичные строки в миллисекунду друг от друга — весь лог истории такой.
  // Работа при этом не дублируется, но лог перестаёт быть счётчиком тиков, а
  // приёмка строится на файлах. Слушатель watch остаётся: скорость реакции не
  // теряется, двигается только счётчик.
  try {
    watch(conversation, () => {
      try {
        lastSize = statSync(conversation).size;
      } catch {}
      runTick().catch((error) => log(houseDir, `error ${error.message}`));
    });
  } catch (error) {
    log(houseDir, `watch unavailable ${error.message}`);
  }
  setInterval(() => {
    try {
      const size = statSync(conversation).size;
      if (size !== lastSize) {
        lastSize = size;
        runTick().catch((error) => log(houseDir, `error ${error.message}`));
      }
    } catch {}
  }, Number(config.courier?.pollMs) || POLL_MS);
}

// Запуск только при прямом вызове: пробе нужно импортировать latestIncoming, и
// импорт не должен поднимать живой курьер. house.mjs делает это так же.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const houseDir = process.argv.includes("--house") ? resolve(process.argv[process.argv.indexOf("--house") + 1]) : process.cwd();
    log(houseDir, `fatal ${error.message}`);
    process.exitCode = 2;
  }
}
