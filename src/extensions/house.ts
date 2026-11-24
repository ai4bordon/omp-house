import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { run } from "../house/house.mjs";
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { blockTargets, findHouse, INJECTION_PREFIX, isoNow, maxStamp, parseStamp, readJson, roleSignatureRegex, sameRole, withHouseLock, writeJsonAtomic } from "../house/house-lock.mjs";

const INBOX_POLL_MS = Number(process.env.OMP_HOUSE_INBOX_POLL_MS) || 3000;
const UNBOUND_REPEAT_MS = 300_000;
// Предел подряд идущих автономных ходов, если в house.json поля нет. Совпадает с
// шаблоном init; вынесено отдельно, чтобы поллер не отказывал на доме без поля.
const DEFAULT_AUTO_TURN_LIMIT = 6;

const INBOX_LOG = "inbox.log";

function readTail(path: string, from: number): string {
  const size = statSync(path).size;
  if (size <= from) return "";
  const start = Math.max(from - 1, 0);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  const chunk = buffer.toString("utf8");
  if (start === from) return chunk;
  // Отрезаем хвост блока, на границе которого мы остановились: первый заголовок — начало.
  const header = chunk.search(/(?:^|\n)##\s+\[/);
  return header === -1 ? "" : chunk.slice(header === 0 ? 0 : header + 1);
}

function inboxLog(houseDir: string, message: string): void {
  try {
    mkdirSync(join(houseDir, "logs"), { recursive: true });
    appendFileSync(join(houseDir, "logs", INBOX_LOG), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
  }
}


function conversationBlocks(text: string): { raw: string; header: string; stamp: string; stampMs: number }[] {

  return text
    .split(/^##\s+\[/m)
    .slice(1)
    .map((raw) => {
      const value = `## [${raw}`;
      const header = value.split("\n", 1)[0] ?? "";
      const stamp = header.match(/^(?:##\s+)?\[([^\]]+)\]/)?.[1] ?? "";
      return { raw: value, header, stamp, stampMs: parseStamp(stamp) ?? -1 };
    })
    .filter((block) => block.stampMs >= 0);
}

export function latestIncoming(
  text: string,
  ownRole: string,
  config: { roles?: string[]; signatures?: Record<string, string> },
  handledMs: number,
): { raw: string; header: string; stamp: string; stampMs: number; sourceRole: string } | null {
  let latest: { raw: string; stamp: string; stampMs: number; sourceRole: string } | null = null;
  for (const block of conversationBlocks(text)) {
    if (block.stampMs <= handledMs) continue;
    const source = (config.roles ?? []).find(
      // Подпись роли читается ТОЛЬКО из заголовка. По телу искать нельзя: автор
      // вставляет в текст чужие литералы вроде notified[architect]=…, и блок приходил
      // бы как сообщение от роли, которую автор не представляет. Заголовок и есть
      // подпись автора.
      (role) => !sameRole(role, ownRole) && roleSignatureRegex(config, role).test(block.header),
    );
    if (!source) continue;
    // Адресный блок чужой роли не доставляется: иначе выбор адресата ничего бы
    // не менял. Пустой список это broadcast, как у блоков без хвоста.
    const targets = blockTargets(block.header);
    if (targets.length && !targets.some((target) => sameRole(target, ownRole))) continue;
    if (!latest || block.stampMs > latest.stampMs) latest = { ...block, sourceRole: source };
  }
  return latest;
}

function blockBody(raw: string): string {
  return raw.split(/\n/).slice(1).join("\n").trim();
}

interface CandidateRow {
  profile: string;
  sessionId: string;
  candidateDescription: string;
  status: string;
  cwd: string;
  kind: string;
  startedAt?: string;
  sessionName?: string | null;
  title?: string | null;
  display?: string | null;
}

interface ParticipantRow {
  participantId?: string;
  sessionId?: string;
  role?: string;
  label?: string;
}

interface LifecycleResult {
  ok: boolean;
  code: string;
  message: string;
  data?: {
    config?: { roles?: string[]; participants?: ParticipantRow[] };
    sessions?: CandidateRow[];
    role?: string;
  };
}


const commandDescriptions: Record<string, string> = {
  setup: "Выбрать живые сессии и назначить роль (включая свою); courier не запускается",
  whoami: "Показать номер и короткий id этого окна в списке /house setup",
  rename: "Задать имя сессии для роли; в setup имя не спрашивается",
  say: "Отправить сообщение от роли и отметить его прочитанным для текущей сессии",
  start: "Запустить собственный courier дома и сохранить PID/heartbeat",
  stop: "Остановить только собственный courier; повторная остановка безопасна",
  status: "Показать дом, bindings, режимы и состояние courier",
};
const commands = Object.keys(commandDescriptions);

function notify(ctx: ExtensionCommandContext, result: LifecycleResult): void {
  ctx.ui.notify(result.message, result.ok ? "info" : "error");
}

const SELF_MARK = "← это окно";
const CUSTOM_ROLE = "Своя роль…";

function shortId(sessionId: string): string {
  return String(sessionId ?? "").slice(0, 8);
}

function clockTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function displayTitle(row: CandidateRow): string {
  return row.title?.trim() || row.display?.trim() || row.candidateDescription;
}

// Номера считаются по всем активным интерактивным сессиям, а не по видимым строкам:
// иначе `/house setup --all` и `/house whoami` называли бы одну сессию разными
// номерами, и сверка окна со списком теряла бы смысл.
export function orderCandidates<T extends { startedAt?: string; sessionId: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (left, right) => String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? "")) || left.sessionId.localeCompare(right.sessionId),
  );
}

export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

export function candidateLabel(row: CandidateRow, number: number, selfId: string, showProfile: boolean): string {
  const parts = [`№${number}`, showProfile ? row.profile : "", shortId(row.sessionId), clockTime(row.startedAt), displayTitle(row)];
  return `${parts.filter(Boolean).join(" · ")}${row.sessionId === selfId ? `  ${SELF_MARK}` : ""}`;
}

// Те же правила, что в house.mjs role-add: отказ должен приходить до вызова CLI,
// чтобы человек видел причину рядом с полем ввода.
export function roleNameError(role: string): string | null {
  if (!role) return "Роль не может быть пустой";
  if (role.length > 32) return "Роль длиннее 32 символов";
  if (/[\s[\]]/.test(role)) return "В роли не должно быть пробелов и квадратных скобок";
  return null;
}

export function editDistance(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

// Опечаткой считаем одну правку при имени от четырёх символов и две правки при
// имени от семи. Две правки на коротком имени это уже другая роль: `spec` и
// `exec` отличаются ровно на две, и предложение заменить одну другой было бы
// вредным. Перестановка букв (`desinger`) даёт две правки и ловится при длине 8.
export function nearestRole(role: string, roles: string[]): string | null {
  const lower = role.toLowerCase();
  if (lower.length < 4) return null;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of roles) {
    const candidateLower = candidate.toLowerCase();
    if (candidateLower === lower) continue;
    const distance = editDistance(lower, candidateLower);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (!best) return null;
  const looksLikeTypo = bestDistance === 1 || (bestDistance === 2 && lower.length >= 7);
  return looksLikeTypo ? best : null;
}

async function chooseRole(ctx: ExtensionCommandContext, roles: string[], row: CandidateRow, number: number): Promise<string | null> {
  const title = `Роль для №${number} · ${shortId(row.sessionId)} · ${displayTitle(row)}`;
  const choice = roles.length === 0
    ? CUSTOM_ROLE
    : await ctx.ui.select(title, [...roles.map((value) => ({ value, label: value })), { value: CUSTOM_ROLE, label: CUSTOM_ROLE }]);
  if (!choice) return null;
  if (choice !== CUSTOM_ROLE) return choice;
  const typed = (await ctx.ui.input("Введи роль (одно слово, без пробелов и скобок)", roles[0] ?? ""))?.trim();
  if (!typed) return null;
  const nameError = roleNameError(typed);
  if (nameError) {
    ctx.ui.notify(nameError, "error");
    return null;
  }
  const nearest = nearestRole(typed, roles);
  if (nearest) {
    const answer = await ctx.ui.select(`«${typed}» похоже на «${nearest}». Это опечатка?`, [
      { value: "take", label: `да, взять ${nearest}` },
      { value: "create", label: `нет, создать ${typed}` },
    ]);
    if (answer === "take") return nearest;
  }
  return typed;
}

async function setup(ctx: ExtensionCommandContext, all: boolean): Promise<void> {
  const result = (await run(["candidates", "--cwd", ctx.cwd, "--json"])) as LifecycleResult;
  if (!result.ok || !result.data?.sessions) {
    notify(ctx, result);
    return;
  }
  const active = orderCandidates(result.data.sessions.filter((row) => row.status === "active" && row.kind === "interactive"));
  if (active.length === 0) {
    ctx.ui.notify("Нет подтверждённых активных OMP-сессий для привязки.", "warning");
    return;
  }
  const selfId = ctx.sessionManager.getSessionId();
  const numbered = active.map((row, index) => ({ row, number: index + 1 }));
  const visible = all ? numbered : numbered.filter(({ row }) => samePath(row.cwd, ctx.cwd));
  if (visible.length === 0) {
    ctx.ui.notify(`В этом каталоге активных сессий нет: ${ctx.cwd}. Запусти окна здесь или повтори /house setup --all.`, "warning");
    return;
  }
  const showProfile = new Set(visible.map(({ row }) => row.profile)).size > 1;
  const byLabel = new Map(visible.map((entry) => [candidateLabel(entry.row, entry.number, selfId, showProfile), entry]));
  const labels = [...byLabel.keys()];
  const selected = ctx.ui.askDialog
    ? await ctx.ui.askDialog([
        {
          id: "sessions",
          question: all ? "Какие сессии подключить к дому? (все проекты)" : "Какие сессии этого проекта подключить к дому?",
          header: "House setup",
          multi: true,
          options: labels.map((label) => ({ label })),
        },
      ])
    : await ctx.ui.select("Выберите OMP-сессии для дома", labels.map((value) => ({ value, label: value })));
  const selectedLabels = typeof selected === "string"
    ? [selected]
    : selected?.kind === "submit"
      ? selected.results[0]?.selectedOptions ?? []
      : [];
  if (selectedLabels.length === 0) {
    ctx.ui.notify("Привязки не изменены.", "info");
    return;
  }
  const roles = [...(result.data.config?.roles ?? [])];
  for (const label of selectedLabels) {
    const entry = byLabel.get(label);
    if (!entry) continue;
    const role = await chooseRole(ctx, roles, entry.row, entry.number);
    if (!role) continue;
    if (!roles.some((item) => item.toLowerCase() === role.toLowerCase())) {
      const added = (await run(["role-add", "--cwd", ctx.cwd, "--role", role])) as LifecycleResult;
      if (!added.ok) {
        notify(ctx, added);
        return;
      }
      roles.push(added.data?.role ?? role);
    }
    // Имя в setup не спрашивается: на трёх сессиях это давало три лишних вопроса,
    // а в первом прогоне имена всё равно совпали с ролями. Имя по умолчанию это
    // роль; своё задаётся отдельно командой /house rename.
    const bindResult = (await run([
      "bind",
      "--cwd",
      ctx.cwd,
      "--role",
      role,
      "--profile",
      entry.row.profile,
      "--session-id",
      entry.row.sessionId,
      "--participant-id",
      entry.row.sessionId,
      // setup привязывает выбранные окна из процесса текущего окна, поэтому
      // PI_SESSION_ID выбранной сессии здесь нет. Разрешение явное и узкое: оно
      // действует только на этот вызов bind, а не на CLI целиком.
      "--allow-other-session",
      "--session-cwd",
      entry.row.cwd,
    ])) as LifecycleResult;
    if (!bindResult.ok) {
      notify(ctx, bindResult);
      return;
    }
  }
  ctx.ui.notify(`Сохранено привязок: ${selectedLabels.length}. Переговорщик не запускался.`, "info");
}

async function whoami(ctx: ExtensionCommandContext): Promise<void> {
  const result = (await run(["candidates", "--cwd", ctx.cwd, "--json"])) as LifecycleResult;
  if (!result.ok || !result.data?.sessions) {
    notify(ctx, result);
    return;
  }
  const active = orderCandidates(result.data.sessions.filter((row) => row.status === "active" && row.kind === "interactive"));
  const selfId = ctx.sessionManager.getSessionId();
  const index = active.findIndex((row) => row.sessionId === selfId);
  if (index === -1) {
    ctx.ui.notify("Это окно не найдено среди активных интерактивных сессий дома. Повтори /house setup, чтобы обновить реестр.", "warning");
    return;
  }
  const row = active[index];
  const binding = (result.data.config?.participants ?? []).find((participant) => participant.sessionId === selfId);
  const suffix = binding
    ? ` · роль ${binding.role}${binding.label ? ` (${binding.label})` : ""}`
    : " · без привязки";
  ctx.ui.notify(`№${index + 1} · ${shortId(selfId)} · ${clockTime(row.startedAt)} · ${displayTitle(row)}${suffix}`, "info");
}

async function rename(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const [role, ...rest] = args.trim().split(/\s+/);
  const name = rest.join(" ").trim();
  if (!role || !name) {
    ctx.ui.notify("Использование: /house rename <роль> <имя>", "error");
    return;
  }
  const result = (await run(["label", "--cwd", ctx.cwd, "--role", role, "--label", name])) as LifecycleResult;
  notify(ctx, result);
}

async function say(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const role = parts.shift() ?? "";
  // Адресат необязателен: без --to блок видят все, как раньше. Флаг идёт сразу
  // после роли, значение одним словом: роли в house.json без пробелов.
  let to: string | undefined;
  if (parts[0] === "--to") {
    parts.shift();
    to = parts.shift();
  }
  const text = parts.join(" ").trim();
  if (!role || !text || to === "") {
    ctx.ui.notify("Использование: /house say <роль> [--to <роли через запятую>] <текст>", "error");
    return;
  }
  const sessionId = ctx.sessionManager.getSessionId();
  // participantId и sessionId расходятся: upsert роли сохраняет id, под которым
  // уже писали в state.lastSentBy. send ищет участие по participantId, поэтому
  // берём его у того же участника, который привязан к этому окну, а не id окна.
  const own = (findHouse(ctx.cwd)?.config?.participants ?? []).find(
    (participant: ParticipantRow) => sameRole(participant.role, role) && participant.sessionId === sessionId,
  );
  const result = (await run([
    "send",
    "--cwd",
    ctx.cwd,
    "--role",
    role,
    "--text",
    text,
    ...(to ? ["--to", to] : []),
    "--participant-id",
    own?.participantId ?? sessionId,
  ])) as LifecycleResult;
  notify(ctx, result);
}

async function handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const command = args.trim().split(/\s+/, 1)[0] || "status";
  const rest = args.trim().slice(command.length).trim();
  if (command === "setup") {
    await setup(ctx, /\b--all\b/.test(rest));
    return;
  }
  if (command === "whoami") {
    await whoami(ctx);
    return;
  }
  if (command === "rename") {
    await rename(rest, ctx);
    return;
  }
  if (command === "say") {
    await say(rest, ctx);
    return;
  }
  if (!commands.includes(command)) {
    ctx.ui.notify(`Неизвестная команда /house: ${command}. Доступно: ${commands.join(", ")}`, "warning");
    return;
  }
  const result = (await run([command, "--cwd", ctx.cwd])) as LifecycleResult;
  notify(ctx, result);
}

function completions(prefix: string): AutocompleteItem[] {
  return commands
    .filter((command) => command.startsWith(prefix.trim().toLowerCase()))
    .map((command) => ({ value: command, label: command, description: commandDescriptions[command] }));
}

function startInbox(pi: ExtensionAPI, ctx: { cwd: string; sessionManager: { getSessionId(): string } }): () => void {
  const house = findHouse(ctx.cwd);
  if (!house || house.error) return () => {};
  const configPath = join(house.houseDir, "house.json");
  const conversationPath = join(house.houseDir, "переписка.md");
  const statePath = join(house.houseDir, "state.json");
  let handledMs = -1;
  let cursor = 0;
  let inFlight = false;
  let unboundLoggedAt = 0;

  // Участник и его роль берутся из свежего house.json в каждом тике, а не из
  // снимка на момент session_start. session_start бьёт один раз при запуске окна,
  // а привязка оформляется позже и раньше невозможна: sessionId ещё не существует.
  // На снимке окно оставалось немым навсегда — процесс жив, команда есть, доставки
  // нет, и ни одной строки в лог. Теперь отсутствие привязки видно в inbox.log.
  //
  // sessionId тоже берётся в каждом тике: после resume окно работает уже другой
  // сессией, и поллер на снимке искал бы прежнюю, которой в participants нет.
  const resolveParticipant = async () => {
    const sessionId = ctx.sessionManager.getSessionId();
    const config = (await readJson(configPath, null)) ?? house.config;
    return { sessionId, config, participant: (config.participants ?? []).find((entry) => entry.sessionId === sessionId) };
  };

  const commitDelivered = async (sessionId: string, stamp: string): Promise<void> => {
    await withHouseLock(statePath, async () => {
      const current = (await readJson(statePath, null)) ?? { version: 1, deliveredBy: {} };
      // Отдельное поле намеренно. lastSentBy — метка отправителя, её пишет house.mjs
      // в sendMessage; подтягивание её сюда маскировало бы чужой блок, пришедший
      // между чужим сообщением и моим собственным ответом.
      current.deliveredBy ??= {};
      current.deliveredBy[sessionId] = stamp;
      // autoTurns здесь НЕ растёт. Счётчик считает ходы, начатые инъекцией, а не
      // доставки: доставка в занятое окно уходит в `_queueSteer` и ход не начинает
      // (agent-session.js:1519-1526 — ранний return до `emitBeforeAgentStart` на
      // 1555). Владелец мог кинуть одно длинное задание, коллега за это время прислать
      // семь блоков — все семь придут steer'ом внутрь одного хода владельца, и счётчик
      // на доставках дал бы «семь ходов подряд без владельца» при нуле автономных.
      // Инкремент живёт в `house-watch` на `before_agent_start`: он бьёт ровно на
      // начавшийся ход и различает ход инъекции по префиксу текста.
      current.updated = isoNow();
      await writeJsonAtomic(statePath, current);
    });
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    // Курсор: с прошлого тика прочитан ровно `cursor` байт. Пока размер не менялся —
    // ноль чтений. Файл читается с позиции курсора, то есть по объёму нового блока,
    // а не по длине переписки. Размер снимается ДО чтения, чтобы запись, попавшая
    // между stat и read, дала следующий тик с новым размером и не потерялась молча.
    const size = statSync(conversationPath).size;
    // Пока привязки нет, окно обязано продолжать напоминать о себе даже когда
    // переписка не менялась: иначе живое молчащее окно и мёртвое окно в логе
    // выглядят одинаково — ровно тот зазор, на котором стоял разбор 1.1.3.
    if (Date.now() - unboundLoggedAt >= UNBOUND_REPEAT_MS && size === cursor) {
      const idle = await resolveParticipant();
      if (!idle.participant) {
        unboundLoggedAt = Date.now();
        inboxLog(house.houseDir, `unbound ${idle.sessionId}: в participants нет окна с таким sessionId, инъекция ждёт /house setup`);
        return;
      }
    }
    if (size === cursor) return;
    const from = cursor;
    inFlight = true;
    let ownRole = "";
    try {
      const text = readTail(conversationPath, from);
      const { sessionId, config, participant } = await resolveParticipant();
      if (!participant) {
        // Курсор намеренно не двигаем: привязка появится позже, и хвост переписки
        // должен предъявиться целиком, а не потеряться на ожидании привязки.
        const now = Date.now();
        if (now - unboundLoggedAt >= UNBOUND_REPEAT_MS) {
          unboundLoggedAt = now;
          inboxLog(house.houseDir, `unbound ${sessionId}: в participants нет окна с таким sessionId, инъекция ждёт /house setup`);
        }
        return;
      }
      ownRole = participant.role;
      const state = (await readJson(statePath, null)) ?? {};
      handledMs = Math.max(handledMs, maxStamp(state.deliveredBy?.[sessionId]) ?? -1);
      const incoming = latestIncoming(text, ownRole, config, handledMs);
      if (!incoming) {
        cursor = size;
        return;
      }
      // Предел подряд идущих автономных ходов. Считает не частоту, а длину цепочки:
      // замер 2026-10-08 дал 9 блоков за 20 минут — медленно, патология в незатухании.
      // Тормоз МЯГКИЙ: окно всё равно будится, блок не теряется, к тексту добавляется
      // только факт петли. Жёсткий вариант (triggerTurn: false) оставил бы блок
      // невидимым до слова владельца — ровно тот риск, от которого фикс избавляет.
      const autoTurns = Number(state.autoTurns?.[sessionId] ?? 0);
      const limit = Number(config.courier?.autoTurnLimit) || DEFAULT_AUTO_TURN_LIMIT;
      const loopLine = autoTurns >= limit
        ? `Вы с коллегой уже ${autoTurns} ходов подряд без владельца. Если отвечать нечего — не отвечай.`
        : null;
      pi.sendUserMessage(
        [
          `${INJECTION_PREFIX}\`${incoming.sourceRole}\` в доме ${house.houseDir}.`,
          "",
          blockBody(incoming.raw),
          "",
          // Молчание — норма, а не сбой: блок коллеги это новые данные, а не задание.
          // Безусловный приказ ответить («Ответь по существу») и был топливом петли —
          // приглашение стояло на каждом блоке, а подтверждений большинство.
          "Это блок коллеги, а не задание. Отвечай только если в нём есть вопрос, просьба или решение, которое меняет твою работу. Подтверждения, согласия и благодарности не пиши — они разбудят коллегу и вернут тебе ответ.",
          ...(loopLine ? ["", loopLine] : []),
          "",
          `Записать ответ, если он нужен: \`/house say ${ownRole} <текст ответа>\`.`,
        ].join("\n"),
        // steer, а не followUp. Разница не в том, показывает ли окно, а в том,
        // ГДЕ показывает: followUp ждёт конца хода, steer ждёт следующего вызова
        // инструментов (agent-session.js, deliverAs → streamingBehavior).
        // Цены у steer нет — он не прерывает текущий ход, по документации метода
        // сообщение встаёт после его tool calls и до следующего LLM-вызова.
        // Для дома это и нужно: блок коллеги — это «новые данные, учти в текущей
        // работе», а не «сделай это вместо того, что делаешь».
        { deliverAs: "steer" },
      );
      // Отметка доставки — только после инъекции. Упавшая доставка оставит и
      // handledMs, и cursor на месте, и блок предъявится заново на следующем тике.
      handledMs = incoming.stampMs;
      cursor = size;
      await commitDelivered(sessionId, incoming.stamp);
      inboxLog(house.houseDir, `delivered ${incoming.sourceRole} ${incoming.stamp} → ${ownRole}`);
    } catch (error) {
      inboxLog(house.houseDir, `error ${ownRole || "?"}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), INBOX_POLL_MS);
  return () => clearInterval(timer);
}

// Окно может быть открыто раньше дома: session_start тогда не находит дом, поллер
// остаётся заглушкой и до перезапуска окна ничего не доставляет. Поэтому пока дома
// нет, ищем его повторно раз в 10 секунд; после находки таймер снимается. Переменные
// окружения это шов для пробы, в работе значения по умолчанию.
const INBOX_BOOT_RETRY_MS = Number(process.env.OMP_HOUSE_BOOT_RETRY_MS) || 10_000;

export default function houseExtension(pi: ExtensionAPI): void {
  let stopInbox: (() => void) | undefined;
  let bootTimer: NodeJS.Timeout | undefined;

  const ensureInbox = (ctx: ExtensionCommandContext): void => {
    if (stopInbox) return;
    const house = findHouse(ctx.cwd);
    if (!house || house.error) return;
    stopInbox = startInbox(pi, ctx);
  };

  const stopBootWait = (): void => {
    clearInterval(bootTimer);
    bootTimer = undefined;
  };

  // session_switch обязателен наравне с session_start: после resume окно работает
  // уже другой сессией, и поллер, поднятый на старте, искал бы прежнюю. Перезапуск
  // сбрасывает и курсор, и handledMs — новая сессия должна получить хвост заново.
  const restartInbox = (_event: unknown, ctx: ExtensionCommandContext) => {
    stopInbox?.();
    stopInbox = undefined;
    stopBootWait();
    ensureInbox(ctx);
    if (stopInbox) return;
    bootTimer = setInterval(() => {
      ensureInbox(ctx);
      if (stopInbox) stopBootWait();
    }, INBOX_BOOT_RETRY_MS);
  };

  pi.on("session_start", restartInbox);
  pi.on("session_switch", restartInbox);
  pi.on("session_shutdown", () => {
    stopInbox?.();
    stopInbox = undefined;
    stopBootWait();
  });
  pi.registerCommand("house", {
    description: "Переписка между выбранными OMP-сессиями: setup, say, запуск, статус и остановка courier",
    getArgumentCompletions: completions,
    // Любая команда дома это повод поднять поллер: setup как раз и создаёт дом в
    // окне, открытом раньше него, поэтому проверка идёт после обработки, в finally.
    handler: async (args, ctx) => {
      try {
        await handle(args, ctx);
      } finally {
        ensureInbox(ctx);
      }
    },
  });
}
