// Проба двойной строки в logs/inbox.log на живом доме 2026-11-23.
//
// Живая картина: два тика доставки одного блока spec в supervisor, 05:04:57.786Z
// и 05:05:10.595Z, при одной вставке в сессии supervisor. Дом в тот момент
// перепривязывался: supervisor висел на окне exec, потом роль ушла на своё окно.
//
// Проба повторяет эту последовательность двумя окнами (два независимых экземпляра
// расширения, у каждого свой поллер) и проверяет: строк в inbox.log две, вставка
// в каждое окно одна, в окно supervisor тело блока приходит ровно один раз.
// Второй блок проверок показывает, что именно отметка deliveredBy не даёт тому же
// окну доставить блок повторно после session_switch.
//
// Нужен Bun. Раскладка профиля собирается во временном каталоге, потому что
// расширение импортирует ../house/house.mjs.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    await sleep(20);
  }
  return predicate();
}

const STAMP = "2026-11-23T17:04:56+12:00";
const BODY = "ТЕЛО блока spec, проба дубля доставки";
const WINDOW_A = "01a206bf-3032-7422-910e-558c26d21812";
const WINDOW_B = "01a206bf-7022-77ad-aa47-4e36037f797e";
const WINDOW_SPEC = "01a206bf-4fb2-77ea-83c0-5b3f27d348ac";

function buildLayout() {
  const agentDir = mkdtempSync(join(tmpdir(), "house-inbox-dup-"));
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

function participant(role: string, sessionId: string) {
  return { participantId: role, role, profile: "profile-a", sessionId };
}

// Переписка и привязки переписываются между шагами: живой дом переписывали
// командами bind между двумя доставками.
function writeHouse(houseDir: string, participants: unknown[]) {
  mkdirSync(houseDir, { recursive: true });
  writeFileSync(
    join(houseDir, "house.json"),
    JSON.stringify(
      {
        version: 1,
        roles: ["supervisor", "spec", "exec"],
        signatures: { supervisor: "\\[supervisor\\]", spec: "\\[spec\\]", exec: "\\[exec\\]" },
        participants,
        courier: { mode: "notify" },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(houseDir, "state.json"), JSON.stringify({ version: 1 }, null, 2), "utf8");
  writeFileSync(
    join(houseDir, "переписка.md"),
    ["# House", "", `## [${STAMP}] [spec]`, "", BODY, "", "[spec]", ""].join("\n"),
    "utf8",
  );
}

function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const delivered: string[] = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: () => {},
    registerTool: () => {},
    sendUserMessage: (text: string) => {
      delivered.push(text);
    },
  };
  return { handlers, delivered, pi };
}

function fakeCtx(project: string, sessionId: string) {
  return { cwd: project, sessionManager: { getSessionId: () => sessionId } };
}

function inboxLines(houseDir: string): string[] {
  try {
    return readFileSync(join(houseDir, "logs", "inbox.log"), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

process.env.OMP_HOUSE_INBOX_POLL_MS = "120";
process.env.OMP_HOUSE_BOOT_RETRY_MS = "60000";

try {
  const layout = buildLayout();

  // Состояние дома в 05:04:55Z живого прогона: supervisor и exec висят на одном
  // окне A, у spec своё окно. Поллер A берёт первое совпадение по sessionId
  // (house.ts:439).
  writeHouse(layout.houseDir, [participant("supervisor", WINDOW_A), participant("spec", WINDOW_SPEC), participant("exec", WINDOW_A)]);

  // Динамический импорт неизбежен: путь расширения лежит во временной раскладке
  // профиля и известен только во время прогона, статический импорт его не видит.
  const factory = (await import(pathToFileURL(layout.extensionPath).href)).default as (api: unknown) => void;

  const a = fakePi();
  factory(a.pi);
  await a.handlers.get("session_start")?.({}, fakeCtx(layout.project, WINDOW_A));
  const aFirst = await waitFor(() => a.delivered.length > 0, 2000);
  check(aFirst, "окно A доставило блок первым тиком", `доставок: ${a.delivered.length}`);
  check(a.delivered[0]?.includes("`spec`") === true, "блок пришёл как сообщение от spec");
  check(a.delivered[0]?.includes(BODY) === true, "тело блока в окне A");
  // При двух ролях на одной сессии ownRole это первое совпадение, то есть supervisor.
  check(
    a.delivered[0]?.includes("/house say supervisor") === true,
    "окно с двумя ролями пишет блок от имени supervisor (первое совпадение по sessionId)",
  );
  const afterAReady = await waitFor(
    () => inboxLines(layout.houseDir).filter((line) => line.includes("delivered spec")).length === 1,
    2000,
  );
  const afterA = inboxLines(layout.houseDir).filter((line) => line.includes("delivered spec"));
  check(afterAReady && afterA[0]?.includes("→ supervisor") === true, "в inbox.log одна строка → supervisor", JSON.stringify(afterA));

  // Живая перепривязка в 05:05:04Z: supervisor уходит на своё окно B, exec остаётся на A.
  writeHouse(layout.houseDir, [participant("supervisor", WINDOW_B), participant("spec", WINDOW_A), participant("exec", WINDOW_A)]);

  const b = fakePi();
  factory(b.pi);
  await b.handlers.get("session_start")?.({}, fakeCtx(layout.project, WINDOW_B));
  const bFirst = await waitFor(() => b.delivered.length > 0, 2000);
  check(bFirst, "окно B (настоящий supervisor) доставило накопленный блок", `доставок: ${b.delivered.length}`);

  const bothReady = await waitFor(
    () => inboxLines(layout.houseDir).filter((line) => line.includes("delivered spec")).length === 2,
    2000,
  );
  const both = inboxLines(layout.houseDir).filter((line) => line.includes("delivered spec"));
  check(bothReady && both.length === 2, "в inbox.log две строки доставки одного блока, как в живом доме", JSON.stringify(both));
  check(both.every((line) => line.includes("→ supervisor")) === true, "обе строки подписаны → supervisor");
  check(a.delivered.length === 1 && b.delivered.length === 1, "каждое окно получило блок ровно один раз", `A: ${a.delivered.length}, B: ${b.delivered.length}`);
  check(
    b.delivered.filter((text) => text.includes(BODY)).length === 1,
    "у окна supervisor тело блока ровно один раз",
  );

  // Дальше проверяем, что то же окно не доставляет повторно: курсор и отметка.
  await sleep(400);
  check(b.delivered.length === 1, "следующие тики окна B повторной доставки не дают", `доставок: ${b.delivered.length}`);

  await b.handlers.get("session_switch")?.({}, fakeCtx(layout.project, WINDOW_B));
  await sleep(400);
  check(b.delivered.length === 1, "session_switch с сохранённым deliveredBy не доставляет повторно", `доставок: ${b.delivered.length}`);

  // А вот потеря отметки deliveredBy даёт реальный дубль в том же окне. Значит,
  // в живом доме дубля не было именно потому, что отметка от 05:05:10.595Z дошла
  // до state.json: следующий перезапуск поллера её видел.
  const statePath = join(layout.houseDir, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { deliveredBy?: Record<string, string> };
  check(state.deliveredBy?.[WINDOW_B] === STAMP, "state.json хранит отметку доставки окна B", JSON.stringify(state.deliveredBy));
  delete state.deliveredBy?.[WINDOW_B];
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  await b.handlers.get("session_switch")?.({}, fakeCtx(layout.project, WINDOW_B));
  const repeated = await waitFor(() => b.delivered.length > 1, 1500);
  check(repeated, "без отметки deliveredBy то же окно доставляет блок второй раз (шов H2)");
  check(
    b.delivered.filter((text) => text.includes(BODY)).length === 2,
    "в этом случае в одном окне действительно два тела блока",
  );

  await a.handlers.get("session_shutdown")?.({}, fakeCtx(layout.project, WINDOW_A));
  await b.handlers.get("session_shutdown")?.({}, fakeCtx(layout.project, WINDOW_B));
} finally {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `ПРОВАЛ: ${failed}` : "PASS: дубль строки это два окна, повторной доставки в одно окно нет");
process.exit(failed ? 1 : 0);
