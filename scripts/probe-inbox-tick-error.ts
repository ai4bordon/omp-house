// Проба строки ошибки в тике поллера и регистра в адресации блоков.
//
// Ошибка в тике раньше не попадала в logs/inbox.log: `const ownRole` был объявлен
// внутри try, а catch ссылался на него из другой области видимости и падал с
// ReferenceError ещё до записи строки. Проба заставляет первый вызов
// sendUserMessage бросить `boom` и проверяет, что в логе есть `error spec: boom`,
// а окно продолжает тикать и доставляет тот же блок следующим тиком ровно раз.
//
// Адресный блок `[SPEC] → Supervisor` проверяет сравнение ролей без
// регистра: адресат `Supervisor` должен совпасть с ownRole `supervisor`, иначе
// `targets.includes(ownRole)` блок отвергал. Окно exec не получает ни один из
// адресных блоков.
//
// Внимание к постановке: блок `[SPEC] → Supervisor` не может прийти окну с ролью
// spec: он написан самим spec и адресован supervisor. Поэтому путь ошибки для
// spec проверяется на блоке `[Supervisor] → SPEC` (том же по смыслу: чужой автор,
// адресат в другом регистре), а литеральный блок из задания доставляется окну
// supervisor. Проверка `latestIncoming` ниже фиксирует оба факта.
//
// Нужен Bun. Раскладка профиля собирается во временном каталоге, потому что
// расширение импортирует ../house/house.mjs.
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const STAMP_SUPERVISOR = "2026-11-23T17:04:56+12:00";
const STAMP_SPEC = "2026-11-23T17:05:10+12:00";
const BODY_SUPERVISOR = "ТЕЛО блока [SPEC] → Supervisor, проба строки ошибки";
const BODY_SPEC = "ТЕЛО блока [Supervisor] → SPEC, проба строки ошибки";
const SESSION_SPEC = "01a206bf-4fb2-77ea-83c0-5b3f27d348ac";
const SESSION_SUPERVISOR = "01a206bf-3032-7422-910e-558c26d21812";
const SESSION_EXEC = "01a206bf-7022-77ad-aa47-4e36037f797e";

function buildLayout() {
  const agentDir = mkdtempSync(join(tmpdir(), "house-inbox-tick-error-"));
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
  return { agentDir, extensionPath, project, houseDir: join(project, ".house") };
}

function participant(role: string, sessionId: string) {
  return { participantId: sessionId, role, profile: "profile-a", sessionId };
}

function configFor(participants: unknown[], roles = ["spec", "supervisor"]) {
  return {
    version: 1,
    roles,
    signatures: {
      spec: "\\[spec\\]",
      supervisor: "\\[supervisor\\]",
      ...(roles.includes("exec") ? { exec: "\\[exec\\]" } : {}),
    },
    participants,
    courier: { mode: "notify" },
  };
}

function writeHouse(houseDir: string, participants: unknown[], roles = ["spec", "supervisor"]) {
  mkdirSync(houseDir, { recursive: true });
  writeFileSync(join(houseDir, "house.json"), JSON.stringify(configFor(participants, roles), null, 2), "utf8");
  writeFileSync(join(houseDir, "state.json"), JSON.stringify({ version: 1 }, null, 2), "utf8");
  writeFileSync(
    join(houseDir, "переписка.md"),
    ["# House", "", `## [${STAMP_SUPERVISOR}] [SPEC] → Supervisor`, "", BODY_SUPERVISOR, ""].join("\n"),
    "utf8",
  );
}

// Второй блок нужен только для пути ошибки окна spec: литеральный блок написан
// самим spec и адресован supervisor, поэтому spec его не получает.
function appendSpecBlock(houseDir: string) {
  appendFileSync(
    join(houseDir, "переписка.md"),
    [`## [${STAMP_SPEC}] [Supervisor] → SPEC`, "", BODY_SPEC, ""].join("\n"),
    "utf8",
  );
}

// Первый вызов бросает ровно один раз: тик ловит ошибку, следующий тик обязан
// доставить тот же блок. Записываются только успешные тексты.
function fakePi(throwFirst: boolean) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const delivered: string[] = [];
  let calls = 0;
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: () => {},
    registerTool: () => {},
    sendUserMessage: (text: string) => {
      calls += 1;
      if (throwFirst && calls === 1) throw new Error("boom");
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
  writeHouse(layout.houseDir, [participant("spec", SESSION_SPEC), participant("supervisor", SESSION_SUPERVISOR)]);

  const extension = (await import(pathToFileURL(layout.extensionPath).href)) as {
    default: (api: unknown) => void;
    latestIncoming: (
      text: string,
      ownRole: string,
      config: unknown,
      handledMs: number,
    ) => { sourceRole: string; stamp: string; raw: string } | null;
  };
  const factory = extension.default;
  const config = configFor([participant("spec", SESSION_SPEC), participant("supervisor", SESSION_SUPERVISOR)]);

  // Прямая проверка контракта адресации: автор [SPEC] в другом регистре,
  // адресат Supervisor в другом регистре. spec: автор, свой блок не получает;
  // supervisor получает; exec не получает.
  const supersBlock = `## [${STAMP_SUPERVISOR}] [SPEC] → Supervisor\n\n${BODY_SUPERVISOR}\n`;
  const specBlock = `## [${STAMP_SPEC}] [Supervisor] → SPEC\n\n${BODY_SPEC}\n`;
  check(extension.latestIncoming(supersBlock, "supervisor", config, -1)?.sourceRole === "spec", "latestIncoming: [SPEC] виден supervisor как spec");
  check(extension.latestIncoming(supersBlock, "spec", config, -1) === null, "latestIncoming: свой блок [SPEC] автору spec не доставляется");
  check(extension.latestIncoming(supersBlock, "exec", config, -1) === null, "latestIncoming: адресат Supervisor не виден exec");
  check(extension.latestIncoming(specBlock, "spec", config, -1)?.sourceRole === "supervisor", "latestIncoming: адресат SPEC виден spec без учёта регистра");
  check(extension.latestIncoming(specBlock, "exec", config, -1) === null, "latestIncoming: адресат SPEC не виден exec");
  // Своя роль в другом регистре: старый `role !== ownRole` считал `spec` и `SPEC`
  // разными ролями и доставлял окну его собственный блок; sameRole исключает.
  const ownCaseBlock = `## [${STAMP_SUPERVISOR}] [SPEC]\n\n${BODY_SUPERVISOR}\n`;
  check(extension.latestIncoming(ownCaseBlock, "SPEC", config, -1) === null, "latestIncoming: собственный блок [SPEC] не доставляется роли SPEC");

  // Литеральный блок задания: [SPEC] → Supervisor доставляется окну supervisor
  // благодаря сравнению адресата без регистра.
  const supervisor = fakePi(false);
  factory(supervisor.pi);
  await supervisor.handlers.get("session_start")?.({}, fakeCtx(layout.project, SESSION_SUPERVISOR));

  const supervisorDelivered = await waitFor(() => supervisor.delivered.length > 0, 5000);
  check(supervisorDelivered, "окно supervisor получает блок [SPEC] → Supervisor", `доставок: ${supervisor.delivered.length}`);
  check(supervisor.delivered[0]?.includes(BODY_SUPERVISOR) === true, "тело блока [SPEC] → Supervisor доставлено");
  check(supervisor.delivered[0]?.includes("`spec`") === true, "автор [SPEC] распознан как spec");
  check(supervisor.delivered[0]?.includes("/house say supervisor") === true, "окно supervisor подписано своей ролью");
  check(
    await waitFor(
      () => inboxLines(layout.houseDir).some((line) => line.includes(`delivered spec ${STAMP_SUPERVISOR} → supervisor`)),
      2000,
    ),
    "в inbox.log есть строка доставки блока supervisor",
    JSON.stringify(inboxLines(layout.houseDir)),
  );

  // Второй блок написан supervisor и адресован SPEC: он даёт окну spec путь
  // ошибки, потому что литеральный блок spec не получает.
  appendSpecBlock(layout.houseDir);

  // Окно spec: первый sendUserMessage бросает boom. Строка ошибки должна попасть
  // в лог с ролью, а следующий тик должен доставить тот же блок ровно один раз.
  const spec = fakePi(true);
  factory(spec.pi);
  await spec.handlers.get("session_start")?.({}, fakeCtx(layout.project, SESSION_SPEC));

  const logged = await waitFor(
    () => inboxLines(layout.houseDir).some((line) => line.includes("error spec: boom")),
    5000,
  );
  check(logged, "тик после boom пишет в logs/inbox.log строку error spec: boom", JSON.stringify(inboxLines(layout.houseDir)));
  check(
    !inboxLines(layout.houseDir).some((line) => line.includes("ReferenceError")),
    "в логе нет ReferenceError из catch",
  );

  const specDelivered = await waitFor(() => spec.delivered.length > 0, 5000);
  check(specDelivered, "окно spec живо и доставляет блок следующим тиком", `доставок: ${spec.delivered.length}`);
  check(spec.delivered[0]?.includes(BODY_SPEC) === true, "текст доставки содержит тело блока [Supervisor] → SPEC");
  check(spec.delivered[0]?.includes("`supervisor`") === true, "блок пришёл как сообщение от supervisor");
  check(spec.delivered[0]?.includes("/house say spec") === true, "окно подписано своей ролью spec");
  check(
    await waitFor(
      () => inboxLines(layout.houseDir).some((line) => line.includes(`delivered supervisor ${STAMP_SPEC} → spec`)),
      2000,
    ),
    "в inbox.log есть строка доставки блока spec",
    JSON.stringify(inboxLines(layout.houseDir)),
  );

  // Курсор сдвинулся: повторных вставок нет ни у одного окна.
  await sleep(500);
  check(spec.delivered.length === 1, "после сдвига курсора spec не получает блок повторно", `доставок: ${spec.delivered.length}`);
  check(supervisor.delivered.length === 1, "после сдвига курсора supervisor не получает блок повторно", `доставок: ${supervisor.delivered.length}`);
  check(
    spec.delivered.filter((text) => text.includes(BODY_SPEC)).length === 1,
    "тело блока spec вставлено ровно один раз",
  );
  check(
    supervisor.delivered.filter((text) => text.includes(BODY_SUPERVISOR)).length === 1,
    "тело блока supervisor вставлено ровно один раз",
  );

  // Второе окно на том же доме: роль exec не адресат ни одного блока.
  const withExec = [
    participant("spec", SESSION_SPEC),
    participant("supervisor", SESSION_SUPERVISOR),
    participant("exec", SESSION_EXEC),
  ];
  writeHouse(layout.houseDir, withExec, ["spec", "supervisor", "exec"]);
  const exec = fakePi(false);
  factory(exec.pi);
  await exec.handlers.get("session_start")?.({}, fakeCtx(layout.project, SESSION_EXEC));
  await sleep(600);
  check(exec.delivered.length === 0, "окно exec не получает адресные блоки", `доставок: ${exec.delivered.length}`);
  check(
    !inboxLines(layout.houseDir).some((line) => line.includes("→ exec")),
    "в inbox.log нет доставки в exec",
    JSON.stringify(inboxLines(layout.houseDir)),
  );

  await spec.handlers.get("session_shutdown")?.({}, fakeCtx(layout.project, SESSION_SPEC));
  await supervisor.handlers.get("session_shutdown")?.({}, fakeCtx(layout.project, SESSION_SUPERVISOR));
  await exec.handlers.get("session_shutdown")?.({}, fakeCtx(layout.project, SESSION_EXEC));
} finally {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
}

console.log(
  failed
    ? `ПРОВАЛ: ${failed}`
    : "PASS: ошибка тика логируется, блок доставляется следующим тиком один раз, регистр адресата учтён",
);
process.exit(failed ? 1 : 0);
