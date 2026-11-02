// The ledger's storage foundation, shared by every command: where a project's
// requirements live, which repository the ledger belongs to, how a file is
// replaced without a reader ever seeing half of it, how a number is handed out
// exactly once, the project lock, and the audit log. Commands compose these;
// nothing here prints.
import { randomBytes } from "node:crypto";
import {
  closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { bodyDigest, emitRecord, fileNameFor, idFor, newRecord, parseRecord, RecordError } from "./record.mjs";
import { nowIso, sleepSync } from "./time.mjs";

// The real filesystem functions `writeFileAtomic` needs. Tests pass a recording
// stand-in to observe the order of fsync and rename; production code never does.
export const realIO = { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync };

export class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = "LockError";
  }
}

// Same rule as Workloop (workloop.mjs `workloopRoot`), read rather than imported:
// a `~` in WORKLOOP_ROOT stands for the home directory.
export const workloopRoot = () =>
  resolve((process.env.WORKLOOP_ROOT || join(homedir(), ".workloop")).replace(/^~(?=$|[\\/])/, homedir()));

// Same rule as Workloop's `project`, so a ledger sits beside its project's runs.
export const projectKey = (repoPath) => basename(repoPath).toLowerCase().replace(/[^a-z0-9-]+/g, "-");

export const ledgerDir = (project) => join(workloopRoot(), project, ".requirements");
export const metaPath = (dir) => join(dir, "_meta.json");
export const logPath = (dir) => join(dir, "_log.jsonl");
export const requirementPath = (dir, file) => join(dir, file);

// ---------------------------------------------------------------- atomic files

// A temp file in the same directory, then a rename: a reader sees the old file or
// the new one, never a half-written file. The temp file is fsynced before the
// rename and the directory after it, so the rename cannot reach the disk ahead of
// the data it points at. (A directory cannot be fsynced on Windows; atomicity
// there rests on the rename alone.)
// Windows refuses for a moment to replace a file another process has open — a
// reader, an antivirus scan, the indexer. Retry briefly, as the workloop's own
// atomic write does; any other error, or one that outlasts the retries, stands.
function renameReplacing(io, from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      io.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      sleepSync(50);
    }
  }
}

export function writeFileAtomic(path, text, io = realIO) {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = io.openSync(tmp, "wx", 0o666);
  try {
    io.writeFileSync(fd, text);
    io.fsyncSync(fd);
  } catch (error) {
    try { io.closeSync(fd); } catch {}
    try { io.unlinkSync(tmp); } catch {}
    throw error;
  }
  io.closeSync(fd);
  try {
    renameReplacing(io, tmp, path);
  } catch (error) {
    try { io.unlinkSync(tmp); } catch {}
    throw error;
  }
  let dirFd;
  try {
    dirFd = io.openSync(dir, "r");
    io.fsyncSync(dirFd);
  } catch (error) {
    // Durability of the directory entry is best effort; only a filesystem that
    // cannot open or sync a directory at all is forgiven, not a real write error.
    if (!["EISDIR", "EINVAL", "EPERM", "EACCES", "EBADF", "ENOTSUP"].includes(error.code)) throw error;
  } finally {
    if (dirFd !== undefined) { try { io.closeSync(dirFd); } catch {} }
  }
}

// ---------------------------------------------------------------- meta

// `lastIssued` is the allocator's source of truth: the high-water mark of every
// number ever handed out. It is read from the value, not from its JSON type — a
// number stored as text ("12", by a hand edit or another tool) is still 12, and
// discarding it would let a number the ledger already issued be issued again.
// Only a value that does not read as a non-negative integer is unreadable; the
// callers then repair upward from the files, never downward.
export function readMeta(dir) {
  const path = metaPath(dir);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      project: null, lastIssued: 0, rawLastIssued: null, updated_at: null, typeMismatch: false,
      problem: error.code === "ENOENT" ? "missing" : error.message,
    };
  }
  try {
    const parsed = JSON.parse(text);
    const raw = parsed?.lastIssued;
    const numeric = typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
    const lastIssued = Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
    return {
      project: typeof parsed?.project === "string" ? parsed.project : null,
      lastIssued: lastIssued ?? 0,
      rawLastIssued: raw,
      updated_at: typeof parsed?.updated_at === "string" ? parsed.updated_at : null,
      typeMismatch: lastIssued !== null && typeof raw !== "number",
      problem: lastIssued === null ? `lastIssued is not a non-negative integer (${JSON.stringify(raw)})` : null,
    };
  } catch (error) {
    return { project: null, lastIssued: 0, rawLastIssued: null, updated_at: null, typeMismatch: false, problem: `not valid JSON: ${error.message}` };
  }
}

export function writeMeta(dir, { project, lastIssued, now = nowIso() }, io = realIO) {
  writeFileAtomic(metaPath(dir), `${JSON.stringify({ project, lastIssued, updated_at: now }, null, 2)}\n`, io);
}

// ---------------------------------------------------------------- requirement files

const REQUIREMENT_FILE = /^REQ-(\d{3,})-(.*)\.md$/;

export function listRequirementFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const match = REQUIREMENT_FILE.exec(name);
      return match ? { file: name, number: Number(match[1]), id: idFor(Number(match[1])) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number || a.file.localeCompare(b.file));
}

export const highestNumber = (files) => files.reduce((max, file) => Math.max(max, file.number), 0);

export function nextNumber(dir) {
  return Math.max(readMeta(dir).lastIssued, highestNumber(listRequirementFiles(dir))) + 1;
}

// The number is persisted before the file that uses it exists. An interruption
// between the two leaves a gap, which is harmless; a number is never reused and
// never handed back.
export function allocateId(dir, { project, now = nowIso(), io = realIO } = {}) {
  mkdirSync(dir, { recursive: true });
  const n = nextNumber(dir);
  writeMeta(dir, { project, lastIssued: n, now }, io);
  return n;
}

// ---------------------------------------------------------------- lock

// Holds the project lock for the duration of `fn`. A lock left behind by a dead
// process is taken over; one whose holder cannot be shown to be dead is not,
// because taking a live writer's lock loses its work.
// `REQ_LOCK_WAIT_MS` shortens the wait in tests, and `beforeBreak` lets a test act
// as a second contender between judging a lock dead and breaking it; nothing else
// needs either.
export function withLock(dir, fn, options = {}) {
  const { waitMs = Number(process.env.REQ_LOCK_WAIT_MS) || 2000, sleep = sleepSync, beforeBreak } = options;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".lock");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      takeLockFile(path);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = lockHolder(path);
      if (holder.state === "unknown") throw new LockError(holder.reason);
      if (holder.state === "alive") {
        if (Date.now() > deadline) {
          throw new LockError(`the ledger is locked by process ${holder.pid}, which is still running (${path}); ` +
            "retry when it finishes, or remove the file if you know that process is gone");
        }
        sleep(50);
        continue;
      }
      if (holder.state !== "dead") continue;
      beforeBreak?.();
      if (breakStaleLock(path, holder.text)) continue;
      // Another contender is breaking the same stale lock; look again once it is done.
      if (Date.now() > deadline) throw new LockError(breakGuardStuck(`${path}.break`));
      sleep(50);
    }
  }
  const release = () => {
    // Delete only our own lock: a longer-running sibling may already have taken
    // over after a slow tick.
    const holder = lockHolder(path);
    if (holder.state === "alive" && holder.pid === process.pid) { try { unlinkSync(path); } catch {} }
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    release();
    throw error;
  }
  if (typeof result?.then === "function") return result.finally(release);
  release();
  return result;
}

function lockHolder(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { state: "gone" };
    return { state: "unknown", reason: `the ledger lock ${path} cannot be read (${error.message}); refusing to take it over` };
  }
  let holder;
  try {
    holder = JSON.parse(text);
  } catch {
    holder = null;
  }
  const pid = Number(holder?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      state: "unknown",
      reason: `the ledger lock ${path} does not name a usable pid (${JSON.stringify(text.trim())}); ` +
        "without that, whether its writer is still running cannot be established, so it is not taken over — inspect it yourself",
    };
  }
  if (alive(pid)) return { state: "alive", pid };
  return { state: "dead", pid, text };
}

// Two contenders can judge the same dead lock at once. If each simply deleted it,
// the slower one could delete the lock the faster one had just taken, and both
// would write. Breaking is therefore serialised by a guard file, and the lock is
// removed only while it still holds the very text that was judged dead. False
// means another contender holds the guard, so nothing was decided here.
function breakStaleLock(path, judged) {
  const guard = `${path}.break`;
  try {
    takeLockFile(guard);
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    let current;
    try {
      current = readFileSync(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
    if (current === judged) unlinkSync(path);
    return true;
  } finally {
    try { unlinkSync(guard); } catch {}
  }
}

// The guard is held only for one read and one delete, so one still there at the
// deadline was most likely left by a process that died in between. Whether it may
// go is the user's call, as with any lock whose holder cannot be confirmed.
function breakGuardStuck(guard) {
  const holder = lockHolder(guard);
  const who = holder.state === "dead" ? `process ${holder.pid}, which is no longer running`
    : holder.state === "alive" ? `process ${holder.pid}, which is still running` : "a process that cannot be identified";
  return `the ledger lock is stale, but ${guard}, left by ${who}, is still clearing it; ` +
    "retry, or remove that file if you know no req command is running";
}

// The lock appears with its pid already inside it: the content is written to a
// temp file and hard-linked into place, and `link` fails if the lock exists. A
// contender therefore never reads a lock file it cannot judge.
function takeLockFile(path) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o666);
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: nowIso() })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// `EPERM` means the process exists but belongs to another user: alive, not dead.
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// ---------------------------------------------------------------- audit log

export function readLog(dir) {
  let text;
  try {
    text = readFileSync(logPath(dir), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ unreadable: line });
    }
  }
  return entries;
}

export const nextSeq = (entries) => entries.reduce((max, entry) => Math.max(max, Number(entry.seq) || 0), 0) + 1;

// The log is an audit trail, not a transaction: the requirement file is already
// authoritative when this runs, so a failed append is reported by `doctor`
// (and re-recorded by `doctor --repair-log`) instead of failing the command that
// made the change.
export function appendLog(dir, entry) {
  try {
    writeFileSync(logPath(dir), `${JSON.stringify(entry)}\n`, { flag: "a" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// One line describing a write that landed: enough for `doctor` to notice a file
// whose `rev` or prose no longer matches anything the CLI recorded.
export function auditEntry({ dir, op, record, body, file, now = nowIso(), extra = {} }) {
  return {
    seq: nextSeq(readLog(dir)),
    at: now,
    op,
    id: record.id,
    rev: record.rev,
    body_sha: bodyDigest(body),
    file,
    ...extra,
  };
}

// ---------------------------------------------------------------- records on disk

export function readRequirement(dir, file) {
  const text = readFileSync(requirementPath(dir, file), "utf8");
  const { frontmatter, body } = parseRecord(text);
  return { file, frontmatter, body };
}

// Reads every parseable record. Damaged files are returned with their error so
// `doctor` can report them and the other checks can keep going.
export function readRequirements(dir) {
  return listRequirementFiles(dir).map(({ file, number }) => {
    try {
      const { frontmatter, body } = readRequirement(dir, file);
      return { file, number, frontmatter, body, error: null };
    } catch (error) {
      if (!(error instanceof RecordError)) throw error;
      return { file, number, frontmatter: null, body: null, error: error.message };
    }
  });
}

// ---------------------------------------------------------------- repository binding

// The URL form with credentials in front of the host, and the scp form
// `git@github.com:owner/repo.git`, both become `github.com/owner/repo`:
// credentials never reach the ledger, a finding or a refusal.
export function sanitiseRemote(url) {
  let text = String(url ?? "").trim();
  if (!text) return null;
  const hadScheme = /^[a-z+]+:\/\//i.test(text);
  text = text.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  // `git@github.com:owner/repo.git` separates host and path with a colon; a URL
  // with a scheme does not, so its colon may be a port and is left alone.
  if (!hadScheme) text = text.replace(/^([^/:]+):(?!\/)/, "$1/");
  return text.replace(/\/+$/, "").replace(/\.git$/, "") || null;
}

// `repo_path` may name a symlinked or not-yet-created path: the comparison is on
// the canonical form when both resolve, and on the normalised text otherwise.
export function sameRepoPath(a, b) {
  const canonical = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return canonical(a) === canonical(b);
}

// The repository this ledger already belongs to, when a record says so and that
// answer disagrees with the one running the command. A record that records
// neither field — an older ledger, or one written before the binding existed —
// says nothing here, and never blocks a write. Only a recorded value that
// disagrees refuses.
function repoConflict(dir, { repoPath, repoRemote = null } = {}) {
  const currentRemote = sanitiseRemote(repoRemote);
  for (const requirement of readRequirements(dir)) {
    if (requirement.error) continue;
    const { id, repo_path: recordedPath, repo_remote: recordedRemote } = requirement.frontmatter;
    if (typeof recordedPath === "string" && recordedPath && repoPath && !sameRepoPath(recordedPath, repoPath)) {
      return { id, field: "repo_path", recorded: recordedPath, current: repoPath };
    }
    const recorded = typeof recordedRemote === "string" ? sanitiseRemote(recordedRemote) : null;
    if (recorded && currentRemote && recorded !== currentRemote) {
      return { id, field: "repo_remote", recorded, current: currentRemote };
    }
  }
  return null;
}

// §3.1: the ledger belongs to one repository. The refusal names both sides, and
// only ever the sanitised remote, so a recorded credential cannot be printed.
class RepoMismatchError extends Error {
  constructor({ id, field, recorded, current }) {
    const now = field === "repo_path" ? "this command runs in" : "this repository is";
    super(`${id} records this ledger as ${recorded}, but ${now} ${current}: ` +
      "`new` does not append to another repository's ledger. Run it from that repository, " +
      "or give this one its own ledger with --project <slug>");
    this.name = "RepoMismatchError";
  }
}

// `new`: allocate, then write the file, then record the write. The caller holds
// the lock.
export function createRequirement({ project, repoPath, repoRemote = null, title, aliases = [], now = nowIso(), io = realIO }) {
  const dir = ledgerDir(project);
  return withLock(dir, () => {
    // Answered before a number is allocated or a file is written, so a refused
    // `new` leaves the ledger — including `_meta.json` — exactly as it was.
    const conflict = repoConflict(dir, { repoPath, repoRemote });
    if (conflict) throw new RepoMismatchError(conflict);
    const n = allocateId(dir, { project, now, io });
    const record = newRecord({ id: idFor(n), title, aliases, repoPath, repoRemote, now });
    const body = `## Summary\n\n## History\n\n## Notes\n`;
    const file = fileNameFor(record.id, title);
    writeFileAtomic(requirementPath(dir, file), emitVerified(record, body), io);
    const audit = appendLog(dir, auditEntry({ dir, op: "new", record, body, file, now }));
    return { id: record.id, dir, file, path: requirementPath(dir, file), record, body, audit };
  });
}

// Defence in depth: a record the ledger writes must be one it can read back. The
// emitted text is parsed and compared before anything is replaced, so an emitter
// bug fails the write — with the old file, the meta and the log untouched — instead
// of leaving a record whose next `list` calls it unreadable.
function emitVerified(record, body) {
  const text = emitRecord(record, body);
  const refuse = (why) => new RecordError(`refusing to write ${record.id}: ${why}`, "unwritable-record");
  let parsed;
  try {
    parsed = parseRecord(text).frontmatter;
  } catch (error) {
    throw refuse(`the emitted frontmatter does not parse back (${error.message})`);
  }
  if (!isDeepStrictEqual(parsed, emittedShape(record))) {
    throw refuse("the emitted frontmatter does not read back as the same record");
  }
  return text;
}

// What `emitRecord` is meant to preserve: `emitMapping` skips a key whose value is
// `undefined`, so the round trip is the record minus those keys. A list keeps its
// length — the emitter writes an `undefined` item as text rather than dropping it,
// so an array member is compared as it stands.
function emittedShape(value) {
  if (Array.isArray(value)) return value.map(emittedShape);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = emittedShape(item);
    return out;
  }
  return value;
}

// Any later CLI write to a record: bump the CLI-managed revision, stamp the time,
// replace the file, then record the write. The caller holds the lock.
export function saveRequirement({ dir, file, record, body, op, now = nowIso(), io = realIO, extra = {}, previous = null }) {
  const next = { ...record, rev: record.rev + 1, updated_at: now };
  writeFileAtomic(requirementPath(dir, file), emitVerified(next, body), io);
  const audit = appendLog(dir, auditEntry({ dir, op, record: next, body, file, now, extra: { ...(previous ? { previous } : {}), ...extra } }));
  return { record: next, audit };
}
