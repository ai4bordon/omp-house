// Проба позднего дома: окно открыто раньше .house, поллер должен подняться
// сам, без перезапуска окна. Два пути: таймер ожидания и любая команда /house.
//
// Нужен Bun. Раскладка профиля собирается во временном каталоге, потому что
// расширение импортирует ../house/house.mjs. Каждый сценарий получает свою копию
// расширения: переменные ожидания читаются при импорте модуля.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOUSE_DIR_NAME } from "../src/house-lock.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const created: string[] = [];

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

function buildLayout() {
  const agentDir = mkdtempSync(join(tmpdir(), "house-inbox-boot-"));
  created.push(agentDir);
  const extensionPath = join(agentDir, "extensions", "house.ts");
  mkdirSync(dirname(extensionPath), { recursive: true });
  cpSync(join(repoRoot, "src", "extensions", "house.ts"), extensionPath);
  mkdirSync(join(agentDir, "house"), { recursive: true });
  for (const file of ["house.mjs", "house-lock.mjs"]) {
    cpSync(join(repoRoot, "src", file), join(agentDir, "house", file));
  }
  const project = join(agentDir, "project");
  mkdirSync(project, { recursive: true });
  return { agentDir, extensionPath, project, houseDir: join(project, HOUSE_DIR_NAME) };
}

function writeHouse(houseDir: string, sessionId: string) {
  mkdirSync(houseDir, { recursive: true });
  writeFileSync(
    join(houseDir, "house.json"),
    JSON.stringify(
      {
        version: 1,
        roles: ["spec", "sup"],
        signatures: {},
        participants: [{ participantId: sessionId, role: "spec", profile: "profile-a", sessionId }],
        courier: { mode: "notify" },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(houseDir, "state.json"), JSON.stringify({ version: 1 }), "utf8");
  writeFileSync(join(houseDir, "переписка.md"), "## [2026-11-23T13:18:18+12:00] [sup]\n\nПоздний блок\n", "utf8");
}

function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const delivered: string[] = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, command);
    },
    registerTool: () => {},
    sendUserMessage: (text: string) => {
      delivered.push(text);
    },
  };
  return { handlers, commands, delivered, pi };
}

function fakeCtx(project: string, sessionId: string) {
  return { cwd: project, sessionManager: { getSessionId: () => sessionId } };
}

try {
  // Сценарий 1: дом появляется позже окна, поллер поднимает таймер ожидания.
  process.env.OMP_HOUSE_INBOX_POLL_MS = "150";
  process.env.OMP_HOUSE_BOOT_RETRY_MS = "100";
  const first = buildLayout();
  const firstPi = fakePi();
  const firstCtx = fakeCtx(first.project, "s1");
  const firstFactory = (await import(pathToFileURL(first.extensionPath).href)).default as (api: unknown) => void;
  firstFactory(firstPi.pi);

  await firstPi.handlers.get("session_start")?.({}, firstCtx);
  await sleep(300);
  check(firstPi.delivered.length === 0, "без дома доставки нет");

  writeHouse(first.houseDir, "s1");
  const booted = await waitFor(() => firstPi.delivered.length > 0, 2500);
  check(booted, "поллер поднялся по таймеру после появления дома", `доставок: ${firstPi.delivered.length}`);
  check(firstPi.delivered.some((text) => text.includes("Поздний блок")), "накопленный блок доставлен первым тиком");

  await firstPi.handlers.get("session_shutdown")?.({}, firstCtx);

  // Сценарий 2: ожидание дома выставлено на минуту, поэтому доставку может дать
  // только команда /house. setup создаёт дом внутри handle, значит проверка идёт
  // после обработки.
  process.env.OMP_HOUSE_BOOT_RETRY_MS = "60000";
  const second = buildLayout();
  const secondPi = fakePi();
  const secondCtx = fakeCtx(second.project, "s1");
  const secondFactory = (await import(pathToFileURL(second.extensionPath).href)).default as (api: unknown) => void;
  secondFactory(secondPi.pi);

  await secondPi.handlers.get("session_start")?.({}, secondCtx);
  const command = secondPi.commands.get("house");
  check(Boolean(command), "команда /house зарегистрирована");
  // Дом создаётся внутри handle, как это делает /house setup. Неизвестная команда
  // доходит до ctx.ui.notify и ничего больше не трогает, поэтому notify и служит
  // точкой создания дома.
  const uiCtx = { ...secondCtx, ui: { notify: () => writeHouse(second.houseDir, "s1") } };
  try {
    await command?.handler("nope", uiCtx);
  } catch {}

  const byCommand = await waitFor(() => secondPi.delivered.length > 0, 1500);
  check(byCommand, "команда /house подняла поллер сразу, без ожидания таймера", `доставок: ${secondPi.delivered.length}`);
  check(secondPi.delivered.some((text) => text.includes("Поздний блок")), "блок доставлен после команды");

  await secondPi.handlers.get("session_shutdown")?.({}, secondCtx);
} finally {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `ПРОВАЛ: ${failed}` : "PASS: поллер поднимается сам, по таймеру и по команде");
process.exit(failed ? 1 : 0);
