#!/usr/bin/env node
// Установщик house-слоя из этого репозитория в профиль omp.
// Источник истины — src/ этого репо. Профили — потребители.
//
// Использование:
//   node install.mjs --profile <profile> [--dry-run]
//   node install.mjs --all-in ~/.omp/profiles.json (не реализовано; ставим по одному)
//
// Что делает:
//   1. Копирует 6 файлов из src/ в ~/.omp/profiles/<имя>/agent/ с бэкапом старых.
//   2. Пишет house-install.json в профиль: версия, время, md5 каждого файла.
//   3. После копирования сверяет md5 с обеих сторон (правило: синк = md5, не cp).

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const profileIdx = args.indexOf("--profile");
const dryRun = args.includes("--dry-run");
if (profileIdx === -1 || !args[profileIdx + 1]) {
  console.error("Использование: node install.mjs --profile <имя> [--dry-run]");
  process.exit(2);
}
const profile = args[profileIdx + 1];

const repoRoot = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(repoRoot, "src");
const profileAgent = resolve(process.env.USERPROFILE ?? process.env.HOME, ".omp", "profiles", profile, "agent");
if (!existsSync(profileAgent)) {
  console.error(`HOUSE_ERROR: профиль не найден: ${profileAgent}`);
  process.exit(2);
}

// Соответствие: файл в src/ → место в профиле.
const MANIFEST = [
  { src: "house.mjs", dest: "house/house.mjs" },
  { src: "courier.mjs", dest: "house/courier.mjs" },
  { src: "house-lock.mjs", dest: "house/house-lock.mjs" },
  { src: "extensions/house.ts", dest: "extensions/house.ts" },
  { src: "hooks/pre/house-watch.ts", dest: "hooks/pre/house-watch.ts" },
  { src: "hooks/pre/house-session-registry.ts", dest: "hooks/pre/house-session-registry.ts" },
];

const md5 = (p) => createHash("md5").update(readFileSync(p)).digest("hex");

// Бэкап: <dest>.bak-<UTC-штамп>, рядом с файлом, не молча.
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

console.log(`Дом ${profile}: установка из ${repoRoot}`);
if (dryRun) console.log("(dry-run: файлы не трогаю)\n");

// Бэкапы прореживаются по dest, а не по общей дате: один свежий бэкап house.mjs
// иначе вытеснил бы более старый бэкап courier.mjs, и картина снова соврала бы.
// Для дома, построенного на недоверии к состоянию, пять версий courier.mjs рядом с
// настоящей — мина для следующей проверки. История всё равно в git.
const KEEP_BACKUPS = 2;

function pruneBackups(dest, kept) {
  const directory = dirname(dest);
  const prefix = `${basename(dest)}.bak-`;
  let stale;
  try {
    stale = readdirSync(directory).filter((name) => name.startsWith(prefix)).sort();
  } catch {
    return 0;
  }
  // Сортировка лексикографическая, а метка в имени — это ISO с тире вместо
  // двоеточия, поэтому порядок хронологический.
  const drop = stale.slice(0, Math.max(0, stale.length - kept));
  for (const name of drop) {
    try {
      rmSync(join(directory, name), { force: true });
    } catch {}
  }
  return drop.length;
}

const record = { version: null, installedAt: new Date().toISOString(), profile, files: [] };
for (const item of MANIFEST) {
  const src = join(srcRoot, item.src);
  const dest = join(profileAgent, item.dest);
  if (!existsSync(src)) {
    console.error(`HOUSE_ERROR: нет в src: ${item.src}`);
    process.exit(2);
  }
  const hash = md5(src);
  const changed = !existsSync(dest) || md5(dest) !== hash;
  if (!changed) {
    console.log(`  = ${item.dest} (уже актуален)`);
    record.files.push({ file: item.dest, src: item.src, md5: hash, changed: false });
    continue;
  }
  if (dryRun) {
    console.log(`~ ${item.dest} (будет заменён${existsSync(dest) ? ", бэкап будет" : ""})`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) copyFileSync(dest, `${dest}.bak-${stamp}`);
  copyFileSync(src, dest);
  // Сверка после копирования: cp врал хотя бы однажды, md5 — нет.
  if (md5(dest) !== hash) {
    console.error(`HOUSE_ERROR: md5 после копирования не сошёлся: ${item.dest}`);
    process.exit(2);
  }
  console.log(`  + ${item.dest} (md5 ${hash.slice(0, 8)}, ${existsSync(`${dest}.bak-${stamp}`) ? "бэкап" : "новый"})`);
  record.files.push({ file: item.dest, src: item.src, md5: hash, changed: true });
}

// Прореживание идёт по всем файлам манифеста, а не только по заменённым: иначе
// у файла, который давно не менялся, копии копились бы вечно — ровно то, из-за чего
// в каталоге профиля и лежали пять версий одного и того же.
for (const item of MANIFEST) {
  const dest = join(profileAgent, item.dest);
  const prunedBackups = pruneBackups(dest, KEEP_BACKUPS);
  if (prunedBackups) console.log(`    прорежено бэкапов ${item.dest}: ${prunedBackups} (оставлено ${KEEP_BACKUPS})`);
}

// Версия дом-репо из package.json.
record.version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
// Путь к репозиторию в манифесте: без него `house verify` сверит профиль только
// сам с собой и не увидит, что источник уехал вперёд.
record.sourceRoot = repoRoot;

if (!dryRun) {
  const installLog = join(profileAgent, "house-install.json");
  writeFileSync(installLog, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nЗаписан ${installLog}: house ${record.version}`);
  console.log("Перезапусти omp-сессии этого профиля: расширения и хуки читаются на старте.");
}
