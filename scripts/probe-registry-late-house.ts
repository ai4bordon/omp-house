// Проба реестра на позднем доме: окно открыто раньше .house и не делает
// ни одного хода после его появления, но обязано попасть в sessions.json, иначе
// /house setup его не покажет.
//
// Нужен Bun: раскладка профиля собирается во временном каталоге, хук импортирует
// ../../house/house-lock.mjs.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOUSE_DIR_NAME } from "../src/house-lock.mjs";

process.env.OMP_HOUSE_REGISTRY_RETRY_MS = "100";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDir = mkdtempSync(join(tmpdir(), "house-registry-late-"));
mkdirSync(join(agentDir, "hooks", "pre"), { recursive: true });
mkdirSync(join(agentDir, "house"), { recursive: true });
const hookPath = join(agentDir, "hooks", "pre", "house-session-registry.ts");
cpSync(join(repoRoot, "src", "hooks", "pre", "house-session-registry.ts"), hookPath);
cpSync(join(repoRoot, "src", "house-lock.mjs"), join(agentDir, "house", "house-lock.mjs"));

const project = join(agentDir, "project");
mkdirSync(project, { recursive: true });
const houseDir = join(project, HOUSE_DIR_NAME);
const sessionsPath = join(houseDir, "sessions.json");

let failed = 0;
const check = (condition: boolean, message: string, detail = "") => {
  if (condition) {
    console.log(`OK   ${message}`);
    return;
  }
  failed += 1;
  console.log(`FAIL ${message}${detail ? `: ${detail}` : ""}`);
};

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

try {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: () => {},
    registerTool: () => {},
  };
  const ctx = {
    cwd: project,
    sessionManager: {
      getSessionId: () => "late-1",
      getCwd: () => project,
      getSessionFile: () => join(project, "session.jsonl"),
      getSessionName: () => undefined,
      getEntries: () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: "Ты спек" }] } }],
    },
  };

  const factory = (await import(pathToFileURL(hookPath).href)).default as (api: unknown) => void;
  factory(pi);

  await handlers.get("session_start")?.({}, ctx);
  await sleep(250);
  check(!existsSync(sessionsPath), "без дома реестр не пишется");

  mkdirSync(houseDir, { recursive: true });
  writeFileSync(
    join(houseDir, "house.json"),
    JSON.stringify({ version: 1, roles: ["spec"], signatures: {}, participants: [], courier: { mode: "notify" } }, null, 2),
    "utf8",
  );

  const appeared = await waitFor(() => existsSync(sessionsPath), 2500);
  check(appeared, "дом появился позже, реестр записался сам", `файл: ${sessionsPath}`);
  const sessions = appeared ? JSON.parse(readFileSync(sessionsPath, "utf8")).sessions ?? [] : [];
  const lease = sessions.find((entry: { sessionId?: string }) => entry.sessionId === "late-1");
  check(Boolean(lease), "окно без хода после дома попало в реестр");
  check(lease?.candidateDescription === "Ты спек", "описание из файла сессии", String(lease?.candidateDescription));

  await handlers.get("session_shutdown")?.({}, ctx);
  await sleep(100);
  const remaining = existsSync(sessionsPath) ? JSON.parse(readFileSync(sessionsPath, "utf8")).sessions ?? [] : [];
  check(!remaining.some((entry: { sessionId?: string }) => entry.sessionId === "late-1"), "закрытие окна снимает запись");
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}

console.log(failed ? `ПРОВАЛ: ${failed}` : "PASS: реестр поднимается на позднем доме");
process.exit(failed ? 1 : 0);
