import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { blockTargets, findHouse, INJECTION_PREFIX, parseStamp, readJson, roleSignatureRegex, sameRole, sessionStatus, withHouseLock, writeJsonAtomic } from "../../house/house-lock.mjs";

interface SessionBinding {
  participantId?: string;
  role?: string;
  profile?: string;
  sessionId?: string;
  cwd?: string;
}

interface HouseConfig {
  version?: number;
  roles?: string[];
  participants?: SessionBinding[];
  signatures?: Record<string, string>;
  stateFile?: string;
  logFile?: string;
}

interface HouseState {
  lastSentBy?: Record<string, string | null>;
  deliveredBy?: Record<string, string | null>;
  notified?: Record<string, string | null>;
  delivered?: Record<string, string | null>;
  open?: Array<{ id: string; owner?: string; topic?: string; created?: string }>;
}

function readState(houseDir: string, config: HouseConfig): HouseState | null {
  const statePath = join(houseDir, config.stateFile ?? "state.json");
  try {
    if (!existsSync(statePath)) return null;
    return JSON.parse(readFileSync(statePath, "utf8")) as HouseState;
  } catch {
    return null;
  }
}

function normalize(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(" ", "T");
  // Метка без суффикса зоны — legacy-формат House (UTC, без Z). Без этого Date.parse
  // прочитал бы её как локальное время и напоминалка считала бы старые блоки свежими.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const stamp = Date.parse(zoned);
  return Number.isFinite(stamp) ? String(stamp) : text;
}

function profileName(agentDir: string | undefined): string {
  if (!agentDir) return "";
  const normalized = resolve(agentDir).replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts.at(-1)?.toLowerCase() === "agent" ? parts.at(-2) ?? "" : "";
}
interface SessionLease {
  profile?: string;
  sessionId?: string;
  pid?: number;
  processStartedAt?: number | null;
  kind?: string;
}

const WATCH_TAIL_BYTES = 128 * 1024;

// Адресован ли последний блок коллеги именно мне. Вопрос «кто говорил последним»
// остаётся за метками lastSentBy: они пишутся при отправке и живут без переписки.
// Здесь только подавление: блок, адресованный другой роли, не повод напоминать.
// Нет переписки или нет блока коллеги: не подавляем, отсутствие данных не довод.
export function lastPeerAddressedTo(houseDir: string, config: HouseConfig, ownRole: string, peerRole: string): boolean {
  const path = join(houseDir, config.logFile ?? "переписка.md");
  let text: string;
  try {
    const size = statSync(path).size;
    if (!size) return true;
    const start = Math.max(0, size - WATCH_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString("utf8");
  } catch {
    return true;
  }
  const signature = roleSignatureRegex(config, peerRole);
  const parts = text.split(/^##\s+\[/m).slice(1);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const raw = `## [${parts[index]}`;
    const header = raw.split("\n", 1)[0] ?? "";
    if (/ОТ\s+КУРЬЕРА/i.test(header) || /\[курьер\s*\(авто\)\]/i.test(raw)) continue;
    if (!signature.test(header)) continue;
    if (parseStamp(header.match(/^(?:##\s+)?\[([^\]]+)\]/)?.[1] ?? null) === null) continue;
    const targets = blockTargets(header);
    return targets.length === 0 || targets.some((target) => sameRole(target, ownRole));
  }
  return true;
}

function reminder(
  houseDir: string,
  config: HouseConfig,
  state: HouseState,
  binding: SessionBinding,
): string | undefined {
  const participantId = binding.participantId ?? binding.role;
  if (!participantId) return undefined;
  // Коллега — тот участник с другой ролью, чья сессия active по тем же правилам,
  // что и у курьера: тот же sessionStatus из house-lock, а не «lease есть».
  // Иначе напоминалка считала бы живым окно с мёртвым pid — мы на этом уже
  // стояли с a729. Записи без живой записи в реестре коллегой не считаются.
  let leases: SessionLease[] = [];
  try {
    const raw = JSON.parse(readFileSync(join(houseDir, "sessions.json"), "utf8")) as { sessions?: SessionLease[] };
    if (Array.isArray(raw.sessions)) leases = raw.sessions;
  } catch {
    leases = [];
  }
  const peer = (config.participants ?? []).find((candidate) => {
    if (candidate.participantId === participantId || sameRole(candidate.role, binding.role)) return false;
    const lease = leases.find(
      (entry) => entry.sessionId === candidate.sessionId && String(entry.profile ?? "").toLowerCase() === String(candidate.profile ?? "").toLowerCase(),
    );
    return lease !== undefined && sessionStatus(lease) === "active";
  });
  // Непрочитанное = коллега говорил последним. Сравниваются метки ОТПРАВКИ
  // (lastSentBy, их пишет house.mjs в sendMessage), а не доставки: deliveredBy
  // пишет поллер окна-ПОЛУЧАТЕЛЯ, и там лежит метка блока, пришедшего ЕМУ.
  // На deliveredBy напоминалка работала ровно наоборот: срабатывала на своём же
  // ответе и молчала, когда блок коллеги ждал ответа. Замер 2026-10-08 в живом
  // доме: последний блок переписки [designer] 11:56:10, deliveredBy[designer]
  // = 11:54:30 (блок коллеги, доставленный мне), deliveredBy[backend] = 11:56:10
  // (мой блок, доставленный коллеге) → старая формула давала unread=true тому,
  // кто написал последним, и unread=false тому, кому надо отвечать.
  //
  // Доставка здесь намеренно не участвует: house-watch — запасной канал на случай,
  // когда инъекция не сработала, а метка отправки существует независимо от того,
  // дошёл блок до чужого окна или нет. По deliveredBy провал доставки выглядел бы
  // как «непрочитанного нет» — то есть запасной канал молчал бы именно тогда,
  // когда он один и остался.
  const mineSent = (key: string | undefined): string | null => normalize(state.lastSentBy?.[key ?? ""]);
  const mySent = mineSent(participantId) ?? mineSent(binding.role);
  const peerSent = peer ? mineSent(peer.participantId ?? peer.role) : null;
  const peerSpokeLast = peerSent !== null && (mySent === null || Number(peerSent) > Number(mySent));
  // Адресат только подавляет напоминание: если последний блок коллеги адресован
  // другой роли, будить меня незачем. Вопрос «кто говорил последним» по-прежнему
  // решают метки отправки, а не текст переписки.
  const unread = peerSpokeLast && (peer ? lastPeerAddressedTo(houseDir, config, binding.role, peer.role) : false);
  const openToMe = (state.open ?? []).filter((item) => sameRole(item.owner, binding.role) || item.owner === participantId);
  if (!unread && openToMe.length === 0) return undefined;

  const lines = [
    "[house] Переписка с коллегой: есть непрочитанное.",
    `Каталог дома: ${houseDir}`,
    "",
  ];
  if (openToMe.length > 0) {
    lines.push("Открыто на тебе:");
    for (const item of openToMe) {
      lines.push(`- [${item.id}] ${item.topic ?? "(без темы)"} (создано ${item.created ?? "—"})`);
    }
    lines.push("");
  }
  lines.push(
    // Безусловный приказ ответить («ответь своим блоком») и был топливом петли:
    // напоминание приходило на каждый ход, и агент отвечал даже на подтверждение.
    // Молчание — норма; отвечаем, когда спросили.
    "Прочитай переписку с конца. Отвечай, только если в блоке есть вопрос, просьба или решение, которое меняет твою работу: подтверждения, согласия и благодарности не пиши.",
    "Записать ответ, если он нужен: `/house say <роль> <текст>`.",
    "Отметку доставки расширение ведёт само в state.json — руками state.json не пиши. Подпись автора должна соответствовать роли из house.json.",
  );
  return lines.join("\n");
}

// Счётчик автономных ходов. Считает ХОДЫ, начатые инъекцией, а не доставки: доставка
// в занятое окно уходит в `_queueSteer` и ход не начинает (`agent-session.js:1519-1526`
// — ранний return до `emitBeforeAgentStart` на 1555), поэтому на доставках счётчик врал
// бы в сценарии «владелец дал длинное задание, коллега прислал семь блоков»: семь
// доставок внутрь одного хода владельца дали бы «семь ходов подряд без владельца» при
// нуле автономных. Здесь счётчик растёт ровно на начавшийся ход, и признак хода —
// префикс текста: инъекция → `+1`, слово владельца → `0`.
// Промпт `undefined` (так его зовёт тестовый стенд) счётчик не трогает: «не знаю, чей
// ход» — не повод ни сбросить защиту, ни её нарастить.
async function recordTurn(houseDir: string, config: HouseConfig, sessionId: string, isInjection: boolean): Promise<void> {
  const statePath = join(houseDir, config.stateFile ?? "state.json");
  await withHouseLock(statePath, async () => {
    const state = await readJson(statePath, null);
    if (!state) return;
    const current = Number(state.autoTurns?.[sessionId] ?? 0);
    const next = isInjection ? current + 1 : 0;
    // Пишем только при изменении: иначе хук дёргал бы файл на каждом ходе.
    if (next === current) return;
    state.autoTurns ??= {};
    state.autoTurns[sessionId] = next;
    await writeJsonAtomic(statePath, state);
  });
}

export default function houseWatch(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const house = findHouse(ctx.cwd);
      // Общий findHouse отдаёт битый конфиг как {config: null, error}: напоминалку
      // по нему не собрать, поэтому выходим так же, как раньше выходили на null.
      if (!house || house.error || !house.config) return;
      const profile = profileName(process.env.PI_CODING_AGENT_DIR);
      const sessionManager = ctx.sessionManager;
      const sessionId = sessionManager.getSessionId();
      const cwd = sessionManager.getCwd();
      const binding = (house.config.participants ?? []).find(
        (candidate) =>
          candidate.sessionId === sessionId &&
          (!candidate.profile || !profile || candidate.profile.toLowerCase() === profile.toLowerCase()) &&
          (!candidate.cwd || candidate.cwd.replace(/\\/g, "/").toLowerCase() === cwd.replace(/\\/g, "/").toLowerCase()),
      );
      if (!binding) return;
      const prompt = typeof event?.prompt === "string" ? event.prompt : null;
      if (prompt !== null) {
        await recordTurn(house.houseDir, house.config, sessionId, prompt.startsWith(INJECTION_PREFIX));
      }
      const state = readState(house.houseDir, house.config);
      if (!state) return;
      const content = reminder(house.houseDir, house.config, state, binding);
      if (!content) return;
      return { message: { customType: "house", content, display: "notice" } };
    } catch {
      return;
    }
  });
}
