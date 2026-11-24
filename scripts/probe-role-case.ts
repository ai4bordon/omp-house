// Проба регистронезависимого ввода ролей (нужен Bun: он исполняет TypeScript без сборки).
//
// Проверяет то, что видит человек: `Spec` и `spec` это одна роль, а в переписку и
// house.json попадает каноническое написание из roles. Напоминалка обязана
// понимать адресата в другом регистре.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "../src/house.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "house-role-case-"));
const project = join(root, "project");
const houseDir = join(project, ".house");
const conversationPath = join(houseDir, "переписка.md");
let failed = 0;

function check(condition: boolean, message: string, detail = "") {
  if (condition) {
    console.log(`OK   ${message}`);
    return;
  }
  failed += 1;
  console.log(`FAIL ${message}${detail ? `: ${detail}` : ""}`);
}

function house(...args: string[]) {
  return run([...args, "--cwd", project]);
}

const config = {
  version: 1,
  roles: ["spec", "supervisor", "exec"],
  signatures: {
    spec: "\\[spec\\]",
    supervisor: "\\[supervisor\\]",
    exec: "\\[exec\\]",
  },
  participants: [{ participantId: "s1", role: "spec", profile: "probe", sessionId: "s1" }],
  courier: { mode: "notify", profile: "probe" },
  // auto не требует живого окна: bind проходит без lease в sessions.json.
  perRole: { spec: { mode: "auto" }, supervisor: { mode: "auto" } },
};

try {
  mkdirSync(houseDir, { recursive: true });
  writeFileSync(join(houseDir, "house.json"), JSON.stringify(config, null, 2), "utf8");
  writeFileSync(join(houseDir, "переписка.md"), "# House\n\n", "utf8");
  writeFileSync(
    join(houseDir, "state.json"),
    JSON.stringify({ version: 1, updated: new Date().toISOString(), lastSentBy: {}, notified: {}, delivered: {}, deliveredBy: {}, autoTurns: {}, open: [] }, null, 2),
    "utf8",
  );
  writeFileSync(join(houseDir, "sessions.json"), JSON.stringify({ version: 1, sessions: [] }, null, 2), "utf8");

  // bind канонизирует роль до participantId по умолчанию и пишет написание из roles.
  const bound = await house("bind", "--role", "SPEC", "--profile", "probe", "--session-id", "s1", "--participant-id", "s1", "--allow-other-session");
  check(bound.ok, "bind принимает роль в другом регистре", `${bound.code} ${bound.message}`);
  const afterBind = JSON.parse(readFileSync(join(houseDir, "house.json"), "utf8"));
  check(afterBind.participants[0]?.role === "spec", "bind сохраняет каноническое имя роли", String(afterBind.participants[0]?.role));

  const sent = await house("send", "--role", "Spec", "--to", "Supervisor", "--text", "привет");
  check(sent.ok, "send принимает роль и адресата в другом регистре", `${sent.code} ${sent.message}`);
  const conversation = readFileSync(conversationPath, "utf8");
  check(conversation.includes("[spec]"), "в заголовке канонический автор [spec]");
  check(conversation.includes("→ supervisor"), "в заголовке канонический адресат → supervisor");

  const labeled = await house("label", "--role", "Spec", "--label", "Spec One");
  check(labeled.ok, "label находит привязку по роли в другом регистре", `${labeled.code} ${labeled.message}`);
  const afterLabel = JSON.parse(readFileSync(join(houseDir, "house.json"), "utf8"));
  check(afterLabel.participants[0]?.label === "Spec One", "label записал имя", String(afterLabel.participants[0]?.label));

  const unknown = await house("send", "--role", "Nope", "--text", "x");
  check(!unknown.ok && unknown.code === "INVALID_ROLE", "неизвестная роль даёт INVALID_ROLE", `${unknown.code} ${unknown.message}`);
  check(String(unknown.message).includes("Nope"), "ошибка называет введённое значение", String(unknown.message));

  // Напоминалка: хук берёт тот же house-lock.mjs, поэтому раскладка профиля рядом.
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "hooks", "pre"), { recursive: true });
  mkdirSync(join(agentDir, "house"), { recursive: true });
  writeFileSync(join(agentDir, "house", "house-lock.mjs"), readFileSync(join(repoRoot, "src", "house-lock.mjs"), "utf8"), "utf8");
  writeFileSync(join(agentDir, "hooks", "pre", "house-watch.ts"), readFileSync(join(repoRoot, "src", "hooks", "pre", "house-watch.ts"), "utf8"), "utf8");
  // Статический импорт невозможен: хук лежит во временной раскладке профиля,
  // путь известен только во время прогона.
  const watch = await import(pathToFileURL(join(agentDir, "hooks", "pre", "house-watch.ts")).href);

  writeFileSync(conversationPath, "## [2026-11-23T11:00:00+03:00] [supervisor] → Spec\n\nтекст\n", "utf8");
  check(watch.lastPeerAddressedTo(houseDir, config, "spec", "supervisor") === true, "адресат Spec узнан ролью spec");
  writeFileSync(conversationPath, "## [2026-11-23T11:00:00+03:00] [supervisor] → exec\n\nтекст\n", "utf8");
  check(watch.lastPeerAddressedTo(houseDir, config, "spec", "supervisor") === false, "чужой адресат exec снимает напоминание");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `ПРОВАЛ: ${failed}` : "PASS: регистр ролей, привязка, имя и напоминание");
process.exitCode = failed ? 1 : 0;