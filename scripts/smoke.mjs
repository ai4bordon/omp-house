import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { HOUSE_DIR_NAME, processStartTimeSync, resolveProcessStartedAt } from "../src/house-lock.mjs";
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "house-smoke-"));
const home = join(root, "home");
const project = join(root, "project");
const profileAgent = join(home, ".omp", "profiles", "profile-a", "agent");
const env = { ...process.env, USERPROFILE: home, HOME: home, PI_CODING_AGENT_DIR: profileAgent };
const houseDir = join(project, HOUSE_DIR_NAME);
let courierPid;

function command(file, args, cwd = project) {
  return execFileSync(process.execPath, [file, ...args], { cwd, env, encoding: "utf8" });
}

function house(...args) {
  // Смоук играет роли нескольких окон из одного процесса: PI_SESSION_ID этой
  // сессии не равен синтетическим id ниже, поэтому привязка чужих окон явная.
  const allowOther = args[0] === "bind" ? ["--allow-other-session"] : [];
  return command(join(profileAgent, "house", "house.mjs"), [...args, ...allowOther, "--cwd", project]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForQuiet(sessionId, timeoutMs = 2500) {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  return !JSON.parse(readFileSync(join(houseDir, "state.json"), "utf8")).notified?.[sessionId];
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function tickLineCount(dir) {
  return readFileSync(join(dir, "logs", "courier.log"), "utf8").split("\n").filter((line) => line.includes(" tick ")).length;
}
function readSessions() {
  return JSON.parse(readFileSync(join(houseDir, "sessions.json"), "utf8")).sessions;
}

function writeSessions(sessions) {
  writeFileSync(join(houseDir, "sessions.json"), JSON.stringify({ version: 1, sessions }, null, 2) + "\n", "utf8");
}

// bind сохраняет participantId роли из lastSentBy, поэтому метки курьера ищутся
// по нему, а не по id сессии: после повторной привязки они расходятся.
function bindingFor(sessionId) {
  return JSON.parse(readFileSync(join(houseDir, "house.json"), "utf8")).participants.find((item) => item.sessionId === sessionId);
}

// Живая lease: pid текущего процесса и его реальное время старта. Именно такой
// вид имеет запись, которую пишет хук реестра внутри живого окна.
function liveLease(sessionId, profile = "profile-a") {
  return {
    profile,
    sessionId,
    sessionName: null,
    cwd: project,
    pid: process.pid,
    processStartedAt: processStartTimeSync(process.pid),
    startedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    candidateDescription: "живая сессия",
    kind: "interactive",
    status: "active",
  };
}

function deadLease(sessionId, profile = "profile-a") {
  return {
    ...liveLease(sessionId, profile),
    pid: 999999,
    processStartedAt: null,
    candidateDescription: "мёртвая сессия",
    status: "stale",
  };
}


try {
  for (const directory of [join(profileAgent, "hooks", "pre"), join(profileAgent, "extensions"), project]) {
    mkdirSync(directory, { recursive: true });
  }

  command(join(repoRoot, "install.mjs"), ["--profile", "profile-a"]);
  const manifest = JSON.parse(readFileSync(join(profileAgent, "house-install.json"), "utf8"));
  assert(manifest.profile === "profile-a" && manifest.files.length === 6, "profile install manifest is incomplete");
  for (const file of [
    "house/house.mjs",
    "house/courier.mjs",
    "house/house-lock.mjs",
    "extensions/house.ts",
    "hooks/pre/house-watch.ts",
    "hooks/pre/house-session-registry.ts",
  ]) assert(existsSync(join(profileAgent, file)), `missing installed House file: ${file}`);

  // processStartedAt в lease не должен быть null: null превращает живую сессию в
  // unconfirmed, а setup берёт только active — окно становится непригодным к
  // привязке. Замер на живом процессе: uptime-оценка попадает в допуск 2000 мс,
  // который использует sessionStatus.
  const ownStart = resolveProcessStartedAt(process.pid);
  assert(Number.isFinite(ownStart), "resolveProcessStartedAt returned null for the current live process");
  const polledStart = processStartTimeSync(process.pid);
  if (Number.isFinite(polledStart)) {
    assert(Math.abs(ownStart - polledStart) <= 2000, `uptime-based start estimate misses the sessionStatus tolerance by ${Math.abs(ownStart - polledStart)}ms`);
  }
  // Одиночный сбой опроса не должен объявлять живое окно мёртвым: prune удаляет
  // привязку по ответу sessionStatus, а два участника одной сессии обязаны
  // получить один ответ. Повтор после сбоя и кэш удачного ответа проверяются
  // подставным poll, иначе эти ветки на живой машине не воспроизвести.
  let startPolls = 0;
  const retriedStart = processStartTimeSync(987654321, () => (++startPolls === 1 ? null : 123456));
  assert(retriedStart === 123456 && startPolls === 2, `start time poll was not retried: value=${retriedStart}, polls=${startPolls}`);
  const pollsAfterRetry = startPolls;
  const cachedStart = processStartTimeSync(987654321, () => {
    startPolls += 1;
    return 999;
  });
  assert(cachedStart === 123456 && startPolls === pollsAfterRetry, `successful start time was not cached: value=${cachedStart}, polls=${startPolls}`);
  assert(resolveProcessStartedAt(999999) === null, "resolveProcessStartedAt invented a start time for a dead pid");
  // Ветка отката опроса: на живой машине PowerShell отвечает, и без явного poll=null
  // этот путь не проверялся бы ни одним тестом — а именно он чинит null в lease.
  const fallbackStart = resolveProcessStartedAt(process.pid, () => null);
  assert(Number.isFinite(fallbackStart), "resolveProcessStartedAt still returns null when the poll fails for the current process");
  if (Number.isFinite(polledStart)) {
    assert(Math.abs(fallbackStart - polledStart) <= 2000, `uptime fallback misses the sessionStatus tolerance by ${Math.abs(fallbackStart - polledStart)}ms`);
  }
  assert(resolveProcessStartedAt(999999, () => null) === null, "resolveProcessStartedAt invented a start time for a foreign dead pid");

  const init = house("init", "--scope", "project", "--roles", "designer,backend");
  assert(init.includes("House initialized"), `init failed: ${init}`);
  const config = JSON.parse(readFileSync(join(houseDir, "house.json"), "utf8"));
  assert(config.roles.join(",") === "designer,backend", "house.json role order differs from init");

  house("bind", "--role", "designer", "--profile", "profile-a", "--session-id", "designer-session", "--participant-id", "designer-session");
  house("bind", "--role", "backend", "--profile", "profile-b", "--session-id", "backend-session", "--participant-id", "backend-session");
  const status = JSON.parse(command(join(profileAgent, "house", "house.mjs"), ["status", "--json", "--cwd", project]).trim());
  assert(status.bindings.length === 2, "status did not show both selected sessions");

  // Живость берётся из реестра сессий. Привязка, чья сессия не active, в bind
  // отвергается, а уже сохранённые мёртвые вычищаются: иначе они копятся, роли в
  // доме двоятся, а курьер честно обходит трупы и пишет метки в никуда. Привязку
  // БЕЗ записи в реестре сохраняем: реестр мог не успеть обновиться, и живое окно
  // потеряло бы роль.
  writeSessions([liveLease("designer-session"), liveLease("backend-session", "profile-b")]);
  const candidates = JSON.parse(command(join(profileAgent, "house", "house.mjs"), ["candidates", "--json", "--cwd", project]).trim());
  assert(candidates.sessions.filter((row) => row.status === "active").length === 2, "live leases were not recognised as active candidates");

  const deadSession = "dead-designer-session";
  writeSessions([liveLease("designer-session"), liveLease("backend-session", "profile-b"), deadLease(deadSession)]);
  let refusal = "";
  try {
    house("bind", "--role", "designer", "--profile", "profile-a", "--session-id", deadSession, "--participant-id", deadSession);
  } catch (error) {
    refusal = String(error?.stderr ?? error?.message ?? error);
  }
  assert(refusal.includes("не active"), `bind accepted a session that is not active: ${refusal || "no error"}`);

  // Мёртвая привязка, уже лежащая в house.json, вычищается следующим bind, а живая
  // трогается при этом только если её запись в реестре тоже мертва.
  const configPath = join(houseDir, "house.json");
  const withDead = JSON.parse(readFileSync(configPath, "utf8"));
  withDead.participants.push({ participantId: deadSession, role: "designer", profile: "profile-a", sessionId: deadSession, sessionName: null, cwd: project });
  writeFileSync(configPath, JSON.stringify(withDead, null, 2) + "\n", "utf8");
  house("bind", "--role", "backend", "--profile", "profile-b", "--session-id", "backend-session", "--participant-id", "backend-session");
  const afterPrune = JSON.parse(readFileSync(configPath, "utf8")).participants;
  assert(!afterPrune.some((item) => item.sessionId === deadSession), "bind kept a participant whose session is stale");
  assert(afterPrune.some((item) => item.sessionId === "designer-session"), "bind dropped a live participant while pruning");
  assert(afterPrune.some((item) => item.sessionId === "backend-session"), "bind dropped a live participant while pruning");

  // Водяные знаки вычищенной привязки в state.json — тот же класс, что и сама
  // привязка: пока notified и deliveredBy держат метки на окне, которого нет,
  // любой читающий их увидит доставку в никуда. Проверяется в том же start,
  // который вычищает привязки.
  const stateWithDead = JSON.parse(readFileSync(join(houseDir, "state.json"), "utf8"));
  stateWithDead.notified = { ...stateWithDead.notified, [deadSession]: "2026-10-08T00:00:00+12:00" };
  stateWithDead.deliveredBy = { ...stateWithDead.deliveredBy, [deadSession]: "2026-10-08T00:00:00+12:00" };
  // autoTurns — тот же класс: счётчик привязан к sessionId окна, и мёртвая привязка
  // оставляет в нём мусор, который никто не уберёт.
  stateWithDead.autoTurns = { ...stateWithDead.autoTurns, [deadSession]: 5 };
  writeFileSync(join(houseDir, "state.json"), JSON.stringify(stateWithDead, null, 2) + "\n", "utf8");
  writeSessions([liveLease("designer-session"), liveLease("backend-session", "profile-b")]);
  const startWithStaleState = house("start");
  const stateAfterPrune = JSON.parse(readFileSync(join(houseDir, "state.json"), "utf8"));
  assert(!stateAfterPrune.notified?.[deadSession], `start kept a watermark of a pruned participant: ${JSON.stringify(stateAfterPrune.notified)}`);
  assert(!stateAfterPrune.deliveredBy?.[deadSession], `start kept a delivery mark of a pruned participant: ${JSON.stringify(stateAfterPrune.deliveredBy)}`);
  assert(!stateAfterPrune.autoTurns?.[deadSession], `start kept an auto turn counter of a pruned participant: ${JSON.stringify(stateAfterPrune.autoTurns)}`);
  assert(stateAfterPrune.notified?.["designer-session"] ?? true, "start dropped a watermark of a live participant while pruning state");
  assert(/вычищено мёртвых меток/.test(startWithStaleState), `start did not report the state cleanup: ${startWithStaleState}`);
  house("stop");

  for (const [role, text] of [["designer", "From designer"], ["backend", "From backend"]]) {
    const result = house("send", "--role", role, "--text", text);
    assert(result.includes(`от роли ${role}`), `${role} send did not identify the sender role`);
  }
  // Норма адресата печатается в выводе send — единственный канал, который автор видит
  // В МОМЕНТ записи блока (агент пишет через CLI, stdout возвращается ему как результат
  // инструмента). Признак «нужен ли коллеге этот блок» смысловой, механически его не
  // проверить, поэтому правило живёт текстом там, где автор читает его вовремя.
  const sendNorm = house("send", "--role", "designer", "--text", "Проверка нормы", "--participant-id", "designer-session");
  assert(/Пиши блок, только если коллеге есть дело/.test(sendNorm), `send did not print the recipient norm: ${sendNorm}`);
  const conversation = readFileSync(join(houseDir, "переписка.md"), "utf8");
  assert(conversation.includes("[designer]\n\nFrom designer") && conversation.includes("[backend]\n\nFrom backend"), "sender role or message text missing from conversation");
  assert(JSON.parse(readFileSync(join(houseDir, "state.json"), "utf8")).lastSentBy["designer-session"], "designer send marker was not recorded");

  const start = house("start");
  assert(start.includes("Courier запущен"), `courier did not start: ${start}`);
  courierPid = Number(start.match(/PID (\d+)/)?.[1]);
  assert(courierPid, `courier PID missing: ${start}`);

  // Привязка, оформленная ПОСЛЕ старта курьера, обязана подхватываться без
  // перезапуска. На снимке конфига курьер уведомлял мёртвые сессии и помечал живые
  // как skipped, поэтому симптом «всё живо, но меток нет» больше не проходит.
  const lateSession = "late-bound-backend";
  writeSessions([
    liveLease("designer-session"),
    liveLease("backend-session", "profile-b"),
    liveLease(lateSession, "profile-b"),
  ]);
  house("bind", "--role", "backend", "--profile", "profile-b", "--session-id", lateSession, "--participant-id", lateSession);
  const lateBinding = bindingFor(lateSession);
  assert(lateBinding, "late binding was not saved");
  const lateId = lateBinding.participantId;
  const notifiedBeforeLate = JSON.parse(readFileSync(join(houseDir, "state.json"), "utf8")).notified?.[lateId];
  house("send", "--role", "designer", "--text", "Late binding probe", "--participant-id", "designer-session");
  assert(
    await waitFor(
      () => JSON.parse(readFileSync(join(houseDir, "state.json"), "utf8")).notified?.[lateId] !== notifiedBeforeLate,
      15000,
    ),
    "courier kept a stale config snapshot: a binding made after its start was never notified",
  );
  const notifiedLateBefore = JSON.parse(readFileSync(join(houseDir, "state.json"), "utf8")).notified?.[lateId];

  // Окно, которое было живо на момент привязки и умерло потом, метку получить не
  // должно. Без фильтра курьер писал notified по каждому участнику house.json, и
  // журнал выглядел как работа при полной тишине в обоих окнах.
  const dyingSession = "dying-backend-session";
  // Роль отдельная: bind держит одну привязку на роль, и backend обязан остаться
  // на lateSession, иначе живой сигнал ниже доказывать нечего.
  house("role-add", "--role", "watcher");
  writeSessions([
    liveLease("designer-session"),
    liveLease("backend-session", "profile-b"),
    liveLease(lateSession, "profile-b"),
    liveLease(dyingSession, "profile-b"),
  ]);
  house("bind", "--role", "watcher", "--profile", "profile-b", "--session-id", dyingSession, "--participant-id", dyingSession);
  const dyingBinding = bindingFor(dyingSession);
  assert(dyingBinding, "binding of the dying window was not saved");
  const dyingId = dyingBinding.participantId;
  writeSessions([
    liveLease("designer-session"),
    liveLease("backend-session", "profile-b"),
    liveLease(lateSession, "profile-b"),
    deadLease(dyingSession, "profile-b"),
  ]);
  house("send", "--role", "designer", "--text", "Probe for the dead window", "--participant-id", "designer-session");
  // Сначала живой сигнал: пока живой участник не получил метку, «тишина» мёртвого
  // ничего не доказывает — курьер мог просто не дойти до тика. И только потом
  // проверяем, что метки у мёртвого нет.
  const liveAdvanced = await waitFor(
    () => JSON.parse(readFileSync(join(houseDir, "state.json"), "utf8")).notified?.[lateId] !== notifiedLateBefore,
    15000,
  );
  assert(liveAdvanced, "live participant stopped being notified, so the dead-window check below would prove nothing");
  assert(await waitForQuiet(dyingId), "courier notified a participant whose session is no longer active");

  // Лог обязан быть счётчиком тиков, и проверка идёт при живом курьере. Раньше на
  // одну запись срабатывали и fs.watch, и интервал сверки размера, serializedTick
  // отдавал им один промис, и обе строки уходили в лог.
  //
  // Проверять «нет дублей» на нескольких тиках нельзя: дубль возникает, только
  // если два триггера совпали по времени. Замер по всему логу боевого дома дал
  // 23 пары из 161 тика — 14 процентов, а не «в каждом». Такой тест проходил бы на
  // старом коде примерно в шести прогонах из семи и падал только когда повезёт.
  //
  // Поэтому ждём заведомо дольше pollMs: если watch двигает lastSize, интервал
  // изменения не увидит и второй тик не запустится ни при каком расписании. Если
  // не двигает — интервал отработает гарантированно, и дубль появится всегда.
  // Проверяется поведение, а не текст в исходнике.
  const tickCountBefore = tickLineCount(houseDir);
  house("send", "--role", "designer", "--text", "Дубль тиков не должен появиться", "--participant-id", "designer-session");
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  const ticksFromOneWrite = tickLineCount(houseDir) - tickCountBefore;
  assert(ticksFromOneWrite === 1, `one write produced ${ticksFromOneWrite} tick lines; the log is no longer a tick counter`);
  const stop = house("stop");
  assert(stop.includes("Courier остановлен"), `courier did not stop cleanly: ${stop}`);
  courierPid = undefined;


  // Поллер после resume. Окно, стартовавшее сессией A, после resume работает
  // сессией B: поллер на снимке продолжал бы искать A и писать deliveredBy[A],
  // а роль B не получала бы сообщений вовсе. Признак — файл state.json и
  // содержимое инъекции, а не тишина в окне.
  const extension = (await import(pathToFileURL(join(profileAgent, "extensions", "house.ts")).href)).default;
  const handlers = new Map();
  const delivered = [];
  let currentSession = "poller-session-a";
  const ui = { notify: () => {}, select: async () => "", askDialog: null };
  const api = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => {},
    sendUserMessage: (message, options) => delivered.push({ message, options, session: currentSession }),
    ui,
  };
  const context = { cwd: project, ui, sessionManager: { getSessionId: () => currentSession } };
  house("bind", "--role", "designer", "--profile", "profile-a", "--session-id", "poller-session-a", "--participant-id", "poller-session-a");
  house("send", "--role", "backend", "--text", "Сообщение до resume", "--participant-id", "backend-session");
  extension(api);
  assert(typeof handlers.get("session_switch") === "function", "extension does not restart the poller on session_switch");
  await handlers.get("session_start")(undefined, context);
  const pollerLog = join(houseDir, "logs", "inbox.log");
  await waitFor(() => delivered.length >= 1, 8000);
  assert(delivered.length >= 1, `poller delivered nothing before resume: ${existsSync(pollerLog) ? readFileSync(pollerLog, "utf8") : "no inbox.log"}`);
  // Инъекция уходит с deliverAs: "steer", а не followUp. Разница не в том,
  // показывает ли окно, а в том, ГДЕ: followUp ждёт конца хода, steer ждёт
  // следующего вызова инструментов. Проверяется фактический аргумент, а не текст
  // в исходнике.
  assert(delivered[0].options?.deliverAs === "steer", `injection does not use steer: ${JSON.stringify(delivered[0].options ?? null)}`);

  currentSession = "poller-session-b";
  house("bind", "--role", "designer", "--profile", "profile-a", "--session-id", "poller-session-b", "--participant-id", "poller-session-b");
  house("send", "--role", "backend", "--text", "Сообщение после resume", "--participant-id", "backend-session");
  await handlers.get("session_switch")(undefined, context);
  await waitFor(() => delivered.some((entry) => entry.message.includes("Сообщение после resume")), 8000);
  assert(delivered.some((entry) => entry.session === "poller-session-b"), `poller kept the session id it started with: ${JSON.stringify(delivered.map((entry) => entry.session))}`);
  handlers.get("session_shutdown")(undefined, context);

  // Петля автономных ходов. Инъекция в простаивающее окно сама запускает ход
  // (`sendUserMessage` — «Always triggers a turn», agent-session.js:1805), а предела
  // числу таких ходов не было ни у одного потребителя: замер 2026-10-08 дал девять
  // блоков за двадцать минут, и остановил их сам агент. Проверяются четыре вещи: текст
  // инъекции не приказывает ответить; доставка сама по себе счётчик НЕ двигает (в
  // занятое окно она уходит steer'ом и хода не начинает); ход инъекции счётчик
  // наращивает, а слово владельца обнуляет; на пределе текст несёт факт петли. Тормоз
  // МЯГКИЙ: пробуждение окна и доставка остаются на любом счётчике — блок не имеет
  // права потеряться.
  const loopHandlers = new Map();
  const loopDelivered = [];
  const loopApi = {
    on: (event, handler) => loopHandlers.set(event, handler),
    registerCommand: () => {},
    sendUserMessage: (message, options) => loopDelivered.push({ message, options }),
    ui,
  };
  const loopSession = "loop-session";
  house("bind", "--role", "designer", "--profile", "profile-a", "--session-id", loopSession, "--participant-id", loopSession);
  const loopConfigPath = join(houseDir, "house.json");
  const loopConfig = JSON.parse(readFileSync(loopConfigPath, "utf8"));
  loopConfig.courier = { ...loopConfig.courier, autoTurnLimit: 1 };
  writeFileSync(loopConfigPath, JSON.stringify(loopConfig, null, 2) + "\n", "utf8");
  writeSessions([liveLease(loopSession), liveLease("backend-session", "profile-b")]);
  const loopStatePath = join(houseDir, "state.json");
  const loopState = JSON.parse(readFileSync(loopStatePath, "utf8"));
  loopState.autoTurns = {};
  loopState.deliveredBy = {};
  writeFileSync(loopStatePath, JSON.stringify(loopState, null, 2) + "\n", "utf8");
  // Переписка чистится: новый sessionId стартует с курсором 0 и первым тиком получает
  // САМЫЙ ПОЗДНИЙ входящий блок из всего файла. Если оставить хвост прежних тестов,
  // он и придёт первым, а счётчик начнёт расти с него — и проверка текста поедет.
  writeFileSync(join(houseDir, "переписка.md"), "# House\n\n", "utf8");
  const loopContext = { cwd: project, ui, sessionManager: { getSessionId: () => loopSession } };
  extension(loopApi);
  await loopHandlers.get("session_start")(undefined, loopContext);
  const loopTurns = () => Number(JSON.parse(readFileSync(loopStatePath, "utf8")).autoTurns?.[loopSession] ?? 0);
  // Хук несёт счётчик; в стенде его надо звать руками, потому что подставной `pi` не
  // прогоняет реальный `prompt()` и `before_agent_start` не эмитится.
  const loopWatchHook = (await import(pathToFileURL(join(profileAgent, "hooks", "pre", "house-watch.ts")).href)).default;
  const loopWatchHandlers = new Map();
  loopWatchHook({ on: (event, handler) => loopWatchHandlers.set(event, handler) });
  const realAgentDirForLoop = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profileAgent;
  const loopWatchStart = async (prompt) =>
    (await loopWatchHandlers.get("before_agent_start")({ type: "before_agent_start", prompt }, {
      cwd: project,
      sessionManager: { getSessionId: () => loopSession, getCwd: () => project },
    })) ?? {};

  house("send", "--role", "backend", "--text", "Первый автономный блок", "--participant-id", "backend-session");
  await waitFor(() => loopDelivered.length >= 1, 12_000);
  assert(loopDelivered.length >= 1, `loop probe delivered nothing: ${JSON.stringify(loopDelivered.map((entry) => entry.message))}`);
  // Текст инъекции: молчание — норма, а не сбой. Безусловный приказ ответить и был
  // топливом петли — приглашение стояло на каждом блоке, а подтверждений большинство.
  const firstInjection = loopDelivered.find((entry) => entry.message.includes("Первый автономный блок"));
  assert(firstInjection, `loop probe missed the first block: ${JSON.stringify(loopDelivered.map((entry) => entry.message))}`);
  assert(!firstInjection.message.includes("Ответь по существу"), `injection still orders a reply: ${firstInjection.message}`);
  assert(firstInjection.message.includes("Отвечай только если"), `injection lost the conditional norm: ${firstInjection.message}`);
  assert(!firstInjection.message.includes("ходов подряд"), `loop line appeared before the limit: ${firstInjection.message}`);
  // Доставка сама счётчик не двигает: в занятое окно она уходит steer'ом и ход не
  // начинает (`agent-session.js:1519-1526`), поэтому считать её автономным ходом нельзя.
  // На доставках счётчик врал бы в сценарии «владелец дал длинное задание, коллега
  // прислал семь блоков»: семь доставок внутрь одного хода владельца.
  assert(loopTurns() === 0, `a delivery moved the auto turn counter, so a steered block inside an owner turn would count as an autonomous turn: ${readFileSync(loopStatePath, "utf8")}`);
  // Ход инъекции счётчик наращивает; префикс текста — признак инъекции.
  await loopWatchStart("Сообщение от роли `backend` в доме X");
  assert(loopTurns() === 1, `an injection turn did not grow the auto turn counter: ${readFileSync(loopStatePath, "utf8")}`);
  // Второй автономный ход: счётчик уже на пределе (K=1) → текст несёт факт петли.
  house("send", "--role", "backend", "--text", "Второй автономный блок", "--participant-id", "backend-session");
  await waitFor(() => loopDelivered.some((entry) => entry.message.includes("Второй автономный блок")), 12_000);
  const secondInjection = loopDelivered.find((entry) => entry.message.includes("Второй автономный блок"));
  assert(secondInjection, `loop probe missed the second block: ${JSON.stringify(loopDelivered.map((entry) => entry.message))}`);
  assert(secondInjection.message.includes("ходов подряд"), `loop line missing at the limit: ${secondInjection.message}`);
  // Мягкий тормоз: окно будится и блок идёт через steer и на пределе. Жёсткий вариант
  // (triggerTurn: false) оставил бы блок невидимым до слова владельца.
  assert(secondInjection.options?.deliverAs === "steer", `loop brake stopped waking the window: ${JSON.stringify(secondInjection.options ?? null)}`);
  // Ход инъекции не сбрасывает; слово владельца обнуляет. Признак хода берётся из
  // текста промпта: событие `before_agent_start` отдаёт хуку только `prompt`
  // (runner.js:1128), поля «кто начал ход» нет, но текст инъекции пишем мы сами.
  await loopWatchStart("Сообщение от роли `backend` в доме X");
  assert(loopTurns() === 2, `an injection turn reset the auto turn counter: ${readFileSync(loopStatePath, "utf8")}`);
  await loopWatchStart("обычное слово владельца");
  assert(loopTurns() === 0, `an owner turn did not reset the auto turn counter: ${readFileSync(loopStatePath, "utf8")}`);
  if (realAgentDirForLoop === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDirForLoop;
  loopHandlers.get("session_shutdown")(undefined, loopContext);

  // Реестр сессий. Запись прежней сессии того же окна — надгробник: после resume
  // sessionId меняется, а прежняя запись остаётся навсегда. Один pid — одно окно,
  // поэтому updateLease выкидывает чужие sessionId того же pid, а session_shutdown
  // снимает все записи своего pid, а не только текущую sessionId.
  const registryHook = (await import(pathToFileURL(join(profileAgent, "hooks", "pre", "house-session-registry.ts")).href)).default;
  const registryHandlers = new Map();
  registryHook({ on: (event, handler) => registryHandlers.set(event, handler) });
  const registryContext = (sessionId) => ({
    cwd: project,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => null,
      getSessionFile: () => join(project, `${sessionId}.jsonl`),
      getCwd: () => project,
      getEntries: () => [],
    },
  });
  let registrySession = "registry-session-a";
  await registryHandlers.get("session_start")(undefined, registryContext(registrySession));
  const windowPid = readSessions().find((row) => row.sessionId === "registry-session-a").pid;
  registrySession = "registry-session-b";
  await registryHandlers.get("session_switch")(undefined, registryContext(registrySession));
  const sameWindow = readSessions().filter((row) => row.pid === windowPid);
  assert(sameWindow.length === 1, `registry kept a tombstone for the same pid: ${JSON.stringify(sameWindow.map((row) => row.sessionId))}`);
  assert(sameWindow[0].sessionId === "registry-session-b", "registry did not move the lease to the current session");
  assert(Number.isFinite(sameWindow[0].processStartedAt), "registry wrote a lease with a null processStartedAt");
  await registryHandlers.get("session_shutdown")(undefined, registryContext(registrySession));
  assert(readSessions().every((row) => row.pid !== windowPid), "session_shutdown left a lease of the same window behind");
  // Тот же случай для shutdown: запись прежней сессии пережила смену sessionId, и
  // снятие по текущей sessionId её не убирает — снять надо всё, что принадлежит
  // этому pid.
  writeSessions([{ ...liveLease("orphan-before-resume"), pid: windowPid }, liveLease("orphan-current")]);
  await registryHandlers.get("session_shutdown")(undefined, registryContext("orphan-current"));
  assert(readSessions().every((row) => row.pid !== windowPid), `session_shutdown left an orphan lease of the same window: ${JSON.stringify(readSessions().map((row) => `${row.sessionId}/${row.pid}`))}`);

  // Мёртвая запись в реестре. Окно, закрытое без session_shutdown, оставляет
  // запись навсегда — на кандидатов и курьера это не влияет (unconfirmed
  // отсекается в обоих местах), но реестр растёт. Убирать дешевле всего здесь.
  writeSessions([liveLease("registry-live"), deadLease("registry-dead-window")]);
  await registryHandlers.get("session_start")(undefined, registryContext("registry-live"));
  assert(!readSessions().some((row) => row.sessionId === "registry-dead-window"), `registry kept a lease of a dead window: ${JSON.stringify(readSessions().map((row) => row.sessionId))}`);
  await registryHandlers.get("session_shutdown")(undefined, registryContext("registry-live"));

  // Регистр профиля в ключе живости. Профиль набирается руками в house.json, и
  // "PROFILE-A" против "profile-a" иначе дали бы session-not-active и молчаливую
  // отсутствие доставки — ровно тот класс тихой поломки, который тут и ловим.
  house("bind", "--role", "designer", "--profile", "PROFILE-A", "--session-id", "upper-case-profile", "--participant-id", "upper-case-profile");
  writeSessions([liveLease("designer-session"), liveLease("upper-case-profile", "profile-a")]);
  const bound = JSON.parse(readFileSync(join(houseDir, "house.json"), "utf8")).participants;
  assert(bound.some((item) => item.sessionId === "upper-case-profile"), "bind dropped a live participant because of profile letter case");
  // Тот же регистр, но через самого курьера: participant.profile в конфиге и
  // session.profile в реестре пишутся разными руками. Без нормализации ключ
  // живости не совпадёт, и notify молча уйдёт в session-not-active при живой
  // сессии — самый тихий из возможных классов поломки.
  house("bind", "--role", "backend", "--profile", "Profile-B", "--session-id", "case-live-notify", "--participant-id", "case-live-notify");
  writeSessions([liveLease("upper-case-profile", "profile-a"), liveLease("case-live-notify", "profile-b")]);
  const caseBinding = bindingFor("case-live-notify");
  assert(caseBinding, "bind of the case probe was not saved");
  const caseId = caseBinding.participantId;
  const notifiedCaseBefore = JSON.parse(readFileSync(join(houseDir, "state.json"), "utf8")).notified?.[caseId];
  const caseStart = house("start");
  assert(/Courier запущен|уже работает/.test(caseStart), `courier did not start for the case probe: ${caseStart}`);
  courierPid = Number(caseStart.match(/PID (\d+)/)?.[1]) ?? courierPid;
  // participantId роли мог смениться предыдущими привязками: шлём от того, кто
  // реально стоит на живой сессии, а не от зашитого id.
  const caseDesignerId = bindingFor("upper-case-profile").participantId;
  house("send", "--role", "designer", "--text", "Case probe", "--participant-id", caseDesignerId);
  assert(
    await waitFor(
      () => JSON.parse(readFileSync(join(houseDir, "state.json"), "utf8")).notified?.[caseId] !== notifiedCaseBefore,
      15000,
    ),
    "courier treated a live participant as dead because of profile letter case",
  );
  house("stop");
  courierPid = undefined;

  // auto не обязан иметь живое окно. В auto доставку делает headless-агент,
  // которого курьер поднимает сам, и auto существует ровно для роли, у которой
  // окна нет. Гейт живости перед развилкой notify/auto съедал его целиком:
  // у закрытого окна auto давал skipped и headless не поднимался никогда.
  // До этого теста слово auto в smoke не встречалось ни разу.
  const autoConfigPath = join(houseDir, "house.json");
  const autoConfig = JSON.parse(readFileSync(autoConfigPath, "utf8"));
  autoConfig.perRole = { ...autoConfig.perRole, backend: { mode: "auto" } };
  autoConfig.courier = { ...autoConfig.courier, profile: "profile-auto" };
  writeFileSync(autoConfigPath, JSON.stringify(autoConfig, null, 2) + "\n", "utf8");
  house("bind", "--role", "backend", "--profile", "profile-auto", "--session-id", "auto-without-window", "--participant-id", "auto-without-window");
  const autoBinding = bindingFor("auto-without-window");
  assert(autoBinding, "auto binding was not saved");
  const autoId = autoBinding.participantId;
  writeSessions([liveLease("designer-session"), deadLease("auto-without-window", "profile-auto")]);
  // Фоновый курьер останавливаем: иначе его строка tick оказывается в хвосте лога,
  // и ассерт читает чужой тик вместо пробы. Проба идёт отдельным процессом.
  const stopForAuto = house("stop");
  assert(/Courier остановлен|Courier уже не работает|уже остановлен/.test(stopForAuto), `courier did not stop before the auto probe: ${stopForAuto}`);
  courierPid = undefined;
  // OMP_BIN подменён на заведомо отсутствующий: так auto доходит до spawn и
  // возвращает ошибку запуска, а не молчаливый skipped. Именно ошибка запуска
  // доказывает, что headless-agent был вызван, а не отсечён гейтом. spawnSync, а
  // не execFileSync: отсутствующий бинарь пишет в stderr, и бросок уронил бы
  // весь прогон вместо внятного ассерта.
  const autoProbe = spawnSync(process.execPath, [join(profileAgent, "house", "courier.mjs"), "--house", houseDir, "--once"], {
    cwd: project,
    env: { ...env, OMP_BIN: join(root, "no-such-omp-binary") },
    encoding: "utf8",
  });
  const autoLog = readFileSync(join(houseDir, "logs", "courier.log"), "utf8").trim().split("\n").pop();
  // Ассерт по конкретному участнику, а не по всей строке: в тике сидят и notify-
  // участники без живой записи, их session-not-active здесь законен и к auto
  // отношения не имеет.
  const autoResults = JSON.parse(autoLog.slice(autoLog.indexOf("[")));
  const autoRow = autoResults.find((row) => row.participantId === autoId);
  assert(autoRow, `auto did not report a result for its participant: ${autoLog}`);
  assert(autoRow.reason !== "session-not-active", `auto was skipped by the liveness gate, so a role without a window can never be served: ${autoLog}`);
  assert(autoRow.ok === false && Boolean(autoRow.error), `auto did not reach the spawn stage: ${autoLog}`);
  assert(autoProbe.status === 0, `auto probe exited with ${autoProbe.status}: ${autoProbe.stderr ?? ""}`);

  // Напоминалка house-watch. Коллега ищется по тому же sessionStatus, что и у
  // курьера, поэтому проверяются ОБЕ стороны: живой коллега даёт напоминалку и
  // мёртвый её не даёт. Односторонний тест на «напоминалка пришла» проходит и на
  // старой неправильной реализации — при живой конфиге peer всегда находится, и
  // напоминалка проходит тем же путём.
  //
  // Предмет напоминалки — «коллега говорил последним», и берётся он из меток
  // ОТПРАВКИ (lastSentBy), а не доставки (deliveredBy). Проверка поэтому
  // двусторонняя по данным: deliveredBy задаётся с обратным знаком, чтобы
  // реализация на deliveredBy падала на обоих ассертах, а не проходила по
  // совпадению. Ровно этот перепутанный источник давал замер 2026-10-08 в живом
  // доме: последний блок переписки [designer], а напоминалка пришла designer'у.
  const watchHook = (await import(pathToFileURL(join(profileAgent, "hooks", "pre", "house-watch.ts")).href)).default;
  const watchHandlers = new Map();
  watchHook({ on: (event, handler) => watchHandlers.set(event, handler) });
  const watchStart = async (sessionId) =>
    (await watchHandlers.get("before_agent_start")(undefined, {
      cwd: project,
      sessionManager: { getSessionId: () => sessionId, getCwd: () => project },
    })) ?? {};
  // Изолируем конфиг: в нём остаются ровно двое — под наблюдением и коллега. Иначе
  // старая реализация выбрала бы первым «любым участником с другой ролью», и
  // проверка падала бы не на той стороне. Односторонний тест здесь проходит и на
  // неправильном коде, а двусторонний ловит именно сверку живости.
  const watchConfigPath = join(houseDir, "house.json");
  const watchConfig = JSON.parse(readFileSync(watchConfigPath, "utf8"));
  watchConfig.participants = [
    { participantId: "watch-designer", role: "designer", profile: "profile-a", sessionId: "watch-designer", sessionName: null, cwd: project },
    { participantId: "watch-backend", role: "backend", profile: "profile-b", sessionId: "watch-backend", sessionName: null, cwd: project },
  ];
  writeFileSync(watchConfigPath, JSON.stringify(watchConfig, null, 2) + "\n", "utf8");
  writeSessions([liveLease("watch-designer"), liveLease("watch-backend", "profile-b")]);
  // Хук берёт профиль из process.env напрямую: в smoke-процессе там лежит настоящий
  // профиль, а не стендовый profile-a, и сверка не проходит. Окружение
  // подменяется на время проверки и возвращается обратно.
  const realAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profileAgent;
  const statePath = join(houseDir, "state.json");
  const writeWatchState = (marks) => {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.lastSentBy = marks.lastSentBy;
    state.deliveredBy = marks.deliveredBy;
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  };

  // Коллега говорил последним: его метка отправки свежее моей → напоминалка есть.
  // deliveredBy задан наоборот, как читала бы его старая реализация.
  writeWatchState({
    lastSentBy: { "watch-designer": "2026-10-08T00:00:00+12:00", "watch-backend": "2026-10-08T02:00:00+12:00" },
    deliveredBy: { "watch-designer": "2026-10-08T02:00:00+12:00", "watch-backend": "2026-10-08T00:00:00+12:00" },
  });
  const alive = await watchStart("watch-designer");
  assert(alive.message?.content?.includes("есть непрочитанное"), `reminder did not fire when the peer spoke last: ${JSON.stringify(alive.message ?? null)}`);

  // Я говорил последним: мяч у коллеги, напоминалки быть не должно. Это тот самый
  // случай, на котором напоминалка в живом доме срабатывала на своём же ответе.
  writeWatchState({
    lastSentBy: { "watch-designer": "2026-10-08T02:00:00+12:00", "watch-backend": "2026-10-08T00:00:00+12:00" },
    deliveredBy: { "watch-designer": "2026-10-08T00:00:00+12:00", "watch-backend": "2026-10-08T02:00:00+12:00" },
  });
  const quiet = await watchStart("watch-designer");
  assert(!quiet.message, `reminder fired for a window that spoke last: ${JSON.stringify(quiet.message ?? null)}`);

  // Я не писал ни разу, коллега писал: непрочитанное есть, и отсутствие моей метки
  // не должно читаться как «нечего читать».
  writeWatchState({
    lastSentBy: { "watch-backend": "2026-10-08T02:00:00+12:00" },
    deliveredBy: {},
  });
  const fresh = await watchStart("watch-designer");
  assert(fresh.message?.content?.includes("есть непрочитанное"), `reminder did not fire for a window that never spoke: ${JSON.stringify(fresh.message ?? null)}`);

  // Тот же state, но коллега мёртв: та же причина отсутствия напоминалки, что и
  // раньше, а найти коллегу больше нельзя.
  writeSessions([liveLease("watch-designer"), deadLease("watch-backend", "profile-b")]);
  const dead = await watchStart("watch-designer");
  assert(!dead.message, `reminder fired for a dead peer, which is exactly the a729 class: ${JSON.stringify(dead.message ?? null)}`);
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;

  writeFileSync(join(houseDir, "smoke-sentinel"), "uninstall retains project data\n");
  house("uninstall");
  assert(existsSync(join(houseDir, "smoke-sentinel")), "uninstall removed project data");

  // Единственное имя: каталог с другим именем домом не считается, init создаёт .house.
  const otherProject = join(root, "other-project");
  mkdirSync(join(otherProject, ".other-house"), { recursive: true });
  writeFileSync(
    join(otherProject, ".other-house", "house.json"),
    JSON.stringify({ version: 1, roles: ["spec"], signatures: {}, participants: [], courier: { mode: "notify" } }, null, 2) + "\n",
    "utf8",
  );
  const otherInit = command(
    join(profileAgent, "house", "house.mjs"),
    ["init", "--scope", "project", "--roles", "designer", "--cwd", otherProject],
    otherProject,
  );
  assert(otherInit.includes("House initialized"), `init failed next to a non-house directory: ${otherInit}`);
  assert(existsSync(join(otherProject, HOUSE_DIR_NAME)), "init did not create .house next to a non-house directory");

  console.log("HOUSE_INSTALL_CLI_SMOKE_PASS");
} finally {
  if (courierPid) {
    try { process.kill(courierPid); } catch {}
  }
  // Уборка не должна перебивать диагностику: EBUSY на Windows маскировал бы
  // исходную ошибку ассерта, и упавший тест выглядел бы как упавшая уборка.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.log(`WARN: временный каталог не убран: ${root}`);
  }
}
