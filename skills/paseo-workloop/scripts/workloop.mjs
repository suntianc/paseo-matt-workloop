#!/usr/bin/env node
// workloop — run state and Paseo/git mechanics for the paseo-workloop skill.
//
// The orchestrating agent makes the judgement calls; this script owns the
// bookkeeping and the invariants (verified bases, budgets, frozen candidates,
// review before integration, cleanup guards) and makes every Paseo and git
// call, so they happen the same way every time.
//
// Zero dependencies, Node >= 18.  `node workloop.mjs help` lists the commands.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync,
  readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { HeartbeatError, maintainHeartbeat } from "./heartbeat.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, "..");
const SKILLS_ROOT = resolve(SKILL_DIR, "..");
const TEMPLATES = join(SKILL_DIR, "templates");
const WIN = process.platform === "win32";
const BUSY = new Set(["running", "initializing", "starting"]);

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };
const say = (...a) => console.log(...a);
const now = () => new Date().toISOString();
const short = (sha) => (sha ? sha.slice(0, 8) : "-");
const tail = (s, n) => s.split("\n").slice(-n).join("\n");
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

// cmd.exe gets one command string; Node does not escape args under shell:true.
export function winQuote(arg) {
  const s = String(arg);
  if (/["%\r\n]/.test(s)) fail(`argument cannot be passed safely through cmd.exe: ${s}`);
  return s === "" || /[\s&|<>^()!,;=]/.test(s) ? `"${s}"` : s;
}
const shellArg = (s) => WIN ? winQuote(s) : `'${String(s).replace(/'/g, "'\\''")}'`;

// The single Paseo backend. PASEO_CLI may be a command on PATH, a path to the
// CLI binary/.cmd shim, or a path to the CLI's JS entry (run with this node).
function paseo(args, { timeout = Number(process.env.PASEO_TIMEOUT_MS || 30000), raw = false } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) fail("Paseo timeout must be a positive number of milliseconds");
  const cli = process.env.PASEO_CLI || "paseo";
  const opts = { encoding: "utf8", maxBuffer: 64 << 20, timeout: Math.ceil(timeout), killSignal: "SIGKILL" };
  let r;
  if (/\.[cm]?js$/i.test(cli)) r = spawnSync(process.execPath, [cli, ...args], opts);
  else if (WIN) r = spawnSync([cli, ...args].map(winQuote).join(" "), { ...opts, shell: true });
  else r = spawnSync(cli, args, opts);
  const what = `paseo ${args.slice(0, 2).join(" ")}`;
  if (r.error?.code === "ETIMEDOUT") fail(`${what} timed out after ${Math.ceil(timeout)}ms. Reconcile live state before retrying a write; it may have reached the daemon.`);
  if (r.error) fail(`${what}: ${r.error.message} (set PASEO_CLI if paseo is not on PATH)`);
  const text = r.stdout || "";
  if (raw) {
    if (r.status !== 0) fail(`${what} failed: ${(r.stderr || text).trim()}`);
    return text;
  }
  if (r.status === 0 && !text.trim()) return null;
  const start = text.search(/[[{]/);
  let data;
  try { data = JSON.parse(text.slice(start)); } catch {
    fail(`${what}: unexpected output (exit ${r.status}):\n${`${text}\n${r.stderr || ""}`.trim().slice(0, 2000)}`);
  }
  if (r.status !== 0 || (data && !Array.isArray(data) && data.error)) {
    const error = new UserError(`${what} failed: ${JSON.stringify(data?.error ?? data)}`);
    error.paseoCode = data?.error?.code;
    error.paseoMessage = data?.error?.message;
    throw error;
  }
  return data;
}
const pathArg = (p) => (WIN ? p.replace(/\\/g, "/") : p);
const untilde = (p) => (p && /^~(?=$|[\\/])/.test(p) ? join(homedir(), p.slice(1)) : p);

// Paseo JSON uses camelCase in some commands and PascalCase in others.
function pick(o, ...keys) {
  for (const k of keys) for (const kk of [k, k[0].toUpperCase() + k.slice(1)]) if (o?.[kk] != null) return o[kk];
}
function inspectAgent(id, options) {
  const a = paseo(["agent", "inspect", id, "--json"], options);
  return {
    id,
    status: String(pick(a, "status") ?? "unknown").toLowerCase(),
    archived: !!pick(a, "archived"),
    pending: (pick(a, "pendingPermissions") || []).length,
    updatedAt: pick(a, "lastActivityAt", "updatedAt") ?? null,
    parentAgentId: pick(a, "parentAgentId") ?? null,
  };
}
function listAgents(labels, { all = false } = {}) {
  const args = ["agent", "ls", "-g", "--json"];
  if (all) args.push("-a");
  for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
  return (paseo(args) || []).map((a) => ({
    id: pick(a, "id", "agentId"), name: pick(a, "name", "title") ?? "",
    status: String(pick(a, "status") ?? "unknown").toLowerCase(),
    cwd: pick(a, "cwd") ?? "",
  }));
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
function loadState(dir) { return JSON.parse(readFileSync(statePath(dir), "utf8")); }

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
// line but never leaves the log ahead of the state.
function record(dir, state, kind, fields = {}) {
  if (["import", "config", "decisions", "worktree", "prepare", "dispatch", "send", "freeze", "review", "integrate", "retry", "cancel"].includes(kind)) {
    state.completion = null;
  }
  state.seq = (state.seq || 0) + 1;
  saveState(dir, state);
  appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ seq: state.seq, ts: now(), kind, ...fields })}\n`);
}

function alive(pid) {
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
  try { return fn(); } finally { try { unlinkSync(p); } catch {} }
}

const tasksOf = (s) => Object.values(s.tasks).sort((a, b) => Number(a.id) - Number(b.id));
function task(s, id) {
  const key = Object.keys(s.tasks).find((k) => Number(k) === Number(id));
  if (key == null) fail(`no task #${id}; tasks: ${Object.keys(s.tasks).join(", ")}`);
  return s.tasks[key];
}
const reportPath = (dir, t) => join(dir, "reports", `${t.id}-${t.attempt}.md`);
const briefPath = (dir, t) => join(dir, "briefs", `${t.id}-${t.attempt}.md`);

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
  return { status: header(text, "Status"), verdict: header(text, "Verdict"), commit: header(text, "Commit"), tip: header(text, "Integration tip"), mtime };
}
const executorReport = (dir, t) => readReport(reportPath(dir, t), t.promptedAt);
const reviewReport = (t) => (t.review ? readReport(t.review.path, t.review.startedAt) : null);

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

function readTickets(dir) {
  if (!existsSync(dir)) fail(`tickets directory not found: ${dir}`);
  const tickets = readdirSync(dir).filter((f) => f.endsWith(".md"))
    .map((f) => parseTicket(join(dir, f), readFileSync(join(dir, f), "utf8"))).filter(Boolean);
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

function mergeTickets(state, tickets) {
  const changes = [];
  for (const k of tickets) {
    const t = Object.values(state.tasks).find((x) => Number(x.id) === Number(k.id));
    if (!t) {
      state.tasks[k.id] = { id: k.id, title: k.title, file: k.file, blockedBy: k.blockedBy, status: "ready", hold: null, attempt: "a1", rounds: 0, history: [] };
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
function cmdDecisions(dir, s) {
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
  const checks = runAll(s.config.checks, integ);
  if (!checks.ok) {
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
      fail(`\`${checks.cmd}\` fails after committing; ${s.integration.branch} is back at ${short(prev)} and the changes are still in the worktree, uncommitted. Fix them and run \`decisions\` again:\n${checks.output}`);
    }
    fail(`${s.integration.branch} is NOT rolled back: \`${checks.cmd}\` fails after committing, and Git could not undo the commit.\n${resetError}\n`
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
// must not call Paseo. A task counts once its candidate is frozen and its review
// report isn't written yet, or when a prepared review is still waiting for its
// receipt. A frozen task with no review yet is not counted: `review` would start it.
const reviewsBusy = (s) => tasksOf(s).filter((t) => (t.status === "in_review" && t.review && !reviewReport(t))
  || t.pendingAction?.kind === "review").length;

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
    ? "archive — retrospective assessed; archive the retained sessions together"
    : "assess the whole run: retro --file <report> or retro --skip --reason <why>, then archive"];
  const out = [];
  const tasks = tasksOf(s);
  // Suggesting a review the budget can't start only earns a refusal, so say what it waits for.
  const busy = reviewsBusy(s);
  const reviewRequest = (t) => (busy >= s.config.maxReviewers
    ? `#${t.id} waits for a reviewer (budget ${busy}/${s.config.maxReviewers})`
    : `review ${t.id} --prepare`);
  for (const t of tasks) {
    if (t.pendingAction) { out.push(`action ${t.id} — reconcile pending MCP action ${t.pendingAction.action}; do not repeat an unacknowledged call`); continue; }
    if (t.hold) { out.push(`#${t.id} on hold (${t.hold}) — resolve it, then \`unhold ${t.id}\``); continue; }
    if (t.status === "running") {
      if (!t.agentId) { out.push(`dispatch ${t.id} --prepare`); continue; }
      const r = executorReport(dir, t);
      if (r?.status === "done") out.push(reviewRequest(t));
      else if (r?.status === "question" || r?.status === "blocked") out.push(`#${t.id} reported ${r.status} — read ${reportPath(dir, t)}, answer with \`send ${t.id} --prepare\``);
    }
    if (t.status === "in_review") {
      const v = reviewReport(t)?.verdict;
      if (!t.review) out.push(reviewRequest(t));
      else if (v === "pass") out.push(`integrate ${t.id}`);
      else if (v) out.push(`#${t.id} changes requested — read ${t.review.path}, then \`send ${t.id} --prepare --file <rework.md>\` (or \`integrate ${t.id} --override "<why>"\`)`);
    }
    for (const b of t.blockedBy) if (s.tasks[b]?.status === "cancelled" && t.status === "ready") out.push(`#${t.id} is blocked by cancelled #${b} — cancel it or edit its ticket and \`import\``);
  }
  if (tasks.some((t) => ["running", "in_review"].includes(t.status) && !t.hold)) out.push("watch, then end this turn; resume on a Paseo notification or heartbeat");
  const free = s.config.maxExecutors - executorsBusy(s);
  const f = frontier(s);
  if (f.length && free > 0) out.push(f.slice(0, free).map((t) => `dispatch ${t.id} --prepare`).join(", "));
  if (tasks.every((t) => ["done", "cancelled"].includes(t.status))) {
    if (isDirect(s)) out.push("all tickets closed — `finish` (a direct run has no final review)");
    else {
      // Documents come first: classifying them can need a repair ticket, and the
      // final review must cover the tip that ticket produces.
      const bad = documentStep(documentReport(s));
      if (bad) out.push(bad);
      else out.push(`all tickets closed — do the final review into ${join(dir, "final-review.md")} (template: ${join(TEMPLATES, "final-review.md")}), then \`finish\``);
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

function cmdInit(opts) {
  const { repo, project, dir } = runLocation(opts);
  if (existsSync(statePath(dir))) fail(`a run already exists at ${dir}`);
  const ticketsDir = resolve(opts.tickets || join(dir, "issues"));
  const { tickets, warnings } = readTickets(ticketsDir);
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
  const config = {
    maxExecutors: Number(opts["max-executors"] || 2), maxReviewers: Number(opts["max-reviewers"] || 1),
    setup, checks, executor: agentConfig(opts, ""), reviewer: agentConfig(opts, "review-"),
  };
  for (const role of Object.keys(ROLES)) launchSettings(config, role);

  const integ = join(dir, "integration");
  mkdirSync(dir, { recursive: true });
  git(repo, "worktree", "add", "-b", branch, integ, baseSha);
  const rollback = (why) => {
    gitTry(repo, "worktree", "remove", "--force", integ);
    gitTry(repo, "branch", "-D", branch);
    fail(why);
  };
  const r1 = runAll(setup, integ);
  if (!r1.ok) rollback(`setup failed (\`${r1.cmd}\`), nothing kept:\n${r1.output}`);
  const r2 = runAll(checks, integ);
  if (!r2.ok) rollback(`checks fail on the base ${baseRef} already (\`${r2.cmd}\`), nothing kept. Fix them or choose checks that pass:\n${r2.output}`);

  const state = {
    version: 1, project, feature: opts.feature, runKey: `${project}-${opts.feature}`, mode: opts.direct ? "direct" : "full",
    repo, spec, tickets: ticketsDir, baseRef, baseSha,
    integration: { branch, worktree: integ, tip: baseSha },
    config, tasks: {}, seq: 0, createdAt: now(),
  };
  mergeTickets(state, tickets);
  for (const d of ["briefs", "reports", "reviews", "messages"]) mkdirSync(join(dir, d), { recursive: true });
  record(dir, state, "init", { baseSha, tasks: Object.keys(state.tasks) });
  warnings.forEach((w) => say(`warning: ${w}`));
  say(`run ${dir}`);
  say(`integration ${branch} at ${short(baseSha)} in ${integ}`);
  say(`use: node ${pathArg(fileURLToPath(import.meta.url))} --run ${project}/${opts.feature} <command>`);
  printStatus(dir, state, false);
}

// ------------------------------------------------------- launch settings

const ROLES = { executor: "", reviewer: "review-" }; // role -> its option prefix
const FIELDS = ["provider", "model", "mode", "thinking"];
const PROFILE_KEYS = { provider: "provider", model: "model", mode: "modeId", thinking: "thinkingOptionId" };

function agentConfig(opts, prefix) {
  const c = {};
  for (const k of [...FIELDS, "profile"]) if (opts[prefix + k]) c[k] = opts[prefix + k];
  return c;
}
function agentArgs(c) {
  return FIELDS.flatMap((k) => (c[k] ? [`--${k}`, c[k]] : []));
}
const describe = (l) => `${l.provider}${FIELDS.slice(1).map((k) => (l[k] ? ` ${k}=${l[k]}` : "")).join("")} ← ${l.source}`;

// Paseo keeps agent profiles in its daemon config, the list the `list_profiles`
// MCP tool serves. See reference/paseo-compat.md.
function paseoProfiles() {
  if (process.env.PASEO_HOST) return { list: [], why: "PASEO_HOST is set, so the daemon's config is not on this machine" };
  const file = join(untilde(process.env.PASEO_HOME || join(homedir(), ".paseo")), "config.json");
  try {
    const list = JSON.parse(readFileSync(file, "utf8")).daemon?.agentProfiles;
    return { list: Array.isArray(list) ? list.filter((p) => p?.name && p.provider) : [], why: `no profiles in ${file}` };
  } catch (e) { return { list: [], why: `cannot read ${file}: ${e.code || e.message}` }; }
}

// A role's launch settings, most specific first: this command's flags, the run's
// config, then a Paseo profile (the one the config names, else "wl-<role>").
// A role with no provider, model or mode at the end is an error, so an agent never
// silently gets Paseo's default.
function resolveLaunch(config, role, opts = {}) {
  const prefix = ROLES[role];
  const { profile: bound, ...explicit } = { ...config[role], ...agentConfig(opts, prefix) };
  const name = bound || `wl-${role}`;
  const profiles = paseoProfiles();
  const hits = profiles.list.filter((p) => p.name.toLowerCase() === name.toLowerCase() || p.id === name);
  if (hits.length > 1) fail(`${role}: ${hits.length} Paseo profiles are named "${name}"; rename all but one`);
  const p = hits[0];
  const known = profiles.list.map((x) => `  - "${x.name}" (${x.provider}${x.model ? `/${x.model}` : ""})${x.notes ? `: ${x.notes.replace(/\s+/g, " ").slice(0, 120)}` : ""}`).join("\n") || `  (${profiles.why})`;
  if (bound && !p) fail(`${role}: the run names Paseo profile "${bound}", which does not exist. Profiles:\n${known}\nTell the user.`);
  if (!p && !explicit.provider) {
    fail(`${role}: no launch settings: no Paseo profile "${name}", and the run sets no --${prefix}provider. Profiles:\n${known}\n`
      + `Create "${name}" in Paseo (Settings → host → Agents → Agent profiles), bind another with \`config --${prefix}profile <name>\`, or set \`--${prefix}provider\`. Tell the user; don't choose for them.`);
  }
  // A profile's model, mode and thinking belong to its provider; overriding the provider drops them.
  const base = p && (!explicit.provider || explicit.provider === p.provider)
    ? Object.fromEntries(FIELDS.filter((k) => p[PROFILE_KEYS[k]]).map((k) => [k, p[PROFILE_KEYS[k]]])) : {};
  const over = Object.keys(explicit);
  const source = !base.provider ? "run config" : `profile "${p.name}"${over.length ? ` + ${over.join(", ")} from the run` : ""}`;
  const features = base.provider ? Object.keys(p.featureValues || {}) : [];
  const warnings = features.length ? [`profile "${p.name}" sets ${features.join(", ")}, which the paseo CLI cannot pass; the agent starts without them`] : [];
  // Paseo starts an agent as provider/model, and an agent on another provider can't
  // inherit the orchestrator's mode, so both must be named here.
  if (!explicit.model && !base.model) {
    fail(`${role}: no model: the launch settings (${source}) set none, and the run sets no --${prefix}model. `
      + `Paseo takes provider/model. Tell the user; don't choose for them.`);
  }
  if (!explicit.mode && !base.mode) {
    fail(`${role}: no mode: the launch settings (${source}) set none, and the run sets no --${prefix}mode. `
      + `An agent on another provider cannot inherit the orchestrator's mode. Tell the user; don't choose for them.`);
  }
  return { ...base, ...explicit, source, warnings, features: base.provider ? p.featureValues || {} : {} };
}

// Resolves, then makes sure Paseo can run the provider at all, before anything is created.
function launchSettings(config, role, opts) {
  const l = resolveLaunch(config, role, opts);
  const id = l.provider.split("/")[0];
  const all = paseo(["provider", "ls", "--json"]) || [];
  const p = all.find((x) => pick(x, "provider", "id") === id);
  const status = String(pick(p, "status") ?? "").toLowerCase();
  if (!p) fail(`${role}: provider "${id}" (${l.source}) is not one Paseo knows (${all.map((x) => pick(x, "provider", "id")).join(", ")}). Tell the user.`);
  if (status && status !== "available") fail(`${role}: provider "${id}" (${l.source}) is ${status} in Paseo. Tell the user.`);
  if (!opts?.prepare) l.warnings.forEach((w) => say(`warning: ${role}: ${w}. Tell the user.`));
  return l;
}

function launchTable(config) {
  return Object.keys(ROLES).map((role) => {
    try { return { role, ...resolveLaunch(config, role) }; } catch (e) {
      if (!(e instanceof UserError)) throw e;
      return { role, error: e.message };
    }
  });
}

function startAgent(role, launch, args, prompt) {
  let res;
  try { res = paseo(["agent", "run", "--background", "--json", ...args, ...agentArgs(launch), prompt]); } catch (e) {
    if (e instanceof UserError) fail(`${e.message}\n${role} launch settings: ${describe(launch)}. If Paseo rejected them, tell the user.`);
    throw e;
  }
  const id = pick(res, "agentId", "id");
  if (!id) fail(`paseo agent run returned no agent id: ${JSON.stringify(res)}`);
  const status = String(pick(res, "status") ?? "").toLowerCase();
  if (status === "error") say(`warning: ${role} ${id} started in status "error". Read \`paseo agent logs ${id} --tail 30\`; if its launch settings (${describe(launch)}) are the cause, tell the user.`);
  return id;
}

// The script prepares guarded MCP calls; the orchestrator executes them in its
// own agent scope so Paseo can notify it. Persist before yielding to the caller.
function printAction(t) { say(JSON.stringify(t.pendingAction, null, 2)); }
function prepareAction(dir, s, t, kind, tool, args, meta = {}) {
  const caller = process.env.PASEO_AGENT_ID;
  if (!caller) fail("MCP preparation needs PASEO_AGENT_ID in the orchestrator's Paseo session");
  if (s.orchestratorId && s.orchestratorId !== caller) fail(`this run belongs to orchestrator ${s.orchestratorId}; reconcile ownership before dispatching`);
  s.orchestratorId = caller;
  const action = randomUUID();
  if (tool === "create_agent") args.labels = { ...args.labels, action };
  t.pendingAction = { action, kind, tool, arguments: args, preparedAt: now(), ...meta };
  record(dir, s, "prepare", { task: t.id, action, tool });
  // Arm recovery before yielding a request to an external tool call. A parent
  // interrupted between create/send and ack must still have a wake-up source.
  cmdWatch(dir, s, true);
  printAction(t);
}
function createArguments(t, launch, labels, title, prompt) {
  const ws = (paseo(["workspace", "ls", "--json"]) || []).find((w) => normPath(pick(w, "cwd")) === normPath(t.worktree));
  const workspaceId = pick(ws, "workspaceId", "id");
  if (!workspaceId) fail(`no Paseo workspace for ${t.worktree}; reconcile before preparing an MCP launch`);
  return {
    title, provider: launch.model ? `${launch.provider.split("/")[0]}/${launch.model}` : launch.provider,
    workspaceId, notifyOnFinish: true, labels, initialPrompt: prompt,
    settings: {
      ...(launch.mode ? { modeId: launch.mode } : {}),
      ...(launch.thinking ? { thinkingOptionId: launch.thinking } : {}),
      ...(Object.keys(launch.features).length ? { features: launch.features } : {}),
    },
  };
}
function cmdAction(s, id) {
  const t = task(s, id);
  if (!t.pendingAction) fail(`#${id} has no pending MCP action`);
  printAction(t);
}
function cmdAck(dir, s, id, opts) {
  const t = task(s, id);
  if (!opts.receipt) fail("ack needs --receipt <JSON file> containing {action, result: <MCP response>}");
  const receipt = JSON.parse(readFileSync(resolve(opts.receipt), "utf8"));
  if (!t.pendingAction && receipt.action === t.lastAction) return say(`action ${receipt.action} already acknowledged`);
  const p = t.pendingAction;
  if (!p || receipt.action !== p.action) fail("receipt action does not match the pending action");
  if (process.env.PASEO_AGENT_ID !== s.orchestratorId) fail("ack must run in the owning orchestrator session");
  let result = receipt.result;
  if (!result || typeof result !== "object") fail("receipt has no MCP result");
  if (result.isError) {
    if (p.tool === "create_agent" && listAgents(p.arguments.labels, { all: true }).length) fail("MCP failed after creating an agent; pending action retained. Recover its agentId and reconcile before acknowledging; do not create another worker");
    if (p.tool === "send_agent_prompt") fail("send returned an error; pending action retained because dispatch may have occurred. Reconcile activity and recover the dispatch receipt before retrying");
    t.pendingAction = null;
    record(dir, s, "action-failed", { task: t.id, action: p.action });
    return say(`MCP action ${p.action} failed; no success recorded. Read its error, then prepare a corrected request.`);
  }
  if (result.structuredContent) result = result.structuredContent;
  else if (result.content) {
    const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    try { result = JSON.parse(text); } catch { fail("MCP receipt has no structured JSON result"); }
  }
  if (p.tool === "create_agent") {
    const agentId = pick(result, "agentId", "id");
    const matches = listAgents(p.arguments.labels, { all: true });
    if (matches.length !== 1 || matches[0].id !== agentId || normPath(matches[0].cwd) !== normPath(t.worktree)) fail("MCP receipt agent does not match the prepared labels and worktree; reconcile before acknowledging");
    if (inspectAgent(agentId).parentAgentId !== s.orchestratorId) fail("MCP worker does not belong to this orchestrator; pending action retained");
    if (p.kind === "dispatch") {
      Object.assign(t, { agentId, launch: p.launch, transport: "mcp" });
    } else {
      t.review = { agentId, candidateSha: p.candidateSha, path: p.path, startedAt: p.preparedAt, launch: p.launch };
      t.reviewers = [...(t.reviewers || []), agentId];
    }
  } else {
    if (result.success !== true) fail("send receipt does not confirm successful dispatch; do not resend without reconciliation");
    completeSend(t, p);
  }
  t.lastAction = p.action;
  t.pendingAction = null;
  record(dir, s, p.kind, { task: t.id, action: p.action, transport: "mcp" });
  say(`#${t.id}: ${p.kind} acknowledged; finish notifications requested. Run watch before ending this turn.`);
}

function completeSend(t, { sentAt, n }) {
  if (t.status === "in_review") {
    t.history.push({ attempt: t.attempt, candidateSha: t.candidateSha, review: t.review?.path ?? null, at: now() });
    Object.assign(t, { status: "running", candidateSha: null, fixedPoint: null, review: null, rounds: (t.rounds || 0) + 1 });
  }
  Object.assign(t, { messages: n, promptedAt: sentAt });
}

function cmdConfig(dir, s, opts) {
  const c = s.config;
  if (opts["max-executors"]) c.maxExecutors = Number(opts["max-executors"]);
  if (opts["max-reviewers"]) c.maxReviewers = Number(opts["max-reviewers"]);
  if (opts.check) c.checks = opts.check;
  if (opts.setup) c.setup = opts.setup;
  Object.assign(c.executor, agentConfig(opts, ""));
  Object.assign(c.reviewer, agentConfig(opts, "review-"));
  record(dir, s, "config", { config: c });
  say(JSON.stringify(c, null, 2));
  printLaunch(c, true);
}

function cmdImport(dir, s) {
  const { tickets, warnings } = readTickets(s.tickets);
  if (isDirect(s)) {
    const added = tickets.filter((k) => !s.tasks[k.id]);
    if (added.length && (added.length !== 1 || tasksOf(s).some((t) => t.status !== "done")
      || !added[0].blockedBy.some((id) => s.tasks[id]?.status === "done"))) {
      fail("a direct run holds one ticket at a time; after integration it can import one repair blocked by an integrated ticket. Broader work belongs in a full run.");
    }
    for (const k of added) if (!ticketScope(k.file, readFileSync(k.file, "utf8"))) fail(`direct repair #${k.id} needs a "Scope:" line`);
  }
  const changes = mergeTickets(s, tickets);
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
  const open = t.blockedBy.filter((b) => s.tasks[b]?.status !== "done");
  if (open.length) fail(`#${t.id} is blocked by ${open.map((b) => `#${b} (${s.tasks[b]?.status})`).join(", ")}`);
  if (t.status === "ready" && executorsBusy(s) >= s.config.maxExecutors) fail(`executor budget full (${s.config.maxExecutors} running); wait for one to reach review, or raise it with \`config --max-executors\``);
  checkIntegration(s);
  const tip = t.reuseWorktree ? t.baseSha : s.integration.tip;
  const branch = t.reuseWorktree ? t.branch : `wl-${s.feature}-${t.id}-${t.attempt}`;

  const vars = {
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
  if (!wt) {
    const res = paseo(opts.prepare
      ? ["workspace", "create", "--isolation", "worktree", "--mode", "branch-off", "--new-branch", branch, "--base", s.integration.branch, "--path", pathArg(s.repo), "--json"]
      : ["worktree", "create", "--mode", "branch-off", "--new-branch", branch, "--base", s.integration.branch, "--cwd", pathArg(s.repo), "--json"]);
    wt = untilde(pick(res, "worktreePath", "path", "cwd")) || worktreeFor(s.repo, pick(res, "branchName", "branch") || branch);
    if (!wt) fail(`paseo created a worktree but did not say where: ${JSON.stringify(res)}`);
    const made = pick(res, "branchName", "branch");
    if (made && made !== branch) fail(`paseo named the branch ${made}, expected ${branch}; reconcile with \`git worktree list\` before retrying`);
  }
  wt = pathArg(wt); // paseo answers with backslashes on Windows; state, brief and --cwd must all spell it one way
  const h = head(wt);
  if (!t.reuseWorktree && h !== tip) fail(`worktree ${wt} is at ${short(h)}, expected the integration tip ${short(tip)}. Not starting the agent; inspect it before continuing.`);
  if (git(wt, "branch", "--show-current") !== branch) fail(`worktree ${wt} is not on expected branch ${branch}; reconcile before dispatch`);
  Object.assign(t, { status: "running", branch, worktree: wt, baseSha: tip, promptedAt: now() });
  vars.worktree = pathArg(wt);
  vars.startSha = h;
  writeFileSync(briefPath(dir, t), render("executor-brief.md", vars));
  record(dir, s, "worktree", { task: t.id, attempt: t.attempt, branch, worktree: wt, sha: tip });

  // 2. agent — adopt one started by an interrupted dispatch, else start it.
  const labels = { workloop: s.runKey, task: t.id, attempt: t.attempt, role: "executor" };
  const existing = listAgents(labels, { all: true });
  if (existing.length) {
    if (opts.prepare) fail("an existing executor has no acknowledged MCP action; reconcile its receipt and notification ownership before adopting it");
    t.agentId = existing[0].id;
    record(dir, s, "adopted", { task: t.id, attempt: t.attempt, agent: t.agentId });
    say(`#${t.id}: adopted existing executor ${t.agentId} (${existing[0].status})`);
    return;
  }
  const prompt = `Read the task brief at ${pathArg(briefPath(dir, t))} and follow it. It is your complete instruction set; never ask the user anything.`;
  if (opts.prepare) return prepareAction(dir, s, t, "dispatch", "create_agent",
    createArguments(t, launch, labels, `wl ${s.feature} #${t.id} ${t.attempt}`, prompt), { launch: describe(launch) });
  t.agentId = startAgent("executor", launch, [
    "--title", `wl ${s.feature} #${t.id} ${t.attempt}`,
    "--cwd", pathArg(wt), ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
  ], prompt);
  t.launch = describe(launch);
  record(dir, s, "dispatch", { task: t.id, attempt: t.attempt, agent: t.agentId, sha: tip, launch: t.launch });
  say(`#${t.id} dispatched: agent ${t.agentId}, branch ${branch}, base ${short(tip)}`);
  say(`executor ${t.launch}`);
  say(`brief ${briefPath(dir, t)}`);
}

function requireIdle(id, role, allowMissing = false) {
  let a;
  try { a = inspectAgent(id); } catch (e) {
    if (!allowMissing || !["NOT_FOUND", "AGENT_NOT_FOUND"].includes(e.paseoCode)) throw e;
    return { id, status: "missing", archived: true, missing: true };
  }
  if (BUSY.has(a.status)) fail(`${role} ${id} is ${a.status}. Wait for it (patrol), or interrupt it with \`paseo agent stop ${id}\` first`);
  return a;
}

function freeze(dir, s, t, quiet = false) {
  if (t.status !== "running" || !t.agentId) fail(`#${t.id} is ${t.status}; only a running task with an executor can be frozen`);
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

function cmdReview(dir, s, id, opts) {
  const t = task(s, id);
  if (!["running", "in_review"].includes(t.status)) fail(`#${t.id} is ${t.status}; nothing to review`);
  if (t.review && !opts.again) fail(`#${t.id} already has review agent ${t.review.agentId} for ${short(t.review.candidateSha)}; pass --again to start another`);
  if (t.review) requireIdle(t.review.agentId, "reviewer");
  const busy = listAgents({ workloop: s.runKey, role: "reviewer" }).filter((a) => BUSY.has(a.status)).length
    + tasksOf(s).filter((x) => x.pendingAction?.kind === "review").length;
  if (busy >= s.config.maxReviewers) fail(`reviewer budget full (${busy}/${s.config.maxReviewers}); patrol, or raise it with \`config --max-reviewers\``);
  const launch = launchSettings(s.config, "reviewer", opts);
  if (t.status === "running") freeze(dir, s, t, opts.prepare);
  requireIdle(t.agentId, "executor");
  if (head(t.worktree) !== t.candidateSha || !isClean(t.worktree)) fail(`#${t.id}: worktree moved off the frozen candidate ${short(t.candidateSha)}`);

  const path = join(dir, "reviews", `${t.id}-${short(t.candidateSha)}${opts.again ? `-${Date.now()}` : ""}.md`);
  const vars = {
    task: t.id, title: t.title, worktree: pathArg(t.worktree), candidateSha: t.candidateSha, candidateShort: short(t.candidateSha),
    fixedPoint: t.fixedPoint, ticketPath: pathArg(t.file), specPath: pathArg(isDirect(s) ? t.file : s.spec), executorReport: pathArg(reportPath(dir, t)),
    reviewPath: pathArg(path), skillsRoot: pathArg(SKILLS_ROOT), codeReviewSkill: skillPath("code-review"), notes: notesFrom(opts),
    direct: isDirect(s) ? `\n${render("reviewer-direct.md", {})}` : "",
  };
  const brief = join(dir, "briefs", `${t.id}-review-${short(t.candidateSha)}.md`);
  writeFileSync(brief, render("reviewer-brief.md", vars));
  const labels = { workloop: s.runKey, task: t.id, attempt: t.attempt, role: "reviewer", candidate: short(t.candidateSha) };
  const startedAt = now();
  if (opts.prepare) return prepareAction(dir, s, t, "review", "create_agent",
    createArguments(t, launch, labels, `wl ${s.feature} #${t.id} review ${short(t.candidateSha)}`,
      `Read the review brief at ${pathArg(brief)} and follow it. Review only; change nothing; never ask the user anything.`),
    { candidateSha: t.candidateSha, path, launch: describe(launch) });
  const agentId = startAgent("reviewer", launch, [
    "--title", `wl ${s.feature} #${t.id} review ${short(t.candidateSha)}`,
    "--cwd", pathArg(t.worktree), ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
  ], `Read the review brief at ${pathArg(brief)} and follow it. Review only; change nothing; never ask the user anything.`);
  t.review = { agentId, candidateSha: t.candidateSha, path, startedAt, launch: describe(launch) };
  t.reviewers = [...(t.reviewers || []), agentId];
  record(dir, s, "review", { task: t.id, attempt: t.attempt, agent: agentId, sha: t.candidateSha, launch: t.review.launch });
  say(`#${t.id} review started: agent ${agentId} on ${short(t.candidateSha)}; report goes to ${path}`);
  say(`reviewer ${t.review.launch}`);
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
  if (t.review?.agentId) requireIdle(t.review.agentId, "reviewer");
  requireIdle(t.agentId, "executor");

  const n = (t.messages || 0) + 1;
  // Reports are overwritten by the executor; keep each previous round for retro.
  if (existsSync(reportPath(dir, t))) writeAtomic(join(dir, "reports", `${t.id}-${t.attempt}-before-${n}.md`), readFileSync(reportPath(dir, t), "utf8"));
  const file = join(dir, "messages", `${t.id}-${t.attempt}-${n}.md`);
  const footer = `\n\n---\nThis continues task #${t.id} (brief: ${pathArg(briefPath(dir, t))}). When you stop, overwrite ${pathArg(reportPath(dir, t))} as the brief describes (first line \`Status: done | question | blocked\`). End with exactly three lines: Result: <done | question | blocked>, Report: ${pathArg(reportPath(dir, t))}, Summary: <one sentence>. Then end your turn.\n`;
  writeFileSync(file, body + footer);
  const sentAt = now(); // before sending: a fast agent may rewrite its report right away
  if (opts.prepare) return prepareAction(dir, s, t, "send", "send_agent_prompt", {
    agentId: t.agentId, prompt: body + footer, notifyOnFinish: true, activeTurnBehavior: "steer",
  }, { sentAt, n });
  paseo(["agent", "send", t.agentId, "--prompt-file", pathArg(file), "--no-wait", "--json"]);
  const wasReview = t.status === "in_review";
  completeSend(t, { sentAt, n });
  record(dir, s, "send", { task: t.id, attempt: t.attempt, agent: t.agentId, file, rework: wasReview });
  say(`#${t.id}: message ${n} sent to ${t.agentId}${wasReview ? ` (rework round ${t.rounds}; back to running)` : ""}`);
  if (t.rounds >= 3 && wasReview) say(`warning: #${t.id} is on rework round ${t.rounds}; if the same findings keep coming back, hold it and escalate`);
}

function cmdIntegrate(dir, s, id, opts) {
  const t = task(s, id);
  if (t.status !== "in_review") fail(`#${t.id} is ${t.status}; only a reviewed candidate can be integrated`);
  if (t.hold) fail(`#${t.id} is on hold: ${t.hold}`);
  const open = t.blockedBy.filter((b) => s.tasks[b]?.status !== "done");
  if (open.length) fail(`#${t.id} is blocked by ${open.join(", ")}`);
  const verdict = reviewReport(t)?.verdict;
  if (verdict !== "pass" && !opts.override) fail(`#${t.id}: review verdict is ${verdict ?? (t.review ? "not written yet" : "missing — run `review`")}; integrate only on "pass", or pass --override "<reason>"`);
  if (t.review?.agentId) requireIdle(t.review.agentId, "reviewer");
  if (head(t.worktree) !== t.candidateSha || !isClean(t.worktree)) fail(`#${t.id}: worktree moved off the frozen candidate ${short(t.candidateSha)}; freeze and review again`);
  checkIntegration(s);
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
  const checks = runAll(s.config.checks, integ);
  if (!checks.ok) {
    gitTry(integ, "reset", "--hard", prev);
    record(dir, s, "integrate_failed", { task: t.id, sha: t.candidateSha, check: checks.cmd });
    fail(`#${t.id}: \`${checks.cmd}\` fails after merging; integration rolled back to ${short(prev)}.\n${checks.output}\nRoute it to the executor with \`send ${t.id}\`.`);
  }
  s.integration.tip = head(integ);
  Object.assign(t, { status: "done", mergeSha: s.integration.tip, integratedAt: now(), override: verdict === "pass" ? null : opts.override });
  s.lastIntegratedAt = t.integratedAt;
  record(dir, s, "integrate", { task: t.id, attempt: t.attempt, sha: t.candidateSha, tip: s.integration.tip, override: t.override || undefined });
  say(`#${t.id} integrated: ${s.integration.branch} ${short(prev)} -> ${short(s.integration.tip)}`);
  say("Sessions and worktree retained for the run retrospective; archive after finish and retro.");
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
  const agents = listAgents({ workloop: s.runKey, task: t.id }).filter((a) => BUSY.has(a.status));
  if (agents.length) fail(`#${t.id}: agents still running against it: ${agents.map((a) => a.id).join(", ")}`);
  if (t.worktree && existsSync(t.worktree)) {
    if (!isClean(t.worktree)) fail(`#${t.id}: worktree ${t.worktree} has uncommitted changes; look at them before cleaning up`);
    const ws = paseo(["workspace", "ls", "--json"]).find((w) => normPath(pick(w, "cwd")) === normPath(t.worktree));
    if (ws) paseo(["workspace", "archive", pick(ws, "workspaceId", "id"), "--json"]);
    if (existsSync(t.worktree)) git(s.repo, "worktree", "remove", t.worktree);
  }
  gitTry(s.repo, "worktree", "prune");
  for (const id of [t.agentId, ...(t.reviewers || [])].filter(Boolean)) {
    if (!requireIdle(id, "run agent", true).archived) paseo(["agent", "archive", id, "--json"]);
  }
  if (t.branch && branchExists(s.repo, t.branch)) git(integ, "branch", "-d", t.branch); // -d refuses unmerged work
  t.cleanedAt = now();
  record(dir, s, "cleanup", { task: t.id, attempt: t.attempt });
  say(`#${t.id} cleaned up (workspace archived, branch ${t.branch} deleted)`);
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
  if (old.worktree) say(`${reuse ? "reusing" : "the old attempt is kept:"} worktree ${old.worktree}, branch ${old.branch}. Sessions remain available for retro.`);
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

function cmdFinish(dir, s) {
  const open = tasksOf(s).filter((t) => !["done", "cancelled"].includes(t.status));
  if (open.length) fail(`not finished: ${open.map((t) => `#${t.id} ${t.status}`).join(", ")}`);
  checkIntegration(s);
  // A direct run's reviewer re-ran the acceptance checks, and there are no other tickets to cross-check.
  if (!isDirect(s)) {
    const fr = readReport(join(dir, "final-review.md"), s.lastIntegratedAt);
    if (!fr) fail(`write the final review to ${join(dir, "final-review.md")} first (template: ${join(TEMPLATES, "final-review.md")}); it must be newer than the last integration`);
    if (fr.verdict !== "pass") fail(`final review verdict is ${fr.verdict ?? "missing"}; fix via repair tickets (write the ticket, \`import\`, dispatch) and review again`);
    if (!fr.tip || !s.integration.tip.startsWith(fr.tip)) fail(`final review is for integration tip ${fr.tip ?? "(none)"}, but the tip is ${short(s.integration.tip)}`);
  }
  // The same check as the next step, so a run cannot pass the final review and then
  // finish with a document it never classified. A repo with no registry is never
  // blocked; one with /tidy-docs installed is only reminded. Both read the one
  // report, so a failed inventory is the gate's error and never a missing registry.
  if (!isDirect(s)) {
    const report = documentReport(s);
    const docs = documentStep(report);
    if (docs) fail(`not finished: ${docs}`);
    const reminder = report.error || report.registry ? null : tidyDocsReminder(s);
    if (reminder) say(reminder);
  }
  const checks = runAll(s.config.checks, s.integration.worktree);
  if (!checks.ok) fail(`\`${checks.cmd}\` fails on the integration tip:\n${checks.output}`);
  for (const a of runAgents(s)) requireIdle(a.id, "run agent", true);
  s.completion ||= { at: now(), tip: s.integration.tip };
  record(dir, s, "finish", { tip: s.integration.tip });
  if ((s.heartbeat || s.heartbeatLedger?.ids?.length || s.heartbeatLedger?.pendingCreate) && process.env.PASEO_AGENT_ID === s.orchestratorId) cmdWatch(dir, s);
  const commits = git(s.repo, "log", "--oneline", "--first-parent", `${s.baseSha}..${s.integration.tip}`);
  say(`delivery checked. ${s.integration.branch} is at ${short(s.integration.tip)} (base ${s.baseRef} ${short(s.baseSha)}):\n${commits}`);
  say("Nothing was pushed or merged into the base; that is the user's call.");
  say("Sessions retained. Read the run evidence, assess retro, then archive. Use `evidence` to save CLI transcripts.");
}

// Session inventory includes replaced attempts and superseded reviewers. Live
// labels recover workers created before a lost receipt; state covers old runs.
function runAgents(s) {
  const agents = new Map();
  const worktrees = new Set(tasksOf(s).flatMap((t) => [...t.history, t]).map((a) => a.worktree && normPath(a.worktree)).filter(Boolean));
  for (const t of tasksOf(s)) {
    for (const a of [...t.history, t]) {
      for (const id of [a.agentId, ...(a.reviewers || []), a.review?.agentId].filter(Boolean)) {
        const entry = agents.get(id) || { id, tasks: [], cwd: a.worktree || t.worktree };
        entry.tasks.push({ task: t.id, attempt: a.attempt, role: id === a.agentId ? "executor" : "reviewer" });
        agents.set(id, entry);
      }
    }
  }
  for (const a of listAgents({ workloop: s.runKey }, { all: true })) {
    if (!agents.has(a.id) && worktrees.has(normPath(a.cwd))) agents.set(a.id, { id: a.id, cwd: a.cwd, tasks: [] });
  }
  return [...agents.values()];
}

function cmdEvidence(dir, s) {
  const folder = join(dir, "evidence");
  if (s.finishedAt && existsSync(join(folder, "index.json"))) return say(`archived run: use the preserved evidence at ${folder}`);
  mkdirSync(folder, { recursive: true });
  const agents = runAgents(s);
  for (const a of agents) {
    const file = `${encodeURIComponent(a.id)}.txt`;
    // An already deleted session is a disclosed evidence gap, not an infinite
    // archive blocker. Connectivity errors still abort before any cleanup.
    let missing = false;
    try { inspectAgent(a.id); } catch (e) {
      if (!["NOT_FOUND", "AGENT_NOT_FOUND"].includes(e.paseoCode)) throw e;
      missing = true;
    }
    const transcript = missing
      ? (existsSync(join(folder, file)) ? readFileSync(join(folder, file), "utf8") : `Session ${a.id} is missing in Paseo. No transcript could be recovered; use the retained briefs, reports, messages and events.\n`)
      : paseo(["agent", "logs", a.id], { raw: true });
    writeAtomic(join(folder, file), transcript);
    Object.assign(a, { file, capturedAt: now(), missing });
    if (missing) say(`evidence gap: session ${a.id} is missing; recorded in the index`);
  }
  const index = { capturedAt: now(), completion: s.completion?.at || null, format: "Paseo CLI activity transcripts; tool output may be curated. Original agent IDs retained for deeper inspection.", agents };
  writeAtomic(join(folder, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  s.evidence = { completion: index.completion, capturedAt: index.capturedAt, path: join(folder, "index.json") };
  record(dir, s, "evidence", { agents: agents.length });
  say(`saved ${agents.length} session transcripts: ${folder}`);
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
  // Snapshot every session before the first destructive cleanup. On an
  // interrupted archive reuse that snapshot, even if Paseo no longer serves it.
  if (!s.archiveStartedAt) {
    cmdEvidence(dir, s);
    s.archiveStartedAt = now();
    record(dir, s, "archive-start");
  }
  if ((s.heartbeat || s.heartbeatLedger?.ids?.length || s.heartbeatLedger?.pendingCreate) && process.env.PASEO_AGENT_ID === s.orchestratorId) cmdWatch(dir, s);
  for (const t of tasksOf(s)) if (t.status === "done" && !t.cleanedAt) cleanupTask(dir, s, t);
  for (const a of agents) if (!requireIdle(a.id, "run agent", true).archived) paseo(["agent", "archive", a.id, "--json"]);
  // Cancelled/replaced workspaces can contain unmerged or uncommitted work.
  // Archive their sessions but retain those trees for a separate user decision.
  const retained = new Map();
  for (const t of tasksOf(s)) for (const a of [...t.history, t]) {
    if (a.worktree && existsSync(a.worktree)) retained.set(a.worktree, { worktree: a.worktree, branch: a.branch });
  }
  if (existsSync(s.integration.worktree)) git(s.repo, "worktree", "remove", s.integration.worktree);
  s.finishedAt = now();
  s.retainedWorktrees = [...retained.values()];
  record(dir, s, "archive", { retainedWorktrees: s.retainedWorktrees });
  say(`archived. ${s.integration.branch} stays at ${short(s.integration.tip)}; evidence and retro remain in ${dir}`);
  if (retained.size) say(`unmerged/cancelled work retained for your decision:\n${[...retained.values()].map((a) => `  ${a.worktree} (${a.branch})`).join("\n")}`);
}

// ------------------------------------------------------- status and patrol

function cmdWatch(dir, s, quiet = false, opts = {}) {
  const owner = process.env.PASEO_AGENT_ID;
  if (!owner) fail("watch needs PASEO_AGENT_ID so its heartbeat targets this conversation");
  if (s.orchestratorId && s.orchestratorId !== owner) fail(`watch belongs to orchestrator ${s.orchestratorId}`);
  s.orchestratorId = owner;
  const problems = [];
  let busy = 0;
  let uncertain = false;
  for (const t of tasksOf(s)) {
    if (s.finishedAt || !["running", "in_review"].includes(t.status)) continue;
    if (t.pendingAction) problems.push(`#${t.id}: pending MCP action; reconcile its receipt`);
    else if (!t.hold && ((t.status === "running" && !t.agentId) || (t.status === "in_review" && !t.review))) {
      uncertain = true;
      problems.push(`#${t.id}: no ${t.status === "running" ? "executor" : "reviewer"} recorded; prepare the next guarded launch`);
    }
    // Include held workers and the current reviewer: a report does not prove
    // they stopped. Superseded reviewers were required idle before rework.
    const ids = [...new Set([t.agentId, t.review?.agentId].filter(Boolean))];
    for (const id of ids) {
      let a;
      try { a = inspectAgent(id); } catch (e) { uncertain = true; problems.push(`#${t.id} ${short(id)}: ${e.message.split("\n")[0]}`); continue; }
      if (BUSY.has(a.status)) {
        busy++;
        const age = (Date.now() - Date.parse(a.updatedAt)) / 60000;
        if (!Number.isFinite(age)) problems.push(`#${t.id} ${short(id)}: activity timestamp unavailable`);
        else if (age >= 45) problems.push(`#${t.id} ${short(id)}: no activity for ${Math.floor(age)}m`);
      } else if (["running", "in_review"].includes(t.status) && (id === t.review?.agentId || (!t.review && id === t.agentId))) {
        problems.push(`#${t.id} ${short(id)}: ${a.status}; read the fresh report and continue the loop`);
      }
      if (a.pending) problems.push(`#${t.id} ${short(id)}: ${a.pending} permission request(s)`);
    }
  }
  const due = new Date(Date.now() + 55 * 60000);
  const command = `node ${shellArg(pathArg(join(HERE, "workloop.mjs")))} --run ${shellArg(pathArg(dir))} watch`;
  const prompt = `【Workloop 保温心跳】Run this command now: ${command}. It checks current state, not a cached snapshot. If normal, reply only 好. On 异常 or 待处理, inspect only the affected agents' recent activity/report, reconcile and continue the workloop within its scope. Never infer acceptance from an agent finishing. Run watch before ending your turn; if all workers stopped it removes the heartbeat. Do not poll or wait in a long shell loop.`;
  maintainHeartbeat({ dir, state: s, owner, due, prompt, call: paseo,
    wanted: !s.finishedAt && Boolean(busy || uncertain || tasksOf(s).some((t) => t.pendingAction)),
    persist: (kind, fields) => record(dir, s, kind, fields), receiptIds: opts["heartbeat-id"] || [],
    clearPending: opts["clear-heartbeat-create"], reason: opts.reason });
  record(dir, s, "watch", { busy, problems, heartbeat: s.heartbeat });
  if (!quiet) say(problems.length ? `【保温心跳·异常／待处理】${problems.join("; ")}` : busy ? "【保温心跳】正常；只回复好" : "no running workers; tracked heartbeats deleted or confirmed absent");
}

function liveMap(s) {
  const map = new Map();
  for (const a of listAgents({ workloop: s.runKey }, { all: true })) map.set(a.id, a);
  return map;
}

function printStatus(dir, s, live, asJson = false) {
  const agents = live ? liveMap(s) : null;
  const rows = tasksOf(s).map((t) => {
    const rep = t.status === "running" ? executorReport(dir, t)?.status : null;
    const rev = t.status === "in_review" ? reviewReport(t)?.verdict ?? (t.review ? "pending" : null) : null;
    return {
      id: t.id, status: t.status + (t.hold ? "*" : ""), attempt: t.attempt, agent: t.agentId ? t.agentId.slice(0, 8) : "-",
      live: live && t.agentId ? agents.get(t.agentId)?.status ?? "missing" : "-",
      candidate: short(t.candidateSha), report: rep || rev || "-", title: t.title,
      blockers: t.blockedBy.filter((b) => s.tasks[b]?.status !== "done"),
    };
  });
  if (asJson) return say(JSON.stringify({ run: dir, mode: s.mode || "full", integration: s.integration, completion: s.completion, retro: s.retro, archivedAt: s.finishedAt, config: s.config, launch: launchTable(s.config), tasks: rows, next: nextSteps(dir, s) }, null, 2));
  say(`run ${s.project}/${s.feature}${isDirect(s) ? " (direct)" : ""} · base ${s.baseRef}@${short(s.baseSha)} · ${s.integration.branch}@${short(s.integration.tip)}${s.finishedAt ? " · FINISHED" : ""}`);
  const reviewing = tasksOf(s).filter((t) => t.review && !reviewReport(t)).length;
  say(`executors ${executorsBusy(s)}/${s.config.maxExecutors} · reviews pending ${reviewing} (max ${s.config.maxReviewers})`);
  if (!s.finishedAt) printLaunch(s.config);
  const cols = ["id", "status", "attempt", "agent", "live", "candidate", "report", "title"];
  const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]));
  say(cols.map((c) => c.padEnd(width[c])).join("  "));
  for (const r of rows) {
    say(cols.map((c) => String(r[c]).padEnd(width[c])).join("  ") + (r.blockers.length && r.status.startsWith("ready") ? `  (blocked by ${r.blockers.join(", ")})` : ""));
  }
  if (rows.some((r) => r.status.endsWith("*"))) say("* = on hold");
  if (live) {
    const known = new Set(tasksOf(s).flatMap((t) => [t.agentId, ...(t.reviewers || []), ...t.history.map((h) => h.agentId)]).filter(Boolean));
    for (const [id, a] of agents) if (!known.has(id)) say(`warning: agent ${id} "${a.name}" (${a.status}) carries this run's label but is not recorded — a dispatch was interrupted; \`dispatch\` adopts it`);
    for (const t of tasksOf(s)) {
      if (["running", "in_review"].includes(t.status) && t.worktree && !existsSync(t.worktree)) say(`warning: #${t.id} worktree is gone: ${t.worktree}`);
    }
    if (!s.finishedAt) {
      const h = existsSync(s.integration.worktree) ? head(s.integration.worktree) : null;
      if (h !== s.integration.tip) say(`warning: integration worktree is at ${short(h)}, state says ${short(s.integration.tip)}`);
    }
  }
  printNext(dir, s);
}

// One line per role; `full` (the config command) prints an unresolved role's whole message.
function printLaunch(config, full = false) {
  for (const l of launchTable(config)) {
    if (l.error && full) say(`${l.role} UNRESOLVED: ${l.error.slice(l.role.length + 2)}`);
    else if (l.error) say(`${l.role} UNRESOLVED: ${l.error.slice(l.role.length + 2).split("\n")[0].replace(/ Profiles:$/, "")} (\`config\` lists the profiles; tell the user)`);
    else say(`${l.role} ${describe(l)}${l.warnings.map((w) => ` · warning: ${w}`).join("")}`);
  }
}

function cmdPatrol(dir, s, opts) {
  const windowMs = Number(opts.window || 1) * 1000;
  const intervalMs = Number(opts.interval || 15) * 1000;
  if (!Number.isFinite(windowMs) || windowMs <= 0 || windowMs > 60000) fail("patrol --window must be > 0 and <= 60 seconds; use finish notifications and watch for ongoing supervision");
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) fail("patrol --interval must be positive");
  const watch = [];
  for (const t of tasksOf(s)) {
    if (t.hold) continue;
    if (t.status === "running" && t.agentId) watch.push({ t, role: "executor", id: t.agentId });
    if (t.status === "in_review" && t.review && !reviewReport(t)) watch.push({ t, role: "reviewer", id: t.review.agentId });
  }
  if (!watch.length) { say("no active agents"); return printNext(dir, s); }
  const started = Date.now();
  let seen;
  for (;;) {
    seen = watch.map((w) => {
      const remaining = windowMs - (Date.now() - started);
      if (remaining <= 0) fail("patrol timed out at its deadline; task state is unchanged; resume on notifications or use watch");
      const a = inspectAgent(w.id, { timeout: Math.min(remaining, Number(process.env.PASEO_TIMEOUT_MS || 30000)) });
      const rep = w.role === "executor" ? executorReport(dir, w.t) : reviewReport(w.t);
      return { ...w, a, rep, attention: !BUSY.has(a.status) || a.pending > 0 };
    });
    if (seen.some((x) => x.attention) || Date.now() - started + intervalMs > windowMs) break;
    sleep(intervalMs);
  }
  const ago = (ts) => (ts ? `${Math.round((Date.now() - Date.parse(ts)) / 60000)}m ago` : "?");
  say(`patrol ${Math.round((Date.now() - started) / 1000)}s`);
  for (const x of seen) {
    const what = x.role === "executor" ? `report=${x.rep?.status ?? "none"}` : `verdict=${x.rep?.verdict ?? "none"}`;
    let line = `#${x.t.id} ${x.role} ${x.id.slice(0, 8)} ${x.a.status} (updated ${ago(x.a.updatedAt)}) ${what}`;
    if (x.a.pending) line += ` · ${x.a.pending} permission request(s) waiting — answer them in Paseo`;
    const launch = x.role === "executor" ? x.t.launch : x.t.review?.launch;
    if (x.a.status === "error") line += ` · the agent errored: read \`paseo agent logs ${x.id} --tail 30\`; if its launch settings (${launch ?? "unknown"}) are the cause, tell the user`;
    else if (!BUSY.has(x.a.status) && !x.rep) line += x.role === "executor" ? " · stopped without a fresh report: check `paseo agent logs`, then nudge it with `send`" : " · stopped without writing its report: check `paseo agent logs`, then `review --again`";
    say(line);
  }
  if (!seen.some((x) => x.attention)) say("no change; run watch and end this turn; resume on a finish notification or heartbeat");
  printNext(dir, loadState(dir));
}

// --------------------------------------------------------------------- CLI

const HELP = `workloop — run state and Paseo/git mechanics for the paseo-workloop skill

usage: node workloop.mjs [--run <dir|project/feature>] <command> [args]

  init --feature <slug> [--repo .] [--base <ref>] [--spec <file>] [--tickets <dir>]
       [--check <cmd>]... [--setup <cmd>]... [--max-executors 2] [--max-reviewers 1]
       [--profile name] [--provider p] [--model m] [--mode m] [--thinking t]
       [--review-profile name] [--review-provider p] ...
       [--direct]                      one ticket with a Scope line, no spec, no final review
       spec and tickets default to <run dir>/spec.md and <run dir>/issues
  scratch --feature <slug> [--repo .]   create <run dir>/issues and print the run's paths
  config  [same options as init]       change budgets, checks, launch settings

  Launch settings per role, most specific first: the command's flags, the run's
  config, the Paseo profile the run names (--profile / --review-profile), else
  the Paseo profile "wl-executor" / "wl-reviewer". Nothing found is an error, and
  so is a role with no --model or no --mode (--review-model / --review-mode).
  import                               re-read the tickets directory (new/repair tickets)
  decisions                            commit ADR/glossary changes before the first dispatch
  status [--live] [--json]             table + next steps; --live reconciles with Paseo and git
  dispatch <NN> [--prepare] [--note t] [--note-file f] [--dry-run] [--profile ...]
  patrol [--window 1] [--interval 15]    bounded diagnostic (window <= 60s)
  watch                                fresh health check; renew/remove 55m heartbeat
        [--heartbeat-id <id>]...        recover IDs from actual heartbeat receipts
        [--clear-heartbeat-create --reason <evidence>]  reconcile a confirmed failed creation
  action <NN>                          show pending MCP request; reconcile before calling
  ack <NN> --receipt <file>             record {action, result: <MCP response>}
  freeze <NN>                          record the executor's commit as the candidate
  review <NN> [--prepare] [--again]     freeze if needed, prepare/start a reviewer
  send <NN> [--prepare] --text t | --file f | --merge-tip   message an idle executor
  integrate <NN> [--override reason]   merge and check; retain sessions/worktree
  cleanup <NN>                         resume cleanup after finish, retro and evidence
  retry <NN> --reason r [--file handoff] [--new-worktree]
                                       replace a lost executor; reuse its worktree by default
  hold <NN> --reason r | unhold <NN>   park a task (waiting on the user, etc.)
  cancel <NN> --reason r
  note [<NN>] --text t
  finish                               check delivery; retain sessions for retro
  evidence                             save CLI transcripts and agent/attempt index
  retro --file <report> | --skip --reason <why>   record findings or no-retro decision
  archive                              after finish and retro: snapshot, archive, clean up

env: WORKLOOP_ROOT (default ~/.workloop) · WORKLOOP_RUN · PASEO_CLI (default "paseo")
     PASEO_HOME (default ~/.paseo; its config.json holds the profiles)
     PASEO_AGENT_ID (required for MCP preparation and watch) · PASEO_TIMEOUT_MS (30000)
Use --prepare for agent-scoped MCP notifications; execute arguments and ack the receipt.
Bare dispatch/review/send retain legacy CLI behavior without a callback guarantee.`;

const OPTIONS = Object.fromEntries([
  ...["run", "repo", "feature", "base", "spec", "tickets", "max-executors", "max-reviewers", "profile", "provider", "model", "mode", "thinking",
    "review-profile", "review-provider", "review-model", "review-mode", "review-thinking", "note", "note-file", "text", "file", "override", "reason",
    "window", "interval", "receipt"].map((k) => [k, { type: "string" }]),
  ...["check", "setup", "heartbeat-id"].map((k) => [k, { type: "string", multiple: true }]),
  ...["json", "live", "keep", "again", "merge-tip", "dry-run", "help", "prepare", "clear-heartbeat-create", "direct", "new-worktree", "skip"].map((k) => [k, { type: "boolean" }]),
]);

export function main(argv) {
  const { values: opts, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [cmd, id] = positionals;
  if (!cmd || cmd === "help" || opts.help) return say(HELP);
  if (cmd === "init") return cmdInit(opts);
  if (cmd === "scratch") return cmdScratch(opts); // before resolveRunDir: a run need not exist, and --run is ignored
  const dir = resolveRunDir(opts.run);
  const needId = ["dispatch", "freeze", "review", "send", "integrate", "cleanup", "retry", "hold", "unhold", "cancel", "action", "ack"];
  if (needId.includes(cmd) && !id) fail(`${cmd} needs a ticket number`);
  if (cmd === "status") return printStatus(dir, loadState(dir), opts.live, opts.json);
  if (cmd === "patrol") return cmdPatrol(dir, loadState(dir), opts);
  if (cmd === "action") return cmdAction(loadState(dir), id);
  const handlers = {
    ack: (s) => cmdAck(dir, s, id, opts),
    watch: (s) => cmdWatch(dir, s, false, opts),
    config: (s) => cmdConfig(dir, s, opts),
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
    finish: (s) => cmdFinish(dir, s),
    evidence: (s) => cmdEvidence(dir, s),
    retro: (s) => cmdRetro(dir, s, opts),
    archive: (s) => cmdArchive(dir, s),
  };
  if (!handlers[cmd]) fail(`unknown command "${cmd}"; see \`help\``);
  return withLock(dir, () => {
    const s = loadState(dir);
    if (s.finishedAt && !["note", "watch", "retro", "archive", "evidence"].includes(cmd)) fail("this run is finished");
    if (s.archiveStartedAt && !["note", "watch", "retro", "archive", "cleanup", "evidence"].includes(cmd)) fail("archive is in progress; resume archive before starting other work");
    if (opts.prepare && (!process.env.PASEO_AGENT_ID || (s.orchestratorId && s.orchestratorId !== process.env.PASEO_AGENT_ID))) fail("MCP preparation needs PASEO_AGENT_ID matching the owning orchestrator");
    if (opts.prepare) s.orchestratorId = process.env.PASEO_AGENT_ID;
    const t = needId.includes(cmd) ? task(s, id) : null;
    const pending = t?.pendingAction;
    if (pending && !["ack", "note", "hold", "unhold"].includes(cmd)) {
      if (opts.prepare && pending.kind === cmd) {
        if (!s.heartbeat) cmdWatch(dir, s, true);
        return printAction(t);
      }
      fail(`#${id}: pending MCP action ${pending.action}; reconcile with action/ack first`);
    }
    return handlers[cmd](s);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (e) {
    if (!(e instanceof UserError) && !(e instanceof HeartbeatError) && e.code !== "ERR_PARSE_ARGS_UNKNOWN_OPTION") throw e;
    console.error(`workloop: ${e.message}`);
    process.exitCode = 1;
  }
}
