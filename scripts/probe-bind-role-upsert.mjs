// Проба bind: чужое окно без флага не привязывается, а роль держит одну запись.
// Проверяется то, что видит живой дом после сбоя: у роли было две привязки, и
// state.lastSentBy указывал на старую. Живые метки и имя должны пережить bind.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOUSE_DIR_NAME, resolveProcessStartedAt, sessionStatus } from "../src/house-lock.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const housePath = join(repoRoot, "src", "house.mjs");
const root = mkdtempSync(join(tmpdir(), "house-bind-role-"));
const project = join(root, "project");
const houseDir = join(project, HOUSE_DIR_NAME);
const configPath = join(houseDir, "house.json");
const sessionsPath = join(houseDir, "sessions.json");
const statePath = join(houseDir, "state.json");
const profile = "profile-a";
let failed = 0;

function check(condition, message, detail = "") {
  if (condition) {
    console.log(`OK   ${message}`);
    return;
  }
  failed += 1;
  console.log(`FAIL ${message}${detail ? `: ${detail}` : ""}`);
}

function config() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function roleRows(role) {
  return config().participants.filter((item) => item.role === role);
}

// self === undefined убирает переменную из окружения: так выглядит вызов bind из
// процесса, который не является окном OMP.
function runBind({ role = "spec", sessionId, participantId, self, allowOther = false }) {
  const env = { ...process.env };
  if (self === undefined) delete env.PI_SESSION_ID;
  else env.PI_SESSION_ID = self;
  const args = [
    housePath,
    "bind",
    "--cwd",
    project,
    "--role",
    role,
    "--profile",
    profile,
    "--session-id",
    sessionId,
    "--participant-id",
    participantId,
  ];
  if (allowOther) args.push("--allow-other-session");
  return spawnSync(process.execPath, args, { cwd: project, env, encoding: "utf8" });
}

function refusal(result) {
  return String(result.stderr ?? "") || String(result.stdout ?? "");
}

try {
  mkdirSync(houseDir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 1,
        roles: ["spec", "exec", "supervisor", "scribe", "reader"],
        signatures: {
          spec: "\\[spec\\]",
          exec: "\\[exec\\]",
          supervisor: "\\[supervisor\\]",
          scribe: "\\[scribe\\]",
          reader: "\\[reader\\]",
        },
        participants: [
          // Живой сбой: старая роль-как-id и новая сессия-как-id у одной роли.
          // Ярлык на второй записи: lastSentBy указывает на первую, и именно
          // этот расклад терял имя при чистке дублей.
          { participantId: "spec", role: "spec", profile, sessionId: "A" },
          { participantId: "A", role: "spec", profile, sessionId: "A", label: "Архитектор" },
          { participantId: "B", role: "exec", profile, sessionId: "B" },
          { participantId: "C", role: "supervisor", profile, sessionId: "C", label: "Надзор" },
          // Без меток lastSentBy: проверяется выбор записи по текущему participantId.
          { participantId: "scribe", role: "scribe", profile, sessionId: "D", label: "Писарь" },
          { participantId: "D", role: "scribe", profile, sessionId: "D", label: "Писарь второй" },
          // Мёртвый дубль с ярлыком: prune уберёт его в этом же bind, имя должно
          // переехать на живую запись роли.
          { participantId: "reader", role: "reader", profile, sessionId: "A" },
          { participantId: "Z", role: "reader", profile, sessionId: "Z", label: "Читатель" },
        ],
        courier: { mode: "notify", cooldownMs: 120000, retryMs: 30000, timeoutMs: 300000, autoTurnLimit: 6 },
        perRole: {},
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const processStartedAt = resolveProcessStartedAt(process.pid);
  const lease = (sessionId) => ({
    profile,
    sessionId,
    sessionName: null,
    cwd: project,
    pid: process.pid,
    processStartedAt,
    startedAt: "2026-11-23T09:00:00.000Z",
    lastSeenAt: new Date().toISOString(),
    candidateDescription: "живая сессия пробы",
    kind: "interactive",
    status: "active",
  });
  const registry = { version: 1, sessions: ["A", "B", "C", "D"].map(lease) };
  writeFileSync(sessionsPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
  // Фикстура обязана быть живой: мёртвую аренду prune законно вычистит, и проверки
  // upsert перестанут что-либо доказывать. Печатаем lease и ответ целиком, чтобы
  // сбой опроса старта был виден как сбой окружения, а не как ошибка upsert.
  const leaseStatuses = Object.fromEntries(registry.sessions.map((entry) => [entry.sessionId, sessionStatus(entry)]));
  check(
    Object.values(leaseStatuses).every((status) => status === "active"),
    "аренды A-D активны до bind",
    JSON.stringify({ processStartedAt, leaseStatuses }),
  );
  const initialParticipants = config().participants;
  check(
    initialParticipants.filter((item) => item.role === "spec").length === 2,
    "в фикстуре две записи spec",
    JSON.stringify(initialParticipants.filter((item) => item.role === "spec")),
  );
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updated: "2026-11-23T09:10:00+03:00",
        lastSentBy: {
          spec: "2026-11-23T09:00:00+03:00",
          B: "2026-11-23T09:05:00+03:00",
          C: "2026-11-23T09:10:00+03:00",
        },
        notified: {},
        delivered: {},
        deliveredBy: {},
        autoTurns: {},
        open: [],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // Нет PI_SESSION_ID и нет флага: bind не знает, чьё это окно, и отказывает.
  const beforeMissing = readFileSync(configPath, "utf8");
  const missing = runBind({ sessionId: "B", participantId: "B" });
  check(missing.status === 2, "bind без PI_SESSION_ID без флага отказывает кодом 2", `exit ${missing.status}`);
  check(refusal(missing).includes("PI_SESSION_ID"), "отказ называет PI_SESSION_ID", refusal(missing).trim());
  check(readFileSync(configPath, "utf8") === beforeMissing, "отказ без PI_SESSION_ID не меняет house.json");

  // Своё окно A, а привязывается B: без флага это чужое окно.
  const beforeForeign = readFileSync(configPath, "utf8");
  const foreign = runBind({ sessionId: "B", participantId: "B", self: "A" });
  check(foreign.status === 2, "bind без флага не привязывает чужую сессию", `exit ${foreign.status}`);
  check(refusal(foreign).includes("A") && refusal(foreign).includes("B"), "отказ называет своё и переданное окно", refusal(foreign).trim());
  check(readFileSync(configPath, "utf8") === beforeForeign, "отказ на чужую сессию не меняет house.json");

  // Флаг разрешает привязку выбранного окна и схлопывает две записи роли в одну.
  const beforeAllowed = config().participants;
  const allowed = runBind({ sessionId: "B", participantId: "B", self: "A", allowOther: true });
  check(allowed.status === 0, "bind с --allow-other-session привязывает чужую сессию", refusal(allowed).trim());
  const merged = roleRows("spec");
  check(merged.length === 1, "у роли spec осталась одна привязка", JSON.stringify(merged));
  check(
    merged[0]?.participantId === "spec",
    "participantId из lastSentBy сохранён",
    JSON.stringify({ merged, before: beforeAllowed, bound: String(allowed.stdout).trim() }),
  );
  check(merged[0]?.label === "Архитектор", "имя роли сохранено", String(merged[0]?.label));
  check(merged[0]?.sessionId === "B", "роль переехала на привязанное окно", String(merged[0]?.sessionId));
  check(String(allowed.stdout).includes("убрано дублей роли: 1"), "bind сообщает число убранных дублей", String(allowed.stdout).trim());

  // Привязка spec на сессию B не съедает exec на той же сессии.
  const onSessionB = config().participants.filter((item) => item.sessionId === "B");
  check(onSessionB.length === 2, "на одной сессии две роли остаются двумя", JSON.stringify(onSessionB));
  check(
    onSessionB.some((item) => item.role === "spec") && onSessionB.some((item) => item.role === "exec"),
    "на сессии B живут spec и exec",
    JSON.stringify(onSessionB),
  );
  const execRows = roleRows("exec");
  check(execRows.length === 1 && execRows[0]?.participantId === "B", "чужая роль exec не тронута", JSON.stringify(execRows));

  // Своё окно B без флага: повторный bind с текущим participantId.
  const own = runBind({ sessionId: "B", participantId: "spec", self: "B" });
  check(own.status === 0, "bind своего окна без флага проходит", refusal(own).trim());
  const ownRows = roleRows("spec");
  check(ownRows.length === 1 && ownRows[0]?.participantId === "spec", "повторный bind с текущим id держит одну привязку", JSON.stringify(ownRows));
  check(ownRows[0]?.label === "Архитектор", "повторный bind не стирает имя", String(ownRows[0]?.label));

  // Меток lastSentBy у scribe нет: выживает запись с переданным participantId.
  const byCurrent = runBind({ role: "scribe", sessionId: "D", participantId: "D", self: "D" });
  check(byCurrent.status === 0, "bind scribe своего окна проходит", refusal(byCurrent).trim());
  const scribeRows = roleRows("scribe");
  check(scribeRows.length === 1, "у роли scribe осталась одна привязка", JSON.stringify(scribeRows));
  check(scribeRows[0]?.participantId === "D", "без меток выживает текущий participantId", String(scribeRows[0]?.participantId));
  check(scribeRows[0]?.label === "Писарь второй", "имя выжившей записи сохранено", String(scribeRows[0]?.label));

  // Мёртвый дубль с ярлыком: prune уносит запись в этом же bind, имя остаётся.
  const reader = runBind({ role: "reader", sessionId: "A", participantId: "reader", self: "A" });
  check(reader.status === 0, "bind роли с мёртвым дублем проходит", refusal(reader).trim());
  const readerRows = roleRows("reader");
  check(readerRows.length === 1, "у роли reader осталась одна привязка", JSON.stringify(readerRows));
  check(readerRows[0]?.label === "Читатель", "имя переехало с мёртвого дубля", String(readerRows[0]?.label));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `ПРОВАЛ: ${failed}` : "PASS: bind держит роль и своё окно");
process.exitCode = failed ? 1 : 0;