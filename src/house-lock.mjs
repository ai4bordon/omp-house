import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const FALLBACK_RETRY_MS = 50;
const FALLBACK_RETRIES = 200;
const FALLBACK_STALE_MS = 120_000;
let ompLockLoader;

// Префикс текста инъекции поллера. По нему `house-watch` отличает ход, начатый
// инъекцией, от хода владельца: `before_agent_start` отдаёт хуку только текст
// промпта (runner.js:1128), поля «кто начал ход» в событии нет. Текст инъекции
// пишем мы сами, поэтому признак надёжный, а не эвристический. Живёт в одном
// месте, чтобы поллер и хук не разошлись при правке текста.
export const INJECTION_PREFIX = "Сообщение от роли ";


function lockPath(target) {
  return `${resolve(target)}.lock`;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLock(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function canRemoveStaleLock(path) {
  const owner = readLock(path);
  if (owner && processIsAlive(Number(owner.pid))) return false;
  try {
    return Date.now() - statSync(path).mtimeMs > FALLBACK_STALE_MS;
  } catch {
    return true;
  }
}

async function acquireFallback(target) {
  const path = lockPath(target);
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < FALLBACK_RETRIES; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      const owner = JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() });
      writeFileSync(fd, owner, "utf8");
      closeSync(fd);
      return {
        release() {
          const current = readLock(path);
          if (current?.token !== token) return;
          try {
            unlinkSync(path);
          } catch {}
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (canRemoveStaleLock(path)) {
        try {
          unlinkSync(path);
          continue;
        } catch {}
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, FALLBACK_RETRY_MS));
    }
  }
  throw new Error(`Не удалось получить блокировку house: ${target}`);
}

async function getOmpLock() {
  if (!ompLockLoader) {
    ompLockLoader = import("@oh-my-pi/pi-utils")
      .then((module) => (typeof module.withFileLock === "function" ? module.withFileLock : null))
      .catch(() => null);
  }
  return ompLockLoader;
}

export async function withHouseLock(target, fn, options = {}) {
  const absoluteTarget = resolve(target);
  await mkdir(dirname(absoluteTarget), { recursive: true });
  const withFileLock = await getOmpLock();
  if (withFileLock) {
    return withFileLock(absoluteTarget, fn, {
      retries: options.retries ?? 50,
      retryDelayMs: options.retryDelayMs ?? 100,
      signal: options.signal,
    });
  }
  const lock = await acquireFallback(absoluteTarget);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function readJsonSync(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(path, value) {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    if (!existsSync(absolutePath)) throw error;
    await rm(absolutePath, { force: true });
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export function writeJsonAtomicSync(path, value) {
  const absolutePath = resolve(path);
  const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(temporaryPath, absolutePath);
  } catch (error) {
    if (!existsSync(absolutePath)) throw error;
    rmSync(absolutePath, { force: true });
    renameSync(temporaryPath, absolutePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

// Имя каталога дома. `.house` единственное имя: запасной каталог убран целиком,
// старых имён код не ищет. Дома на прежнем имени владелец переименовывает сам.
export const HOUSE_DIR_NAME = ".house";

export function findHouse(startCwd = process.cwd()) {
  let current = resolve(startCwd);
  while (true) {
    const houseDir = join(current, HOUSE_DIR_NAME);
    const configPath = join(houseDir, "house.json");
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        return { houseDir, configPath, config, error: null };
      } catch (error) {
        // Битый конфиг единственного имени возвращаем ошибкой, а не «дома нет»:
        // иначе CLI молча создал бы новый дом поверх сломанного.
        return { houseDir, configPath, config: null, error };
      }
    }
    const parent = parse(current).dir;
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveHousePath(houseDir, configuredPath, fallbackName) {
  const value = configuredPath || fallbackName;
  return isAbsolute(value) ? resolve(value) : resolve(houseDir, value);
}

export function profileNameFromAgentDir(agentDir) {
  if (!agentDir) return "";
  const normalized = resolve(agentDir);
  const agentSegment = parse(normalized).base.toLowerCase() === "agent" ? normalized : "";
  if (!agentSegment) return "";
  return parse(dirname(normalized)).base;
}

export function getActiveAgentDir(moduleUrl = import.meta.url) {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv) return resolve(fromEnv);
  const modulePath = new URL(moduleUrl).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1));
  const normalized = modulePath.replace(/\//g, "\\");
  const marker = normalized.toLowerCase().lastIndexOf("\\agent\\");
  if (marker >= 0) return normalized.slice(0, marker + "\\agent".length);
  return "";
}

export function getActiveProfileName(moduleUrl = import.meta.url) {
  return profileNameFromAgentDir(getActiveAgentDir(moduleUrl));
}

export function isProcessAlive(pid) {
  return processIsAlive(Number(pid));
}

// Время старта процесса неизменно, пока живёт pid, поэтому удачный опрос
// переиспользуется. Это не только экономит PowerShell: pruneDeadParticipants
// спрашивает живость каждого участника, и два участника одной сессии обязаны
// получить один ответ. Одиночный сбой опроса объявлял живое окно мёртвым.
const START_TIME_CACHE_MS = 5000;
const startTimeCache = new Map();

function pollProcessStartTime(numericPid) {
  if (process.platform === "win32") {
    try {
      const output = execFileSync(
        "powershell.exe",
        // -ErrorAction SilentlyContinue гасит поиск процесса, но не падение на
        // .StartTime у null: остаётся RuntimeException в stderr. $ErrorActionPreference
        // = 'SilentlyContinue' в начале скрипта глушит и его. Ошибку мы всё равно ловим
        // сами — return null ниже, — а шум в консоли агента не нужен.
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference='SilentlyContinue'; (Get-Process -Id ${numericPid}).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { encoding: "utf8", timeout: 3000, windowsHide: true },
      ).trim();
      const value = Date.parse(output);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }
  try {
    const stat = readFileSync(`/proc/${numericPid}/stat`, "utf8");
    const closing = stat.lastIndexOf(")");
    const fields = stat.slice(closing + 2).split(" ");
    const ticks = Number(fields[19]);
    if (!Number.isFinite(ticks)) return null;
    const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
    const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
    if (!Number.isFinite(hz) || !Number.isFinite(boot)) return null;
    return boot * 1000 + (ticks / hz) * 1000;
  } catch {
    return null;
  }
}

export function processStartTimeSync(pid, poll = pollProcessStartTime) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  const cached = startTimeCache.get(numericPid);
  if (cached && Date.now() - cached.at <= START_TIME_CACHE_MS) return cached.value;
  // Один повтор: таймаут PowerShell или сбой разбора это не доказательство смерти,
  // а prune удаляет привязку именно по этому ответу. poll внедряется для пробы,
  // как у resolveProcessStartedAt: ветку повтора иначе не проверить.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const value = poll(numericPid);
    if (Number.isFinite(value)) {
      startTimeCache.set(numericPid, { value, at: Date.now() });
      return value;
    }
  }
  return null;
}

// Метка старта процесса, записанная его собственным хуком. Считается один раз на
// процесс: uptime монотонен, поэтому Date.now() минус uptime даёт время старта с
// точностью до десятков миллисекунд — замер на живом pid дал расхождение 96 мс
// против PowerShell, чего хватает с допуском 2000 мс в sessionStatus.
let ownProcessStartedAt;

export function getOwnProcessStartedAt() {
  if (!Number.isFinite(ownProcessStartedAt)) ownProcessStartedAt = Date.now() - Math.round(process.uptime() * 1000);
  return ownProcessStartedAt;
}

// Опрос времени старта у чужого процесса ходит в PowerShell и возвращает null при
// таймауте. null в lease означает unconfirmed, а unconfirmed отсекается в setup —
// живое окно становится непригодным к привязке. Поэтому при неудаче берём оценку
// старта СВОЕГО процесса: lease пишет хук, живущий внутри этого процесса, и pid
// в нём — его собственный.
// poll внедряется: на живой машине опрос PowerShell почти всегда проходит, и ветка
// отката по нему не проверяется ни одним тестом — а именно она чинит null.
export function resolveProcessStartedAt(pid, poll = processStartTimeSync) {
  const polled = poll(pid);
  if (Number.isFinite(polled)) return polled;
  if (pid !== process.pid) return null;
  return getOwnProcessStartedAt();
}

export function sessionStatus(session) {
  if (session.kind !== "interactive") return "unconfirmed";
  if (!isProcessAlive(session.pid)) return "stale";
  const currentStart = processStartTimeSync(session.pid);
  if (!Number.isFinite(session.processStartedAt) || !Number.isFinite(currentStart)) return "unconfirmed";
  if (Math.abs(currentStart - session.processStartedAt) > 2000) return "stale";
  return "active";
}

export function isoNow() {
  return new Date().toISOString();
}

// Метки сообщений в переписке — локальное системное время с явным UTC-offset.
// Раньше был toISOString() без offset: на машине UTC+12 в переписке показывалось
// на 12 часов раньше системных часов. Смещение обязательно, иначе блоки с разных
// машин не сортируются по реальному моменту времени.
export function localStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

export function parseStamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(" ", "T");
  // Метка без суффикса зоны — это legacy-формат House (UTC, без Z). Date.parse
  // такие строки читает как локальное время, что на машине не в UTC сдвигало бы
  // старые блоки на десятки часов и ломало сравнение с новыми метками со смещением.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function maxStamp(...values) {
  const parsed = values.map(parseStamp).filter((value) => value !== null);
  return parsed.length ? Math.max(...parsed) : null;
}

// Подпись роли одна на весь дом: курьер, поллер окна и напоминалка обязаны
// находить автора одинаково. Локальные копии этого разбора уже разъезжались.
export function roleSignatureRegex(config, role) {
  const configured = config?.signatures?.[role];
  if (configured) {
    try {
      return new RegExp(configured, "i");
    } catch {}
  }
  return new RegExp(`\\[${String(role).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "i");
}

// Ввод команд сравнивается без регистра: `Spec` и `spec` это одна роль.
// house.json при этом хранит точное написание, его не переписываем.
export function sameRole(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

export function canonicalRole(roles, value) {
  const key = String(value ?? "").trim().toLowerCase();
  return (roles ?? []).find((role) => String(role).toLowerCase() === key) ?? null;
}

// Адресат в заголовке: `## [метка] [роль] → Роль1, Роль2`. Имена без квадратных
// скобок намеренно: подпись автора ищется по `\[роль\]` в заголовке, и адресат в
// скобках читался бы как второй автор. Пустой список означает broadcast.
export function blockTargets(header) {
  const match = String(header ?? "").match(/→\s*([^\n]+)$/);
  if (!match) return [];
  return match[1].split(",").map((value) => value.trim()).filter(Boolean);
}

export function normalizeCwd(value) {
  return resolve(String(value || process.cwd())).replace(/\\/g, "/").toLowerCase();
}
