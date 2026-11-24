// Проба CLI для фичи house-setup-roles-labels.
// Проверяет то, что видит человек: заголовок сессии, добавление роли, имя сессии.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatStatus, run } from "../src/house.mjs";
import { HOUSE_DIR_NAME, resolveProcessStartedAt } from "../src/house-lock.mjs";

const root = mkdtempSync(join(tmpdir(), "house-labels-"));
const project = join(root, "project");
const sessionFile = join(root, "session.jsonl");
const sessionId = "0123abcd-1111-2222-3333-444455556666";
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

function house(...args) {
  // Проба играет окна из одного процесса: привязка чужих сессий явная.
  const allowOther = args[0] === "bind" ? ["--allow-other-session"] : [];
  return run([...args, ...allowOther, "--cwd", project]);
}

try {
  mkdirSync(project, { recursive: true });
  check((await house("init", "--scope", "project", "--roles", "designer,backend")).ok, "init создаёт дом");

  // Файл сессии с заголовком в конце: ровно так omp пишет авто-заголовок.
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: "title", v: 1, title: "🧭 SUPRV: Supervisor pipeline kickoff", source: "auto" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Привет" }] } }),
      JSON.stringify({ type: "title_change", title: "🧭 SUPRV: Supervisor pipeline kickoff v2", source: "auto" }),
    ].join("\n") + "\n",
    "utf8",
  );

  const lease = {
    profile,
    sessionId,
    sessionFile,
    cwd: project,
    pid: process.pid,
    processStartedAt: resolveProcessStartedAt(process.pid),
    startedAt: "2026-11-22T22:08:12.498Z",
    lastSeenAt: new Date().toISOString(),
    // Реестр намеренно отстаёт: имя пусто, описание это первое сообщение.
    candidateDescription: "Привет",
    kind: "interactive",
  };
  writeFileSync(join(project, HOUSE_DIR_NAME, "sessions.json"), JSON.stringify({ version: 1, sessions: [lease] }, null, 2), "utf8");

  const candidates = await house("candidates", "--json");
  const row = candidates.data?.sessions?.[0];
  check(row?.status === "active", "сессия активна");
  check(row?.title === "🧭 SUPRV: Supervisor pipeline kickoff v2", "заголовок взят из файла, последний по времени", String(row?.title));
  check(row?.display === row?.title, "display это заголовок");
  check(row?.shortId === "0123abcd", "короткий id это 8 символов", String(row?.shortId));

  writeFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Ты спек" }] } })}\n`, "utf8");
  const untitled = await house("candidates", "--json");
  const untitledRow = untitled.data?.sessions?.[0];
  check(untitledRow?.title === null, "без заголовка title пустой", String(untitledRow?.title));
  check(untitledRow?.display === "Ты спек", "без заголовка показывается первое сообщение", String(untitledRow?.display));

  const added = await house("role-add", "--role", "sprint");
  check(added.ok && added.data?.added === true, "role-add добавляет роль", added.message);
  const config = JSON.parse(readFileSync(join(project, HOUSE_DIR_NAME, "house.json"), "utf8"));
  check(config.roles.includes("sprint"), "роль в house.json");
  check(config.signatures.sprint === "\\[sprint\\]", "подпись роли создана", String(config.signatures.sprint));

  const duplicate = await house("role-add", "--role", "Sprint");
  check(duplicate.ok && duplicate.data?.added === false, "дубликат регистронезависим", duplicate.message);

  const badName = await house("role-add", "--role", "две роли");
  check(!badName.ok && badName.code === "INVALID_ROLE", "имя с пробелом отклонено", `${badName.code} ${badName.message}`);

  const bound = await house("bind", "--role", "sprint", "--profile", profile, "--session-id", sessionId, "--participant-id", sessionId, "--label", "бэкенд-спринт", "--session-cwd", project);
  check(bound.ok, "bind с именем выполнен", bound.message);
  const boundConfig = JSON.parse(readFileSync(join(project, HOUSE_DIR_NAME, "house.json"), "utf8"));
  check(boundConfig.participants[0]?.label === "бэкенд-спринт", "имя сессии сохранено", String(boundConfig.participants[0]?.label));

  const rebound = await house("bind", "--role", "sprint", "--profile", profile, "--session-id", sessionId, "--participant-id", sessionId);
  const reboundConfig = JSON.parse(readFileSync(join(project, HOUSE_DIR_NAME, "house.json"), "utf8"));
  check(rebound.ok && reboundConfig.participants[0]?.label === "бэкенд-спринт", "повторный bind без имени не стирает имя", String(reboundConfig.participants[0]?.label));

  const status = await house("status", "--json");
  const statusText = formatStatus(status.data);
  check(statusText.includes("sprint (бэкенд-спринт): profile-a/0123abcd"), "статус печатает имя и короткий id", statusText.split("\n").at(-1));

  const broadcast = await house("send", "--role", "sprint", "--text", "всем");
  const broadcastHeader = String(broadcast.data?.block ?? "").split("\n")[0];
  check(broadcast.ok && !broadcastHeader.includes("→"), "send без адресата хвоста не пишет", broadcastHeader);

  const addressed = await house("send", "--role", "sprint", "--text", "одному", "--to", "designer");
  const addressedHeader = String(addressed.data?.block ?? "").split("\n")[0];
  check(addressed.ok && addressedHeader.endsWith("[sprint] → designer"), "адресат в заголовке", addressedHeader);
  check(JSON.stringify(addressed.data?.targets) === JSON.stringify(["designer"]), "адресаты в результате", JSON.stringify(addressed.data?.targets));

  const pair = await house("send", "--role", "sprint", "--text", "двоим", "--to", "designer, backend");
  check(String(pair.data?.block ?? "").split("\n")[0].endsWith("→ designer, backend"), "список адресатов через запятую", String(pair.data?.block ?? "").split("\n")[0]);

  const unknownTarget = await house("send", "--role", "sprint", "--text", "x", "--to", "Никто");
  check(!unknownTarget.ok && unknownTarget.code === "INVALID_ROLE", "неизвестный адресат отклонён", `${unknownTarget.code} ${unknownTarget.message}`);

  const selfTarget = await house("send", "--role", "sprint", "--text", "x", "--to", "sprint");
  check(!selfTarget.ok && selfTarget.code === "INVALID_ARGUMENTS", "адресат-автор отклонён", `${selfTarget.code} ${selfTarget.message}`);

  const emptyTarget = await house("send", "--role", "sprint", "--text", "x", "--to=");
  check(!emptyTarget.ok && emptyTarget.code === "INVALID_ARGUMENTS", "пустой --to отклонён", `${emptyTarget.code} ${emptyTarget.message}`);

  const renamed = await house("label", "--role", "sprint", "--label", "новое имя");
  check(renamed.ok, "label меняет имя", renamed.message);
  const renamedConfig = JSON.parse(readFileSync(join(project, HOUSE_DIR_NAME, "house.json"), "utf8"));
  check(renamedConfig.participants[0]?.label === "новое имя", "новое имя записано", String(renamedConfig.participants[0]?.label));

  const cleared = await house("label", "--role", "sprint", "--label=");
  const clearedConfig = JSON.parse(readFileSync(join(project, HOUSE_DIR_NAME, "house.json"), "utf8"));
  check(cleared.ok && clearedConfig.participants[0]?.label === undefined, "пустое имя снимает поле", String(clearedConfig.participants[0]?.label));

  const secondSession = "0123abcd-7777-8888-9999-000011112222";
  writeFileSync(
    join(project, HOUSE_DIR_NAME, "sessions.json"),
    JSON.stringify({ version: 1, sessions: [{ ...lease }, { ...lease, sessionId: secondSession }] }, null, 2),
    "utf8",
  );
  await house("bind", "--role", "sprint", "--profile", profile, "--session-id", secondSession, "--participant-id", secondSession);
  const mergedConfig = JSON.parse(readFileSync(join(project, HOUSE_DIR_NAME, "house.json"), "utf8"));
  check(mergedConfig.participants.filter((item) => item.role === "sprint").length === 1, "bind держит одну привязку на роль", JSON.stringify(mergedConfig.participants));
  // Защита label от неоднозначности проверяется на legacy-доме: bind уже не
  // оставляет двух привязок роли, а дом после сбоя выглядел именно так.
  mergedConfig.participants.push({ participantId: "sprint-legacy", role: "sprint", profile, sessionId });
  writeFileSync(join(project, HOUSE_DIR_NAME, "house.json"), JSON.stringify(mergedConfig, null, 2), "utf8");
  const ambiguous = await house("label", "--role", "sprint", "--label", "кто-то");
  check(!ambiguous.ok && ambiguous.code === "AMBIGUOUS_PARTICIPANT", "две привязки роли требуют --session-id", `${ambiguous.code} ${ambiguous.message}`);
  const targeted = await house("label", "--role", "sprint", "--label", "второе окно", "--session-id", secondSession);
  check(targeted.ok, "с --session-id имя меняется", targeted.message);

  const cleanProject = join(root, "clean");
  mkdirSync(cleanProject, { recursive: true });
  const cleanInit = await run(["init", "--scope", "project", "--cwd", cleanProject]);
  check(cleanInit.ok, "init без ролей выполняется", cleanInit.message);
  const cleanConfig = JSON.parse(readFileSync(join(cleanProject, HOUSE_DIR_NAME, "house.json"), "utf8"));
  check(Array.isArray(cleanConfig.roles) && cleanConfig.roles.length === 0, "дом без ролей создаётся пустым", JSON.stringify(cleanConfig.roles));
  const cleanRole = await run(["role-add", "--cwd", cleanProject, "--role", "spec"]);
  check(cleanRole.ok && cleanRole.data?.added === true, "первая роль добавляется в пустой дом", cleanRole.message);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `ПРОВАЛ: ${failed}` : "PASS: заголовки, роли, имена и статус");
process.exitCode = failed ? 1 : 0;
