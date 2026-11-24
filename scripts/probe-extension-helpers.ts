// Проба чистых помощников расширения (нужен Bun: он исполняет TypeScript без сборки).
//
// Расширение импортирует `../house/house.mjs`, то есть рассчитано на раскладку
// профиля (agent/extensions и agent/house рядом), а не на src/ репозитория.
// Поэтому проба собирает эту раскладку во временном каталоге и импортирует
// расширение оттуда: заодно проверяется, что путь импорта верный.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDir = mkdtempSync(join(tmpdir(), "house-helpers-"));
const extensionPath = join(agentDir, "extensions", "house.ts");
cpSync(join(repoRoot, "src", "extensions", "house.ts"), extensionPath);
for (const file of ["house.mjs", "house-lock.mjs", "courier.mjs"]) {
  cpSync(join(repoRoot, "src", file), join(agentDir, "house", file));
}
mkdirSync(join(agentDir, "hooks", "pre"), { recursive: true });
cpSync(join(repoRoot, "src", "hooks", "pre", "house-watch.ts"), join(agentDir, "hooks", "pre", "house-watch.ts"));

let failed = 0;
function check(condition: boolean, message: string, detail = "") {
  if (condition) {
    console.log(`OK   ${message}`);
    return;
  }
  failed += 1;
  console.log(`FAIL ${message}${detail ? `: ${detail}` : ""}`);
}

// Минимум, который расширение трогает в команде /house say: регистрация команды,
// события и отправка в окно. Больше фейку не нужно.
type FakeContext = {
  cwd: string;
  ui: { notify: (message: string, level?: string) => void; select: () => Promise<string>; askDialog: null };
  sessionManager: { getSessionId: () => string };
};

type FakeApi = {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  registerCommand: (name: string, definition: { handler: (args: string, ctx: FakeContext) => Promise<void> }) => void;
  sendUserMessage: (message: string, options?: { deliverAs?: string }) => void;
};

try {
  const helpers = await import(pathToFileURL(extensionPath).href);

  type Row = {
    profile: string;
    sessionId: string;
    candidateDescription: string;
    status: string;
    cwd: string;
    kind: string;
    startedAt?: string;
    title?: string | null;
  };

  const rows: Row[] = [
    { profile: "profile-a", sessionId: "cccccccc-3", candidateDescription: "третья", status: "active", cwd: "C:/p", kind: "interactive", startedAt: "2026-11-22T22:08:12.498Z", title: "EXEC" },
    { profile: "profile-a", sessionId: "aaaaaaaa-1", candidateDescription: "Привет", status: "active", cwd: "C:/p", kind: "interactive", startedAt: "2026-11-22T22:16:42.301Z", title: null },
    { profile: "profile-a", sessionId: "bbbbbbbb-2", candidateDescription: "Привет", status: "active", cwd: "C:/p", kind: "interactive", startedAt: "2026-11-22T22:16:45.956Z", title: "SUPRV" },
  ];

  const ordered = helpers.orderCandidates(rows);
  check(ordered.map((row: Row) => row.sessionId.slice(0, 1)).join("") === "cab", "сортировка по времени старта", ordered.map((row: Row) => row.sessionId).join(","));

  const labelSelf = helpers.candidateLabel(ordered[2], 3, "bbbbbbbb-2", false);
  check(labelSelf.includes("№3") && labelSelf.includes("bbbbbbbb") && labelSelf.includes("SUPRV"), "подпись: номер, id, заголовок", labelSelf);
  check(labelSelf.includes("← это окно"), "своё окно помечено", labelSelf);
  check(!helpers.candidateLabel(ordered[0], 1, "bbbbbbbb-2", false).includes("это окно"), "чужое окно без пометки");
  check(helpers.candidateLabel(ordered[0], 3, "eeeeeeee-9", true).includes("profile-a"), "профиль показывается при нескольких профилях");

  check(helpers.samePath("C:\\p\\", "c:/p"), "пути сравниваются без регистра и разделителя");
  check(!helpers.samePath("C:/p", "C:/p/sub"), "вложенный каталог это другой проект");

  check(helpers.roleNameError("sprint") === null, "обычное имя роли принято");
  check(helpers.roleNameError("две роли") !== null, "пробел отклонён");
  check(helpers.roleNameError("a".repeat(33)) !== null, "длинное имя отклонено");
  check(helpers.roleNameError("") !== null, "пустое имя отклонено");

  check(helpers.editDistance("desinger", "designer") === 2, "расстояние перестановки это 2", String(helpers.editDistance("desinger", "designer")));
  check(helpers.nearestRole("desinger", ["designer", "backend"]) === "designer", "опечатка в длинном имени найдена");
  check(helpers.nearestRole("designe", ["designer", "backend"]) === "designer", "одна правка найдена");
  check(helpers.nearestRole("spec", ["exec", "designer"]) === null, "две правки на коротком имени не считаются опечаткой");
  check(helpers.nearestRole("dve", ["designer"]) === null, "имя короче четырёх не проверяется");
  check(helpers.nearestRole("Sprint", ["sprint"]) === null, "совпадение без регистра не опечатка");

  const cfg = { roles: ["Supervisor", "Exec", "Spec"], signatures: {} };
  const toSupervisor = "## [2026-11-23T11:32:46+03:00] [Spec] → Supervisor\n\nтекст\n";
  check(helpers.latestIncoming(toSupervisor, "Exec", cfg, -1) === null, "чужой адресный блок не доставляется");
  check(helpers.latestIncoming(toSupervisor, "Supervisor", cfg, -1)?.sourceRole === "Spec", "свой адресный блок доставляется");
  const broadcastBlock = "## [2026-11-23T11:32:46+03:00] [Spec]\n\nтекст\n";
  check(helpers.latestIncoming(broadcastBlock, "Exec", cfg, -1)?.sourceRole === "Spec", "broadcast доставляется всем");
  const toBoth = "## [2026-11-23T11:40:00+03:00] [Spec] → Supervisor, Exec\n\nтекст\n";
  check(helpers.latestIncoming(toBoth, "Exec", cfg, -1)?.sourceRole === "Spec", "два адресата доставляются обоим");
  check(helpers.latestIncoming(toBoth, "Spec", cfg, -1) === null, "автор свой блок не получает");

  const watch = await import(pathToFileURL(join(agentDir, "hooks", "pre", "house-watch.ts")).href);
  const convDir = join(agentDir, "conv");
  mkdirSync(convDir, { recursive: true });
  const convPath = join(convDir, "переписка.md");
  writeFileSync(convPath, "## [2026-11-23T11:32:46+03:00] [Spec] → Supervisor\n\nтекст\n", "utf8");
  check(watch.lastPeerAddressedTo(convDir, cfg, "Exec", "Spec") === false, "чужой адресат снимает напоминание");
  check(watch.lastPeerAddressedTo(convDir, cfg, "Supervisor", "Spec") === true, "свой адресат оставляет напоминание");
  writeFileSync(convPath, "## [2026-11-23T11:32:46+03:00] [Spec]\n\nтекст\n", "utf8");
  check(watch.lastPeerAddressedTo(convDir, cfg, "Exec", "Spec") === true, "broadcast не снимает напоминание");
  rmSync(convPath, { force: true });
  check(watch.lastPeerAddressedTo(convDir, cfg, "Exec", "Spec") === true, "без переписки напоминание не подавляется");

  // /house say обязан слать participantId участника, а не id окна: после upsert
  // роли они расходятся (spec остаётся "spec"), и send ищет участие по id.
  const sayProject = join(agentDir, "say-project");
  const sayHouse = join(sayProject, ".house");
  mkdirSync(sayHouse, { recursive: true });
  writeFileSync(
    join(sayHouse, "house.json"),
    JSON.stringify(
      {
        version: 1,
        roles: ["spec", "exec"],
        signatures: { spec: "\\[spec\\]", exec: "\\[exec\\]" },
        participants: [
          { participantId: "spec", role: "spec", profile: "probe", sessionId: "session-uuid-1" },
          { participantId: "exec", role: "exec", profile: "probe", sessionId: "exec-session-2" },
        ],
        courier: { mode: "notify" },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  writeFileSync(
    join(sayHouse, "state.json"),
    JSON.stringify({ version: 1, updated: new Date().toISOString(), lastSentBy: {}, notified: {}, delivered: {}, deliveredBy: {}, autoTurns: {}, open: [] }, null, 2),
    "utf8",
  );
  writeFileSync(join(sayHouse, "переписка.md"), "# House\n\n", "utf8");

  const registered = new Map<string, { handler: (args: string, ctx: FakeContext) => Promise<void> }>();
  const sayNotices: string[] = [];
  const fakeApi: FakeApi = {
    on: () => {},
    registerCommand: (name, definition) => registered.set(name, definition),
    sendUserMessage: () => {},
  };
  helpers.default(fakeApi);
  const sayContext = {
    cwd: sayProject,
    ui: { notify: (message: string) => sayNotices.push(message), select: async () => "", askDialog: null },
    sessionManager: { getSessionId: () => "session-uuid-1" },
  };
  const houseCommand = registered.get("house");
  if (!houseCommand) throw new Error("команда /house не зарегистрирована");
  await houseCommand.handler("say Spec проверка participantId", sayContext);
  const sayState = JSON.parse(readFileSync(join(sayHouse, "state.json"), "utf8"));
  check(sayState.lastSentBy?.spec !== undefined, "say пишет метку под participantId из конфига", JSON.stringify(sayState.lastSentBy));
  check(sayState.lastSentBy?.["session-uuid-1"] === undefined, "say не использует id окна как participantId", JSON.stringify(sayState.lastSentBy));
  const sayConversation = readFileSync(join(sayHouse, "переписка.md"), "utf8");
  check(sayConversation.includes("[spec]\n\nпроверка participantId"), "say пишет блок от канонической роли", sayConversation.trim().split("\n").at(-1));
  check(sayNotices.some((message) => message.includes("Сообщение отправлено от роли spec")), "say сообщает об успехе", JSON.stringify(sayNotices));
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}

console.log(failed ? `ПРОВАЛ: ${failed}` : "PASS: нумерация, подписи, пути, роли, опечатки и say");
process.exit(failed ? 1 : 0);
