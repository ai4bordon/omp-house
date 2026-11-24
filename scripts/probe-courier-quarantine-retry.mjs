// Проба курьера: карантин без .tmp, пауза по исходу последней auto-попытки и
// регистр в разборе заголовков. Импорт courier.mjs не поднимает процесс: main под isMain.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestIncoming, processParticipant, quarantineCopy } from "../src/courier.mjs";

let failed = 0;
function check(condition, message, detail = "") {
  if (condition) {
    console.log(`OK   ${message}`);
    return;
  }
  failed += 1;
  console.log(`FAIL ${message}${detail ? `: ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const roots = [];
function makeTemp(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

function findTempFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...findTempFiles(path));
    else if (entry.name.endsWith(".tmp")) found.push(path);
  }
  return found;
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function quarantineCase() {
  const houseDir = makeTemp("house-quarantine-");
  const content = "## [2026-11-23T10:00:00+03:00] [spec]\n\nтекст\n";
  const target = quarantineCopy(houseDir, "переписка.md", content);
  check(existsSync(target), "quarantineCopy создаёт файл копии", target);
  check(readFileSync(target, "utf8") === content, "quarantineCopy сохраняет содержимое");
  check(target.startsWith(join(houseDir, "quarantine")), "копия лежит в quarantine/", target);
  const temporary = findTempFiles(houseDir);
  check(temporary.length === 0, "quarantineCopy не оставляет .tmp", temporary.join(", "));
}

async function retryCase() {
  const houseDir = makeTemp("house-courier-retry-");
  const conversation = join(houseDir, "переписка.md");
  const stateFile = join(houseDir, "state.json");
  const participant = { participantId: "backend", role: "backend", profile: "probe" };
  const config = {
    roles: ["spec", "supervisor", "exec"],
    participants: [participant],
    perRole: { backend: { mode: "auto" } },
    courier: { mode: "notify", profile: "probe", cooldownMs: 400, retryMs: 20, timeoutMs: 5000 },
  };
  writeFileSync(join(houseDir, "house.json"), JSON.stringify(config, null, 2), "utf8");
  writeFileSync(conversation, "", "utf8");
  writeFileSync(
    stateFile,
    JSON.stringify({ version: 1, lastSentBy: {}, notified: {}, delivered: {}, deliveredBy: {}, open: [] }, null, 2),
    "utf8",
  );

  const calls = [];
  const successSpawn = async (dir, _config, current, _incoming, stamp) => {
    calls.push({ ok: true, stamp });
    appendFileSync(
      join(dir, "переписка.md"),
      `## [${stamp}] ОТ КУРЬЕРА → ${current.role}\nдоставлено\n[курьер (авто)]\n`,
      "utf8",
    );
    return { ok: true, code: 0 };
  };
  const failingSpawn = async () => {
    calls.push({ ok: false });
    return { ok: false, error: "boom" };
  };

  // state.json перечитывается перед каждым вызовом, как это делает tick.
  // markState пишет только файл: один и тот же объект state оставил бы delivered
  // пустым, и старый код тоже пошёл бы по retryMs, проба дала бы ложный зелёный.
  const readState = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const appendIncoming = (stamp, body) => {
    appendFileSync(conversation, `## [${stamp}] [supervisor]\n\n${body}\n`, "utf8");
  };
  const call = (spawn) =>
    processParticipant(houseDir, config, participant, readFileSync(conversation, "utf8"), readState(), new Set(), spawn);

  appendIncoming("2026-11-23T10:00:00+03:00", "первый входящий");
  const first = await call(successSpawn);
  check(first.ok === true && !first.skipped, "первый успешный вызов доставляет", JSON.stringify(first));

  await sleep(450);
  appendIncoming("2026-11-23T11:00:00+03:00", "второй входящий");
  const second = await call(failingSpawn);
  check(second.ok === false && second.error === "boom", "падающий spawn возвращает boom", JSON.stringify(second));

  await sleep(40);
  appendIncoming("2026-11-23T12:00:00+03:00", "третий входящий");
  const courierBlocksBefore = countOccurrences(readFileSync(conversation, "utf8"), "ОТ КУРЬЕРА");
  const third = await call(successSpawn);
  check(
    !(third.skipped === true && third.reason === "cooldown"),
    "третий вызов проходит по retryMs, а не по cooldown",
    JSON.stringify(third),
  );
  check(third.ok === true && !third.skipped, "третий вызов доставляет", JSON.stringify(third));
  const courierBlocksAfter = countOccurrences(readFileSync(conversation, "utf8"), "ОТ КУРЬЕРА");
  check(
    courierBlocksAfter === courierBlocksBefore + 1,
    "третий вызов дописал новый блок курьера",
    `${courierBlocksBefore} → ${courierBlocksAfter}`,
  );
  check(calls.length === 3, "spawn вызывался три раза", String(calls.length));
}

function incomingCase() {
  const config = { roles: ["spec", "supervisor", "exec"] };
  const text = "## [2026-11-23T11:32:46+03:00] [SPEC] → Supervisor\n\nтекст\n";
  const incomingFor = (role) => latestIncoming(text, { participantId: role, role }, config, {});

  // Блок адресован Supervisor, автор [SPEC]. Автору собственный блок не
  // приходит: latestIncoming отбрасывает собственную роль ещё до проверки
  // адреса. Регистр проверяется на адресате: [SPEC] даёт sourceRole "spec",
  // а "Supervisor" в заголовке совпадает с ролью "supervisor".
  const addressee = incomingFor("supervisor");
  check(
    addressee?.sourceRole === "spec",
    "курьер: [SPEC] распознан автором spec, адресат Supervisor доходит до supervisor",
    JSON.stringify(addressee?.sourceRole ?? null),
  );
  check(incomingFor("exec") === null, "курьер: адресный блок не доходит до exec");
  check(incomingFor("spec") === null, "курьер: автор не получает собственный блок");
}

try {
  quarantineCase();
  await retryCase();
  incomingCase();
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `ПРОВАЛ: ${failed}` : "PASS: карантин, пауза и регистр курьера");
process.exitCode = failed ? 1 : 0;
