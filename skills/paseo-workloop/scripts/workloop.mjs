#!/usr/bin/env node
// workloop — run state and Rex/git mechanics for the paseo-workloop skill
// (rex-local: executors and reviewers are headless CLI turns in Rex tabs).
//
// The orchestrating agent makes the judgement calls; this script owns the
// bookkeeping and the invariants (verified bases, budgets, frozen candidates,
// review before integration, cleanup guards) and starts every agent turn and
// makes every git call, so they happen the same way every time.
//
// Zero dependencies, Node >= 18.  `node workloop.mjs help` lists the commands.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ADAPTERS, PROVIDERS, settingsProblem } from "./agents.mjs";
import * as host from "./rex.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_RUN = join(HERE, "agent-run.mjs");
const SKILL_DIR = resolve(HERE, "..");
const SKILLS_ROOT = resolve(SKILL_DIR, "..");
const TEMPLATES = join(SKILL_DIR, "templates");
const CHECK_RUNNER = join(HERE, "check-run.mjs");
const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));
const WIN = process.platform === "win32";
const BUSY = new Set(["running", "initializing", "starting"]);

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };
const say = (...a) => console.log(...a);
const now = () => new Date().toISOString();
const short = (sha) => (sha ? sha.slice(0, 8) : "-");
const tail = (s, n) => s.split("\n").slice(-n).join("\n");
// How long ago a recorded time was, such as a running turn's last output: a turn
// silent since yesterday reads as one.
const ago = (iso) => {
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(min)) return "at an unknown time";
  return min < 1 ? "just now" : min < 120 ? `${min}m ago` : min < 48 * 60 ? `${Math.floor(min / 60)}h ago` : `${Math.floor(min / 1440)}d ago`;
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------------------------------------------------------------- processes

function run(cmd, args, { cwd, allowFail = false, trim = true } = {}) {
  let r;
  for (let attempt = 0; ; attempt++) {
    r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
    // Windows can temporarily refuse to start Git under load. Retry only a
    // failed spawn with no child PID; never replay a command that already ran.
    if (cmd !== "git" || r.error?.code !== "EBUSY" || r.pid > 0 || attempt === 3) break;
    sleep(100 * 2 ** attempt);
  }
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  const text = r.stdout || "";
  const res = { code: r.status, out: trim ? text.trim() : text, err: (r.stderr || "").trim() };
  if (res.code !== 0 && !allowFail) fail(`${cmd} ${args.join(" ")} failed (exit ${res.code}):\n${res.err || res.out.trim()}`);
  return res;
}
const git = (cwd, ...args) => run("git", ["-C", cwd, ...args]).out;
const gitTry = (cwd, ...args) => run("git", ["-C", cwd, ...args], { allowFail: true });
// Untrimmed output, for NUL-separated records whose leading space carries meaning (porcelain's " M path").
const gitRaw = (cwd, ...args) => run("git", ["-C", cwd, ...args], { trim: false }).out;

// User-configured setup/check commands run through the platform shell.
function sh(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", maxBuffer: 64 << 20 });
  return { ok: r.status === 0, output: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}
function runAll(cmds, cwd) {
  for (const cmd of cmds) {
    const r = sh(cmd, cwd);
    if (!r.ok) return { ok: false, cmd, output: tail(r.output, 40) };
  }
  return { ok: true };
}

// ------------------------------------------------------------------- checks
//
// Every check the script runs stops at the run's limit. A check is the user's
// command, possibly a shell wrapping anything, so the whole process tree goes
// with it: a fresh process group on POSIX, `taskkill /T /F` on Windows. The
// check runner is the one asynchronous part of this script (a check's pipe can
// outlive the check), so the commands that run checks await it.
//
// A timed-out check is a failed check: the caller's normal failure path
// (rollback, refusal) follows, and the output says the limit was the cause.

const DEFAULT_CHECK_TIMEOUT = 30; // minutes
// One day, well inside Node's timer range (about 24.8 days); a longer timer fires at once.
const MAX_CHECK_TIMEOUT = 1440;
// One wording for a check that ran out of time, wherever a command reports it.
const timedOut = (cmd, minutes) => `\`${cmd}\` timed out after ${minutes} minutes; it and every process it spawned were stopped`;
const checkLimit = (s) => {
  const n = Number(s?.config?.checkTimeout);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_CHECK_TIMEOUT) : DEFAULT_CHECK_TIMEOUT;
};
function checkTimeoutSetting(value) {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_CHECK_TIMEOUT) fail(`--check-timeout takes a positive number of minutes up to ${MAX_CHECK_TIMEOUT} (decimals allowed)`);
  return n;
}

// The cap on rework rounds. Past it the task waits for the user, who can grant one
// more round with `send --extra-round --reason`, which `finish` then lists.
const DEFAULT_MAX_REWORK_ROUNDS = 2;
const reworkCap = (s) => s.config?.maxReworkRounds ?? DEFAULT_MAX_REWORK_ROUNDS;
function maxRoundsSetting(value) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`--max-rework-rounds takes a whole number of rounds, 0 or more; got "${value}"`);
  return n;
}

// Stopping a check: its process group on POSIX (a process that leaves the group
// on purpose, a daemon, is outside the contract), its tree on Windows. A stop is
// verified, not assumed: `signalCheck` reports a failed signal, and the caller
// then waits until `checkRunning` confirms the group (or pid) is gone.
const groupExists = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const checkRunning = (pid, win = WIN) => (win ? alive(pid) : groupExists(pid));
const stopWhat = (pid, win = WIN) => (win ? `pid ${pid}` : `process group ${pid}`);
function signalCheck(pid, win = WIN) {
  if (win) {
    let r;
    try { r = run("taskkill", ["/pid", String(pid), "/T", "/F"], { allowFail: true }); } catch (e) { return { ok: false, error: e.message }; }
    return r.code === 0 ? { ok: true } : { ok: false, error: `taskkill exited ${r.code}: ${r.err || r.out}` };
  }
  try { process.kill(-pid, "SIGKILL"); } catch (e) {
    if (e.code !== "ESRCH") return { ok: false, error: `kill(-${pid}, SIGKILL): ${e.code || e.message}` };
  }
  return { ok: true };
}
const STOP_CONFIRM_MS = 5000;
// Synchronous stop for recovery: {ok} or {ok: false, error} naming what survived.
export function stopCheckNow(pid, win = WIN) {
  const r = signalCheck(pid, win);
  if (!r.ok) return r;
  for (const end = Date.now() + STOP_CONFIRM_MS; checkRunning(pid, win);) {
    if (Date.now() > end) return { ok: false, error: `${stopWhat(pid, win)} still exists ${STOP_CONFIRM_MS / 1000} s after it was killed` };
    sleep(50);
  }
  return { ok: true };
}
// The same for a check this process started: the event loop must run, so Node
// reaps the killed wrapper and its group can disappear.
async function stopCheck(pid) {
  const r = signalCheck(pid);
  if (!r.ok) return r;
  for (const end = Date.now() + STOP_CONFIRM_MS; checkRunning(pid);) {
    if (Date.now() > end) return { ok: false, error: `${stopWhat(pid)} still exists ${STOP_CONFIRM_MS / 1000} s after it was killed` };
    await new Promise((done) => setTimeout(done, 50));
  }
  return { ok: true };
}

// What a pid is now, judged by its command line: "match" when it carries every
// marker, "other" when it belongs to something else (a reused pid), "gone", or
// "unknown" when the command line cannot be read. Only "match" is signalled.
export function processIdentity(pid, markers) {
  if (!pid || !alive(pid)) return "gone";
  let r;
  try {
    r = WIN
      ? run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { allowFail: true })
      : run("ps", ["-ww", "-o", "command=", "-p", String(pid)], { allowFail: true });
  } catch { return "unknown"; }
  if (r.code !== 0 || !r.out) return alive(pid) ? "unknown" : "gone";
  return markers.every((m) => r.out.includes(m)) ? "match" : "other";
}

// One command under the limit, started through check-run.mjs. `onSpawn(pid,
// token)` records the check's identity; only then is the wrapper told to run
// the command, so a check never works unrecorded. A process the check left
// behind can hold its output pipes open, so the result never waits on them long.
export function runOneCheck(cmd, cwd, limitMs, onSpawn, logPath) {
  return new Promise((resolve) => {
    const logFd = logPath ? openSync(logPath, "wx", 0o600) : null;
    let logError;
    const token = `wl-check-${randomUUID()}`;
    // Detached on every platform: on POSIX the wrapper leads its own process group;
    // on Windows it stays out of this process's job object, which would otherwise
    // end the wrapper with an interrupted owner and strand its tree beyond recovery.
    const child = spawn(process.execPath, [CHECK_RUNNER, token, cmd], { cwd, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    let ending = false; // the wrapper exited or the limit expired; cleanup decides the result
    let closed = false;
    let result = null;
    let grace;
    const collect = (d) => {
      output = (output + d).slice(-(1 << 20));
      if (logFd !== null && !logError) {
        try { writeFileSync(logFd, d); } catch (e) { logError = e.message; }
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdin.on("error", () => { /* the wrapper exited; its exit is reported below */ });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref(); // a check whose stop failed must not keep this process alive
      if (logFd !== null) {
        try { closeSync(logFd); } catch (e) { logError ??= e.message; }
      }
      if (logError) { output += `\ncheck log failed: ${logError}`; result = { ...result, ok: false, logError }; }
      resolve({ exitCode: null, signal: null, ...result, output: tail(output.trim(), 40) });
    };
    // Whether the limit expires or the wrapper exits (normally, crashed or
    // killed), the check is settled only once its group is confirmed gone,
    // survivors stopped; a failed stop is part of the result, so the caller keeps
    // the phase for recovery. Windows has no group to sweep after an exit.
    const cleanUp = async (timedOut, ok) => {
      const stop = timedOut || !WIN ? await stopCheck(child.pid) : { ok: true };
      if (!stop.ok) output += `\ncleanup failed: ${stop.error}`;
      return { ok: ok && stop.ok, ...(timedOut && { timedOut }), ...(stop.ok ? {} : { cleanupFailed: { pid: child.pid, token, error: stop.error } }) };
    };
    const timer = setTimeout(async () => {
      if (ending) return;
      ending = true;
      finish(await cleanUp(true, false));
    }, limitMs);
    child.on("error", (e) => { output += `\n${e.message}`; if (!ending) finish({ ok: false }); });
    child.on("exit", async (code, signal) => {
      if (ending) return;
      ending = true;
      clearTimeout(timer);
      result = { ...await cleanUp(false, code === 0), exitCode: code, signal };
      if (closed) return finish(result);
      grace = setTimeout(() => finish(result), 1000); // a pipe a stopped process held may close late
    });
    child.on("close", () => { closed = true; if (result) finish(result); });
    if (!child.pid) return;
    try { onSpawn?.(child.pid, token); } catch (e) {
      // Closing stdin without "go" ends the wrapper before the command starts.
      child.stdin.end();
      output += `\nnot run: ${e.message}`;
      return finish({ ok: false });
    }
    child.stdin.end("go\n");
  });
}

// Runs check commands one at a time, each under the full limit, and names the
// first that fails. Every phase that runs checks goes through here. An entry may
// be a command string or `{cmd, ...}`; an entry's extra fields come back with the
// failure, so an acceptance command keeps the ticket it proves.
export async function runChecks(cmds, cwd, minutes, onSpawn) {
  for (const item of cmds) {
    const { cmd, ...meta } = typeof item === "string" ? { cmd: item } : item;
    const r = await runOneCheck(cmd, cwd, Math.max(1, Math.round(minutes * 60000)), onSpawn);
    if (!r.ok) return { cmd, ...meta, ...r };
  }
  return { ok: true };
}

// cmd.exe gets one command string; Node does not escape args under shell:true.
export function winQuote(arg) {
  const s = String(arg);
  if (/["%\r\n]/.test(s)) fail(`argument cannot be passed safely through cmd.exe: ${s}`);
  return s === "" || /[\s&|<>^()!,;=]/.test(s) ? `"${s}"` : s;
}
const shellArg = (s) => WIN ? winQuote(s) : `'${String(s).replace(/'/g, "'\\''")}'`;

const pathArg = (p) => (WIN ? p.replace(/\\/g, "/") : p);
const untilde = (p) => (p && /^~(?=$|[\\/])/.test(p) ? join(homedir(), p.slice(1)) : p);

// --------------------------------------------------------------- agents
//
// An agent is one conversation with a CLI (an executor's, a reviewer's) in one
// worktree. Each prompt it gets is a turn: a headless process in its own Rex tab
// (agent-run.mjs) that exits when the turn is over. The run keeps its agents in
// state, `s.agents[id]`, with every turn's tab and files; a turn's meta file
// carries the conversation id the next turn goes on in.
//
// A command reads one run, so the agents `inspectAgent` and `requireIdle` look up
// are those of the state `loadState` last read.
let CURRENT = null;
const turnFiles = (base) => ({ prompt: `${base}.prompt.md`, log: `${base}.log`, meta: `${base}.json`, spec: `${base}.spec.json` });
function turnMeta(turn) {
  try { return JSON.parse(readFileSync(turnFiles(turn.base).meta, "utf8")); } catch { return null; }
}
function agentRecord(id) {
  const a = CURRENT?.s.agents?.[id];
  if (!a) {
    const e = new UserError(`agent ${id} is not one of this run's`);
    e.agentMissing = true;
    throw e;
  }
  return a;
}
// running · idle (its last turn exited 0) · error (it exited otherwise) · closed (its
// tab went before the turn said how it ended) · missing (no turn started) · unknown
// (Rex could not be asked).
function inspectAgent(id) {
  const a = agentRecord(id);
  const turn = a.turns.at(-1);
  if (!turn) return { id, status: "missing", archived: true, pending: 0, updatedAt: null };
  const meta = turnMeta(turn);
  let logAt = null;
  try { logAt = statSync(turnFiles(turn.base).log).mtime.toISOString(); } catch { /* nothing printed yet */ }
  const base = { id, pending: 0, updatedAt: logAt ?? meta?.startedAt ?? turn.startedAt, turn, archived: Boolean(a.archivedAt) };
  let p;
  try { p = host.processState(CURRENT.s.rex.session, turn.block); } catch (e) {
    if (!(e instanceof host.RexError)) throw e;
    return { ...base, status: "unknown", error: e.message };
  }
  if (p.state === "running") return { ...base, status: "running" };
  const code = p.exitCode ?? meta?.exitCode ?? null;
  return { ...base, status: code == null ? "closed" : code === 0 ? "idle" : "error", exitCode: code };
}
const settingsOf = (l) => Object.fromEntries(["model", "mode", "profile", "thinking"].filter((k) => l[k]).map((k) => [k, l[k]]));
function newAgent(s, { role, task, attempt, cwd, launch }) {
  s.agents ||= {};
  let id;
  do id = randomUUID().slice(0, 8); while (s.agents[id]);
  s.agents[id] = { id, role, task, attempt: attempt ?? null, cwd: pathArg(cwd), provider: launch.provider, settings: settingsOf(launch), launch: describe(launch), session: null, turns: [], createdAt: now() };
  return id;
}
// Start the first turn in the session's initial tab; later turns get new tabs.
function openTurn(s, title, cwd, argv) {
  if (s.rex?.session && host.sessionExists(s.rex.session)) return host.openTab(s.rex.session, title, cwd, argv);
  const label = `wl-${s.project}-${s.feature}`;
  const tab = host.newSession(label, title, cwd, argv);
  s.rex = { session: tab.session, label, createdAt: now() };
  return tab;
}
// Starts the agent's next turn with `prompt` in a new tab. A turn after the first
// goes on in the same conversation; the previous turn's tab closes, and its files
// stay in the run.
function startTurn(dir, s, id, prompt, title) {
  const a = s.agents[id];
  const prev = a.turns.at(-1);
  if (prev && !a.session) a.session = turnMeta(prev)?.session ?? null;
  if (prev && !a.session) fail(`agent ${id}'s last turn left no conversation id (${turnFiles(prev.base).meta}), so a new turn cannot go on in it; \`retry\` the task instead`);
  const n = a.turns.length + 1;
  mkdirSync(join(dir, "turns"), { recursive: true });
  const base = pathArg(join(dir, "turns", `${id}-${n}`));
  const f = turnFiles(base);
  writeFileSync(f.prompt, prompt);
  writeFileSync(f.spec, `${JSON.stringify({ provider: a.provider, settings: a.settings, session: a.session, prompt: f.prompt, log: f.log, meta: f.meta, cwd: a.cwd, title }, null, 2)}\n`);
  const tab = openTurn(s, title, a.cwd, [process.execPath, AGENT_RUN, f.spec]);
  a.turns.push({ n, title, block: tab.block, window: tab.window, base, startedAt: now() });
  if (prev) host.closeTab(s.rex.session, prev.block);
  return a.turns.at(-1);
}
// Closes every tab the agent's turns left open; their files stay in the run.
function archiveAgent(s, id) {
  const a = s.agents?.[id];
  if (!a || a.archivedAt) return;
  if (s.rex?.session) for (const t of a.turns) host.closeTab(s.rex.session, t.block);
  a.archivedAt = now();
}

function normPath(p) {
  if (!p) return "";
  let q = untilde(p);
  // Native Windows resolution expands 8.3 aliases such as RUNNER~1.
  try { q = WIN ? realpathSync.native(q) : realpathSync(q); } catch { q = resolve(q); }
  q = q.replace(/\\/g, "/").replace(/\/+$/, "");
  return WIN ? q.toLowerCase() : q;
}

// --------------------------------------------------------------- run state

const workloopRoot = () => resolve((process.env.WORKLOOP_ROOT || join(homedir(), ".workloop")).replace(/^~(?=$|[\\/])/, homedir()));
const statePath = (dir) => join(dir, "state.json");

function resolveRunDir(opt) {
  const v = opt ?? process.env.WORKLOOP_RUN;
  if (!v) fail("which run? pass --run <dir|project/feature> or set WORKLOOP_RUN");
  for (const cand of [resolve(v), join(workloopRoot(), v)]) if (existsSync(statePath(cand))) return cand;
  fail(`no workloop run at ${v} (looked in the cwd and in ${workloopRoot()})`);
}
function loadState(dir) {
  const s = JSON.parse(readFileSync(statePath(dir), "utf8"));
  // Runs created before the setting existed use the default, as does a state file
  // with a value that is not a positive number of minutes.
  if (!(Number(s.config?.checkTimeout) > 0)) s.config = { ...s.config, checkTimeout: DEFAULT_CHECK_TIMEOUT };
  CURRENT = { dir, s };
  return s;
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { renameSync(tmp, path); return; } catch (e) {
      if (i >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e; // Windows: AV/indexer locks
      sleep(50);
    }
  }
}
function saveState(dir, state) { writeAtomic(statePath(dir), `${JSON.stringify(state, null, 2)}\n`); }

// The log is an audit trail. State is saved first, so a crash can lose a log
// line but never leaves the log ahead of the state. A command whose result is a
// state change plus more than one event records them in one save, so the change
// and the events that explain it are either both recorded or neither.
const CLEARS_COMPLETION = ["import", "config", "decisions", "worktree", "dispatch", "send", "freeze", "review", "integrate", "retry", "cancel"];
function recordAll(dir, state, events) {
  if (events.some(([kind]) => CLEARS_COMPLETION.includes(kind))) state.completion = null;
  const lines = events.map(([kind, fields = {}]) => {
    state.seq = (state.seq || 0) + 1;
    return `${JSON.stringify({ seq: state.seq, ts: now(), kind, ...fields })}\n`;
  });
  saveState(dir, state);
  appendFileSync(join(dir, "events.jsonl"), lines.join(""));
}
function record(dir, state, kind, fields = {}) { recordAll(dir, state, [[kind, fields]]); }

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function withLock(dir, fn) {
  const p = join(dir, ".lock");
  const deadline = Date.now() + 15000;
  for (;;) {
    try { writeFileSync(p, String(process.pid), { flag: "wx" }); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const holder = Number(readFileSync(p, "utf8")) || 0;
      if (!holder || !alive(holder)) { try { unlinkSync(p); } catch {} continue; }
      if (Date.now() > deadline) fail(`run is busy: workloop pid ${holder} holds ${p}`);
      sleep(200);
    }
  }
  const release = () => { try { unlinkSync(p); } catch {} };
  let r;
  try { r = fn(); } catch (e) { release(); throw e; }
  // A command that awaits checks (`decisions`) holds the lock until they end.
  if (typeof r?.then === "function") return r.finally(release);
  release();
  return r;
}

const tasksOf = (s) => Object.values(s.tasks).sort((a, b) => Number(a.id) - Number(b.id));
function task(s, id) {
  const key = Object.keys(s.tasks).find((k) => Number(k) === Number(id));
  if (key == null) fail(`no task #${id}; tasks: ${Object.keys(s.tasks).join(", ")}`);
  return s.tasks[key];
}
const reportPath = (dir, t) => join(dir, "reports", `${t.id}-${t.attempt}.md`);
const briefPath = (dir, t) => join(dir, "briefs", `${t.id}-${t.attempt}.md`);

// Each brief names two folders for its agent: `evidence/<brief>` for what its report
// cites, kept with the run, and `scratch/<brief>` for what it can regenerate (another
// commit's tree, installs, caches), which archive deletes. Without a scratch folder,
// reviewers comparing commits left whole trees in evidence: gigabytes per run.
function workFolders(dir, brief, make = true) {
  const name = basename(brief, ".md");
  const folders = { evidenceDir: join(dir, "evidence", name), scratchDir: join(dir, "scratch", name) };
  if (make) for (const f of Object.values(folders)) mkdirSync(f, { recursive: true });
  return { evidenceDir: pathArg(folders.evidenceDir), scratchDir: pathArg(folders.scratchDir) };
}

function dirBytes(path) {
  let st;
  try { st = lstatSync(path); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let names = [];
  try { names = readdirSync(path); } catch { return 0; }
  return names.reduce((n, name) => n + dirBytes(join(path, name)), 0);
}
const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

// First "Key: value" line of a report, tolerant of markdown emphasis.
export function header(text, key) {
  const m = text.match(new RegExp(`^[\\s>*_]*${key}[*_]*\\s*:[*_\\s]*([A-Za-z0-9_-]+)`, "im"));
  return m ? m[1].toLowerCase().replace(/-/g, "_") : null;
}
function readReport(path, since) {
  if (!path || !existsSync(path)) return null;
  const mtime = statSync(path).mtimeMs;
  if (since && mtime < Date.parse(since)) return null; // written before the latest prompt
  const text = readFileSync(path, "utf8");
  return { status: header(text, "Status"), verdict: header(text, "Verdict"), commit: header(text, "Commit"), tip: header(text, "Integration tip"), mtime, text };
}
const executorReport = (dir, t) => readReport(reportPath(dir, t), t.promptedAt);
const reviewReport = (t) => (t.review ? readReport(t.review.path, t.review.startedAt) : null);

// ------------------------------------------------- review findings and waivers

// The findings table of a review report. Columns are found by header name, so a
// reordered or re-emphasised table still reads; a row is a finding when its ID is
// a letter followed by digits, and blocking when its Blocking cell starts with
// "yes". Returns null when no table carries both an ID and a Blocking column:
// that is a report whose findings cannot be read, not a report with none.
export function parseFindings(text) {
  const cellsOf = (line) => {
    const t = line.trim();
    if (!t.includes("|")) return null;
    const body = t.replace(/^\|/, "").replace(/\|$/, "");
    const out = [];
    let cur = "";
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "\\" && body[i + 1] === "|") { cur += "|"; i++; continue; }
      if (body[i] === "|") { out.push(cur); cur = ""; continue; }
      cur += body[i];
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  const plain = (c) => c.replace(/[*_`]/g, "").trim();
  let cols = null;
  const findings = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const cells = cellsOf(line);
    if (!cells) {
      if (cols) break; // the table ends at the first line that is not part of it
      continue;
    }
    const names = cells.map((c) => plain(c).toLowerCase());
    if (!cols) {
      const id = names.indexOf("id");
      const blocking = names.indexOf("blocking");
      if (id >= 0 && blocking >= 0) {
        cols = { id, blocking, axis: names.indexOf("axis"), location: names.indexOf("location"), basis: names.indexOf("basis") };
      }
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c.trim()))) continue; // the header rule
    const id = plain(cells[cols.id] ?? "");
    if (!/^[A-Za-z]\d+$/.test(id)) continue;
    const at = (i) => (i >= 0 ? cells[i] ?? "" : "");
    findings.push({
      id,
      axis: at(cols.axis),
      location: at(cols.location),
      basis: at(cols.basis),
      blocking: /^yes/i.test(plain(cells[cols.blocking] ?? "")),
    });
  }
  return cols ? findings : null;
}

// A review as state stores it: the object a task carries, or the bare path an
// earlier version of this script wrote into history.
const reviewOf = (value) => (typeof value === "string" ? { path: value } : value ?? null);
// The IDs the ticket had confirmed: what a review of it may cite.
const confirmedIds = (t) => (t.criteria ?? []).map((c) => c.id);

// A new review displaces the task's current one, and a send that ends a review does
// the same. Either way the displaced review moves into history rather than being
// dropped, so finish still lists its findings and suggestions — exactly once, since
// a path already in history is not added again.
function displaceReview(t) {
  const review = reviewOf(t.review);
  if (!review?.path) return;
  if (t.history.some((h) => reviewOf(h.review)?.path === review.path)) return;
  t.history.push({ attempt: t.attempt, candidateSha: review.candidateSha ?? null, review: { ...review }, at: now() });
}

// ------------------------------------------------------------ review boundary
//
// A review is bounded by what the user already settled. A blocking finding must
// cite one of the ticket's confirmed criteria (`AC2: …`) or one of four floor
// classes; anything else is a suggestion for the user, and nothing gates on it.
// Runs created before numbered criteria have no boundary: every finding stands.

// The floor classes, a closed list: each pattern is the name as a reviewer writes
// it, tolerating the spacing and numbering a citation invites ("Data-loss:",
// "ADR-0003:"). Anything outside the list is a suggestion.
const FLOOR_PATTERNS = [
  ["Regression", /^Regression\s*:/i],
  ["Data loss", /^Data[\s-]*loss\s*:/i],
  ["Security", /^Security\s*:/i],
  ["ADR", /^ADR(?:\s*[-–]?\s*\d+)?\s*:/i],
];

// What a Basis cell cites, if anything. The citation leads the cell: markdown
// emphasis and an opening bracket or quote are tolerated, prose before it is not,
// so "AC2: …" cites and "see AC2" does not.
export function citedBasis(basis) {
  const lead = String(basis ?? "").replace(/[*_`]/g, "").replace(/^[\s"'([]+/, "");
  const id = lead.match(/^(AC\d+)\s*:/i);
  if (id) return { id: id[1].toUpperCase(), floor: null };
  return { id: null, floor: FLOOR_PATTERNS.find(([, re]) => re.test(lead))?.[0] ?? null };
}

// `ids` are the criterion IDs the ticket had confirmed when the review started: a
// cited floor class always holds, a cited ID only when it is one of them.
export function inBoundary(finding, ids = []) {
  const { id, floor } = citedBasis(finding.basis);
  if (floor) return true;
  return Boolean(id) && ids.includes(id);
}

// A task's blocking findings, split by whether they may gate integration. `blocking`
// is null when the review's table cannot be read (nothing is known to be in-boundary,
// either). `confined` is false in a run created before numbered criteria.
//
// A review is judged against the criteria confirmed when it started, which it
// carries; a later `criteria` change never reclassifies a finding that was already
// raised. A review from before that was recorded falls back to the task's set.
function splitBlocking(t, confined = true) {
  const r = reviewReport(t);
  const all = r && parseFindings(r.text);
  if (!all) return { blocking: null, out: null };
  const blocking = all.filter((f) => f.blocking);
  if (!confined) return { blocking, out: [] };
  const ids = t.review?.criteria ?? confirmedIds(t);
  return {
    blocking: blocking.filter((f) => inBoundary(f, ids)),
    out: blocking.filter((f) => !inBoundary(f, ids)),
  };
}

// The out-of-boundary blocking findings of the run's current reviews: the user
// decides these, and `status` reports them as suggestions rather than gates.
function boundarySuggestions(s) {
  if (!numberedCriteria(s)) return [];
  return tasksOf(s).flatMap((t) => (splitBlocking(t, true).out ?? []).map((f) => ({ task: t.id, ...f })));
}

// Every review report the run wrote, with the task it belongs to: each attempt's
// current review, and every review the task replaced — a rework send or another
// `review --again`. Each path appears once, so finish lists a review exactly once.
function runReviews(s) {
  const out = [];
  const seen = new Set();
  for (const t of tasksOf(s)) {
    for (const a of [...t.history, t]) {
      const review = reviewOf(a.review);
      if (review?.path && !seen.has(review.path)) { seen.add(review.path); out.push({ t, review }); }
    }
  }
  return out;
}

// The suggestions a review listed under `## Out of scope`, up to the next heading:
// one per bullet or numbered item, its bullet removed. A wrapped item's following
// lines join it; a blank line ends it, and prose after one is an item of its own. A
// fenced block is no suggestion — reviewers end their report with one holding the
// Result/Report/Summary lines — so its lines are skipped.
export function outOfScope(text) {
  const out = [];
  let inside = false;
  let fence = null;
  let open = false;
  for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const fenceMark = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMark && fenceMark[1][0] === fence[0] && fenceMark[1].length >= fence.length) fence = null;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      inside = /^#{1,6}\s+out of scope[*_\s]*$/i.test(line.trim());
      open = false;
      continue;
    }
    if (!inside) continue;
    if (fenceMark) {
      fence = fenceMark[1];
      open = false;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) { open = false; continue; }
    const bullet = trimmed.match(/^(?:[-*+]|\d+[.)])\s+/);
    const item = trimmed.slice(bullet ? bullet[0].length : 0).trim();
    if (!item) continue;
    if (open && !bullet) out[out.length - 1] += ` ${item}`;
    else out.push(item);
    open = true;
  }
  return out;
}

// What `finish` shows the user about the run's review boundary: the rounds that
// went past the cap, and everything the reviews raised outside the boundary — the
// suggestions they decide, which never gated anything. Null when the run predates
// the boundary, which has none of this.
function boundaryReport(dir, s) {
  if (!numberedCriteria(s)) return null;
  const extras = s.extraRounds || [];
  const out = [];
  const scope = [];
  for (const { t, review } of runReviews(s)) {
    if (!existsSync(review.path)) continue;
    const text = readFileSync(review.path, "utf8");
    // The set this review was issued against, not the task's current one.
    const ids = review.criteria ?? confirmedIds(t);
    for (const f of (parseFindings(text) || []).filter((x) => x.blocking && !inBoundary(x, ids))) {
      out.push({ who: `#${t.id}`, ...f });
    }
    const items = outOfScope(text);
    if (items.length) scope.push({ who: `#${t.id}`, title: t.title, path: review.path, items });
  }
  // The final reviewer's report is bounded the same way: what its mapping, criteria,
  // ledger and floor classes did not cover is a suggestion for the user.
  for (const round of finalRounds(s)) {
    const r = finalReport(round);
    if (!r || !existsSync(round.path)) continue;
    const boundary = finalBoundary(s, round);
    for (const f of (parseFindings(r.text) || []).filter((x) => x.blocking && !inFinalBoundary(x, boundary))) {
      out.push({ who: "final review", ...f });
    }
    const items = outOfScope(r.text);
    if (items.length) scope.push({ who: "final review", title: null, path: round.path, items });
  }
  return [
    extras.length
      ? ["rework past the cap — the user decided each one:", ...extras.map((e) => (e.task === "final"
        ? `- final review round ${e.round}, repair cycle ${e.cycle} of cap ${e.cap}: ${e.reason}`
        : `- #${e.task} round ${e.round} of cap ${e.cap}: ${e.reason}`))].join("\n")
      : "rework past the cap: none",
    out.length
      ? ["out-of-boundary findings — raised outside the confirmed criteria and floor classes; the user decides:",
        ...out.map((f) => `- ${f.who} ${f.id} · ${f.axis} · ${f.location} · ${f.basis}`)].join("\n")
      : "out-of-boundary findings: none",
    scope.length ? suggestionsSummary(writeSuggestions(dir, s, scope), scope) : "out-of-scope suggestions: none",
  ].join("\n");
}

// The reviews' `## Out of scope` suggestions go to one file in the run directory,
// grouped by ticket and then by review, so the user reads them in one place and a
// suggestion a later round repeats sits next to the first. finish prints the counts
// and the path; printed one per line, a run's suggestions ran to hundreds of lines.
function writeSuggestions(dir, s, scope) {
  const path = join(dir, "suggestions.md");
  const lines = [`# Out-of-scope suggestions: ${s.project}/${s.feature}`, "",
    "The reviews raised these outside the confirmed criteria and floor classes. Nothing gated on them; each is the user's to decide.", ""];
  let who = null;
  for (const g of scope) {
    if (g.who !== who) {
      who = g.who;
      lines.push(g.title ? `## ${g.who} ${g.title}` : `## ${g.who[0].toUpperCase()}${g.who.slice(1)}`, "");
    }
    lines.push(`### ${relative(dir, g.path).replace(/\\/g, "/")}`, "", ...g.items.map((i) => `- ${i}`), "");
  }
  writeFileSync(path, lines.join("\n"));
  return path;
}
function suggestionsSummary(path, scope) {
  const counts = new Map();
  for (const g of scope) counts.set(g.who, (counts.get(g.who) || 0) + g.items.length);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return `suggestions from \`## Out of scope\`: ${total} (${[...counts].map(([w, n]) => `${w} ${n}`).join(", ")}) — the user decides; all of them, by ticket and review: ${path}`;
}

// The ledger: every finding the orchestrator let through, with its reason. It
// lives in state as `waivers` (absent in older runs, which reads as empty), and
// each entry is also an event. `ledgerAdd` only mutates the state: the caller
// writes it in the same save as the change it belongs to, so an interruption
// cannot leave a send recorded with its waiver missing.
function ledgerAdd(s, entry) {
  const full = { ...entry, at: entry.at ?? now() };
  s.waivers = [...(s.waivers || []), full];
  return full;
}
// The event that mirrors a ledger entry. `waiver` carries the entry's own kind,
// which `kind` already names for the log.
function waiverEvent(entry) {
  const { kind, ...rest } = entry;
  return ["waiver", { waiver: kind, ...rest }];
}
const waivedFindings = (s) => (s.waivers || []).reduce((n, w) => n + (w.findings?.length || 0), 0);

// Every entry carries its label, `L1`, `L2`, …, so a final reviewer can cite one
// even when it holds no finding of its own (an override of a missing review).
const ledgerLabel = (i) => `L${i + 1}`;
function waiverReport(s) {
  const entries = s.waivers || [];
  if (!entries.length) return "waived findings: none";
  const lines = [`waived findings — the user should review ${entries.length === 1 ? "this entry" : `these ${entries.length} entries`}:`];
  entries.forEach((w, i) => {
    const who = w.task === "final" ? "final review" : `#${w.task}`;
    const findings = w.findings?.length ? w.findings : [{ id: "-", axis: "-", location: "-", basis: w.note || "(no findings recorded)" }];
    for (const f of findings) lines.push(`- ${ledgerLabel(i)} · ${who} ${f.id} · ${w.kind} · ${f.axis} · ${f.location} · ${f.basis} · reason: ${w.reason}`);
  });
  return lines.join("\n");
}

// A rework send must account for every in-boundary blocking finding of the review
// it answers: named in the message as a whole word, or waived with a reason. An
// out-of-boundary finding is only a suggestion, so it needs neither. Returns the
// findings to record as waived, `{warning}` when the review's table cannot be read
// (a warning, not a refusal), or null when the message names them all.
function reworkAccounting(s, t, body, opts) {
  const listed = opts.waive ? String(opts.waive).split(",").map((x) => x.trim()).filter(Boolean) : [];
  if (listed.length && !opts.reason) fail(`send --waive needs --reason "<why they are let through>"; it records why ${listed.join(", ")} was not fixed`);
  const { blocking, out } = splitBlocking(t, numberedCriteria(s));
  if (blocking === null) {
    const lost = listed.length ? `not recording --waive ${listed.join(", ")}; ` : "";
    return { warning: `cannot read the blocking findings of ${t.review?.path ?? "the review"}; ${lost}sending without accounting for them` };
  }
  const cited = (l) => blocking.some((f) => f.id.toLowerCase() === l.toLowerCase());
  const outside = listed.filter((l) => !cited(l) && out.some((f) => f.id.toLowerCase() === l.toLowerCase()));
  if (outside.length) {
    fail(`send --waive: ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} out of #${t.id}'s review boundary (the Basis cites no confirmed criterion and no floor class), so ${outside.length === 1 ? "it is a suggestion" : "they are suggestions"} and needs no waiver`);
  }
  const unknown = listed.filter((l) => !cited(l));
  if (unknown.length) {
    fail(`send --waive: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a blocking finding of #${t.id}'s review; blocking: ${blocking.map((f) => f.id).join(", ") || "none"}`);
  }
  const unaccounted = blocking.filter((f) => !listed.some((l) => l.toLowerCase() === f.id.toLowerCase()) && !namesInBody(body, f.id));
  if (unaccounted.length) {
    fail(`#${t.id}: the rework message does not account for blocking finding${unaccounted.length === 1 ? "" : "s"} ${unaccounted.map((f) => f.id).join(", ")}; name ${unaccounted.length === 1 ? "it" : "each"} in the message, or list ${unaccounted.length === 1 ? "it" : "them"} in \`--waive <IDs> --reason "<why>"\``);
  }
  const waived = blocking.filter((f) => listed.some((l) => l.toLowerCase() === f.id.toLowerCase()));
  return waived.length ? { findings: waived, reason: opts.reason } : null;
}

// A finding ID counts as named when it stands as a word: `S12` does not name `S1`.
const namesInBody = (body, id) => new RegExp(`(?<![A-Za-z0-9_])${id}(?![A-Za-z0-9_])`, "i").test(body);

// The entry an `integrate --override` records: the in-boundary blocking findings it
// lets through, or why that cannot be listed (no review, or one whose findings
// cannot be read). An out-of-boundary finding is never let through by an override:
// nothing gated on it.
function overrideWaiver(s, t, sha, reason) {
  const { blocking } = splitBlocking(t, numberedCriteria(s));
  const entry = { kind: "override", task: t.id, review: t.review?.path ?? null, sha, findings: blocking ?? [], reason };
  if (blocking === null) entry.note = t.review ? "the review could not be read as a findings table" : "the review was missing";
  else if (!blocking.length && t.review) entry.note = "no in-boundary blocking finding: the review raised only suggestions";
  return entry;
}

// ------------------------------------------------- independent final review
//
// A full run's verdict is not the orchestrator's. Once every ticket is closed the
// orchestrator writes the acceptance mapping into `final-review.md`, and
// `final-review` starts an independent reviewer in its own worktree at the
// integration tip. `finish` accepts only that reviewer's report for that tip: `pass`,
// or `changes_requested` whose blocking findings are all in the ledger as final
// waivers. A round is one review of one tip; a second round at the same tip needs
// `--again`, and earlier rounds stay in `finalReviews` for the record.

const MAPPING = "final-review.md";
const mappingPath = (dir) => join(dir, MAPPING);

function readMapping(dir) {
  const path = mappingPath(dir);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return { path, text, mtime: statSync(path).mtimeMs, tip: header(text, "Integration tip") };
}

// The rows the acceptance mapping numbers M1, M2, …: any table cell that is exactly
// one, so the orchestrator may put it in a Row column or in the first cell.
export function mappingRows(text) {
  const rows = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    for (const cell of line.replace(/^\|/, "").replace(/\|$/, "").split("|")) {
      const id = cell.replace(/[*_`]/g, "").trim();
      if (/^M\d+$/.test(id) && !rows.includes(id)) rows.push(id);
    }
  }
  return rows;
}

// Why `final-review` cannot start a reviewer, or null.
function mappingProblem(dir, s) {
  const path = mappingPath(dir);
  const m = readMapping(dir);
  if (!m) return `write the acceptance mapping to ${path} first (template: ${join(TEMPLATES, MAPPING)}): the final reviewer verifies it`;
  // Written after the last merge, so it maps the tip that exists rather than an
  // earlier one, and it names that tip itself.
  if (s.lastIntegratedAt && m.mtime < Date.parse(s.lastIntegratedAt)) {
    return `${path} is older than the last integration (${s.lastIntegratedAt}); rewrite the mapping for the current tip ${short(s.integration.tip)}, then start it again`;
  }
  if (!m.tip || !s.integration.tip.startsWith(m.tip)) {
    return `${path} is for integration tip ${m.tip ?? "(none)"}, but the tip is ${short(s.integration.tip)}; rewrite it for the current tip, then start it again`;
  }
  return null;
}

// Every final review round the run started, in order: the current one last.
const finalRounds = (s) => [...(s.finalReviews || []), ...(s.finalReview ? [s.finalReview] : [])];
const finalReport = (f) => readReport(f?.path, f?.startedAt);

// The boundary a final-review finding is judged against: the mapping rows and the
// tickets' confirmed criteria this round started with (as a ticket review carries
// its own criteria, so a later change never reclassifies a finding), and the ledger.
function finalBoundary(s, round) {
  return { ...(round?.boundary || {}), waivers: s.waivers || [] };
}

// What a final-review Basis cites, if anything. As in a ticket review the citation
// leads the cell: markdown emphasis and an opening bracket or quote are tolerated,
// prose before it is not. A ticket criterion names its ticket (`#02 AC3:`), a
// mapping row is `M2:`, a waiver entry is its ledger label (`Waiver L3:`, which every
// entry has, even one with no findings) or its task and finding (`Waiver #01 S3:`),
// and a floor class is one of the four names.
export function finalCitation(basis) {
  const lead = String(basis ?? "").replace(/[*_`]/g, "").replace(/^[\s"'([]+/, "");
  const ac = lead.match(/^#(\d{1,4})\s+(AC\d+)\s*:/i);
  if (ac) return { ticket: ac[1], criterion: ac[2].toUpperCase() };
  const row = lead.match(/^(M\d+)\s*:/i);
  if (row) return { mapping: row[1].toUpperCase() };
  const entry = lead.match(/^waiver\s+(L\d+)\s*:/i);
  if (entry) return { waiver: { entry: entry[1].toUpperCase() } };
  const waiver = lead.match(/^waiver\s+(?:#(\d{1,4})|(final))\s+([A-Za-z]\d+)\s*:/i);
  if (waiver) return { waiver: { task: waiver[1] ?? "final", id: waiver[3].toUpperCase() } };
  const floor = FLOOR_PATTERNS.find(([, re]) => re.test(lead))?.[0] ?? null;
  return floor ? { floor } : {};
}

// A blocking final finding is in-boundary when its Basis cites a ticket criterion
// the ticket confirmed, a mapping row this round was given, a waiver entry in the
// ledger, or a floor class. Anything else is a suggestion for the user.
export function inFinalBoundary(finding, boundary = {}) {
  const c = finalCitation(finding.basis);
  if (c.floor) return true;
  // `#2` and `#02` name the same ticket, so compare numbers; "final" only itself.
  const sameTask = (a, b) => (a === "final" || b === "final" ? a === b : Number(a) === Number(b));
  if (c.criterion) {
    const ids = Object.entries(boundary.criteria || {}).find(([id]) => sameTask(id, c.ticket))?.[1] ?? [];
    return ids.includes(c.criterion);
  }
  if (c.mapping) return Boolean(boundary.mappings?.includes(c.mapping));
  if (c.waiver?.entry) return (boundary.waivers || []).some((w, i) => ledgerLabel(i) === c.waiver.entry);
  if (c.waiver) {
    return (boundary.waivers || []).some((w) => sameTask(String(w.task), c.waiver.task) && (w.findings || []).some((f) => f.id.toUpperCase() === c.waiver.id));
  }
  return false;
}

// A round's blocking findings, split by whether they may gate `finish`.
function splitFinalBlocking(s, round, text) {
  const all = parseFindings(text);
  if (!all) return { blocking: null, out: null };
  const blocking = all.filter((f) => f.blocking);
  if (!numberedCriteria(s)) return { blocking, out: [] }; // a run from before the boundary: every finding stands
  const boundary = finalBoundary(s, round);
  return { blocking: blocking.filter((f) => inFinalBoundary(f, boundary)), out: blocking.filter((f) => !inFinalBoundary(f, boundary)) };
}

// The row a waiver covers: the finding exactly as the report wrote it. A later report
// that reuses an ID for a different finding is not the one that was waived.
const findingKey = (f) => [f.id ?? "", f.axis ?? "", f.location ?? "", f.basis ?? ""].join("\u0000");
function finalWaived(s, round, finding) {
  const key = findingKey(finding);
  return (s.waivers || []).some((w) => w.kind === "final" && w.sha === round.tip && w.review === round.path
    && (w.findings || []).some((f) => findingKey(f) === key));
}

// Why `finish` may not record delivery yet, or null. A full run needs a round for
// the current tip whose report is fresh and names it; the verdict decides the rest.
function finalGate(dir, s) {
  const round = s.finalReview;
  if (!round || round.tip !== s.integration.tip) {
    return `no final review round for the current tip ${short(s.integration.tip)}: write the acceptance mapping in ${mappingPath(dir)} (template: ${join(TEMPLATES, MAPPING)}), then \`final-review\``;
  }
  if (!round.agentId) {
    return `the final review round ${round.round} has no reviewer recorded: its start was interrupted, so nothing it wrote is that round's verdict. Start another round with \`final-review --again\``;
  }
  const r = finalReport(round);
  if (!r) {
    return `the final reviewer (round ${round.round}) has not written ${round.path} yet since ${round.startedAt}; wait for it, then finish, write repair tickets or waive its findings`;
  }
  if (!r.tip || !s.integration.tip.startsWith(r.tip)) {
    return `the final review's report is for integration tip ${r.tip ?? "(none)"}, but the tip is ${short(s.integration.tip)}; start a new round with \`final-review\``;
  }
  if (r.verdict === "pass") return null;
  if (r.verdict !== "changes_requested") {
    return `the final review's verdict is ${r.verdict ?? "missing"}; it must be \`pass\` or \`changes_requested\``;
  }
  const { blocking } = splitFinalBlocking(s, round, r.text);
  if (blocking === null) {
    return `the final review requested changes, and its findings table cannot be read, so its blocking findings cannot be bounded or waived; fix the report or start another round with \`final-review --again\``;
  }
  const open = blocking.filter((f) => !finalWaived(s, round, f));
  if (!open.length) return null;
  const ids = open.map((f) => f.id).join(", ");
  return `the final review requested changes and ${ids} ${open.length === 1 ? "is" : "are"} not waived: write repair tickets (then a new round on the new tip with \`final-review\`), `
    + `or record why ${open.length === 1 ? "it stands" : "they stand"} with \`final-review --waive ${ids} --reason "<why>"\``;
}

// The regression set as one line for the final reviewer's brief.
function regressionText(s) {
  const set = regressionSet(s);
  return set.length ? set.map((e) => `\`${e.cmd}\` (#${e.task})`).join(", ") : "none — every criterion is manual";
}

// Each ticket's last review report: the one its task carries, else the newest in
// its history. Their non-blocking findings are reference for the final reviewer.
function reviewList(s) {
  const lines = tasksOf(s).map((t) => {
    const now = reviewOf(t.review);
    const was = t.history.map((h) => reviewOf(h.review)).filter((r) => r?.path).at(-1);
    const review = now?.path ? now : was;
    return `  - #${t.id}: ${review?.path ? `\`${pathArg(review.path)}\`` : "no review recorded"}`;
  });
  return lines.length ? lines.join("\n") : "  (no tickets)";
}

const floorClasses = () => render("floor-classes.md", {}).trimEnd();
const indentLines = (text) => text.split("\n").map((l) => `  ${l}`).join("\n");

// A full run's last step before `finish`: the mapping, the independent review of it,
// and what its report leaves to do.
function finalSteps(dir, s) {
  const problem = mappingProblem(dir, s);
  if (problem) return [`do the acceptance mapping: ${problem}`];
  const round = s.finalReview;
  if (!round || round.tip !== s.integration.tip) {
    return [`final-review — start the independent final reviewer at ${short(s.integration.tip)}`];
  }
  if (!round.agentId) return [`final review round ${round.round} has no reviewer recorded — \`final-review --again\``];
  const r = finalReport(round);
  if (!r) return [`wait for the final reviewer (round ${round.round}) to write ${round.path} — run \`wait\` in the background, then end this turn; then finish, write repair tickets or waive its findings`];
  if (r.verdict === "pass") return ["finish — the final reviewer passed the current tip"];
  if (!r.verdict) return [`the final reviewer's report has no verdict; read ${round.path}, then \`final-review --again\``];
  const { blocking, out } = splitFinalBlocking(s, round, r.text);
  const open = (blocking || []).filter((f) => !finalWaived(s, round, f));
  if (!open.length) {
    if (blocking === null) return [`the final review's findings table cannot be read; read ${round.path}, then \`final-review --again\``];
    // A blocking finding outside the boundary is advice: it gates nothing, so the
    // run is as ready as a pass, and finish lists it for the user.
    if (out?.length) return ["finish — the final review's blocking findings are all outside its boundary (suggestions for the user)"];
    return ["finish — the final review's blocking findings are all waived"];
  }
  const ids = open.map((f) => f.id).join(", ");
  // Repairs now would put the next round past the cap: the user decides first, as
  // they do for a ticket's rework round past it.
  const capped = numberedCriteria(s) && reviewedTips(s) > reworkCap(s)
    ? ` The next round would be repair cycle ${reviewedTips(s)}, past the run's cap of ${reworkCap(s)}: ask the user before writing repair tickets, then start it with \`final-review --extra-round --reason "<their decision>"\`.`
    : "";
  return [`final review changes requested (${ids}): read ${round.path}, then write repair tickets and integrate them (a new round follows at the new tip), `
    + `or \`final-review --waive ${ids} --reason "<why>"\`; \`final-review --again\` reviews this tip once more.${capped}`];
}

// The distinct tips a final reviewer has reported on. Each was followed by repairs,
// or the run would have finished, so a round at a new tip is repair cycle `n`.
const reviewedTips = (s) => new Set(finalRounds(s).filter((r) => finalReport(r)).map((r) => r.tip)).size;

// The round a final re-review follows: the most recent one whose reviewer wrote its
// report, the current round first (`--again` replaces it), then the earlier ones.
function previousFinalRound(s) {
  return finalRounds(s).reverse().find((r) => r.tip && finalReport(r)) ?? null;
}

// A final round at a new tip past the run's cap waits for the user, as a rework round
// does: the orchestrator asks, then records their decision with --extra-round --reason,
// which `finish` lists. A round at the same tip (`--again`) repairs nothing and never
// counts. Null when the round is within the cap, or when the run predates the cap.
function finalExtraRound(s, sameTip, round, opts) {
  const asked = opts["extra-round"];
  if (sameTip) {
    if (asked) fail("final-review --extra-round goes past the cap at a new tip; --again at the same tip repairs nothing and needs no decision");
    return null;
  }
  if (!numberedCriteria(s)) {
    if (asked) fail("this run predates the review boundary and its cap, so final-review --extra-round does not apply");
    return null;
  }
  const cycle = reviewedTips(s);
  const cap = reworkCap(s);
  if (cycle <= cap) {
    if (asked) fail(`final review round ${round} is repair cycle ${cycle}, within the run's cap of ${cap}, so --extra-round is not needed`);
    return null;
  }
  if (!asked) {
    fail(`final review round ${round} would be repair cycle ${cycle}, past the run's cap of ${cap}. The run waits for the user: decide with them whether to go on, `
      + `then \`final-review --extra-round --reason "<the user's decision>"\`; or waive what stands with \`final-review --waive\``);
  }
  if (!opts.reason?.trim()) fail(`final-review --extra-round needs --reason "<the user's decision>": repair cycle ${cycle} goes past the cap of ${cap}, and finish lists it`);
  return { task: "final", round, cycle, cap, reason: opts.reason.trim() };
}

// `final-review` creates the round's worktree, writes the brief, and starts the
// final reviewer's turn.
function cmdFinalReview(dir, s, opts) {
  if (opts.waive) return cmdFinalWaive(dir, s, opts);
  if (opts.reason && !opts["extra-round"]) fail("final-review --reason belongs to --waive <IDs>, which records why a blocking finding was let through, or to --extra-round, which records the user's decision to go past the cap");
  if (isDirect(s)) fail("a direct run has no final review: its reviewer already re-ran the acceptance commands, so go to `finish`");
  const open = tasksOf(s).filter((t) => !["done", "cancelled"].includes(t.status));
  if (open.length) fail(`final-review needs every ticket closed: ${open.map((t) => `#${t.id} ${t.status}`).join(", ")}`);
  const docs = documentStep(documentReport(s));
  if (docs) fail(`the end-of-run document step still reports work: ${docs}`);
  const current = s.finalReview;
  const sameTip = Boolean(current && current.tip === s.integration.tip);
  if (sameTip && !opts.again) fail(`the final review already has round ${current.round} for the current tip ${short(current.tip)}; pass --again to start another round`);
  if (!sameTip && opts.again) fail(`--again starts a second round at the same tip, and no round covers the current tip ${short(s.integration.tip)}; run \`final-review\``);
  const problem = mappingProblem(dir, s);
  if (problem) fail(problem);
  const round = (current?.round ?? s.finalReviews?.at(-1)?.round ?? 0) + 1;
  const extra = finalExtraRound(s, sameTip, round, opts);
  // Read before anything is created, so a missing profile cannot leave a worktree behind.
  const launch = launchSettings(s.config, "reviewer", opts);
  if (sameTip && current.agentId) requireIdle(current.agentId, "final reviewer");
  checkIntegration(s);
  const tip = s.integration.tip;
  // A round after one whose report was written follows it, as a ticket re-review does.
  const prev = numberedCriteria(s) ? previousFinalRound(s) : null;
  const branch = `wl-${s.feature}-final-${round}`;
  const path = join(dir, "reviews", `final-${round}-${short(tip)}.md`);

  // A start interrupted before its state was saved left this round's branch and
  // worktree behind; the branch name is deterministic, so adopt them.
  let wt = worktreeFor(s.repo, branch);
  const adopted = Boolean(wt);
  if (!wt) wt = addWorktree(dir, s, branch);
  wt = pathArg(wt);
  if (head(wt) !== tip) fail(`the final review's worktree ${wt} is at ${short(head(wt))}, not the integration tip ${short(tip)}. Not starting the reviewer; inspect it before continuing.`);
  if (git(wt, "branch", "--show-current") !== branch) fail(`worktree ${wt} is not on expected branch ${branch}; reconcile before starting the final reviewer`);
  // A tree someone has been editing is not the tip, whatever its HEAD says.
  if (adopted && !isClean(wt)) {
    fail(`the final review's worktree ${wt} was left by an interrupted start with uncommitted or untracked changes. Nothing was changed: inspect them, then commit or discard them yourself before starting again.`);
  }

  if (current) s.finalReviews = [...(s.finalReviews || []), current];
  s.finalReview = {
    round, worktree: wt, branch, tip, path: pathArg(path), startedAt: now(),
    boundary: {
      mappings: mappingRows(readFileSync(mappingPath(dir), "utf8")),
      criteria: Object.fromEntries(tasksOf(s).map((t) => [t.id, confirmedIds(t)])),
    },
  };
  const brief = join(dir, "briefs", `final-${round}-${short(tip)}.md`);
  const vars = {
    ...workFolders(dir, brief),
    feature: s.feature, round, tip, tipShort: short(tip), baseSha: s.baseSha, worktree: wt, branch,
    specPath: pathArg(s.spec), ticketsDir: pathArg(s.tickets), mappingPath: pathArg(mappingPath(dir)),
    reviewPath: pathArg(path), checks: list(s.config.checks), regressionSet: regressionText(s),
    waivers: indentLines(waiverReport(s)), reviews: reviewList(s), skillsRoot: pathArg(SKILLS_ROOT),
    // A run created before the boundary has no confirmed criteria to cite, so it keeps
    // the brief it always had: every blocking finding stands.
    boundary: numberedCriteria(s) ? `\n${render("final-reviewer-boundary.md", { floorClasses: floorClasses() })}` : "",
    reReview: prev ? `\n${render("final-reviewer-re-review.md", {
      previousReview: pathArg(prev.path), previousTip: prev.tip, previousShort: short(prev.tip), tip,
    })}` : "",
    notes: notesFrom(opts),
  };
  writeFileSync(brief, render("final-reviewer-brief.md", vars));
  const id = newAgent(s, { role: "reviewer", task: "final", attempt: `r${round}`, cwd: wt, launch });
  const turn = startTurn(dir, s, id, `Read the final review brief at ${pathArg(brief)} and follow it. Review only; change nothing; never ask the user anything.`, `final r${round} ${short(tip)}`);
  Object.assign(s.finalReview, { agentId: id, launch: describe(launch) });
  // The user's decision is recorded with the round it opens, in the same save.
  const past = extra && extraRoundsAdd(s, extra);
  recordAll(dir, s, [["final_review", { round, branch, worktree: wt, tip, agent: id, block: turn.block }], ...(past ? [["extra_round", past]] : [])]);
  say(`final review round ${round}: ${describe(launch)} started in Rex tab "${turn.title}". Run \`wait\` in the background, then end this turn.`);
}

// `final-review --waive <IDs> --reason "<why>"`: the blocking findings of the
// current round's report that the orchestrator lets through, in the ledger.
function cmdFinalWaive(dir, s, opts) {
  const listed = String(opts.waive).split(",").map((x) => x.trim()).filter(Boolean);
  if (!listed.length) fail("final-review --waive takes finding IDs, e.g. `--waive X1,A2`");
  if (!opts.reason?.trim()) fail(`final-review --waive needs --reason "<why they are let through>": it records why ${listed.join(", ")} was not fixed`);
  const round = s.finalReview;
  if (!round) fail("no final review round is recorded; start one with `final-review`");
  if (round.tip !== s.integration.tip) fail(`the current final review round is for tip ${short(round.tip)}, and the tip is now ${short(s.integration.tip)}; start a new round with \`final-review\``);
  const r = finalReport(round);
  if (!r) fail(`the final reviewer has not written ${round.path} yet; waivers answer its report`);
  if (!r.tip || !s.integration.tip.startsWith(r.tip)) fail(`the final review's report is for integration tip ${r.tip ?? "(none)"}, but the tip is ${short(s.integration.tip)}; start a new round with \`final-review\``);
  const all = parseFindings(r.text);
  if (!all) fail(`the findings table of ${round.path} cannot be read, so ${listed.join(", ")} cannot be checked against it`);
  const blocking = all.filter((f) => f.blocking);
  const find = (l) => blocking.find((f) => f.id.toLowerCase() === l.toLowerCase());
  const outside = numberedCriteria(s) ? listed.filter((l) => find(l) && !inFinalBoundary(find(l), finalBoundary(s, round))) : [];
  if (outside.length) {
    fail(`final-review --waive: ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the final review's boundary (the Basis cites no ticket criterion, mapping row, waiver entry or floor class), `
      + `so ${outside.length === 1 ? "it is a suggestion" : "they are suggestions"} and ${outside.length === 1 ? "needs" : "need"} no waiver`);
  }
  const unknown = listed.filter((l) => !find(l));
  if (unknown.length) {
    fail(`final-review --waive: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a blocking finding of the final review; blocking: ${blocking.map((f) => f.id).join(", ") || "none"}`);
  }
  const ids = new Set(listed.map((l) => l.toLowerCase()));
  const findings = blocking.filter((f) => ids.has(f.id.toLowerCase()));
  const entry = ledgerAdd(s, { kind: "final", task: "final", review: round.path, sha: round.tip, findings, reason: opts.reason.trim() });
  recordAll(dir, s, [waiverEvent(entry)]);
  say(`final review: waived ${findings.map((f) => f.id).join(", ")}; finish lists ${findings.length === 1 ? "it" : "them"} for the user`);
}

// ------------------------------------------------------------ check phase
//
// `integrate` and `finish` split into three steps: under the lock they record a
// `checking` entry, then they release it to run the checks, then they take it
// again to record the result on the reloaded state. That way `status`, `wait`,
// `note` and `send` keep working while a slow suite runs.

// Every command allowed while a live check phase holds the run. `config` is not
// among them, so the checks that run are the checks configured; `send` to the
// task under check also refuses (checkPhaseRefusal).
const CHECK_PHASE_COMMANDS = ["status", "note", "hold", "unhold", "send", "import"];

// A `checking` entry whose process is gone is an interrupted check phase: the
// work it did in Git is still there, and rerunning the same command recovers it.
// The owner counts as gone only when its pid is free or now runs something other
// than this script's `integrate`/`finish`; a pid whose command line cannot be
// read is never treated as gone.
const ownerSeen = new Map();
function ownerIdentity(c) {
  const key = `${c.pid}:${c.kind}`;
  if (!ownerSeen.has(key)) ownerSeen.set(key, processIdentity(c.pid, [SCRIPT_NAME, c.kind]));
  return ownerSeen.get(key);
}
const ownerLive = (c) => !["gone", "other"].includes(ownerIdentity(c));
const liveCheck = (s) => (s.checking && ownerLive(s.checking) ? s.checking : null);
const interrupted = (s) => (s.checking && !ownerLive(s.checking) ? s.checking : null);
const checkPhaseLabel = (c) => (c.kind === "finish" ? "finish" : `integrate on #${c.task}`);
const recoveryCommand = (c) => (c.kind === "finish" ? "finish" : `integrate ${c.task}`);
function describeCheckPhase(c) {
  if (!ownerLive(c)) return `interrupted check phase: ${checkPhaseLabel(c)} (pid ${c.pid} is gone); rerun \`${recoveryCommand(c)}\` to recover it`;
  if (ownerIdentity(c) === "unknown") {
    return `check phase: ${checkPhaseLabel(c)} since ${c.startedAt}, held by pid ${c.pid}, which is alive but cannot be identified as that workloop process; if it is not, stop and ask the user`;
  }
  return `check phase: ${checkPhaseLabel(c)} is running its checks (pid ${c.pid}, since ${c.startedAt})`;
}
// Why `cmd` may not run now, or null. A live phase admits the commands above; an
// interrupted one also admits `config` and the command that recovers it.
function checkPhaseRefusal(s, cmd, id) {
  const c = s.checking;
  if (!c) return null;
  if (ownerLive(c)) {
    const underCheck = cmd === "send" && c.kind === "integrate" && Number(id) === Number(c.task);
    if (CHECK_PHASE_COMMANDS.includes(cmd) && !underCheck) return null;
    return `${describeCheckPhase(c)}. Until it ends only ${CHECK_PHASE_COMMANDS.join(", ")} run (\`send\` to a task other than the one under check); `
      + "collect that command's exit code and output, then continue.";
  }
  if (CHECK_PHASE_COMMANDS.includes(cmd) || cmd === "config") return null;
  const recovers = c.kind === "finish" ? cmd === "finish" : cmd === "integrate" && Number(id) === Number(c.task);
  return recovers ? null : `${describeCheckPhase(c)} before \`${cmd}\`.`;
}

// Records the entry, so a later step can confirm the phase still belongs to us.
function beginCheckPhase(dir, s, fields) {
  s.checking = { ...fields, pid: process.pid, startedAt: now() };
  const { kind, ...rest } = s.checking;
  record(dir, s, "checking", { phase: kind, ...rest }); // `kind` names the event
  return { ...s.checking };
}
const ownsPhase = (s, phase) => s.checking?.pid === phase.pid && s.checking?.startedAt === phase.startedAt;
// Step 2 and 3: runs the checks outside the lock, then hands the outcome to
// `complete` under the lock on the reloaded state, so a `note`, `send` or
// `hold` written meanwhile survives. Each check's identity goes into the
// entry as `check: {pid, token}` before the check runs (its pid leads its
// process group on POSIX), so recovery can verify and stop it.
async function runCheckPhase(dir, phase, commands, cwd, complete) {
  const minutes = checkLimit(loadState(dir));
  const checks = await runChecks(commands, cwd, minutes, (pid, token) => withLock(dir, () => {
    const s = loadState(dir);
    if (!ownsPhase(s, phase)) fail("the check phase is no longer this process's");
    s.checking.check = { pid, token };
    saveState(dir, s);
  }));
  return withLock(dir, () => {
    const s = loadState(dir);
    if (!ownsPhase(s, phase)) {
      fail(`the ${checkPhaseLabel(phase)} check phase is no longer this process's (pid ${phase.pid}); its result was not recorded and nothing was changed. Run \`status\` and reconcile.`);
    }
    return complete(s, checks, minutes);
  });
}
// A failed command names itself and, for an acceptance command, the ticket it
// proves: `#02 acceptance \`cmd\` fails` says whose behaviour regressed.
const checkFailure = (r, minutes) => `${r.task ? `#${r.task} acceptance ` : ""}${r.timedOut ? timedOut(r.cmd, minutes) : `\`${r.cmd}\` fails`}`;
// A timed-out check that could not be stopped leaves the phase recorded, and
// nothing is rolled back or recorded as done: recovery has to stop it first.
// How to find a check's leftover processes and confirm they are still the
// check's before stopping any: only its wrapper's command line carries the token,
// and the pid (or group) may since have been reused by something else.
function inspectCheckHint(pid, token) {
  const list = WIN
    ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=${pid} or ParentProcessId=${pid}' | Select-Object ProcessId,ParentProcessId,CommandLine"`
    : `ps -o pid=,pgid=,command= -g ${pid}`;
  return `Some of its processes may still be running. Before stopping anything, list the candidates (\`${list}\`) and confirm that the command line of pid ${pid}, the check's wrapper, carries the check's token ${token}; `
    + `only then are they the check's to stop. If pid ${pid} is gone or shows anything else, the number may belong to something else now: stop nothing and ask the user`;
}
// A check whose processes could not be stopped: what happened, and how to
// inspect them by hand.
function cleanupFailure(checks, minutes) {
  const { pid, token, error } = checks.cleanupFailed;
  const ended = checks.timedOut ? `timed out after ${minutes} minutes` : "ended";
  return `\`${checks.cmd}\` ${ended}, and cleanup failed: ${stopWhat(pid)} could not be stopped (${error}). ${inspectCheckHint(pid, token)}`;
}
// Recovery commands printed for the user, quoted for the platform shell.
export const initCleanupCommands = (repo, integ, branch) => [
  `git -C ${shellArg(repo)} worktree remove --force ${shellArg(integ)}`,
  `git -C ${shellArg(repo)} branch -D ${shellArg(branch)}`,
];
export const decisionsResetCommand = (integ, prev) => `git -C ${shellArg(integ)} reset --soft ${shellArg(prev)}`;
function keepPhaseAfterFailedCleanup(dir, s, phase, checks, minutes) {
  if (!checks.cleanupFailed) return;
  const { pid, error } = checks.cleanupFailed;
  record(dir, s, "check_cleanup_failed", { phase: phase.kind, task: phase.task, check: checks.cmd, pid, error });
  fail(`${cleanupFailure(checks, minutes)}. Once they are stopped, rerun \`${recoveryCommand(phase)}\`. `
    + `The check phase stays recorded and nothing was rolled back or recorded.\n${checks.output}`);
}

// An interrupted phase's check outlives the process that started it, because
// it runs in a group of its own. Stopping it first keeps it from writing to the
// integration worktree during or after recovery. Only a pid whose command line
// still carries the check's token is signalled; one that cannot be identified
// stops the recovery, so the user decides.
function stopInterruptedCheck(c) {
  if (!c.check) return; // no check had its identity recorded, so none ran
  const { pid, token } = c.check;
  const id = processIdentity(pid, [token]);
  if (id === "unknown") {
    fail(`cannot recover the interrupted check phase (${checkPhaseLabel(c)}): pid ${pid} is alive but its command line cannot be read, so it is not known whether it is that phase's check (token ${token}). Nothing was signalled or changed. Stop and ask the user to inspect pid ${pid}.`);
  }
  if (id === "other") return; // a reused pid: the check's group is gone, and this process is not ours
  // POSIX: a group outlives its leader, and its id is not reissued while it
  // exists, so a group left by a dead wrapper is still the check's. Windows has
  // no group: a dead wrapper's descendants cannot be reached (see run.md).
  if (id === "gone" && (WIN || !groupExists(pid))) return;
  const stop = stopCheckNow(pid);
  if (!stop.ok) {
    fail(`cannot recover the interrupted check phase (${checkPhaseLabel(c)}): its check's ${stopWhat(pid)} could not be stopped (${stop.error}). Nothing was reset or cleared. ${inspectCheckHint(pid, token)}. Once they are stopped, rerun \`${recoveryCommand(c)}\`.`);
  }
}

// ------------------------------------------------------------------ tickets

// Parses the local-markdown ticket format written by the to-tickets skill:
// NN-slug.md, a "# NN: Title" heading, and blockers either inline
// ("**Blocked by:** 01, 03" / "Blocked by: None") or under a "## Blocked by" heading.
export function parseTicket(file, text) {
  const m = basename(file).match(/^(\d+)-(.+)\.md$/);
  if (!m) return null;
  const lines = text.replace(/\r/g, "").split("\n");
  const h1 = lines.find((l) => /^#\s+\S/.test(l));
  const title = h1 ? h1.replace(/^#\s+/, "").replace(/^#?\d+\s*[:.)–—-]\s*/, "").trim() : m[2];
  let blocked = "";
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,6}\s*blocked[ -]by\s*:?\s*$/i.test(lines[i])) {
      for (let j = i + 1; j < lines.length && !/^#{1,6}\s/.test(lines[j]); j++) blocked += ` ${lines[j]}`;
      break;
    }
    const inline = lines[i].match(/^\s*[-*]?\s*(?:\*\*|__)?blocked[ -]by\s*:?\s*(?:\*\*|__)?\s*:?\s*(.*)$/i);
    if (inline) { blocked = inline[1]; break; }
  }
  const refs = [...blocked.matchAll(/(?<![\w.])#?(\d{1,4})(?![\w.])/g)].map((x) => Number(x[1]));
  // to-tickets allows blockers by title; the graph needs numbers, and silently reading a title as "no blockers" would dispatch too early.
  const loose = blocked.replace(/[*_`>•\s-]+/g, " ").trim();
  if (!refs.length && loose && !/^\(?(none|nothing|n\/a|no blockers?)\b/i.test(loose)) {
    fail(`${basename(file)}: "Blocked by" names no ticket numbers ("${loose.slice(0, 60)}"); write the blockers' numbers, e.g. "Blocked by: 01, 03", or "None"`);
  }
  return { id: m[1], title, file, refs: [...new Set(refs)] };
}

// A ticket's "Scope:" line: comma-separated repo-relative globs naming the paths it may change.
// null when the line is absent, so tickets written without one are not checked.
export function ticketScope(file, text) {
  const line = text.replace(/\r/g, "").split("\n")
    .map((l) => l.match(/^\s*[-*]?\s*(?:\*\*|__)?scope(?:\*\*|__)?\s*:\s*(?:\*\*|__)?(.*)$/i)).find(Boolean);
  if (!line) return null;
  const globs = line[1].split(",").map((g) => g.replace(/`/g, "").trim().replace(/^\.?\//, "").replace(/\/$/, "/**")).filter(Boolean);
  if (!globs.length) fail(`${basename(file)}: "Scope" lists no paths`);
  const unfilled = globs.find((g) => /[<>]/.test(g));
  if (unfilled) fail(`${basename(file)}: "Scope" still holds a template placeholder ("${unfilled.slice(0, 60)}")`);
  return globs;
}

// A ticket's acceptance criteria: checklist lines "- [ ] [AC<n>:] <criterion> [— check: `<command>`]".
// The `check:` marker may be written with an em dash or one or two ASCII dashes and
// in any case, and the first single-backtick span after it is the command (one per
// line). A criterion line without a command is manual — the reviewer, or the final
// review's acceptance mapping, checks it — and its command is null. A command that is
// empty or still holds a template placeholder refuses the ticket, so a run never
// "checks" the template's own text.
//
// `numbered` is what a run created by this version uses: every criterion carries its
// own `AC<n>` ID, unique within the ticket, so a review finding can cite it and a
// change to one is visible. A ticket that breaks either rule is refused, naming the
// ticket and the line. Runs created earlier read tickets as before, with `id: null`.
//
// `explicit` is what a run created by this version uses on top of that: a criterion
// ends in either `— check: \`<command>\`` or `— manual: <why no command can check
// it>`, so a criterion is manual by choice, which the user sees when confirming the
// tickets, and never by omission. The reason is part of the confirmed criterion.
// Runs created earlier keep reading a criterion without either as manual, and keep
// any "manual:" text as part of the criterion.
const CHECK_MARKER = /(?:—\s*|(?<![\w-])--?\s*)check\s*:/i;
const MANUAL_MARKER = /(?:—\s*|(?<![\w-])--?\s*)manual\s*:/i;
const CRITERION_ID = /^AC(\d+)\s*:\s*/i;
export function acceptanceCriteria(file, text, { numbered = false, explicit = false } = {}) {
  const out = [];
  const seen = new Map(); // ID -> 1-based line number of the criterion that claimed it
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].match(/^\s*[-*]\s*\[[ xX]\]\s+(.+)$/);
    if (!line) continue;
    const n = i + 1;
    let body = line[1].trim();
    const idm = numbered ? body.match(CRITERION_ID) : null; // an older run keeps the whole text
    const id = idm ? `AC${idm[1]}` : null;
    if (idm) body = body.slice(idm[0].length).trim();
    const marker = body.match(CHECK_MARKER);
    const manual = explicit ? body.match(MANUAL_MARKER) : null;
    const end = Math.min(marker?.index ?? Infinity, manual?.index ?? Infinity);
    const criterion = end < Infinity ? body.slice(0, end).replace(/[\s—–-]+$/, "").trim() : body;
    if (numbered) {
      if (!id) fail(`${basename(file)}:${n}: the acceptance criterion "${criterion.slice(0, 60)}" has no ID; write "- [ ] AC1: ${body.slice(0, 60)}"`);
      const was = seen.get(id);
      if (was) fail(`${basename(file)}:${n}: ${id} is already the ID of the criterion on line ${was}; an acceptance ID is unique within its ticket`);
      seen.set(id, n);
    }
    if (explicit) {
      const name = id ?? `"${criterion.slice(0, 60)}"`;
      if (marker && manual) fail(`${basename(file)}:${n}: ${name} has both "check:" and "manual:"; keep the command, or say why none can check it — not both`);
      if (!marker && !manual) fail(`${basename(file)}:${n}: ${name} names no command and no reason it is manual; end it with "— check: \`<command>\`", or with "— manual: <why no command can check it>"`);
    }
    if (manual) {
      const reason = body.slice(manual.index + manual[0].length).trim();
      if (!reason || /<[^<>]*>/.test(reason)) fail(`${basename(file)}:${n}: the manual reason for ${id ?? `"${criterion.slice(0, 60)}"`} is ${reason ? "a template placeholder" : "empty"}; say why no command can check it`);
      out.push({ id, criterion, command: null, manual: reason });
      continue;
    }
    if (!marker) {
      out.push({ id, criterion, command: null });
      continue;
    }
    const span = body.slice(marker.index + marker[0].length).match(/`([^`]*)`/);
    if (!span) fail(`${basename(file)}: the acceptance line "${criterion.slice(0, 60)}" ends in "check:" but names no command in backticks; ${explicit ? `replace "check:" with "manual: <why no command can check it>"` : `drop "check:"`} to make it a manual criterion`);
    const command = span[1].trim();
    if (!command || /<[^<>]*>/.test(command)) {
      fail(`${basename(file)}: the acceptance command for "${criterion.slice(0, 60)}" is a template placeholder (${command || "empty"}); name the command that proves it`);
    }
    out.push({ id, criterion, command });
  }
  return out;
}

// The commands among a ticket's criteria, in order: the regression set's entries.
const criterionCommands = (criteria) => criteria.filter((c) => c.command).map(({ criterion, command }) => ({ criterion, command }));
export function acceptanceCommands(file, text, opts) {
  return criterionCommands(acceptanceCriteria(file, text, opts));
}

// Runs created by this version record that they use numbered, frozen criteria.
// State without the marker predates it, and reads its tickets as before.
const numberedCriteria = (s) => Boolean(s.reviewBoundary);
// Runs created by this version also require every criterion to name its command or
// why it is manual. State without the marker reads a bare criterion as manual.
const explicitAcceptance = (s) => Boolean(s.explicitAcceptance);
const criteriaOptions = (s) => ({ numbered: numberedCriteria(s), explicit: explicitAcceptance(s) });

// The IDs whose criterion text, command, manual reason or presence differs from the
// confirmed set, in the ticket file's order and then the IDs only the confirmed set has.
export function criteriaDiff(confirmed = [], current = []) {
  const was = new Map(confirmed.map((c) => [c.id, c]));
  const now = new Set(current.map((c) => c.id));
  return [
    ...current.filter((c) => {
      const old = was.get(c.id);
      return !old || old.criterion !== c.criterion || (old.command ?? null) !== (c.command ?? null)
        || (old.manual ?? null) !== (c.manual ?? null);
    }).map((c) => c.id),
    ...confirmed.filter((c) => !now.has(c.id)).map((c) => c.id),
  ];
}

// Why #t cannot be dispatched, frozen or integrated: its criteria no longer match
// the set the user confirmed. Null when they agree, or when the run predates
// numbered criteria. Only `criteria <NN>` opens this gate, because only it records
// that the user agreed to the change.
function criteriaGate(s, t) {
  if (!numberedCriteria(s)) return null;
  if (!existsSync(t.file)) return `#${t.id}: its ticket file is gone (${t.file}); restore it before continuing`;
  let current;
  try {
    current = acceptanceCriteria(t.file, readFileSync(t.file, "utf8"), criteriaOptions(s));
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    return `#${t.id}: its criteria cannot be read: ${e.message}`;
  }
  const ids = criteriaDiff(t.criteria ?? [], current);
  if (!ids.length) return null;
  return `#${t.id}: its acceptance criteria changed since the user confirmed them (${ids.join(", ")}). `
    + `If the user agreed to the change, record it with \`criteria ${t.id} --reason "<the user's decision>"\`, then retry.`;
}

// What `finish` shows the user: every criteria change the run recorded, and why.
function criteriaReport(s) {
  const entries = s.criteriaChanges || [];
  if (!entries.length) return "acceptance criteria changed during the run: none";
  return ["acceptance criteria changed during the run — each followed the user's agreement:",
    ...entries.map((e) => `- #${e.task} ${e.ids.join(", ")}: ${e.reason}`)].join("\n");
}

function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith("**/", i)) { re += "(?:.*/)?"; i += 2; }
    else if (glob.startsWith("**", i)) { re += ".*"; i += 1; }
    else if (glob[i] === "*") re += "[^/]*";
    else if (glob[i] === "?") re += "[^/]";
    else re += glob[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
// A glob without wildcards also covers everything below it, so "src/foo" reads as the file or the directory.
export const inScope = (path, scope) => scope.some((g) => globRe(g).test(path) || (!/[*?]/.test(g) && path.startsWith(`${g}/`)));

function readTickets(dir, { numbered = false, explicit = false } = {}) {
  if (!existsSync(dir)) fail(`tickets directory not found: ${dir}`);
  const tickets = readdirSync(dir).filter((f) => f.endsWith(".md"))
    .map((f) => {
      const file = join(dir, f);
      const text = readFileSync(file, "utf8");
      const t = parseTicket(file, text);
      const criteria = t && acceptanceCriteria(file, text, { numbered, explicit });
      return t && { ...t, criteria, acceptance: criterionCommands(criteria) };
    }).filter(Boolean);
  if (!tickets.length) fail(`no NN-slug.md tickets in ${dir}`);
  const byNum = new Map();
  for (const t of tickets) {
    if (byNum.has(Number(t.id))) fail(`duplicate ticket number ${t.id}: ${basename(byNum.get(Number(t.id)).file)}, ${basename(t.file)}`);
    byNum.set(Number(t.id), t);
  }
  const warnings = [];
  for (const t of tickets) {
    t.blockedBy = [];
    for (const n of t.refs) {
      if (n === Number(t.id)) fail(`ticket ${t.id} lists itself as a blocker`);
      if (byNum.has(n)) t.blockedBy.push(byNum.get(n).id);
      else warnings.push(`ticket ${t.id}: "Blocked by" mentions ${n}, which is not a ticket number; ignored`);
    }
  }
  const color = new Map();
  const visit = (t, path) => {
    if (color.get(t.id) === 1) fail(`blocking cycle: ${[...path, t.id].join(" -> ")}`);
    if (color.get(t.id) === 2) return;
    color.set(t.id, 1);
    for (const b of t.blockedBy) visit(byNum.get(Number(b)), [...path, t.id]);
    color.set(t.id, 2);
  };
  tickets.forEach((t) => visit(t, []));
  return { tickets, warnings };
}

// The regression set: every integrated ticket's acceptance commands, in ticket
// number order, run again at each later integration and at finish. Each entry
// carries its ticket, so a failure says whose accepted behaviour broke.
const commandEntries = (t, acceptance = []) => acceptance.map((a) => ({ cmd: a.command, task: t.id, criterion: a.criterion }));
const regressionSet = (s) => tasksOf(s).filter((t) => t.status === "done").flatMap((t) => commandEntries(t, t.acceptance));

// A ticket's criteria are confirmed once: a run that uses numbered criteria records
// them when the ticket enters the run, and from then on only `criteria <NN>` (after
// the user agreed) replaces them. An import of a ticket already in the run therefore
// leaves its confirmed set alone, which is what makes the later gates meaningful.
function mergeTickets(state, tickets, { numbered = false } = {}) {
  const changes = [];
  for (const k of tickets) {
    const t = Object.values(state.tasks).find((x) => Number(x.id) === Number(k.id));
    if (!t) {
      state.tasks[k.id] = {
        id: k.id, title: k.title, file: k.file, blockedBy: k.blockedBy, status: "ready", hold: null, attempt: "a1", rounds: 0, history: [],
        ...(numbered && { criteria: k.criteria }),
      };
      changes.push(`added #${k.id} ${k.title}`);
    } else if (t.status === "ready") {
      if (t.title !== k.title || t.file !== k.file || t.blockedBy.join() !== k.blockedBy.join()) changes.push(`updated #${t.id}`);
      Object.assign(t, { title: k.title, file: k.file, blockedBy: k.blockedBy });
    } else if (t.blockedBy.join() !== k.blockedBy.join()) {
      changes.push(`#${t.id} is ${t.status}; its new blockers (${k.blockedBy.join(", ") || "none"}) were NOT applied`);
    }
  }
  return changes;
}

// ----------------------------------------------------------------- briefs

// The version-dependent pieces of the reviewer brief. A run created by this version
// states the review boundary, asks for cited bases and narrows a re-review; a run
// created before it keeps the brief it has always had.
function briefParts(bounded) {
  if (bounded) {
    return {
      boundary: `\n${render("reviewer-boundary.md", { floorClasses: floorClasses() })}`,
      adrRule: "",
      findingsExample: [
        '| S1 | Standards | src/x.ts:12 | AC2: "the parser reads `x`" | yes | what proves it fixed |',
        '| S2 | Standards | src/y.ts:3 | Regression: `npm test` — suite `parse` fails | yes | green again |',
        '| P1 | Spec | src/z.ts:8 | AC3: "the writer keeps the header" | no | ... |',
      ].join("\n"),
      outOfScopeExample: "\n\n## Out of scope\n- src/x.ts has a long function that could be split; not a floor class.",
      verdictRule: "",
      boundaryFinding: "A Boundary finding blocks only when its `Basis` cites a confirmed criterion or a floor class: the criterion the overstep breaks, or `Data loss:` when it can overwrite or lose work outside the task. Number it `B1`, `B2`, …. Any other overstep, and any open product decision, is a line under `## Out of scope` for the user, never a finding ID.",
      reReviewLimit: "\n- **The three-part limit still applies.** In a re-review, raise a `B` finding only where that method reaches: a previous in-boundary blocking finding still unfixed, an acceptance command, or a floor-class problem the change introduced. An overstep older than the change goes under `## Out of scope`.",
    };
  }
  return {
    boundary: "",
    adrRule: "- ADRs in `docs/adr/` are constraints: a change that contradicts one is a blocking finding unless the ticket says that ADR is superseded.",
    findingsExample: [
      "| S1 | Standards | src/x.ts:12 | the standard or smell, quoted | yes | what proves it fixed |",
      "| P1 | Spec | ... | the ticket/spec line, quoted | no | ... |",
    ].join("\n"),
    outOfScopeExample: "",
    verdictRule: "- The verdict is `Verdict: changes_requested` if any finding is blocking, and `Verdict: pass` otherwise.",
    boundaryFinding: "Report each as a finding with Axis `Boundary`, numbered `B1`, `B2`, …, and mark it blocking.",
    reReviewLimit: "",
  };
}

function render(name, vars) {
  return readFileSync(join(TEMPLATES, name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) fail(`template ${name} uses unknown placeholder {{${k}}}`);
    return vars[k];
  });
}
const skillPath = (name) => pathArg(join(SKILLS_ROOT, name, "SKILL.md"));
const list = (cmds) => (cmds.length ? cmds.map((c) => `\`${c}\``).join(", ") : "none configured — run the repo's own tests");

function notesFrom(opts) {
  const parts = [];
  if (opts.note) parts.push(opts.note);
  if (opts["note-file"]) parts.push(readFileSync(resolve(opts["note-file"]), "utf8").trim());
  return parts.length ? `\n## Notes from the orchestrator\n\n${parts.join("\n\n")}\n` : "";
}

// ----------------------------------------------------------- helpers: git

const branchExists = (repo, b) => gitTry(repo, "show-ref", "--verify", "--quiet", `refs/heads/${b}`).code === 0;
function worktreeFor(repo, branch) {
  // NUL records avoid platform line endings and Git's quoted path format.
  const out = gitRaw(repo, "worktree", "list", "--porcelain", "-z");
  const line = `branch refs/heads/${branch}`;
  for (const block of out.split("\0\0")) {
    const fields = block.split("\0");
    if (fields.includes(line)) return fields.find((field) => field.startsWith("worktree "))?.slice(9) ?? null;
  }
  return null;
}
const isClean = (dir) => git(dir, "status", "--porcelain") === "";
const head = (dir) => git(dir, "rev-parse", "HEAD");
const isAncestor = (dir, a, b) => gitTry(dir, "merge-base", "--is-ancestor", a, b).code === 0;

function checkIntegration(s) {
  const wt = s.integration.worktree;
  if (!existsSync(wt)) fail(`integration worktree is missing: ${wt}`);
  const h = head(wt);
  if (h !== s.integration.tip) fail(`integration worktree HEAD ${short(h)} != recorded tip ${short(s.integration.tip)}; something else wrote to ${s.integration.branch}. Inspect it before continuing.`);
  if (!isClean(wt)) fail(`integration worktree has uncommitted changes: ${wt}`);
}

// -------------------------------------------------------------- decisions

// ADR and glossary files decided before the work starts. Additions, edits,
// deletions and renames all count; a rename contributes both of its paths.
const DECISION_PATHS = ["docs/adr", "docs/adr-history.md", "GLOSSARY.md", "GLOSSARY-MAP.md", "**/GLOSSARY.md", "**/docs/adr/**"];

// The branch a worktree has checked out; null on a detached HEAD.
const currentBranch = (dir) => gitTry(dir, "symbolic-ref", "--quiet", "--short", "HEAD").out || null;

// A run is still undispatched while every task is ready and none was ever started.
// `retry` puts a task back to ready, so attempt history is what tells them apart.
function dispatchedTask(s) {
  const all = tasksOf(s);
  return all.find((t) => t.status !== "ready") ?? all.find((t) => t.history.length || t.agentId || t.attempt !== "a1");
}

// Every path the worktree changed, both sides of a rename, untracked files included.
// Porcelain -z gives "<XY> <path>\0" per entry, and a rename adds the original path
// as one more field right after it.
function changedPaths(dir) {
  const fields = gitRaw(dir, "status", "--porcelain", "-z", "--untracked-files=all").split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const xy = fields[i].slice(0, 2);
    paths.push(fields[i].slice(3));
    if (xy[0] === "R" || xy[0] === "C") paths.push(fields[++i]);
  }
  return [...new Set(paths)].sort();
}

// Records the ADR and glossary changes decided before dispatch as one commit on
// the integration branch, so executors and reviewers branch from them.
async function cmdDecisions(dir, s) {
  const early = dispatchedTask(s);
  if (early) {
    const why = early.status === "ready" ? `#${early.id} has attempt history` : `#${early.id} is ${early.status}`;
    fail(`${why}; decisions are recorded before the first dispatch, and the tasks share the integration branch already. Nothing committed.`);
  }
  const integ = s.integration.worktree;
  if (!existsSync(integ)) fail(`integration worktree is missing: ${integ}`);
  const prev = s.integration.tip;
  // The commit has to land on the integration branch itself. Another branch, or a
  // detached HEAD, can sit at the very same SHA and pass a HEAD-vs-tip check while
  // the branch stays behind and state points at a commit it does not contain.
  const branch = currentBranch(integ);
  if (!branch) fail(`integration worktree ${integ} has a detached HEAD at ${short(head(integ))}; it must be on ${s.integration.branch}, or the commit would land where the run does not track it. Nothing committed.`);
  if (branch !== s.integration.branch) fail(`integration worktree ${integ} is on branch ${branch}, not ${s.integration.branch}; a commit there would leave ${s.integration.branch} behind. Nothing committed.`);
  const h = head(integ);
  const ref = gitTry(integ, "rev-parse", "--verify", "--quiet", `refs/heads/${s.integration.branch}`).out;
  if (h !== prev || ref !== prev) {
    fail(`integration worktree HEAD ${short(h)} (${s.integration.branch} ref ${short(ref)}) != recorded tip ${short(prev)}; something else wrote to ${s.integration.branch}. Nothing committed.`);
  }

  const paths = changedPaths(integ);
  if (!paths.length) fail(`nothing to record: no changes in ${integ}`);
  const outside = paths.filter((p) => !inScope(p, DECISION_PATHS));
  if (outside.length) fail(`changes outside the decision paths (${DECISION_PATHS.join(", ")}):\n  ${outside.join("\n  ")}\nRecord only ADR and glossary decisions here; nothing committed.`);

  git(integ, "add", "-A");
  git(integ, "commit", "-q", "-m", `workloop: record decisions for ${s.feature}`);
  const minutes = checkLimit(s);
  const checks = await runChecks(s.config.checks, integ, minutes);
  // A check that may still be running could write into the worktree, so the
  // commit and the changes stay as they are until its processes are stopped.
  if (checks.cleanupFailed) {
    record(dir, s, "decisions_failed", { check: checks.cmd, paths, tip: prev, head: head(integ), cleanupFailed: checks.cleanupFailed });
    fail(`${cleanupFailure(checks, minutes)}. ${s.integration.branch} was NOT rolled back: the decisions commit ${short(head(integ))} is still on it and the recorded tip is still ${short(prev)}.\n`
      + `Once they are stopped, put the branch back keeping your changes uncommitted (\`${decisionsResetCommand(integ, prev)}\`), fix what \`${checks.cmd}\` rejects, and run \`decisions\` again.\n${checks.output}`);
  }
  if (!checks.ok) {
    const why = checks.timedOut ? timedOut(checks.cmd, minutes) : `\`${checks.cmd}\` fails after committing`;
    // Like integrate, a failing check puts the branch back and leaves the changes
    // uncommitted. The reset can fail on its own (a lock the check left behind, a
    // race), so its outcome is verified rather than assumed: only a HEAD confirmed
    // back at the previous tip is reported as a rollback.
    const reset = gitTry(integ, "reset", "--mixed", prev);
    const now = head(integ);
    const back = reset.code === 0 && now === prev;
    const resetError = reset.code === 0 ? `reset --mixed ${short(prev)} left HEAD at ${short(now)}` : reset.err || reset.out;
    record(dir, s, "decisions_failed", {
      check: checks.cmd, paths, tip: prev, recovered: back, head: now,
      branch: currentBranch(integ) || "(detached)", ...(back ? {} : { resetError }),
    });
    if (back) {
      fail(`${why}; ${s.integration.branch} is back at ${short(prev)} and the changes are still in the worktree, uncommitted. Fix them and run \`decisions\` again:\n${checks.output}`);
    }
    fail(`${s.integration.branch} is NOT rolled back: ${why}, and Git could not undo the commit.\n${resetError}\n`
      + `Nothing was lost and nothing was accepted: the commit is still on ${currentBranch(integ) || "the detached HEAD"}, HEAD is ${short(now)}, expected ${short(prev)}, and the recorded integration tip is still ${short(prev)}. Your changes are in that commit, not gone, and nothing dispatches from it.\n`
      + `To get back to the recorded tip yourself, without editing this run's state or events (only this script writes them):\n`
      + `  1. Read what Git refused on above before touching anything. If it is a lock some other, already-finished process left behind, remove that file once you have identified it.\n`
      + `  2. Put the branch back on the recorded tip, keeping your work: \`git -C ${integ} reset --soft ${short(prev)}\`. A soft reset moves HEAD only; your files stay as they are.\n`
      + `  3. Fix what \`${checks.cmd}\` rejects, then run \`decisions\` again. Only that command records the new tip, and only after the checks pass.\n`
      + `Check output:\n${checks.output}`);
  }
  s.integration.tip = head(integ);
  record(dir, s, "decisions", { tip: s.integration.tip, paths });
  say(`decisions recorded: ${s.integration.branch} ${short(prev)} -> ${short(s.integration.tip)}`);
  paths.forEach((p) => say(`  ${p}`));
}

// ------------------------------------------------------------- next steps

function frontier(s) {
  return tasksOf(s).filter((t) => t.status === "ready" && !t.hold && t.blockedBy.every((b) => s.tasks[b]?.status === "done"));
}
const executorsBusy = (s) => tasksOf(s).filter((t) => t.status === "running").length;
const isDirect = (s) => s.mode === "direct"; // runs from before modes existed are full runs
// Reviews in progress, counted from state alone: nextSteps runs on every status and
// does not ask Rex. A task counts once its candidate is frozen and its review report
// isn't written yet. A frozen task with no review yet is not counted: `review` would start it.
const reviewsBusy = (s) => tasksOf(s).filter((t) => t.status === "in_review" && t.review && !reviewReport(t)).length;

// ------------------------------------------------- end-of-run document check

// The installed /tidy-docs skill, as tidy-docs.mjs writes it: the Agent Skills
// location pi reads and the Claude Code one. Both are excluded from git, so they
// exist in the user's main checkout and never in the integration worktree.
const TIDY_SKILLS = [join(".agents", "skills", "tidy-docs", "SKILL.md"), join(".claude", "skills", "tidy-docs", "SKILL.md")];

// Runs tidy-docs.mjs inventory as a child process. Importing it would make a cycle
// (it imports inScope from this file); a report is the only thing wanted here.
function documentInventory(s, { since = null } = {}) {
  const script = join(HERE, "tidy-docs.mjs");
  const args = [script, "inventory", "--repo", s.integration.worktree, "--json"];
  if (since) args.push("--since", since);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error) fail(`tidy-docs.mjs inventory: ${r.error.message}`);
  if (r.status !== 0) fail(`tidy-docs.mjs inventory failed (exit ${r.status}):\n${(r.stderr || r.stdout || "").trim()}`);
  // Exit 0 with output a parser cannot read is no report either: treating it as an
  // empty one would silently pass a run that added an unregistered document.
  try { return JSON.parse(r.stdout.slice(r.stdout.search(/[[{]/))); } catch {
    fail(`tidy-docs.mjs inventory printed no JSON report (exit ${r.status}):\n${`${r.stdout}\n${r.stderr || ""}`.trim().slice(0, 2000)}`);
  }
}

// The documents a full run added that the repo's registry doesn't cover, or null
// when the repo has no registry (which never blocks: that repo is not in the model
// yet). Only what the run added is considered (--since the base), so an existing
// unregistered backlog outside the run cannot block it.
// An inventory that could not run is not an empty inventory: it is reported as an
// error, so `status` and `finish` refuse on it rather than pass a run nobody checked.
function documentReport(s) {
  if (s.finishedAt) return { paths: [], registry: true }; // no worktree left to inventory
  try {
    const r = documentInventory(s, { since: s.baseSha });
    return { paths: r.registry ? r.unregistered || [] : [], registry: !!r.registry };
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    return { error: e.message };
  }
}

// The message for a report from documentReport: null when there is nothing to say.
// One inventory per command, so `finish` makes its gate and its reminder decision
// from the same report: a second subprocess could fail and turn a valid registry
// into the "no registry" reminder.
function documentStep(report) {
  if (report.error) return `the document inventory failed, so nothing checked what this run added: fix the registry and run \`status\` again — ${report.error}`;
  if (!report.registry || !report.paths.length) return null;
  return `${report.paths.length} new documents aren't in the registry (${report.paths.join(", ")}): classify them per reference/tidy-docs.md and fix them with a repair ticket before the final review`;
}

// A repo without a registry is never blocked, but a repo with the /tidy-docs skill
// installed has asked to be tidied, and the run that added documents is the moment.
function tidyDocsReminder(s) {
  return TIDY_SKILLS.some((p) => existsSync(join(s.repo, p))) ? "this repo has no document registry yet; run /tidy-docs" : null;
}

function nextSteps(dir, s) {
  if (s.finishedAt) return ["archived; retrospective evidence remains in the run directory"];
  if (s.completion) return [s.retro?.completion === s.completion.at
    ? "archive — retrospective assessed; archive the retained agents and worktrees together"
    : "assess the whole run: retro --file <report> or retro --skip --reason <why>, then archive"];
  const out = [];
  const tasks = tasksOf(s);
  // Until a check phase ends or is recovered, every other step would be refused.
  if (s.checking) {
    return [interrupted(s) ? `${recoveryCommand(s.checking)} — recover the interrupted check phase`
      : `wait for \`${recoveryCommand(s.checking)}\` (pid ${s.checking.pid}) to end: collect its exit code and output when its background command notifies you; meanwhile end this turn`];
  }
  // Suggesting a review the budget can't start only earns a refusal, so say what it waits for.
  const busy = reviewsBusy(s);
  const reviewRequest = (t) => (busy >= s.config.maxReviewers
    ? `#${t.id} waits for a reviewer (budget ${busy}/${s.config.maxReviewers})`
    : `review ${t.id}`);
  for (const t of tasks) {
    if (t.hold) { out.push(`#${t.id} on hold (${t.hold}) — resolve it, then \`unhold ${t.id}\``); continue; }
    if (t.status === "running") {
      if (!t.agentId) { out.push(`dispatch ${t.id}`); continue; }
      const r = executorReport(dir, t);
      if (r?.status === "done") out.push(reviewRequest(t));
      else if (r?.status === "question" || r?.status === "blocked") out.push(`#${t.id} reported ${r.status} — read ${reportPath(dir, t)}, answer with \`send ${t.id} --text <answer>\``);
    }
    if (t.status === "in_review") {
      const v = reviewReport(t)?.verdict;
      if (!t.review) out.push(reviewRequest(t));
      else if (v === "pass") out.push(`integrate ${t.id}`);
      else if (v) {
        // A review whose blocking findings are all outside its boundary is advice:
        // the candidate is ready to integrate, and nothing needs rework.
        const gate = numberedCriteria(s) ? splitBlocking(t, true).blocking : null;
        if (gate && !gate.length) out.push(`integrate ${t.id} — the review's blocking findings are all outside its boundary (suggestions for the user)`);
        else if (numberedCriteria(s) && (t.rounds || 0) + 1 > reworkCap(s)) out.push(`#${t.id} changes requested, and at the rework cap (${reworkCap(s)}) — ask the user, then \`send ${t.id} --extra-round --reason "<their decision>"\``);
        else out.push(`#${t.id} changes requested — read ${t.review.path}, then \`send ${t.id} --file <rework.md>\` (or \`integrate ${t.id} --override "<why>"\`)`);
      }
    }
    for (const b of t.blockedBy) if (s.tasks[b]?.status === "cancelled" && t.status === "ready") out.push(`#${t.id} is blocked by cancelled #${b} — cancel it or edit its ticket and \`import\``);
  }
  if (tasks.some((t) => ["running", "in_review"].includes(t.status) && !t.hold)) out.push("run `wait` in the background, then end this turn; it returns when a turn ends");
  const free = s.config.maxExecutors - executorsBusy(s);
  const f = frontier(s);
  if (f.length && free > 0) out.push(f.slice(0, free).map((t) => `dispatch ${t.id}`).join(", "));
  if (tasks.every((t) => ["done", "cancelled"].includes(t.status))) {
    if (isDirect(s)) out.push("all tickets closed — `finish` (a direct run has no final review)");
    else {
      // Documents come first: classifying them can need a repair ticket, and the
      // final review must cover the tip that ticket produces.
      const bad = documentStep(documentReport(s));
      if (bad) out.push(bad);
      else out.push(...finalSteps(dir, s));
    }
  }
  return [...new Set(out)];
}

function printNext(dir, s) {
  const steps = nextSteps(dir, s);
  if (steps.length) say(`next: ${steps.join("\n      ")}`);
}

// ---------------------------------------------------------------- commands

// A run's location, derived one way for every command that needs it: the repo's
// top level, the project name it implies, and the run directory under WORKLOOP_ROOT.
function runLocation(opts) {
  if (!opts.feature || !/^[a-z0-9][a-z0-9-]*$/.test(opts.feature)) fail("--feature <slug> is required (lowercase letters, digits, dashes)");
  const repo = git(resolve(opts.repo || "."), "rev-parse", "--show-toplevel");
  const project = basename(repo).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return { repo, project, dir: join(workloopRoot(), project, opts.feature) };
}

// Prints where a run's documents go and creates the tickets directory, so the
// spec and tickets can be written there before `init` (or during a run, for repairs).
function cmdScratch(opts) {
  const { dir } = runLocation(opts);
  mkdirSync(join(dir, "issues"), { recursive: true });
  say(`run dir: ${dir}`);
  say(`spec: ${join(dir, "spec.md")}`);
  say(`tickets: ${join(dir, "issues")}`);
}

async function cmdInit(opts) {
  const { repo, project, dir } = runLocation(opts);
  if (existsSync(statePath(dir))) fail(`a run already exists at ${dir}`);
  const ticketsDir = resolve(opts.tickets || join(dir, "issues"));
  const { tickets, warnings } = readTickets(ticketsDir, { numbered: true, explicit: true });
  if (opts.direct) {
    if (tickets.length !== 1) fail(`a direct run takes exactly one ticket; ${ticketsDir} has ${tickets.length}`);
    if (!ticketScope(tickets[0].file, readFileSync(tickets[0].file, "utf8"))) fail(`${basename(tickets[0].file)}: a direct run needs a "Scope:" line listing the paths it may change`);
  }
  // A direct ticket is its own spec.
  const spec = resolve(opts.spec || (opts.direct ? tickets[0].file : join(dir, "spec.md")));
  if (!existsSync(spec)) fail(`spec not found: ${spec} (pass --spec)`);
  const baseRef = opts.base || gitTry(repo, "symbolic-ref", "--short", "HEAD").out || "HEAD";
  const baseSha = git(repo, "rev-parse", "--verify", `${baseRef}^{commit}`);
  const branch = `workloop/${opts.feature}`;
  if (branchExists(repo, branch)) fail(`branch ${branch} already exists; pick another --feature or delete the branch`);
  const setup = opts.setup || [];
  const checks = opts.check || [];
  const checkTimeout = checkTimeoutSetting(opts["check-timeout"]) ?? DEFAULT_CHECK_TIMEOUT;
  const maxReworkRounds = maxRoundsSetting(opts["max-rework-rounds"]) ?? DEFAULT_MAX_REWORK_ROUNDS;
  const config = {
    maxExecutors: Number(opts["max-executors"] || 2), maxReviewers: Number(opts["max-reviewers"] || 1),
    checkTimeout, maxReworkRounds, setup, checks, executor: agentConfig(opts, ""), reviewer: agentConfig(opts, "review-"),
  };
  for (const role of Object.keys(ROLES)) launchSettings(config, role);

  // Not "integration": pytest makes each directory on a test's path a keyword, and a repo whose
  // conftest skips by `"integration" in item.keywords` would skip every test in this tree.
  const integ = join(dir, "tip");
  mkdirSync(dir, { recursive: true });
  git(repo, "worktree", "add", "-b", branch, integ, baseSha);
  const rollback = (why) => {
    gitTry(repo, "worktree", "remove", "--force", integ);
    gitTry(repo, "branch", "-D", branch);
    fail(why);
  };
  const r1 = runAll(setup, integ);
  if (!r1.ok) rollback(`setup failed (\`${r1.cmd}\`), nothing kept:\n${r1.output}`);
  const r2 = await runChecks(checks, integ, checkTimeout);
  // A check that may still be running works inside the worktree, so it is kept.
  if (r2.cleanupFailed) {
    fail(`${cleanupFailure(r2, checkTimeout)}. The integration worktree ${integ} and branch ${branch} were kept, and no run was created.\n`
      + `Once they are stopped, remove both (${initCleanupCommands(repo, integ, branch).map((c) => `\`${c}\``).join(" and ")}), then run \`init\` again.\n${r2.output}`);
  }
  if (!r2.ok) rollback(`checks fail on the base ${baseRef} already (${r2.timedOut ? timedOut(r2.cmd, checkTimeout) : `\`${r2.cmd}\``}), nothing kept. Fix them or choose checks that pass:\n${r2.output}`);

  const state = {
    version: 1, host: "rex", project, feature: opts.feature, runKey: `${project}-${opts.feature}`, mode: opts.direct ? "direct" : "full",
    repo, spec, tickets: ticketsDir, baseRef, baseSha,
    integration: { branch, worktree: integ, tip: baseSha },
    config, tasks: {}, seq: 0, createdAt: now(), reviewBoundary: 1, explicitAcceptance: 1,
  };
  mergeTickets(state, tickets, { numbered: true });
  for (const d of ["briefs", "reports", "reviews", "messages"]) mkdirSync(join(dir, d), { recursive: true });
  record(dir, state, "init", { baseSha, tasks: Object.keys(state.tasks) });
  warnings.forEach((w) => say(`warning: ${w}`));
  say(`run ${dir}`);
  say(`checks stop after ${checkTimeout}m each; change it with \`config --check-timeout <minutes>\``);
  say(`rework stops at ${maxReworkRounds} round${maxReworkRounds === 1 ? "" : "s"}; change it with \`config --max-rework-rounds <n>\``);
  say(`integration ${branch} at ${short(baseSha)} in ${integ}`);
  say(`use: node ${pathArg(fileURLToPath(import.meta.url))} --run ${project}/${opts.feature} <command>`);
  printStatus(dir, state, false);
}

// ------------------------------------------------------- launch settings

const ROLES = { executor: "", reviewer: "review-" }; // role -> its option prefix
const FIELDS = ["provider", "model", "mode", "thinking", "profile"];

function agentConfig(opts, prefix) {
  const c = {};
  for (const k of FIELDS) if (opts[prefix + k]) c[k] = opts[prefix + k];
  return c;
}
const describe = (l) => `${l.provider}${FIELDS.slice(1).map((k) => (l[k] ? ` ${k}=${l[k]}` : "")).join("")} ← ${l.source}`;

// The launch settings a role falls back to, kept for every run in
// <WORKLOOP_ROOT>/launch.json: {"executor": {"provider": "dsh", "mode": "…"}, "reviewer": {…}}.
const defaultsPath = () => join(workloopRoot(), "launch.json");
function launchDefaults() {
  const file = defaultsPath();
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")) || {}; } catch (e) { fail(`cannot read ${file}: ${e.message}`); }
}

// A role's launch settings, most specific first: this command's flags, the run's
// config, then the defaults file. A role with no provider, or with a setting its CLI
// does not take or without one it needs, is an error, so an agent never starts on a guess.
function resolveLaunch(config, role, opts = {}) {
  const prefix = ROLES[role];
  const explicit = { ...config[role], ...agentConfig(opts, prefix) };
  const d = launchDefaults()[role] || {};
  // The defaults' other settings belong to their provider; naming another drops them.
  const base = !explicit.provider || explicit.provider === d.provider ? Object.fromEntries(FIELDS.filter((k) => d[k]).map((k) => [k, d[k]])) : {};
  const over = Object.keys(explicit);
  const source = !base.provider ? "run config" : `${defaultsPath()}${over.length ? ` + ${over.join(", ")} from the run` : ""}`;
  const l = { ...base, ...explicit, source };
  if (!l.provider) {
    fail(`${role}: no launch settings: the run sets no --${prefix}provider, and ${defaultsPath()} has no "${role}" entry. `
      + `Providers: ${PROVIDERS.join(", ")}. Tell the user; don't choose for them.`);
  }
  const problem = settingsProblem(role, l);
  if (problem) fail(`${problem} (${source}). Tell the user; don't choose for them.`);
  return l;
}
const launchSettings = (config, role, opts) => resolveLaunch(config, role, opts);

function launchTable(config) {
  return Object.keys(ROLES).map((role) => {
    try { return { role, ...resolveLaunch(config, role) }; } catch (e) {
      if (!(e instanceof UserError)) throw e;
      return { role, error: e.message };
    }
  });
}

// A send that ends a review keeps that review in history, so finish still sees it.
// Only a rework send opens a round: a nudge after a pass, or a `--merge-tip` send,
// sends the task back to running without spending the user's round budget.
function completeSend(t, { sentAt, n, rework = false }) {
  if (t.status === "in_review") {
    displaceReview(t);
    Object.assign(t, { status: "running", candidateSha: null, fixedPoint: null, review: null, ...(rework && { rounds: (t.rounds || 0) + 1 }) });
  }
  Object.assign(t, { messages: n, promptedAt: sentAt });
}

function cmdConfig(dir, s, opts) {
  const c = s.config;
  if (opts["max-executors"]) c.maxExecutors = Number(opts["max-executors"]);
  if (opts["max-reviewers"]) c.maxReviewers = Number(opts["max-reviewers"]);
  if (opts.check) c.checks = opts.check;
  if (opts.setup) c.setup = opts.setup;
  const timeout = checkTimeoutSetting(opts["check-timeout"]);
  if (timeout != null) c.checkTimeout = timeout;
  const rounds = maxRoundsSetting(opts["max-rework-rounds"]);
  if (rounds != null) c.maxReworkRounds = rounds;
  // Flags only add launch overrides; dropping a role's overrides is how it follows
  // the defaults file again after the user edits it. Flags in the same
  // command apply after the clear.
  const cleared = [...new Set(opts["clear-launch"] || [])];
  for (const role of cleared) if (!(role in ROLES)) fail(`--clear-launch takes executor or reviewer, not "${role}"`);
  for (const role of cleared) c[role] = {};
  Object.assign(c.executor, agentConfig(opts, ""));
  Object.assign(c.reviewer, agentConfig(opts, "review-"));
  record(dir, s, "config", { config: c, ...(cleared.length && { clearedLaunch: cleared }) });
  say(JSON.stringify(c, null, 2));
  for (const role of cleared) say(`${role}: the run's launch overrides were dropped; agents started from now on use the defaults in ${defaultsPath()}${Object.keys(c[role]).length ? " plus this command's flags" : ""}`);
  printLaunch(c, true);
}

// The one way a ticket's confirmed criteria change: the user agreed to it, and the
// reason is recorded, so `finish` can show the user every change the run accepted.
function cmdCriteria(dir, s, id, opts) {
  const t = task(s, id);
  if (!numberedCriteria(s)) fail(`this run predates numbered acceptance criteria, so #${t.id} has no confirmed set to change; it reads its tickets as before`);
  if (!opts.reason?.trim()) fail(`criteria needs --reason "<the user's decision>": a change follows the user's agreement, and finish lists it with that reason`);
  if (!existsSync(t.file)) fail(`#${t.id}: its ticket file is gone (${t.file}); restore it before recording its criteria`);
  const current = acceptanceCriteria(t.file, readFileSync(t.file, "utf8"), criteriaOptions(s));
  const ids = criteriaDiff(t.criteria ?? [], current);
  if (!ids.length) return say(`#${t.id}: its criteria are unchanged; nothing recorded`);
  const entry = { task: t.id, ids, reason: opts.reason.trim(), at: now() };
  t.criteria = current;
  s.criteriaChanges = [...(s.criteriaChanges || []), entry];
  record(dir, s, "criteria", entry);
  say(`#${t.id}: recorded the user's change to ${ids.join(", ")}; finish lists it with the reason`);
}

function cmdImport(dir, s) {
  const { numbered, explicit } = criteriaOptions(s);
  const { tickets, warnings } = readTickets(s.tickets, { numbered, explicit });
  if (isDirect(s)) {
    const added = tickets.filter((k) => !s.tasks[k.id]);
    if (added.length && (added.length !== 1 || tasksOf(s).some((t) => t.status !== "done")
      || !added[0].blockedBy.some((id) => s.tasks[id]?.status === "done"))) {
      fail("a direct run holds one ticket at a time; after integration it can import one repair blocked by an integrated ticket. Broader work belongs in a full run.");
    }
    for (const k of added) if (!ticketScope(k.file, readFileSync(k.file, "utf8"))) fail(`direct repair #${k.id} needs a "Scope:" line`);
  }
  const changes = mergeTickets(s, tickets, { numbered });
  const missing = Object.values(s.tasks).filter((t) => !tickets.some((k) => Number(k.id) === Number(t.id)));
  record(dir, s, "import", { changes });
  warnings.forEach((w) => say(`warning: ${w}`));
  missing.forEach((t) => say(`warning: #${t.id} has no ticket file any more; it stays in the run (cancel it if it is gone for good)`));
  say(changes.length ? changes.join("\n") : "no changes");
}

function cmdDispatch(dir, s, id, opts) {
  const t = task(s, id);
  if (!(t.status === "ready" || (t.status === "running" && !t.agentId))) fail(`#${t.id} is ${t.status}${t.agentId ? ` with agent ${t.agentId}` : ""}; nothing to dispatch`);
  if (t.hold) fail(`#${t.id} is on hold: ${t.hold}`);
  const criteria = criteriaGate(s, t);
  if (criteria) fail(criteria);
  const open = t.blockedBy.filter((b) => s.tasks[b]?.status !== "done");
  if (open.length) fail(`#${t.id} is blocked by ${open.map((b) => `#${b} (${s.tasks[b]?.status})`).join(", ")}`);
  if (t.status === "ready" && executorsBusy(s) >= s.config.maxExecutors) fail(`executor budget full (${s.config.maxExecutors} running); wait for one to reach review, or raise it with \`config --max-executors\``);
  checkIntegration(s);
  const tip = t.reuseWorktree ? t.baseSha : s.integration.tip;
  const branch = t.reuseWorktree ? t.branch : `wl-${s.feature}-${t.id}-${t.attempt}`;

  const vars = {
    ...workFolders(dir, briefPath(dir, t), false),
    task: t.id, title: t.title, attempt: t.attempt, ticketPath: pathArg(t.file), specPath: pathArg(isDirect(s) ? t.file : s.spec),
    branch, baseSha: tip, startSha: tip, worktree: "(set at dispatch)", reportPath: pathArg(reportPath(dir, t)),
    skillsRoot: pathArg(SKILLS_ROOT), implementSkill: skillPath("implement"), tddSkill: skillPath("tdd"),
    integrationBranch: s.integration.branch, checks: list(s.config.checks),
    setup: !t.reuseWorktree && s.config.setup.length ? `- Before anything else, set up the worktree: ${list(s.config.setup)}.` : "",
    notes: [t.handoff || "", notesFrom(opts)].filter(Boolean).join("\n\n"),
  };
  const launch = launchSettings(s.config, "executor", opts);
  if (opts["dry-run"]) {
    say(render("executor-brief.md", vars));
    say(`\n(dry run: would create branch ${branch} from ${s.integration.branch} at ${short(tip)} and start an executor: ${describe(launch)})`);
    return;
  }

  // 1. worktree — adopt one left by an interrupted dispatch, else create it.
  let wt = worktreeFor(s.repo, branch);
  if (t.reuseWorktree && (!wt || normPath(wt) !== normPath(t.worktree))) fail(`recovery worktree is missing or moved (branch=${branch}, registered=${JSON.stringify(wt)}, expected=${JSON.stringify(t.worktree)}, normalized=${JSON.stringify([normPath(wt), normPath(t.worktree)])}); reconcile it, or explicitly retry --new-worktree --reason <why>`);
  if (t.reuseWorktree) wt = t.worktree; // Preserve the recorded spelling after verifying directory identity.
  if (!wt) wt = addWorktree(dir, s, branch);
  wt = pathArg(wt); // state, brief and the agent's cwd all spell it one way
  const h = head(wt);
  if (!t.reuseWorktree && h !== tip) fail(`worktree ${wt} is at ${short(h)}, expected the integration tip ${short(tip)}. Not starting the agent; inspect it before continuing.`);
  if (git(wt, "branch", "--show-current") !== branch) fail(`worktree ${wt} is not on expected branch ${branch}; reconcile before dispatch`);
  Object.assign(t, { status: "running", branch, worktree: wt, baseSha: tip, promptedAt: now() });
  vars.worktree = pathArg(wt);
  vars.startSha = h;
  workFolders(dir, briefPath(dir, t));
  writeFileSync(briefPath(dir, t), render("executor-brief.md", vars));
  record(dir, s, "worktree", { task: t.id, attempt: t.attempt, branch, worktree: wt, sha: tip });

  // 2. agent — its first turn, in a tab of the run's Rex session.
  const prompt = `Read the task brief at ${pathArg(briefPath(dir, t))} and follow it. It is your complete instruction set; never ask the user anything.`;
  const agent = newAgent(s, { role: "executor", task: t.id, attempt: t.attempt, cwd: wt, launch });
  const turn = startTurn(dir, s, agent, prompt, `#${t.id} exec ${t.attempt}`);
  Object.assign(t, { agentId: agent, launch: describe(launch) });
  record(dir, s, "dispatch", { task: t.id, attempt: t.attempt, agent, block: turn.block, launch: t.launch });
  say(`#${t.id} dispatched: ${describe(launch)} in Rex tab "${turn.title}". Run \`wait\` in the background, then end this turn.`);
}

// A new branch off the integration branch, checked out in the run's worktrees folder.
function addWorktree(dir, s, branch) {
  const path = pathArg(join(dir, "worktrees", branch));
  if (existsSync(path)) fail(`${path} already exists but is not the worktree of ${branch}; look at it before retrying`);
  mkdirSync(dirname(path), { recursive: true });
  git(s.repo, "worktree", "add", "-b", branch, path, s.integration.branch);
  return path;
}

function requireIdle(id, role, allowMissing = false) {
  let a;
  try { a = inspectAgent(id); } catch (e) {
    if (!allowMissing || !e.agentMissing) throw e;
    return { id, status: "missing", archived: true, missing: true };
  }
  // Not knowing is not idle: a turn Rex cannot report on may still be writing.
  if (a.status === "unknown") fail(`cannot tell whether ${role} ${id} is still running: ${a.error}`);
  if (BUSY.has(a.status)) fail(`${role} ${id} is ${a.status} (Rex tab "${a.turn.title}"). Wait for it (\`wait\`), or stop it with Ctrl-C in its tab first`);
  return a;
}

function freeze(dir, s, t, quiet = false) {
  if (t.status !== "running" || !t.agentId) fail(`#${t.id} is ${t.status}; only a running task with an executor can be frozen`);
  const criteria = criteriaGate(s, t);
  if (criteria) fail(criteria);
  requireIdle(t.agentId, "executor");
  const r = executorReport(dir, t);
  if (!r) fail(`#${t.id}: no report written since the last prompt (${reportPath(dir, t)})`);
  if (r.status !== "done") fail(`#${t.id}: the executor reported "${r.status}", not "done"`);
  if (!isClean(t.worktree)) fail(`#${t.id}: worktree has uncommitted or untracked files; ask the executor to commit everything:\n${git(t.worktree, "status", "--short")}`);
  const sha = head(t.worktree);
  if (r.commit && !sha.startsWith(r.commit)) fail(`#${t.id}: report says Commit ${r.commit} but HEAD is ${short(sha)}`);
  const fixedPoint = git(t.worktree, "merge-base", s.integration.branch, sha);
  if (Number(git(t.worktree, "rev-list", "--count", `${fixedPoint}..${sha}`)) === 0) fail(`#${t.id}: no commits ahead of the integration branch`);
  // Read fresh, so a Scope widened with the user's OK applies without an import.
  if (!existsSync(t.file)) fail(`#${t.id}: its ticket file is gone (${t.file}); restore it before freezing`);
  const scope = ticketScope(t.file, readFileSync(t.file, "utf8"));
  if (scope) {
    const outside = git(t.worktree, "diff", "--name-only", "--no-renames", "-z", fixedPoint, sha).split("\0").filter((f) => f && !inScope(f, scope));
    if (outside.length) fail(`#${t.id}: changes outside the ticket's Scope (${scope.join(", ")}):\n  ${outside.join("\n  ")}\nIf they aren't needed, \`send\` the executor a correction. If the ticket needs them, widen its Scope line with the user's OK, then review again.`);
  }
  Object.assign(t, { status: "in_review", candidateSha: sha, fixedPoint, review: null, override: null });
  record(dir, s, "freeze", { task: t.id, attempt: t.attempt, sha, ...(scope && { scope }) });
  if (!quiet) say(`#${t.id} frozen at ${short(sha)} (${git(t.worktree, "rev-list", "--count", `${fixedPoint}..${sha}`)} commits over ${short(fixedPoint)})`);
}

// The review a re-review follows: the last one this task recorded, either the one
// its rework answered (kept in history) or the one `--again` replaces.
function previousReview(t) {
  const written = (review) => {
    const r = reviewOf(review);
    return r?.path && r.candidateSha && existsSync(r.path) ? { path: r.path, candidateSha: r.candidateSha } : null;
  };
  // `--again` replaces a review that is still the task's current one, and it is the
  // most recent: cite it before reaching into history.
  const current = written(t.review);
  if (current) return current;
  for (let i = t.history.length - 1; i >= 0; i--) {
    const found = written(t.history[i].review);
    if (found) return found;
  }
  return null;
}

function cmdReview(dir, s, id, opts) {
  const t = task(s, id);
  if (!["running", "in_review"].includes(t.status)) fail(`#${t.id} is ${t.status}; nothing to review`);
  if (t.review && !opts.again) fail(`#${t.id} already has review agent ${t.review.agentId} for ${short(t.review.candidateSha)}; pass --again to start another`);
  if (t.review) requireIdle(t.review.agentId, "reviewer");
  const busy = Object.values(s.agents || {}).filter((a) => a.role === "reviewer" && a.turns.length && BUSY.has(inspectAgent(a.id).status)).length;
  if (busy >= s.config.maxReviewers) fail(`reviewer budget full (${busy}/${s.config.maxReviewers}); \`wait\` for one, or raise it with \`config --max-reviewers\``);
  const launch = launchSettings(s.config, "reviewer", opts);
  if (t.status === "running") freeze(dir, s, t, true); // review prints only its request
  requireIdle(t.agentId, "executor");
  if (head(t.worktree) !== t.candidateSha || !isClean(t.worktree)) fail(`#${t.id}: worktree moved off the frozen candidate ${short(t.candidateSha)}`);

  const path = join(dir, "reviews", `${t.id}-${short(t.candidateSha)}${opts.again ? `-${Date.now()}` : ""}.md`);
  // A task that has been reviewed before gets the re-review brief: it looks at the
  // previous findings, the acceptance commands and floor-class problems in the
  // change since, and raises nothing else.
  const prev = previousReview(t);
  // The criteria this review is issued against. Stored with it, so a later
  // `criteria` change never reclassifies a finding it already raised.
  const bounded = numberedCriteria(s);
  const ids = bounded ? confirmedIds(t) : null;
  const parts = briefParts(bounded);
  const brief = join(dir, "briefs", `${t.id}-review-${short(t.candidateSha)}.md`);
  const vars = {
    ...workFolders(dir, brief),
    task: t.id, title: t.title, worktree: pathArg(t.worktree), branch: t.branch, candidateSha: t.candidateSha, candidateShort: short(t.candidateSha),
    fixedPoint: t.fixedPoint, ticketPath: pathArg(t.file), specPath: pathArg(isDirect(s) ? t.file : s.spec), executorReport: pathArg(reportPath(dir, t)),
    reviewPath: pathArg(path), skillsRoot: pathArg(SKILLS_ROOT), codeReviewSkill: skillPath("code-review"), notes: notesFrom(opts),
    direct: isDirect(s) ? `\n${render("reviewer-direct.md", { boundaryFinding: parts.boundaryFinding, reReviewLimit: parts.reReviewLimit })}` : "",
    reReview: bounded && prev ? `\n${render("reviewer-re-review.md", {
      previousReview: pathArg(prev.path), previousCandidate: prev.candidateSha, previousShort: short(prev.candidateSha), candidateSha: t.candidateSha,
    })}` : "",
    boundary: parts.boundary, adrRule: parts.adrRule, findingsExample: parts.findingsExample,
    outOfScopeExample: parts.outOfScopeExample, verdictRule: parts.verdictRule,
  };
  writeFileSync(brief, render("reviewer-brief.md", vars));
  const agent = newAgent(s, { role: "reviewer", task: t.id, attempt: t.attempt, cwd: t.worktree, launch });
  const startedAt = now(); // before starting: a fast reviewer may write its report right away
  const turn = startTurn(dir, s, agent, `Read the review brief at ${pathArg(brief)} and follow it. Review only; change nothing; never ask the user anything.`, `#${t.id} review ${short(t.candidateSha)}`);
  displaceReview(t);
  t.review = { agentId: agent, candidateSha: t.candidateSha, path, startedAt, launch: describe(launch), ...(ids && { criteria: ids }) };
  t.reviewers = [...(t.reviewers || []), agent];
  record(dir, s, "review", { task: t.id, agent, block: turn.block, candidate: t.candidateSha });
  say(`#${t.id}: reviewer ${describe(launch)} started on ${short(t.candidateSha)} in Rex tab "${turn.title}". Run \`wait\` in the background, then end this turn.`);
}

// A rework round past the run's cap waits for the user: the orchestrator asks, then
// records their decision with --extra-round --reason, which `finish` lists. Null
// when the round is within the cap, or when the run predates the cap.
function extraRound(s, t, opts) {
  if (!numberedCriteria(s)) return null;
  const cap = reworkCap(s);
  const round = (t.rounds || 0) + 1;
  if (round <= cap) {
    if (opts["extra-round"]) fail(`#${t.id}: rework round ${round} is within the run's cap of ${cap}, so --extra-round is not needed`);
    return null;
  }
  if (!opts["extra-round"]) {
    fail(`#${t.id}: rework round ${round} would pass the run's cap of ${cap}. The task waits for the user: decide with them whether to go on, then `
      + `\`send ${t.id} --extra-round --reason "<the user's decision>"\``);
  }
  if (!opts.reason?.trim()) fail(`send --extra-round needs --reason "<the user's decision>": round ${round} goes past the cap of ${cap}, and finish lists it`);
  return { task: t.id, attempt: t.attempt, round, cap, reason: opts.reason.trim() };
}
// The extra round is recorded in the same save as the send it belongs to, like a
// waiver: an interruption cannot leave a send past the cap unrecorded.
function extraRoundsAdd(s, entry) {
  const full = { ...entry, at: entry.at ?? now() };
  s.extraRounds = [...(s.extraRounds || []), full];
  return full;
}

function cmdSend(dir, s, id, opts) {
  const t = task(s, id);
  if (!["running", "in_review"].includes(t.status) || !t.agentId) fail(`#${t.id} is ${t.status}; no executor to talk to`);
  let body;
  if (opts["merge-tip"]) {
    body = `The integration branch \`${s.integration.branch}\` has moved to ${s.integration.tip}. Merge it into your branch (\`git merge ${s.integration.tip}\`), resolve conflicts keeping the intent of both sides, re-run the checks, and commit the merge.`;
  } else if (opts.file) body = readFileSync(resolve(opts.file), "utf8").trim();
  else if (opts.text) body = opts.text;
  else fail("send needs --text <message>, --file <path> or --merge-tip");
  // A rework answers a `changes_requested`, so it must account for that review's
  // blocking findings. A merge-tip send and one after a pass are not rework.
  const rework = t.status === "in_review" && !opts["merge-tip"] && reviewReport(t)?.verdict === "changes_requested";
  if (opts.waive && !rework) fail(`send --waive applies only to a rework send after a changes_requested review of #${t.id}; it records why a blocking finding was let through`);
  if (opts["extra-round"] && !rework) fail(`send --extra-round applies only to a rework send that would pass the run's cap of ${reworkCap(s)}; it records the user's decision to go past it`);
  const extra = rework ? extraRound(s, t, opts) : null;
  const accounting = rework ? reworkAccounting(s, t, body, opts) : null;
  const waiver = accounting?.findings ? { kind: "rework", task: t.id, review: t.review.path, sha: t.candidateSha, findings: accounting.findings, reason: accounting.reason } : null;
  if (t.review?.agentId) requireIdle(t.review.agentId, "reviewer");
  requireIdle(t.agentId, "executor");

  const n = (t.messages || 0) + 1;
  // Reports are overwritten by the executor; keep each previous round for retro.
  if (existsSync(reportPath(dir, t))) writeAtomic(join(dir, "reports", `${t.id}-${t.attempt}-before-${n}.md`), readFileSync(reportPath(dir, t), "utf8"));
  const file = join(dir, "messages", `${t.id}-${t.attempt}-${n}.md`);
  // A rework names the review it answers and how to answer it: reproduce each finding,
  // fix its cause, and check the change since as the re-review will. Most findings that
  // re-reviews block on are a fix that fell short or broke something nearby.
  const method = rework ? `${render("executor-rework.md", {
    reviewPath: pathArg(t.review.path), candidateSha: t.candidateSha, candidateShort: short(t.candidateSha),
  }).trimEnd()}\n\n` : "";
  const footer = `\n\n---\n${method}This continues task #${t.id} (brief: ${pathArg(briefPath(dir, t))}). When you stop, overwrite ${pathArg(reportPath(dir, t))} as the brief describes (first line \`Status: done | question | blocked\`). End with exactly three lines: Result: <done | question | blocked>, Report: ${pathArg(reportPath(dir, t))}, Summary: <one sentence>. Then end your turn.\n`;
  writeFileSync(file, body + footer);
  const sentAt = now(); // before sending: a fast agent may rewrite its report right away
  const turn = startTurn(dir, s, t.agentId, body + footer, `#${t.id} exec ${t.attempt} · ${n}`);
  completeSend(t, { sentAt, n, rework });
  // The waiver and the extra round go in the same save as the send they belong to.
  const waived = waiver && ledgerAdd(s, waiver);
  const past = extra && extraRoundsAdd(s, extra);
  recordAll(dir, s, [
    ["send", { task: t.id, n, rework: rework || undefined, block: turn.block }],
    ...(waived ? [waiverEvent(waived)] : []),
    ...(past ? [["extra_round", past]] : []),
  ]);
  if (accounting?.warning) say(`warning: ${accounting.warning}`);
  say(`#${t.id}: message ${n} sent; the executor goes on in Rex tab "${turn.title}". Run \`wait\` in the background, then end this turn.`);
}

// Why #t's candidate cannot be integrated, or null. Checked before the merge and
// again on the reloaded state before the result is recorded.
function integrateGate(s, t, override) {
  if (t.status !== "in_review") return `#${t.id} is ${t.status}; only a reviewed candidate can be integrated`;
  if (t.hold) return `#${t.id} is on hold: ${t.hold}`;
  const open = t.blockedBy.filter((b) => s.tasks[b]?.status !== "done");
  if (open.length) return `#${t.id} is blocked by ${open.join(", ")}`;
  const verdict = reviewReport(t)?.verdict;
  if (verdict !== "pass" && !override) {
    // A review with no verdict gates as it always did; one verdict to the contrary
    // only gates on findings inside its boundary, so a review whose blocking
    // findings all cite nothing the user settled is a list of suggestions.
    if (verdict == null) return `#${t.id}: review verdict is ${t.review ? "not written yet" : "missing — run `review`"}; integrate only on "pass", or pass --override "<reason>"`;
    if (numberedCriteria(s)) {
      const { blocking } = splitBlocking(t, true);
      if (blocking === null) return `#${t.id}: review verdict is ${verdict}, and its findings table cannot be read, so its blocking findings cannot be bounded; fix the review, or pass --override "<reason>"`;
      if (!blocking.length) return null;
    }
    return `#${t.id}: review verdict is ${verdict}; integrate only on "pass", or pass --override "<reason>"`;
  }
  return null;
}

// `integrate` runs in the three steps of a check phase. Step 1, under the lock:
// recover an interrupted phase, the guards, the merge and the `checking` entry.
// It returns step 2 and 3, which `main` runs once the lock is released.
function cmdIntegrate(dir, s, id, opts) {
  const t = task(s, id);
  const stale = interrupted(s);
  if (stale) recoverIntegrate(dir, s, stale);
  // A criteria change is compared before anything is merged: only `criteria <NN>`
  // (which records the user's agreement) opens this gate, never a rewording.
  const changed = criteriaGate(s, t);
  if (changed) fail(changed);
  const gate = integrateGate(s, t, opts.override);
  if (gate) fail(gate);
  const verdict = reviewReport(t)?.verdict;
  // Say what did not gate, so a suggestion is never silently read as a pass.
  const suggested = numberedCriteria(s) ? splitBlocking(t, true).out ?? [] : [];
  if (suggested.length) say(`#${t.id}: ${suggested.length} blocking finding${suggested.length === 1 ? "" : "s"} out of the review's boundary (${suggested.map((f) => f.id).join(", ")}); ${suggested.length === 1 ? "it is a suggestion" : "they are suggestions"} for the user, not a gate`);
  if (t.review?.agentId) requireIdle(t.review.agentId, "reviewer");
  if (head(t.worktree) !== t.candidateSha || !isClean(t.worktree)) fail(`#${t.id}: worktree moved off the frozen candidate ${short(t.candidateSha)}; freeze and review again`);
  checkIntegration(s);
  // Read fresh, as `freeze` reads Scope: the commands that run are the ticket's
  // now, and they are stored on the task only when this integration is recorded.
  if (!existsSync(t.file)) fail(`#${t.id}: its ticket file is gone (${t.file}); restore it before integrating`);
  const acceptance = acceptanceCommands(t.file, readFileSync(t.file, "utf8"), criteriaOptions(s));
  const integ = s.integration.worktree;
  const prev = s.integration.tip;

  const m = gitTry(integ, "merge", "--no-ff", "-m", `workloop: integrate #${t.id} ${t.title}`, t.candidateSha);
  if (m.code !== 0) {
    const conflicts = gitTry(integ, "diff", "--name-only", "--diff-filter=U").out;
    gitTry(integ, "merge", "--abort");
    gitTry(integ, "reset", "--hard", prev);
    record(dir, s, "integrate_conflict", { task: t.id, sha: t.candidateSha, conflicts });
    fail(`#${t.id} conflicts with ${s.integration.branch} (${conflicts.split("\n").join(", ") || m.err}); nothing merged.\nAsk the executor to merge the tip: \`send ${t.id} --merge-tip\`, then review again.`);
  }
  const phase = beginCheckPhase(dir, s, { kind: "integrate", task: t.id, candidateSha: t.candidateSha, prevTip: prev, mergeSha: head(integ) });
  const override = verdict === "pass" ? null : opts.override;
  // The run's checks, then this ticket's acceptance commands, then the regression set.
  const commands = [...s.config.checks, ...commandEntries(t, acceptance), ...regressionSet(s).filter((e) => e.task !== t.id)];
  return { afterLock: () => runCheckPhase(dir, phase, commands, integ, (s2, checks, minutes) => completeIntegrate(dir, s2, phase, checks, minutes, opts.override, override, acceptance)) };
}

// An interrupted integrate left its merge on the branch. The candidate is still
// on the task's branch, so putting the integration worktree back to the recorded
// tip loses nothing, unless something outside the run moved it: that is the
// user's call.
function recoverIntegrate(dir, s, stale) {
  stopInterruptedCheck(stale);
  const integ = s.integration.worktree;
  const h = head(integ);
  if (h !== stale.mergeSha && h !== stale.prevTip) {
    record(dir, s, "check_recovery_refused", { task: stale.task, prevTip: stale.prevTip, mergeSha: stale.mergeSha, head: h });
    fail(`cannot recover the interrupted check phase of #${stale.task} (pid ${stale.pid}): the integration worktree is at ${short(h)}: neither the merge that phase made (${short(stale.mergeSha)}) nor the tip before it (${short(stale.prevTip)}). Something outside the run wrote to ${s.integration.branch}. Stop and ask the user before touching it.`);
  }
  const reset = gitTry(integ, "reset", "--hard", stale.prevTip);
  if (reset.code !== 0 || head(integ) !== stale.prevTip) fail(`cannot recover the interrupted check phase of #${stale.task} (pid ${stale.pid}): the integration worktree could not be reset to ${short(stale.prevTip)}; state is unchanged.\n${reset.err || reset.out}`);
  s.checking = null;
  record(dir, s, "check_recovered", { phase: "integrate", task: stale.task, prevTip: stale.prevTip, mergeSha: stale.mergeSha });
  say(`recovered the interrupted check phase of #${stale.task}: ${s.integration.branch} is back at ${short(stale.prevTip)}`);
}

// Step 3, under the lock: the branch must still be at the merge, and step 1's
// gates must still hold on the reloaded state for the same candidate; then the
// result is recorded, or the merge rolled back as for a failed check.
function completeIntegrate(dir, s, phase, checks, minutes, overrideFlag, override, acceptance = []) {
  keepPhaseAfterFailedCleanup(dir, s, phase, checks, minutes);
  const t = task(s, phase.task);
  const integ = s.integration.worktree;
  const h = head(integ);
  if (h !== phase.mergeSha) {
    s.checking = null;
    record(dir, s, "integrate_moved", { task: t.id, mergeSha: phase.mergeSha, head: h });
    fail(`#${t.id}: the integration worktree moved to ${short(h)} while the checks ran (the merge was ${short(phase.mergeSha)}, the tip before it ${short(phase.prevTip)}); nothing was recorded. Something outside the run wrote to ${s.integration.branch}. Stop and ask the user.`);
  }
  // Step 1's gates are re-checked on the reloaded state, and so are the confirmed
  // criteria: the ticket can be edited while the checks run, and a merge is only
  // recorded for the criteria the user confirmed. A drift is reported in its own
  // words, as step 1 would have, and rolls back like any other failed gate.
  const drift = criteriaGate(s, t);
  const gate = drift || (t.candidateSha !== phase.candidateSha
    ? `#${t.id}'s candidate is now ${short(t.candidateSha)}, not the ${short(phase.candidateSha)} that was checked`
    : integrateGate(s, t, overrideFlag));
  const changed = gate && !drift ? `step 1's gate no longer holds after the checks: ${gate}` : null;
  if (!checks.ok || gate) {
    const reset = gitTry(integ, "reset", "--hard", phase.prevTip);
    const back = reset.code === 0 && head(integ) === phase.prevTip;
    s.checking = null;
    // A failing acceptance command names its own ticket and the merge that broke
    // it (`#02 acceptance \`cmd\` fails after merging #05`); anything else leads
    // with the ticket being integrated.
    const why = drift || changed || (checks.task
      ? `${checkFailure(checks, minutes)} after merging #${t.id}`
      : `${checkFailure(checks, minutes)} after merging`);
    const lead = drift ? "" : changed || !checks.task ? `#${t.id}: ` : "";
    record(dir, s, "integrate_failed", {
      task: t.id, sha: phase.candidateSha,
      ...(gate ? { gate } : { check: checks.cmd, timedOut: checks.timedOut || undefined, ...(checks.task && { acceptanceTask: checks.task }) }), rolledBack: back,
    });
    const where = back ? `integration rolled back to ${short(phase.prevTip)}` : `${s.integration.branch} could NOT be rolled back to ${short(phase.prevTip)}: ${reset.err || reset.out}`;
    fail(`${lead}${why}; ${where}.${gate ? "" : `\n${checks.output}\nRoute it to the executor with \`send ${t.id}\`.`}`);
  }
  s.checking = null;
  s.integration.tip = h;
  Object.assign(t, { status: "done", mergeSha: h, integratedAt: now(), override, acceptance });
  s.lastIntegratedAt = t.integratedAt;
  // The findings the user's override let through are recorded in the same save as
  // the integration that let them through, so the two cannot disagree.
  const waived = override ? ledgerAdd(s, overrideWaiver(s, t, phase.candidateSha, override)) : null;
  recordAll(dir, s, [
    ...(waived ? [waiverEvent(waived)] : []),
    ["integrate", { task: t.id, attempt: t.attempt, sha: t.candidateSha, tip: h, override: override || undefined }],
  ]);
  say(`#${t.id} integrated: ${s.integration.branch} ${short(phase.prevTip)} -> ${short(h)}`);
  say("Agent turns and worktree retained for the run retrospective; archive after finish and retro.");
  const unlocked = frontier(s).filter((x) => x.blockedBy.includes(t.id));
  if (unlocked.length) say(`unblocked: ${unlocked.map((x) => `#${x.id}`).join(", ")}`);
}

function cleanupTask(dir, s, t) {
  requireArchiveReady(s);
  if (!s.evidence || s.evidence.completion !== s.completion.at) fail("capture evidence before cleanup: run archive");
  if (t.status !== "done") fail(`#${t.id} is ${t.status}; only integrated tasks are cleaned up automatically`);
  if (t.cleanedAt) return say(`#${t.id} already cleaned up`);
  const integ = s.integration.worktree;
  if (!isAncestor(integ, t.candidateSha, s.integration.branch)) fail(`#${t.id}: candidate ${short(t.candidateSha)} is not on ${s.integration.branch}; not cleaning up`);
  const agents = Object.values(s.agents || {}).filter((a) => String(a.task) === String(t.id) && a.turns.length && BUSY.has(inspectAgent(a.id).status));
  if (agents.length) fail(`#${t.id}: agents still running against it: ${agents.map((a) => a.id).join(", ")}`);
  if (t.worktree && existsSync(t.worktree)) {
    if (!isClean(t.worktree)) fail(`#${t.id}: worktree ${t.worktree} has uncommitted changes; look at them before cleaning up`);
    git(s.repo, "worktree", "remove", t.worktree);
  }
  gitTry(s.repo, "worktree", "prune");
  for (const id of [t.agentId, ...(t.reviewers || [])].filter(Boolean)) {
    requireIdle(id, "run agent", true);
    archiveAgent(s, id);
  }
  if (t.branch && branchExists(s.repo, t.branch)) git(integ, "branch", "-d", t.branch); // -d refuses unmerged work
  t.cleanedAt = now();
  record(dir, s, "cleanup", { task: t.id, attempt: t.attempt });
  say(`#${t.id} cleaned up (worktree removed, tabs closed, branch ${t.branch} deleted)`);
}

function cmdRetry(dir, s, id, opts) {
  const t = task(s, id);
  if (!["running", "in_review"].includes(t.status) && !(t.status === "ready" && t.reuseWorktree)) fail(`#${t.id} is ${t.status}; retry is for a task whose executor can't continue`);
  if (!opts.reason) fail("retry needs --reason");
  if (t.agentId) requireIdle(t.agentId, "executor", true);
  if (t.review?.agentId) requireIdle(t.review.agentId, "reviewer", true);
  const reuse = !opts["new-worktree"];
  if (reuse && (!t.worktree || !existsSync(t.worktree) || git(t.worktree, "branch", "--show-current") !== t.branch)) fail("worktree unavailable or on another branch; reconcile it, or use retry --new-worktree --reason <why>");
  const previous = { attempt: t.attempt, agentId: t.agentId ?? null, launch: t.launch ?? null, branch: t.branch ?? null, worktree: t.worktree ?? null, baseSha: t.baseSha, candidateSha: t.candidateSha ?? null, reviewers: t.reviewers || [], review: t.review, reason: opts.reason, at: now() };
  t.history.push(previous);
  const old = { branch: t.branch, worktree: t.worktree };
  const handoff = `## Recovery handoff\n\nPrevious executor: ${t.agentId || "not launched"}; attempt: ${t.attempt}. Reason: ${opts.reason}\n\nRead the previous brief ${pathArg(briefPath(dir, t))} for context (the current brief supersedes its starting-HEAD and reporting instructions), report ${pathArg(reportPath(dir, t))} if present, and this task's messages/reviews under ${pathArg(dir)}. ${reuse ? "Continue the existing work, including uncommitted changes; inspect git status and diff before editing." : "This is a fresh worktree. Inspect the preserved previous attempt before deciding which work to carry forward."}\nPrevious worktree: ${old.worktree || "none"}; branch: ${old.branch || "none"}.\n${opts.file ? readFileSync(resolve(opts.file), "utf8") : ""}`;
  const baseSha = t.baseSha;
  const next = `a${Number(t.attempt.slice(1)) + 1}`;
  Object.assign(t, { status: "ready", attempt: next, agentId: null, launch: null, branch: reuse ? old.branch : null, worktree: reuse ? old.worktree : null, baseSha: reuse ? baseSha : null, candidateSha: null, fixedPoint: null, review: null, reviewers: [], messages: 0, promptedAt: null, reuseWorktree: reuse, handoff });
  record(dir, s, "retry", { task: t.id, attempt: next, reason: opts.reason, reuseWorktree: reuse });
  say(`#${t.id} reset to ready as attempt ${next}.`);
  if (old.worktree) say(`${reuse ? "reusing" : "the old attempt is kept:"} worktree ${old.worktree}, branch ${old.branch}. The old agent's turns remain available for retro.`);
}

function cmdHold(dir, s, id, opts, on) {
  const t = task(s, id);
  if (on && !opts.reason) fail("hold needs --reason");
  t.hold = on ? opts.reason : null;
  record(dir, s, on ? "hold" : "unhold", { task: t.id, note: opts.reason });
  say(`#${t.id} ${on ? `on hold: ${opts.reason}` : "released"}`);
}

function cmdCancel(dir, s, id, opts) {
  const t = task(s, id);
  if (["done", "cancelled"].includes(t.status)) fail(`#${t.id} is already ${t.status}`);
  if (!opts.reason) fail("cancel needs --reason");
  if (t.agentId) requireIdle(t.agentId, "executor");
  Object.assign(t, { status: "cancelled", hold: null, cancelReason: opts.reason });
  record(dir, s, "cancel", { task: t.id, note: opts.reason });
  say(`#${t.id} cancelled.${t.worktree ? ` Its worktree (${t.worktree}) and branch (${t.branch}) are left for you to inspect.` : ""}`);
  const deps = tasksOf(s).filter((x) => x.blockedBy.includes(t.id) && x.status === "ready");
  if (deps.length) say(`warning: ${deps.map((x) => `#${x.id}`).join(", ")} depend on it and can no longer start`);
}

function cmdNote(dir, s, id, opts) {
  if (!opts.text) fail("note needs --text");
  if (id) task(s, id);
  record(dir, s, "note", { task: id ?? undefined, note: opts.text });
  say("noted");
}

// The delivery gates `finish` checks before its checks run and again, on the
// reloaded state, before it records completion. Fails with the first that does
// not hold; returns the /tidy-docs reminder, if any.
function finishGates(dir, s) {
  const open = tasksOf(s).filter((t) => !["done", "cancelled"].includes(t.status));
  if (open.length) fail(`not finished: ${open.map((t) => `#${t.id} ${t.status}`).join(", ")}`);
  checkIntegration(s);
  // A direct run's reviewer re-ran the acceptance checks, and there are no other tickets to cross-check.
  let reminder = null;
  if (!isDirect(s)) {
    // The same check as the next step, so a run cannot pass the final review and then
    // finish with a document it never classified. A repo with no registry is never
    // blocked; one with /tidy-docs installed is only reminded. Both read the one
    // report, so a failed inventory is the gate's error and never a missing registry.
    const report = documentReport(s);
    const docs = documentStep(report);
    if (docs) fail(`not finished: ${docs}`);
    reminder = report.error || report.registry ? null : tidyDocsReminder(s);
    // The verdict is the independent reviewer's, for this tip: a round of its own,
    // a report newer than that round and naming this tip, and either a pass or every
    // in-boundary blocking finding in the ledger as a final waiver.
    const final = finalGate(dir, s);
    if (final) fail(`not finished: ${final}`);
  }
  for (const a of runAgents(s)) requireIdle(a.id, "run agent", true);
  return reminder;
}

// `finish` runs in the three steps of a check phase, like `integrate`. Step 1,
// under the lock: the delivery gates and the `checking` entry. Finish changes
// nothing in Git, so an interrupted finish is cleared by rerunning it.
function cmdFinish(dir, s) {
  const stale = interrupted(s);
  if (stale) {
    stopInterruptedCheck(stale);
    s.checking = null;
    record(dir, s, "check_recovered", { phase: "finish" });
  }
  const reminder = finishGates(dir, s);
  if (reminder) say(reminder);
  const phase = beginCheckPhase(dir, s, { kind: "finish", tip: s.integration.tip });
  // The run's checks, then the whole regression set: every integrated ticket's
  // acceptance commands, so the tip that ships is the one that proves each ticket.
  const commands = [...s.config.checks, ...regressionSet(s)];
  return { afterLock: () => runCheckPhase(dir, phase, commands, s.integration.worktree, (s2, checks, minutes) => completeFinish(dir, s2, phase, checks, minutes)) };
}

// Step 3, under the lock: the tip must not have moved while the checks ran, and
// the delivery gates must still hold on the reloaded state (an `import` may have
// added a ticket meanwhile).
function completeFinish(dir, s, phase, checks, minutes) {
  keepPhaseAfterFailedCleanup(dir, s, phase, checks, minutes);
  s.checking = null;
  const h = existsSync(s.integration.worktree) ? head(s.integration.worktree) : null;
  if (h !== phase.tip || s.integration.tip !== phase.tip) {
    record(dir, s, "finish_failed", { tip: phase.tip, head: h });
    fail(`the integration worktree moved to ${short(h)} while finish's checks ran (they ran on ${short(phase.tip)}); nothing was recorded. Inspect ${s.integration.branch} before continuing.`);
  }
  if (!checks.ok) {
    record(dir, s, "finish_failed", { tip: phase.tip, check: checks.cmd, timedOut: checks.timedOut || undefined, ...(checks.task && { acceptanceTask: checks.task }) });
    fail(`${checkFailure(checks, minutes)} on the integration tip:\n${checks.output}`);
  }
  try { finishGates(dir, s); } catch (e) {
    if (!(e instanceof UserError)) throw e;
    record(dir, s, "finish_failed", { tip: phase.tip, gate: e.message });
    fail(`finish's checks passed, but a delivery gate no longer holds, so delivery is not recorded: ${e.message}`);
  }
  s.completion ||= { at: now(), tip: s.integration.tip };
  record(dir, s, "finish", { tip: s.integration.tip });
  const commits = git(s.repo, "log", "--oneline", "--first-parent", `${s.baseSha}..${s.integration.tip}`);
  say(`delivery checked. ${s.integration.branch} is at ${short(s.integration.tip)} (base ${s.baseRef} ${short(s.baseSha)}):\n${commits}`);
  // The whole ledger, for the user: these are the findings the run let through,
  // and the criteria changes it accepted.
  say(waiverReport(s));
  const boundary = boundaryReport(dir, s);
  if (boundary) say(boundary);
  say(criteriaReport(s));
  say("Nothing was pushed or merged into the base; that is the user's call.");
  say("Agent turns retained. Read the run evidence, assess retro, then archive. Use `evidence` to index the turn logs.");
}

// Every agent the run started: replaced attempts, superseded reviewers and the final
// reviewer of every round, from the run's own registry.
function runAgents(s) {
  return Object.values(s.agents || {}).map((a) => ({ id: a.id, cwd: a.cwd, tasks: [{ task: a.task, attempt: a.attempt, role: a.role }] }));
}

// One file per agent: each turn's prompt and everything its CLI printed, from the
// turn files the run already holds, so nothing depends on a CLI keeping its sessions.
function cmdEvidence(dir, s) {
  const folder = join(dir, "evidence");
  if (s.finishedAt && existsSync(join(folder, "index.json"))) return say(`archived run: use the preserved evidence at ${folder}`);
  mkdirSync(folder, { recursive: true });
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "(missing)\n");
  const agents = runAgents(s);
  for (const a of agents) {
    const rec = s.agents[a.id];
    const file = `${encodeURIComponent(a.id)}.txt`;
    const turns = rec.turns.map((t) => {
      const f = turnFiles(t.base);
      const meta = turnMeta(t);
      const ended = meta ? `exit ${meta.exitCode ?? "?"} · session ${meta.session ?? "?"}` : "no meta file";
      return `=== turn ${t.n} · ${t.title} · started ${t.startedAt} · ${ended}\n--- prompt\n${read(f.prompt)}\n--- output\n${read(f.log)}\n`;
    });
    writeAtomic(join(folder, file), `${rec.provider} ${rec.role} for ${rec.task} (${rec.launch})\n\n${turns.join("\n")}`);
    const last = rec.turns.at(-1);
    Object.assign(a, { file, provider: rec.provider, session: rec.session ?? (last ? turnMeta(last)?.session : null) ?? null, turns: rec.turns.length, capturedAt: now() });
  }
  const index = { capturedAt: now(), completion: s.completion?.at || null, format: "agent-run turn files: each turn's prompt and its CLI's raw output; turns/ keeps the originals.", agents };
  writeAtomic(join(folder, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  s.evidence = { completion: index.completion, capturedAt: index.capturedAt, path: join(folder, "index.json") };
  record(dir, s, "evidence", { agents: agents.length });
  say(`saved ${agents.length} agent transcripts: ${folder}`);
}

function cmdRetro(dir, s, opts) {
  if (Boolean(opts.skip) === Boolean(opts.file)) fail("retro needs --file <findings.md> or --skip --reason <why>");
  if (opts.skip && !opts.reason?.trim()) fail("retro --skip needs --reason");
  const text = opts.skip ? `No retrospective needed: ${opts.reason}\n` : readFileSync(resolve(opts.file), "utf8");
  if (!text.trim()) fail("retro report is empty");
  const folder = join(dir, "retros");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${Date.now()}-${randomUUID().slice(0, 8)}.md`);
  writeAtomic(path, text);
  s.retro = { status: opts.skip ? "skipped" : "done", path, at: now(), completion: s.completion?.at || null };
  record(dir, s, "retro", s.retro);
  say(`retro ${s.retro.status}: ${path}. Suggestions only; no changes applied.${s.finishedAt ? " Run remains archived." : s.completion ? " Ready to archive." : " This is an interim retro; assess again after finish."}`);
}

function requireArchiveReady(s) {
  if (!s.completion || s.completion.tip !== s.integration.tip) fail("run finish before archive; delivery has not been checked");
  if (s.retro?.completion !== s.completion.at) fail("assess retro before archive: retro --file <report> or --skip --reason <why>");
}

function cmdArchive(dir, s) {
  if (s.finishedAt) return say("already archived; run evidence is retained");
  requireArchiveReady(s);
  const agents = runAgents(s);
  for (const a of agents) requireIdle(a.id, "run agent", true);
  if (existsSync(s.integration.worktree)) checkIntegration(s);
  // Snapshot every agent's turns before the first destructive cleanup. On an
  // interrupted archive reuse that snapshot.
  if (!s.archiveStartedAt) {
    cmdEvidence(dir, s);
    s.archiveStartedAt = now();
    record(dir, s, "archive-start");
  }
  for (const t of tasksOf(s)) if (t.status === "done" && !t.cleanedAt) cleanupTask(dir, s, t);
  for (const a of agents) archiveAgent(s, a.id);
  // Cancelled/replaced workspaces can contain unmerged or uncommitted work.
  // Close their tabs but retain those trees for a separate user decision.
  const retained = new Map();
  for (const t of tasksOf(s)) for (const a of [...t.history, t]) {
    if (a.worktree && existsSync(a.worktree)) retained.set(a.worktree, { worktree: a.worktree, branch: a.branch });
  }
  // A final reviewer's worktree is its own branch at the tip. It goes only when
  // nothing can be lost: a clean tree still at the round's recorded tip, on a branch
  // that is still that tip and already contained in the integration branch. Uncommitted
  // work, a commit the tree gained after preparation, or a branch that is not merged
  // is retained and listed, and its branch is never force-deleted.
  for (const r of finalRounds(s)) {
    if (!r.worktree || !existsSync(r.worktree)) continue;
    const ref = r.branch ? gitTry(s.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${r.branch}`).out : "";
    const safe = isClean(r.worktree) && head(r.worktree) === r.tip && ref === r.tip
      && existsSync(s.integration.worktree) && isAncestor(s.integration.worktree, r.tip, s.integration.branch);
    if (!safe) { retained.set(r.worktree, { worktree: r.worktree, branch: r.branch }); continue; }
    if (existsSync(r.worktree)) git(s.repo, "worktree", "remove", r.worktree);
    // From the integration worktree, so `-d` checks against the branch that contains the tip.
    if (branchExists(s.repo, r.branch)) gitTry(s.integration.worktree, "branch", "-d", r.branch); // -d refuses unmerged work
  }
  // Before the prune, so a worktree an agent added under scratch is unregistered too.
  // A failed delete costs disk, not evidence: reported, not blocking.
  const scratch = join(dir, "scratch");
  let freed = existsSync(scratch) ? dirBytes(scratch) : 0;
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); } catch (e) {
    freed = 0;
    say(`could not delete ${scratch} (${e.code || e.message}); delete it yourself`);
  }
  gitTry(s.repo, "worktree", "prune");
  if (existsSync(s.integration.worktree)) git(s.repo, "worktree", "remove", s.integration.worktree);
  // The run's Rex session goes with it; every tab in it was the run's.
  if (s.rex?.session) host.killSession(s.rex.session);
  s.finishedAt = now();
  s.retainedWorktrees = [...retained.values()];
  record(dir, s, "archive", { retainedWorktrees: s.retainedWorktrees, scratchFreed: freed });
  say(`archived. ${s.integration.branch} stays at ${short(s.integration.tip)}; evidence and retro remain in ${dir} (${megabytes(dirBytes(dir))}${freed ? `, after deleting ${megabytes(freed)} of scratch` : ""})`);
  if (retained.size) say(`unmerged or dirty work retained for your decision:\n${[...retained.values()].map((a) => `  ${a.worktree} (${a.branch})`).join("\n")}`);
}

// ------------------------------------------------------- status and waiting

// The turns running now, each with the agent it is a turn of.
function runningTurns(s) {
  const out = [];
  for (const a of Object.values(s.agents || {})) {
    if (!a.turns.length || a.archivedAt) continue;
    const st = inspectAgent(a.id);
    if (st.status === "unknown") fail(`cannot ask Rex about agent ${a.id}: ${st.error}`);
    if (st.status === "running") out.push({ agent: a, block: st.turn.block, title: st.turn.title, updatedAt: st.updatedAt });
  }
  return out;
}
const DEFAULT_WAIT = 110; // minutes: inside the two hours a background command may run
const describeEnd = (p) => (p.exit_code === 0 ? "exit 0"
  : p.exit_code != null ? `exit ${p.exit_code}${p.error ? `, ${p.error}` : ""}`
    : p.block_id ? "its tab was closed" : p.error || "ended");

// `wait [--for <minutes>]` returns when one of the running turns ends, or at the
// limit. Run it as a background command and end the turn: its exit is what wakes the
// orchestrator. It holds no lock, so every other command works meanwhile.
//
// `--wake codex` is for a codex orchestrator, whose background terminals do not wake
// it: what `wait` would print is queued into its session (CODEX_THREAD_ID) with
// `codex queue --resume`, which opens a turn when it is idle and follows the current
// one when it is busy. Only this script's own words go into that message.
async function cmdWait(dir, opts) {
  const minutes = opts.for == null ? DEFAULT_WAIT : Number(opts.for);
  if (!Number.isFinite(minutes) || minutes <= 0) fail("wait --for takes a positive number of minutes");
  const wake = opts.wake == null ? null : wakeTarget(opts.wake);
  const s = loadState(dir);
  if (s.finishedAt) return say("this run is archived; nothing runs");
  const lines = [];
  const tell = (line) => { say(line); lines.push(line); };
  const next = (st) => { const steps = nextSteps(dir, st); if (steps.length) tell(`next: ${steps.join("\n      ")}`); };
  const running = runningTurns(s);
  if (!running.length) {
    // Waking now would only wake the orchestrator to arm this again.
    if (wake) fail("no turn is running, so there is nothing to wake you for; run `status` for the next step");
    tell("no turn is running");
    // A turn that ended while nobody waited, and left nothing to go on, is said here:
    // the next steps read reports only, so they would pass over it.
    for (const id of currentAgents(s)) {
      const a = inspectAgent(id);
      if (a.turn && /left no fresh report/.test(turnOutcome(dir, s, id))) tell(`"${a.turn.title}" ended (${a.status}${a.exitCode != null ? ` ${a.exitCode}` : ""}); ${turnOutcome(dir, s, id)}`);
    }
    return next(s);
  }
  say(`waiting on ${running.map((r) => `"${r.title}"`).join(", ")} (up to ${minutes}m)`);
  const ended = await host.waitAny(s.rex.session, running.map((r) => r.block), Math.round(minutes * 60000));
  const s2 = loadState(dir);
  if (!ended) {
    const still = runningTurns(s2).map((r) => `"${r.title}" last printed ${ago(r.updatedAt)}`);
    tell(`no turn ended in ${minutes}m${still.length ? `; ${still.join(", ")}` : ""}`);
    tell("next: run `wait` in the background again, then end this turn");
  } else {
    const r = running.find((x) => x.block === ended.block);
    tell(`turn ended: "${r.title}" (${describeEnd(ended.payload)}); ${turnOutcome(dir, s2, r.agent.id)}`);
    next(s2);
  }
  if (wake) deliverWake(dir, s2, wake, lines);
}

// Where `wait --wake` sends its news. Read at the start, from the orchestrator's own
// environment, so a wait started anywhere else cannot wake the wrong session.
function wakeTarget(kind) {
  if (kind !== "codex") fail(`wait --wake takes codex, not "${kind}" (Claude Code and pi with pi-background-run wake on a background command's exit by themselves)`);
  const thread = process.env.CODEX_THREAD_ID;
  if (!thread) fail("wait --wake codex needs CODEX_THREAD_ID: start it from the codex session it should wake");
  return { kind, thread };
}
function deliverWake(dir, s, wake, lines) {
  const wl = `node ${shellArg(pathArg(fileURLToPath(import.meta.url)))} --run ${shellArg(pathArg(dir))}`;
  const text = [`[workloop ${s.project}/${s.feature}]`, ...lines,
    `Act on it. Before you end your turn, if a turn still runs, start \`${wl} wait --wake codex\` in a background terminal again.`].join("\n");
  const bin = process.env.WORKLOOP_CODEX_CLI || "codex";
  const [cmd, pre] = /\.[cm]?js$/i.test(bin) ? [process.execPath, [bin]] : [bin, []];
  const r = spawnSync(cmd, [...pre, "queue", "--thread", wake.thread, "--message", text, "--resume"], { cwd: s.repo, encoding: "utf8", timeout: 60000 });
  if (r.error || r.status !== 0) fail(`could not wake codex session ${wake.thread}: ${(r.error?.message || r.stderr || r.stdout || `exit ${r.status}`).trim()}`);
  say(`woke codex session ${wake.thread}`);
}

// The agents whose report the run is waiting for: each open task's executor (or,
// once frozen, its current reviewer) and the current final reviewer.
function currentAgents(s) {
  const ids = [];
  for (const t of tasksOf(s)) {
    if (t.hold) continue;
    if (t.status === "running" && t.agentId) ids.push(t.agentId);
    if (t.status === "in_review" && t.review?.agentId && !reviewReport(t)) ids.push(t.review.agentId);
  }
  const f = s.finalReview;
  if (f?.agentId && f.tip === s.integration.tip && !finalReport(f)) ids.push(f.agentId);
  return ids;
}

// What an ended turn left: the report its brief asks for, or where to look when it
// left none. A report is fresh only if written after the turn's prompt.
function turnOutcome(dir, s, id) {
  const a = s.agents[id];
  const log = turnFiles(a.turns.at(-1).base).log;
  const none = (again) => `it left no fresh report: read its output in ${log}, then ${again}`;
  if (a.task === "final") {
    const round = s.finalReview?.agentId === id ? s.finalReview : null;
    if (!round) return "a superseded final reviewer";
    const rep = finalReport(round);
    return rep ? `verdict ${rep.verdict ?? "missing"} in ${round.path}` : none("`final-review --again`");
  }
  const t = s.tasks[a.task];
  if (!t) return `agent of a task this run no longer has (${a.task})`;
  if (a.role === "reviewer") {
    if (t.review?.agentId !== id) return `a superseded reviewer of #${t.id}`;
    const rep = reviewReport(t);
    return rep ? `verdict ${rep.verdict ?? "missing"} in ${t.review.path}` : none(`\`review ${t.id} --again\``);
  }
  if (t.agentId !== id) return `a replaced executor of #${t.id}`;
  const rep = executorReport(dir, t);
  return rep ? `#${t.id} reports ${rep.status ?? "no status"} in ${reportPath(dir, t)}` : none(`\`send ${t.id} --text <what to do>\` to go on, or \`retry ${t.id} --reason <why>\``);
}

// The agent's state for display: its status, or why it cannot be had.
function liveStatus(id) {
  try {
    const a = inspectAgent(id);
    return a.status === "error" || a.status === "closed" ? `${a.status}${a.exitCode != null ? `:${a.exitCode}` : ""}` : a.status;
  } catch (e) {
    if (e instanceof UserError && e.agentMissing) return "missing";
    throw e;
  }
}

const isRexRun = (s) => s.host === "rex";
const PASEO_RUN = "started by the Paseo workloop: continue it with that copy of the skill (this one is rex-local)";
// A Paseo run's next steps are that copy's, and its launch settings are Paseo profiles.
const nextFor = (dir, s) => (isRexRun(s) || s.finishedAt ? nextSteps(dir, s) : [PASEO_RUN]);

function printStatus(dir, s, live, asJson = false) {
  const rows = tasksOf(s).map((t) => {
    const rep = t.status === "running" ? executorReport(dir, t)?.status : null;
    const rev = t.status === "in_review" ? reviewReport(t)?.verdict ?? (t.review ? "pending" : null) : null;
    return {
      id: t.id, status: t.status + (t.hold ? "*" : ""), attempt: t.attempt, agent: t.agentId ? t.agentId.slice(0, 8) : "-",
      live: live && t.agentId ? liveStatus(t.review?.agentId ?? t.agentId) : "-",
      candidate: short(t.candidateSha), report: rep || rev || "-", title: t.title, acceptance: t.acceptance ?? [],
      blockers: t.blockedBy.filter((b) => s.tasks[b]?.status !== "done"),
    };
  });
  const checking = s.checking ? { ...s.checking, interrupted: Boolean(interrupted(s)) } : null;
  const suggestions = boundarySuggestions(s);
  if (asJson) return say(JSON.stringify({ run: dir, mode: s.mode || "full", integration: s.integration, checking, completion: s.completion, retro: s.retro, archivedAt: s.finishedAt, config: s.config, launch: isRexRun(s) ? launchTable(s.config) : null, waivers: s.waivers || [], extraRounds: s.extraRounds || [], suggestions, finalReview: s.finalReview ?? null, finalReviews: s.finalReviews ?? [], tasks: rows, next: nextFor(dir, s) }, null, 2));
  say(`run ${s.project}/${s.feature}${isDirect(s) ? " (direct)" : ""}${isRexRun(s) ? "" : " · Paseo run"} · base ${s.baseRef}@${short(s.baseSha)} · ${s.integration.branch}@${short(s.integration.tip)}${s.finishedAt ? " · FINISHED" : ""}`);
  const reviewing = tasksOf(s).filter((t) => t.review && !reviewReport(t)).length;
  say(`executors ${executorsBusy(s)}/${s.config.maxExecutors} · reviews pending ${reviewing} (max ${s.config.maxReviewers})`);
  const regression = regressionSet(s);
  if (regression.length) {
    const tickets = new Set(regression.map((e) => e.task));
    say(`regression set: ${regression.length} command${regression.length === 1 ? "" : "s"} from ${tickets.size} ticket${tickets.size === 1 ? "" : "s"} — run again at every integration and at finish`);
  }
  const waived = waivedFindings(s);
  if (waived) say(`waived findings: ${waived} — the user reviews them at finish`);
  if (suggestions.length) {
    say(`out-of-boundary findings: ${suggestions.length} blocking finding${suggestions.length === 1 ? "" : "s"} outside the reviews' boundary — the user decides these, and nothing gates on them:`);
    for (const f of suggestions) say(`- #${f.task} ${f.id} · ${f.axis} · ${f.location} · ${f.basis}`);
  }
  if (!s.finishedAt && isRexRun(s)) printLaunch(s.config);
  if (s.checking) say(describeCheckPhase(s.checking));
  const cols = ["id", "status", "attempt", "agent", "live", "candidate", "report", "title"];
  const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]));
  say(cols.map((c) => c.padEnd(width[c])).join("  "));
  for (const r of rows) {
    say(cols.map((c) => String(r[c]).padEnd(width[c])).join("  ") + (r.blockers.length && r.status.startsWith("ready") ? `  (blocked by ${r.blockers.join(", ")})` : ""));
  }
  if (rows.some((r) => r.status.endsWith("*"))) say("* = on hold");
  if (live) {
    if (s.finalReview?.agentId && !s.finishedAt) say(`final review round ${s.finalReview.round}: ${liveStatus(s.finalReview.agentId)}`);
    for (const t of tasksOf(s)) {
      if (["running", "in_review"].includes(t.status) && t.worktree && !existsSync(t.worktree)) say(`warning: #${t.id} worktree is gone: ${t.worktree}`);
    }
    if (!s.finishedAt) {
      const h = existsSync(s.integration.worktree) ? head(s.integration.worktree) : null;
      if (h !== s.integration.tip) say(`warning: integration worktree is at ${short(h)}, state says ${short(s.integration.tip)}`);
    }
  }
  const steps = nextFor(dir, s);
  if (steps.length) say(`next: ${steps.join("\n      ")}`);
}

// One line per role; `full` (the config command) prints an unresolved role's whole message.
function printLaunch(config, full = false) {
  for (const l of launchTable(config)) {
    if (l.error && full) say(`${l.role} UNRESOLVED: ${l.error.slice(l.role.length + 2)}`);
    else if (l.error) say(`${l.role} UNRESOLVED: ${l.error.slice(l.role.length + 2).split("\n")[0].replace(/ Profiles:$/, "")} (tell the user)`);
    else say(`${l.role} ${describe(l)}`);
  }
}

// --------------------------------------------------------------------- CLI

const HELP = `workloop — run state and Rex/git mechanics for the paseo-workloop skill (rex-local)

usage: node workloop.mjs [--run <dir|project/feature>] <command> [args]

  init --feature <slug> [--repo .] [--base <ref>] [--spec <file>] [--tickets <dir>]
       [--check <cmd>]... [--setup <cmd>]... [--check-timeout <minutes>] [--max-rework-rounds 2]
       [--max-executors 2] [--max-reviewers 1]
       [--profile name] [--provider p] [--model m] [--mode m] [--thinking t]
       [--review-profile name] [--review-provider p] ...
       [--direct]                      one ticket with a Scope line, no spec, no final review
       spec and tickets default to <run dir>/spec.md and <run dir>/issues
  scratch --feature <slug> [--repo .]   create <run dir>/issues and print the run's paths
  config  [same options as init]       change budgets, checks, time limit, rework cap, launch settings
          [--clear-launch executor|reviewer]  drop the run's launch overrides for that role, so it
                                       follows the defaults file again

  Launch settings per role, most specific first: the command's flags, the run's
  config, then WORKLOOP_ROOT/launch.json ({"executor": {...}, "reviewer": {...}}).
  Providers: dsh (--mode <permission preset>, --profile <dsh profile>, default
  headless), devin (--mode <permission mode>, --model), codex (--mode <sandbox>,
  --model, --thinking <effort>) and pi (--model, --thinking; no modes). No provider,
  a setting the CLI does not take, or a missing --mode is an error.
  import                               re-read the tickets directory (new/repair tickets)
  decisions                            commit ADR/glossary changes before the first dispatch
  status [--live] [--json]             table + next steps; --live asks Rex about each agent
  dispatch <NN> [--note t] [--note-file f] [--dry-run] [--provider ...]
                                       worktree, brief, and the executor's first turn in a Rex tab
  wait [--for 110] [--wake codex]      return when a running turn ends (or after the minutes);
                                       run it as a background command, then end your turn;
                                       --wake codex queues what it printed into the codex
                                       session (CODEX_THREAD_ID) that started it
  freeze <NN>                          record the executor's commit as the candidate
  criteria <NN> --reason r             record the user's agreement to a change in its criteria
  review <NN> [--again]                freeze if needed, start a reviewer; after a rework the
                                        brief adds the previous review and the change since it
  send <NN> --text t | --file f | --merge-tip   the idle executor's next turn, same conversation
       [--waive ID,ID --reason r]      a rework answers every blocking finding: name it, or waive it
       [--extra-round --reason r]      a rework round past the cap goes on, with the user's decision
  integrate <NN> [--override reason]   merge, then the checks and the regression set outside the run
                                       lock; retain turns/worktree; --override records the
                                       blocking findings it lets through
  cleanup <NN>                         resume cleanup after finish, retro and evidence
  retry <NN> --reason r [--file handoff] [--new-worktree]
                                       replace a lost executor; reuse its worktree by default
  hold <NN> --reason r | unhold <NN>   park a task (waiting on the user, etc.)
  cancel <NN> --reason r
  note [<NN>] --text t
  final-review [--again]               start an independent final reviewer at the integration
                                       tip: new worktree, brief, and its turn in a Rex tab; after
                                       a reported round the brief adds it and the change since
       [--extra-round --reason r]      a repair cycle past the cap goes on, with the user's decision
  final-review --waive ID,ID --reason r  record the final findings the user lets through
  finish                               run the checks and the regression set outside the run lock;
                                       only on the final reviewer's pass for the current tip
  evidence                             index every agent's turns (prompts and CLI output)
  retro --file <report> | --skip --reason <why>   record findings or no-retro decision
  archive                              after finish and retro: snapshot, archive, clean up

env: WORKLOOP_ROOT (default ~/.workloop; launch.json holds the default launch settings)
     WORKLOOP_RUN · REX_CLI (default: rex on PATH, else the CLI inside Rex Beta.app)
Every turn is a headless process in a tab of the run's Rex session; \`wait\` reports when one ends.`;

const OPTIONS = Object.fromEntries([
  ...["run", "repo", "feature", "base", "spec", "tickets", "max-executors", "max-reviewers", "profile", "provider", "model", "mode", "thinking",
    "review-profile", "review-provider", "review-model", "review-mode", "review-thinking", "note", "note-file", "text", "file", "override", "reason",
    "check-timeout", "waive", "max-rework-rounds", "for", "wake"].map((k) => [k, { type: "string" }]),
  ...["check", "setup", "clear-launch"].map((k) => [k, { type: "string", multiple: true }]),
  ...["json", "live", "keep", "again", "merge-tip", "dry-run", "help", "direct", "new-worktree", "skip", "extra-round"].map((k) => [k, { type: "boolean" }]),
]);

export async function main(argv) {
  const { values: opts, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [cmd, id] = positionals;
  if (!cmd || cmd === "help" || opts.help) return say(HELP);
  if (cmd === "init") return cmdInit(opts);
  if (cmd === "scratch") return cmdScratch(opts); // before resolveRunDir: a run need not exist, and --run is ignored
  const dir = resolveRunDir(opts.run);
  // A run the Paseo workloop started keeps its agents in Paseo; this copy cannot see
  // them, so it only shows such a run (`status`, which reads state alone) and refuses
  // the rest rather than mixing a second kind of agent into it.
  if (!isRexRun(loadState(dir)) && !(cmd === "status" && !opts.live)) {
    fail(`${dir} was started by the Paseo workloop; continue it with that copy of the skill (this one is rex-local). \`status\` without --live shows it.`);
  }
  const needId = ["dispatch", "freeze", "review", "send", "integrate", "cleanup", "retry", "hold", "unhold", "cancel", "criteria"];
  if (needId.includes(cmd) && !id) fail(`${cmd} needs a ticket number`);
  if (cmd === "status") return printStatus(dir, loadState(dir), opts.live, opts.json);
  if (cmd === "wait") return cmdWait(dir, opts);
  const handlers = {
    config: (s) => cmdConfig(dir, s, opts),
    criteria: (s) => cmdCriteria(dir, s, id, opts),
    decisions: (s) => cmdDecisions(dir, s),
    import: (s) => cmdImport(dir, s),
    dispatch: (s) => cmdDispatch(dir, s, id, opts),
    freeze: (s) => freeze(dir, s, task(s, id)),
    review: (s) => cmdReview(dir, s, id, opts),
    send: (s) => cmdSend(dir, s, id, opts),
    integrate: (s) => cmdIntegrate(dir, s, id, opts),
    cleanup: (s) => cleanupTask(dir, s, task(s, id)),
    retry: (s) => cmdRetry(dir, s, id, opts),
    hold: (s) => cmdHold(dir, s, id, opts, true),
    unhold: (s) => cmdHold(dir, s, id, opts, false),
    cancel: (s) => cmdCancel(dir, s, id, opts),
    note: (s) => cmdNote(dir, s, id, opts),
    "final-review": (s) => cmdFinalReview(dir, s, opts),
    finish: (s) => cmdFinish(dir, s),
    evidence: (s) => cmdEvidence(dir, s),
    retro: (s) => cmdRetro(dir, s, opts),
    archive: (s) => cmdArchive(dir, s),
  };
  if (!handlers[cmd]) fail(`unknown command "${cmd}"; see \`help\``);
  const result = withLock(dir, () => {
    const s = loadState(dir);
    if (s.finishedAt && !["note", "retro", "archive", "evidence"].includes(cmd)) fail("this run is finished");
    if (s.archiveStartedAt && !["note", "retro", "archive", "cleanup", "evidence"].includes(cmd)) fail("archive is in progress; resume archive before starting other work");
    const refusal = checkPhaseRefusal(s, cmd, id);
    if (refusal) fail(refusal);
    if (needId.includes(cmd)) task(s, id);
    return handlers[cmd](s);
  });
  // `integrate` and `finish` run their checks after the lock is released.
  return result?.afterLock ? result.afterLock() : result;
}

// True when the module is the command being run, not one the tests import. Compare
// real paths: reached through a symlinked directory (macOS /tmp, a linked skills
// folder) the two spellings differ, and the command would silently do nothing.
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    if (!(e instanceof UserError) && !(e instanceof host.RexError) && e.code !== "ERR_PARSE_ARGS_UNKNOWN_OPTION") throw e;
    console.error(`workloop: ${e.message}`);
    process.exitCode = 1;
  });
}
