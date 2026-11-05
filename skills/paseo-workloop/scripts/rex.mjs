// Rex: where a run's executors and reviewers run. Each run has one Rex session;
// each turn of an agent is a tab in it, running agent-run.mjs, so a person can
// watch it and the run can wait for it. This file is the only one that talks to
// Rex, through five of its CLI commands: new/ls, window new, block call process,
// wait, and block close/kill.
//
// REX_CLI names the rex binary, or a .mjs file run with this node (the tests' fake).
// Unset, it is `rex` on PATH, else the CLI inside the macOS app.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const APP_CLI = "/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex";

export class RexError extends Error {}

function cli() {
  if (process.env.REX_CLI) return process.env.REX_CLI;
  const found = spawnSync("/bin/sh", ["-c", "command -v rex"], { encoding: "utf8" }).stdout?.trim();
  return found || (existsSync(APP_CLI) ? APP_CLI : "rex");
}
function command(args) {
  const bin = cli();
  return /\.[cm]?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

function rex(args, { allowFail = false } = {}) {
  const [bin, argv] = command(args);
  const r = spawnSync(bin, argv, { encoding: "utf8", timeout: 30000, maxBuffer: 16 << 20 });
  if (r.error) throw new RexError(`rex ${args.slice(0, 2).join(" ")}: ${r.error.message} (is Rex running? set REX_CLI if rex is elsewhere)`);
  const res = { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
  if (res.code !== 0 && !allowFail) throw new RexError(`rex ${args.slice(0, 2).join(" ")} failed (exit ${res.code}): ${res.err || res.out}`);
  return res;
}
function json(text, what) {
  try { return JSON.parse(text); } catch { throw new RexError(`rex ${what}: unexpected output: ${text.slice(0, 500)}`); }
}

export function sessionExists(id) {
  const data = json(rex(["ls", "--json"]).out || "{}", "ls");
  return (data.sessions || []).some((x) => x.session_id === id);
}

// Start the first turn in the initial tab, avoiding an unused default shell.
export function newSession(label, title, cwd, argv) {
  const data = json(rex(["new", label, "-c", cwd, "--window", title, "--keep-open", "--json", "--", ...argv]).out, "new");
  if (!data.session_id) throw new RexError(`rex new did not name the session: ${JSON.stringify(data)}`);
  const window = data.initial_windows?.[0];
  const block = window?.block_ids?.[0];
  if (!block) throw new RexError(`rex new did not name the tab's block: ${JSON.stringify(data)}`);
  return { session: data.session_id, block, window: window.window_id ?? null };
}

// A tab running argv in cwd. It stays open after the program exits, so its output
// can still be read, and it does not take focus from what the person is doing.
export function openTab(session, label, cwd, argv) {
  const data = json(rex(["window", "new", "-s", session, label, "-c", cwd, "--keep-open", "--focus=false", "--json", "--", ...argv]).out, "window new");
  const block = data.block_ids?.[0];
  if (!block) throw new RexError(`rex window new did not name the tab's block: ${JSON.stringify(data)}`);
  return { block, window: data.window_id ?? null };
}

// running, exited (with its exit code), or gone (the tab was closed).
export function processState(session, block) {
  const r = rex(["block", "call", "-s", session, "-b", block, "process"], { allowFail: true });
  if (r.code !== 0) {
    if (/not found|no such|closed/i.test(`${r.err} ${r.out}`)) return { state: "gone" };
    throw new RexError(`rex block call process failed (exit ${r.code}): ${r.err || r.out}`);
  }
  const p = json(r.out, "block call process");
  if (p.last_exit) return { state: "exited", exitCode: p.last_exit.exit_code ?? null, error: p.last_exit.error ?? null };
  return { state: p.child ? "running" : "exited", exitCode: null };
}

export function closeTab(session, block) {
  rex(["block", "close", "-s", session, block], { allowFail: true });
}

export function killSession(session) {
  rex(["kill", session], { allowFail: true });
}

// Resolves with {block, payload} for the first of the tabs whose program ends, or
// null when `ms` passes first. `rex wait` returns at once for a program that has
// already ended, so a tab that ended before the call is reported, not missed.
export function waitAny(session, blocks, ms) {
  return new Promise((resolveWait) => {
    const children = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
      resolveWait(value);
    };
    const timer = setTimeout(() => finish(null), ms);
    for (const block of blocks) {
      const [bin, argv] = command(["wait", "-s", session, block, "--json"]);
      const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.on("error", (e) => finish({ block, payload: { error: e.message } }));
      child.on("close", () => {
        let payload = {};
        try { payload = JSON.parse(out.trim().split("\n")[0] || "{}"); } catch { payload = { error: out.trim() }; }
        finish({ block, payload });
      });
      children.push(child);
    }
  });
}
