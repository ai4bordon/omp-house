import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  findHouse,
  getActiveProfileName,
  isoNow,
  isProcessAlive,
  readJson,
  resolveProcessStartedAt,
  writeJsonAtomic,
  withHouseLock,
} from "../../house/house-lock.mjs";

interface HouseConfig {
  participants?: Array<{ sessionId?: string; participantId?: string; role?: string }>;
}

interface SessionLease {
  profile: string;
  sessionId: string;
  sessionName?: string | null;
  sessionFile?: string;
  cwd: string;
  pid: number;
  processStartedAt?: number | null;
  startedAt: string;
  lastSeenAt: string;
  candidateDescription: string;
  kind: "interactive" | "courier" | "headless" | "service" | "unknown";
  status: "active" | "stale" | "unconfirmed";
}

interface SessionRegistry {
  version: 1;
  sessions: SessionLease[];
}

function firstUserText(context: ExtensionContext): string | undefined {
  for (const entry of context.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    for (const part of entry.message.content) {
      if (part.type !== "text") continue;
      const text = part.text.trim();
      if (text) return text.slice(0, 160);
    }
  }
  return undefined;
}

function sessionKind(): SessionLease["kind"] {
  const marker = `${process.env.OMP_HOUSE_SESSION_KIND ?? ""} ${process.env.OMP_HOUSE_PROMPT_MARKER ?? ""}`.toLowerCase();
  if (marker.includes("courier")) return "courier";
  if (marker.includes("headless")) return "headless";
  if (marker.includes("service")) return "service";
  return "interactive";
}

function loadRegistry(path: string): SessionRegistry {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionRegistry>;
    if (Array.isArray(value.sessions)) return { version: 1, sessions: value.sessions as SessionLease[] };
  } catch {}
  return { version: 1, sessions: [] };
}

async function updateLease(context: ExtensionContext): Promise<void> {
  const house = findHouse(context.cwd);
  if (!house || !house.config || house.error) return;
  const sessionsPath = join(house.houseDir, "sessions.json");
  const sessionManager = context.sessionManager;
  const sessionId = sessionManager.getSessionId();
  const pid = process.pid;
  const kind = sessionKind();
  const profile = getActiveProfileName();
  const sessionFile = sessionManager.getSessionFile();
  const existing = loadRegistry(sessionsPath).sessions.find((entry) => entry.sessionId === sessionId);
  const title = sessionManager.getSessionName()?.trim();
  const candidateDescription = title || firstUserText(context) || "no title yet";
  const lease: SessionLease = {
    profile,
    sessionId,
    sessionName: title || null,
    sessionFile,
    cwd: sessionManager.getCwd(),
    pid,
    processStartedAt: resolveProcessStartedAt(pid),
    startedAt: existing?.startedAt ?? isoNow(),
    lastSeenAt: isoNow(),
    candidateDescription,
    kind,
    status: kind === "interactive" && isProcessAlive(pid) ? "active" : "unconfirmed",
  };
  await withHouseLock(sessionsPath, async () => {
    const registry = loadRegistry(sessionsPath);
    // Две чистки, обе по pid. Первая — запись прежней сессии того же окна: после
    // resume sessionId меняется, и прежняя запись с её processStartedAt (а он может
    // быть null) делает кандидата unconfirmed навсегда. Один pid — одно окно.
    // Вторая — записи вообще мёртвых окон: окно, закрытое без session_shutdown,
    // иначе оставляет запись навсегда, и реестр растёт. Обе чистки безопасны:
    // запись в sessions.json пишет только живой хук, и пережить он может только
    // себя.
    const sessions = registry.sessions.filter((entry) => isProcessAlive(entry.pid) && !(entry.pid === pid && entry.sessionId !== sessionId));
    const index = sessions.findIndex((entry) => entry.sessionId === sessionId);
    if (index >= 0) sessions[index] = lease;
    else sessions.push(lease);
    await writeJsonAtomic(sessionsPath, { version: 1, sessions });
  });
}

async function removeLease(context: ExtensionContext): Promise<void> {
  const house = findHouse(context.cwd);
  if (!house || house.error) return;
  const sessionsPath = join(house.houseDir, "sessions.json");
  const pid = process.pid;
  await withHouseLock(sessionsPath, async () => {
    const registry = loadRegistry(sessionsPath);
    // Снимаем ВСЕ записи своего pid, а не только текущую sessionId: после resume
    // прежняя запись принадлежит тому же окну, и на session_shutdown её тоже
    // нечем будет убрать — текущая sessionId на неё не указывает.
    const sessions = registry.sessions.filter((entry) => entry.pid !== pid);
    await writeJsonAtomic(sessionsPath, { version: 1, sessions });
  });
}

// Окно, открытое до дома, иначе не попадает в реестр: session_start дом не нашёл,
// а хода после появления дома может не быть вовсе. Ждём дом таймером, как поллер
// расширения. Переменная окружения это шов для пробы.
const REGISTRY_RETRY_MS = Number(process.env.OMP_HOUSE_REGISTRY_RETRY_MS) || 10_000;

export default function houseSessionRegistry(pi: ExtensionAPI): void {
  let retryTimer: NodeJS.Timeout | undefined;
  let lastContext: ExtensionContext | undefined;
  let closed = false;
  // Записи и снятие lease идут строго по очереди: иначе тик, начатый до
  // session_shutdown, дописывает запись уже после её снятия, и в реестре остаётся
  // призрак закрытого окна.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };

  const stopRetry = (): void => {
    clearInterval(retryTimer);
    retryTimer = undefined;
  };

  const writeLease = (context: ExtensionContext): Promise<boolean> =>
    serialize(async () => {
      if (closed) return false;
      const house = findHouse(context.cwd);
      if (!house || !house.config || house.error) return false;
      await updateLease(context);
      return true;
    });

  const register = (_event: unknown, context: ExtensionContext) => {
    closed = false;
    lastContext = context;
    // Promise возвращается наружу: тесты и хост могут дождаться записи lease.
    return writeLease(context)
      .then((written) => {
        if (written) {
          stopRetry();
          return;
        }
        if (retryTimer !== undefined) return;
        retryTimer = setInterval(() => {
          const current = lastContext;
          if (!current) {
            stopRetry();
            return;
          }
          void writeLease(current).then((found) => {
            if (found) stopRetry();
          });
        }, REGISTRY_RETRY_MS);
      })
      .catch(() => {});
  };

  pi.on("session_start", register);
  pi.on("session_switch", register);
  pi.on("before_agent_start", register);
  pi.on("session_shutdown", (_event, context) => {
    closed = true;
    stopRetry();
    return serialize(() => removeLease(context)).catch(() => {});
  });
}
