// Проба адресации в курьере. Импорт courier.mjs не поднимает процесс: main под isMain.
import { latestIncoming } from "../src/courier.mjs";

let failed = 0;
function check(condition, message, detail = "") {
  if (condition) {
    console.log(`OK   ${message}`);
    return;
  }
  failed += 1;
  console.log(`FAIL ${message}${detail ? `: ${detail}` : ""}`);
}

const config = { roles: ["Supervisor", "Exec", "Spec"], signatures: {} };
const state = {};
const participant = (role) => ({ role, participantId: role });

const toSupervisor = "## [2026-11-23T11:32:46+03:00] [Spec] → Supervisor\n\nтекст\n";
check(latestIncoming(toSupervisor, participant("Exec"), config, state) === null, "курьер не будит чужого адресата");
check(latestIncoming(toSupervisor, participant("Supervisor"), config, state)?.sourceRole === "Spec", "курьер будит адресата");

const broadcastBlock = "## [2026-11-23T11:32:46+03:00] [Spec]\n\nтекст\n";
check(latestIncoming(broadcastBlock, participant("Exec"), config, state)?.sourceRole === "Spec", "блок без адресата будит всех");

const toBoth = "## [2026-11-23T11:40:00+03:00] [Spec] → Supervisor, Exec\n\nтекст\n";
check(latestIncoming(toBoth, participant("Exec"), config, state)?.sourceRole === "Spec", "два адресата получают оба");

const handled = Date.parse("2026-11-23T11:45:00+03:00");
const stateDelivered = { delivered: { Supervisor: "2026-11-23T11:45:00+03:00" } };
check(
  latestIncoming(toSupervisor, participant("Supervisor"), config, stateDelivered) === null,
  "доставленный адресату блок не повторяется",
  String(handled),
);

console.log(failed ? `ПРОВАЛ: ${failed}` : "PASS: адресная доставка курьера");
process.exit(failed ? 1 : 0);
