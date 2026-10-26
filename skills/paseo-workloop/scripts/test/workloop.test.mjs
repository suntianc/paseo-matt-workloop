// End-to-end tests for workloop.mjs against real git and a fake paseo CLI.
// Run: node --test paseo-workloop/scripts/test/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { header, inScope, parseTicket, ticketScope, winQuote } from "../workloop.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "workloop.mjs");
const FAKE = join(HERE, "fake-paseo.mjs");
const CHECK = `node -e "process.exit(require('fs').existsSync('BROKEN') ? 1 : 0)"`;

const TICKETS = {
  "01-schema.md": "# 01: Schema\n\n**What to build:** the table.\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n\n- [ ] works\n",
  "02-api.md": "# 02: API\n\n**What to build:** endpoints.\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n",
  "03-ui.md": "# 03: UI over OAuth2\n\n## What to build\n\nScreens.\n\n## Blocked by\n\n- 01 (schema)\n- [02: API](./02-api.md)\n",
};

const PROFILES = [
  { id: "p1", name: "wl-executor", provider: "fake", model: "exec-model", modeId: "full", notes: "workloop executors" },
  { id: "p2", name: "wl-reviewer", provider: "fake", model: "review-model", modeId: "full", thinkingOptionId: "high", notes: "workloop reviewers" },
];
const flag = (args, name) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
const slash = (p) => p.replace(/\\/g, "/"); // paths reach agents with forward slashes (pathArg); join() gives backslashes on Windows

function sandbox({ tickets = TICKETS, init = [], profiles = PROFILES } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workloop-test-")));
  const repo = join(root, "repo");
  writeFileSync(join(root, "gitconfig"), "");
  const env = {
    ...process.env, WORKLOOP_ROOT: join(root, "wl"), PASEO_CLI: FAKE, FAKE_PASEO_DB: join(root, "paseo.json"), PASEO_AGENT_ID: "orchestrator",
    FAKE_PASEO_HOME: join(root, "paseo"), PASEO_HOME: join(root, "paseo-home"), GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  delete env.WORKLOOP_RUN;
  delete env.PASEO_HOST;
  const setProfiles = (list) => {
    mkdirSync(env.PASEO_HOME, { recursive: true });
    writeFileSync(join(env.PASEO_HOME, "config.json"), JSON.stringify({ version: 1, daemon: { agentProfiles: list } }));
  };
  setProfiles(profiles);
  const g = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  // The run's documents live in its run directory, not in the repo.
  const runDir = join(root, "wl", "repo", "feat");
  mkdirSync(join(runDir, "issues"), { recursive: true });
  g(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "shared.txt"), "base\n");
  g(repo, "add", "shared.txt");
  g(repo, "commit", "-q", "-m", "base");
  writeFileSync(join(runDir, "spec.md"), "# Spec\n");
  for (const [f, c] of Object.entries(tickets)) writeFileSync(join(runDir, "issues", f), c);

  const nodeArgs = [];
  const wl = (...args) => {
    const r = spawnSync(process.execPath, [...nodeArgs, CLI, "--run", "repo/feat", ...args], { env, cwd: repo, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const ok = (...args) => { const r = wl(...args); assert.equal(r.code, 0, r.out); return r.out; };
  const no = (pattern, ...args) => { const r = wl(...args); assert.notEqual(r.code, 0, r.out); assert.match(r.out, pattern); return r.out; };
  const db = () => (existsSync(env.FAKE_PASEO_DB) ? JSON.parse(readFileSync(env.FAKE_PASEO_DB, "utf8")) : { n: 0, agents: [], workspaces: [], calls: [] });
  const editDb = (fn) => { const d = db(); fn(d); writeFileSync(env.FAKE_PASEO_DB, JSON.stringify(d)); };
  const agent = (id) => db().agents.find((a) => a.id === id);
  const setAgent = (id, status) => editDb((d) => { d.agents.find((a) => a.id === id).status = status; });
  const state = () => JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  const sb = { root, repo, env, nodeArgs, runDir, g, wl, ok, no, db, editDb, agent, setAgent, state, setProfiles };

  // Executor finishes a round: edits files, commits, writes its report, goes idle.
  sb.work = (id, { files = { [`f${id}.txt`]: `ticket ${id}\n` }, status = "done", commit = true } = {}) => {
    const t = state().tasks[id];
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(dirname(join(t.worktree, f)), { recursive: true });
      writeFileSync(join(t.worktree, f), c);
    }
    if (commit) { g(t.worktree, "add", "-A"); g(t.worktree, "commit", "-q", "-m", `work ${id}`); }
    writeFileSync(join(runDir, "reports", `${id}-${t.attempt}.md`), `Status: ${status}\nCommit: ${g(t.worktree, "rev-parse", "HEAD")}\n\n## Summary\nDid it.\n`);
    setAgent(t.agentId, "idle");
  };
  sb.reviewed = (id, verdict = "pass") => {
    const t = state().tasks[id];
    writeFileSync(t.review.path, `**Verdict:** ${verdict}\nCandidate: ${t.candidateSha}\n`);
    setAgent(t.review.agentId, "idle");
  };
  sb.complete = (id, workOpts) => { ok("dispatch", id); sb.work(id, workOpts); ok("review", id); sb.reviewed(id); return ok("integrate", id); };

  if (init) ok("init", "--feature", "feat", "--repo", repo, "--check", CHECK, ...init);
  return sb;
}

// Inject failures at the actual CLI spawn boundary, without changing real Git
// or allowing the fault to leak into the fake Paseo subprocess.
function failGitSpawns(sb, { failures = 2, code = "EBUSY", status = null, pid = 0 } = {}) {
  const preload = join(sb.root, "git-spawn-fault.cjs");
  const log = join(sb.root, "git-spawns.jsonl");
  writeFileSync(preload, `
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const original = cp.spawnSync;
    let calls = 0;
    cp.spawnSync = (command, args, options) => {
      if (command !== 'git') return original(command, args, options);
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
      if (++calls > ${failures}) return original(command, args, options);
      const error = ${status === null ? `Object.assign(new Error('spawnSync git ${code}'), { code: ${JSON.stringify(code)} })` : "undefined"};
      return { error, pid: ${pid}, status: ${JSON.stringify(status)}, stdout: '', stderr: 'injected Git failure' };
    };
    require('node:module').syncBuiltinESMExports();
  `);
  sb.nodeArgs.push("--require", preload);
  return () => readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
}

test("init retries EBUSY only when Git could not start", () => {
  const sb = sandbox({ init: null });
  const calls = failGitSpawns(sb);
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  assert.deepEqual(calls().slice(0, 3), Array(3).fill(["-C", sb.repo, "rev-parse", "--show-toplevel"]));
  assert.equal(sb.g(sb.state().integration.worktree, "rev-parse", "HEAD"), sb.state().integration.tip);
});

test("init stops after four EBUSY spawn attempts without creating run state", () => {
  const sb = sandbox({ init: null });
  const calls = failGitSpawns(sb, { failures: 100 });
  sb.no(/spawnSync git EBUSY/, "init", "--feature", "feat", "--repo", sb.repo);
  assert.equal(calls().length, 4);
  assert.equal(existsSync(join(sb.runDir, "state.json")), false);
});

test("init never retries other spawn errors or a Git process that already started", () => {
  for (const fault of [{ code: "ENOENT" }, { code: "EACCES" }, { code: "EBUSY", pid: 123 }, { status: 1, pid: 123 }]) {
    const sb = sandbox({ init: null });
    const calls = failGitSpawns(sb, fault);
    sb.no(/spawnSync git|injected Git failure/, "init", "--feature", "feat", "--repo", sb.repo);
    assert.equal(calls().length, 1, JSON.stringify(fault));
    assert.equal(existsSync(join(sb.runDir, "state.json")), false);
  }
});

test("parseTicket reads the to-tickets local formats", () => {
  assert.deepEqual(parseTicket("/x/01-a.md", TICKETS["01-schema.md"]), { id: "01", title: "Schema", file: "/x/01-a.md", refs: [] });
  assert.deepEqual(parseTicket("/x/02-b.md", TICKETS["02-api.md"]).refs, [1]);
  const ui = parseTicket("/x/03-ui.md", TICKETS["03-ui.md"]);
  assert.equal(ui.title, "UI over OAuth2");
  assert.deepEqual(ui.refs, [1, 2]);
  assert.deepEqual(parseTicket("/x/04-c.md", "# Title\n\nBlocked by: 02, #3, v1.2\n").refs, [2, 3]);
  assert.equal(parseTicket("/x/notes.md", "# x"), null);
  assert.deepEqual(parseTicket("/x/05-e.md", "# E\n\n## Blocked by\n\n- None\n").refs, []);
  assert.throws(() => parseTicket("/x/06-f.md", "# F\n\n**Blocked by:** the schema ticket\n"), /names no ticket numbers/);
});

// Simulate the external MCP call; the workloop itself must not start a CLI worker.
function deliver(sb, action, result) {
  if (action.tool === "create_agent" && !result) {
    const id = `mcp-${sb.db().n + 1}`;
    sb.editDb((d) => { d.n++; d.agents.push({ id, title: action.arguments.title, cwd: sb.state().tasks["01"].worktree,
      labels: action.arguments.labels, parentAgentId: sb.env.PASEO_AGENT_ID, status: "running", archived: false, updatedAt: new Date().toISOString() }); });
    result = { agentId: id, status: "running" };
  }
  const receipt = join(sb.root, "receipt.json");
  writeFileSync(receipt, JSON.stringify({ action: action.action, result: result || { success: true, disposition: "turn_started", status: "running" } }));
  return sb.ok("ack", "01", "--receipt", receipt);
}

test("MCP dispatch/review/rework keeps guards and registers asynchronous receipts", () => {
  const sb = sandbox();
  let action = JSON.parse(sb.ok("dispatch", "01", "--prepare"));
  assert.equal(action.tool, "create_agent");
  assert.equal(action.arguments.notifyOnFinish, true);
  assert.equal(action.arguments.provider, "fake/exec-model");
  assert.equal(action.arguments.settings.modeId, "full");
  assert.ok(action.arguments.workspaceId);
  assert.ok(sb.db().calls.some((c) => c[0] === "workspace" && c[1] === "create"));
  assert.equal(sb.db().agents.length, 0);
  assert.equal(sb.db().heartbeats.length, 1);
  assert.deepEqual(JSON.parse(sb.ok("action", "01")), action);
  deliver(sb, action);
  assert.ok(sb.state().tasks["01"].agentId);
  sb.no(/running with agent/, "dispatch", "01", "--prepare");
  sb.work("01");
  action = JSON.parse(sb.ok("review", "01", "--prepare"));
  assert.equal(action.arguments.settings.thinkingOptionId, "high");
  deliver(sb, action);
  sb.reviewed("01", "changes_requested");
  action = JSON.parse(sb.ok("send", "01", "--prepare", "--text", "Fix finding S1"));
  assert.equal(action.tool, "send_agent_prompt");
  assert.equal(action.arguments.notifyOnFinish, true);
  assert.equal(sb.state().tasks["01"].status, "in_review");
  deliver(sb, action);
  assert.equal(sb.state().tasks["01"].status, "running");
  assert.equal(sb.state().tasks["01"].rounds, 1);
  sb.ok("ack", "01", "--receipt", join(sb.root, "receipt.json"));
  assert.equal(sb.state().tasks["01"].rounds, 1);
  assert.equal(sb.db().calls.filter((c) => c[0] === "agent" && ["run", "send"].includes(c[1])).length, 0);
  sb.work("01", { files: { "f01.txt": "reworked after S1\n" } });
  action = JSON.parse(sb.ok("review", "01", "--prepare"));
  deliver(sb, action);
  sb.reviewed("01");
  sb.ok("integrate", "01");
  assert.equal(sb.state().tasks["01"].status, "done");
});

test("pending MCP action survives interruption and rejects unrelated receipts", () => {
  const sb = sandbox();
  const action = JSON.parse(sb.ok("dispatch", "01", "--prepare"));
  assert.deepEqual(JSON.parse(sb.ok("dispatch", "01", "--prepare")), action);
  sb.no(/pending MCP action/, "retry", "01", "--reason", "do not duplicate");
  const receipt = join(sb.root, "bad.json");
  writeFileSync(receipt, JSON.stringify({ action: "wrong", result: { agentId: "other" } }));
  sb.no(/action.*match/, "ack", "01", "--receipt", receipt);
  assert.equal(sb.state().tasks["01"].pendingAction.action, action.action);
  deliver(sb, action, { isError: true, content: [{ type: "text", text: "provider rejected request" }] });
  assert.equal(sb.state().tasks["01"].pendingAction, null);
  assert.equal(sb.db().agents.length, 0);
  assert.match(sb.ok("watch"), /no executor recorded/);
  assert.equal(sb.db().heartbeats.length, 1);
});

test("watch checks fresh activity, maintains one heartbeat, and stops when workers stop", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  assert.match(sb.ok("watch"), /保温心跳/);
  assert.equal(sb.db().heartbeats.length, 1);
  sb.ok("watch");
  assert.equal(sb.db().heartbeats.length, 1);
  sb.editDb((d) => { d.agents[0].updatedAt = new Date(Date.now() - 46 * 60000).toISOString(); });
  assert.match(sb.ok("watch"), /异常.*46m/);
  sb.editDb((d) => { d.agents[0].updatedAt = new Date().toISOString(); d.agents[0].pending = [{ id: "permission" }]; });
  assert.match(sb.ok("watch"), /permission/);
  sb.editDb((d) => { d.agents[0].pending = []; });
  sb.work("01");
  assert.match(sb.ok("watch"), /待处理/);
  assert.equal(sb.db().heartbeats.length, 0);
});

test("watch removes hidden heartbeat IDs on renewal and shutdown", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.ok("watch");
  const first = sb.state().heartbeat.id;
  sb.ok("watch");
  assert.equal(sb.db().heartbeats.length, 1, "schedule ls hides heartbeats: renewal must still delete the previous ID");
  assert.notEqual(sb.state().heartbeat.id, first);
  assert.ok(sb.db().calls.some((c) => c[0] === "heartbeat" && c[1] === "delete" && c[2] === first));
  sb.work("01");
  sb.ok("watch");
  assert.deepEqual(sb.db().heartbeats, [], "all known heartbeat IDs must be deleted before claiming removal");
});

test("watch retains both IDs on delete failure and does not accumulate more heartbeats", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.ok("watch");
  const old = sb.state().heartbeat.id;
  sb.editDb((d) => { d.failOnce = "heartbeat delete"; });
  sb.no(/injected failure/, "watch");
  assert.equal(sb.db().heartbeats.length, 2);
  assert.ok(sb.state().heartbeatLedger.ids.some((h) => h.id === old));
  sb.editDb((d) => { d.failOnce = "heartbeat delete"; });
  sb.no(/injected failure/, "watch");
  assert.equal(sb.db().heartbeats.length, 2, "a failed cleanup must block another creation");
  sb.work("01");
  sb.ok("watch");
  assert.deepEqual(sb.db().heartbeats, []);
  assert.deepEqual(sb.state().heartbeatLedger.ids, []);
});

test("watch recovers a created heartbeat after a lost receipt without creating another", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.editDb((d) => { d.loseCreateReplyOnce = true; });
  sb.no(/lost the receipt/, "watch");
  assert.ok(sb.state().heartbeatLedger.pendingCreate);
  assert.equal(sb.db().heartbeats.length, 1);
  const id = sb.db().heartbeats[0].id;
  sb.ok("watch");
  assert.equal(sb.state().heartbeat.id, id);
  assert.equal(sb.state().heartbeatLedger.pendingCreate, null);
  assert.equal(sb.db().calls.filter((c) => c[0] === "heartbeat" && c[1] === "create").length, 1);
  sb.work("01");
  sb.ok("watch");
  assert.deepEqual(sb.db().heartbeats, []);
});

test("watch keeps ambiguous remote creation pending until an explicit receipt ID is supplied", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.env.PASEO_HOST = "remote-host:6767";
  sb.editDb((d) => { d.loseCreateReplyOnce = true; });
  sb.no(/lost the receipt/, "watch");
  const id = sb.db().heartbeats[0].id;
  sb.no(/pending heartbeat creation/, "watch");
  assert.equal(sb.db().heartbeats.length, 1);
  assert.equal(sb.db().calls.filter((c) => c[0] === "heartbeat" && c[1] === "create").length, 1);
  sb.work("01");
  sb.ok("watch", "--heartbeat-id", id);
  assert.deepEqual(sb.db().heartbeats, []);
});

test("watch confirms already deleted IDs after a lost delete receipt", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.ok("watch");
  sb.work("01");
  sb.editDb((d) => { d.loseDeleteReplyOnce = true; });
  sb.no(/lost the receipt/, "watch");
  assert.equal(sb.state().heartbeatLedger.ids.length, 1);
  assert.equal(sb.db().heartbeats.length, 0);
  sb.ok("watch");
  assert.deepEqual(sb.state().heartbeatLedger.ids, []);
  assert.ok(readFileSync(join(sb.runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line)).some((e) => e.kind === "heartbeat-deleted" && e.confirmedAbsent === true));
});

test("watch migrates earlier heartbeat IDs from its audit log even on a remote host", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  const state = sb.state();
  state.orchestratorId = sb.env.PASEO_AGENT_ID;
  state.heartbeat = { id: "legacy_2", owner: sb.env.PASEO_AGENT_ID };
  writeFileSync(join(sb.runDir, "state.json"), JSON.stringify(state));
  const events = join(sb.runDir, "events.jsonl");
  writeFileSync(events, readFileSync(events, "utf8") + ["legacy_1", "legacy_2"].map((id) => JSON.stringify({ kind: "watch", heartbeat: { id, owner: sb.env.PASEO_AGENT_ID } }) + "\n").join(""));
  sb.editDb((d) => { d.heartbeats = ["legacy_1", "legacy_2"].map((id) => ({ id, target: { type: "agent", agentId: sb.env.PASEO_AGENT_ID } })); });
  sb.env.PASEO_HOST = "remote-host:6767";
  sb.work("01");
  sb.ok("watch");
  assert.deepEqual(sb.db().heartbeats, []);
  assert.deepEqual(sb.state().heartbeatLedger.ids, []);
});

test("watch discovers legacy local heartbeats without a saved receipt and preserves unrelated records", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  const records = [
    { id: "old_orphan", name: `workloop:repo-feat:${sb.env.PASEO_AGENT_ID}`, target: { type: "agent", agentId: sb.env.PASEO_AGENT_ID } },
    { id: "unrelated", name: "keepwarm", target: { type: "agent", agentId: sb.env.PASEO_AGENT_ID } },
  ];
  const store = join(sb.env.PASEO_HOME, "schedules");
  mkdirSync(store, { recursive: true });
  for (const h of records) writeFileSync(join(store, `${h.id}.json`), JSON.stringify(h));
  sb.editDb((d) => { d.heartbeats = records; });
  sb.work("01");
  sb.ok("watch");
  assert.deepEqual(sb.db().heartbeats.map((h) => h.id), ["unrelated"]);
});

test("Stop hook cleans ledger-only heartbeat records after the run finished", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.ok("watch");
  sb.work("01");
  const state = sb.state();
  state.heartbeat = null;
  state.finishedAt = new Date().toISOString();
  writeFileSync(join(sb.runDir, "state.json"), JSON.stringify(state));
  const r = spawnSync(process.execPath, [join(HERE, "..", "stop-hook.mjs")], { env: sb.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sb.db().heartbeats, []);
  assert.deepEqual(sb.state().heartbeatLedger.ids, []);
});

test("patrol deadline bounds a blocked inspect without changing task state", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  const before = sb.state();
  sb.env.FAKE_PASEO_DELAY_COMMAND = "agent inspect";
  sb.env.FAKE_PASEO_DELAY_MS = "3000";
  const started = Date.now();
  sb.no(/timed out/, "patrol", "--window", "0.2", "--interval", "0.05");
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(sb.state(), before);
});

test("MCP acknowledgements reject wrong workers and preserve selected profile features", () => {
  const sb = sandbox({ profiles: PROFILES.map((p) => ({ ...p, featureValues: { fast_mode: true } })) });
  const action = JSON.parse(sb.ok("dispatch", "01", "--prepare"));
  assert.deepEqual(action.arguments.settings.features, { fast_mode: true });
  const receipt = join(sb.root, "receipt.json");
  writeFileSync(receipt, JSON.stringify({ action: action.action, result: { agentId: "unrelated" } }));
  sb.no(/does not match/, "ack", "01", "--receipt", receipt);
  assert.equal(sb.state().tasks["01"].agentId, undefined);
  assert.equal(sb.state().tasks["01"].pendingAction.action, action.action);
});

test("watch and Stop hook preserve unrelated heartbeats and other orchestrators", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.editDb((d) => { d.heartbeats = [{ id: "unrelated", name: "keepwarm", status: "active", target: { agentId: "orchestrator" } }]; });
  sb.ok("watch");
  const hook = join(HERE, "..", "stop-hook.mjs");
  let r = spawnSync(process.execPath, [hook], { env: sb.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(sb.db().heartbeats.some((h) => h.id === "unrelated"));
  assert.equal(sb.db().heartbeats.length, 2);
  const before = sb.db();
  r = spawnSync(process.execPath, [hook], { env: { ...sb.env, PASEO_AGENT_ID: "other" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sb.db(), before);
  sb.setAgent(sb.state().tasks["01"].agentId, "idle");
  r = spawnSync(process.execPath, [hook], { env: sb.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sb.db().heartbeats.map((h) => h.id), ["unrelated"]);
});

test("the repair-ticket template is refused until its blockers are filled in, then parses", () => {
  const text = readFileSync(join(HERE, "..", "..", "templates", "repair-ticket.md"), "utf8");
  assert.throws(() => parseTicket("/x/04-fix-a.md", text), /names no ticket numbers/);
  const filled = text.replace(/^# NN: Fix <.*>$/m, "# 04: Fix totals").replace(/^Blocked by: .*$/m, "Blocked by: 01, 03");
  assert.deepEqual(parseTicket("/x/04-fix-a.md", filled), { id: "04", title: "Fix totals", file: "/x/04-fix-a.md", refs: [1, 3] });
});

test("ticketScope reads the Scope line; inScope matches globs, directories and plain paths", () => {
  assert.equal(ticketScope("/x/01-a.md", "# A\n\nBlocked by: None\n"), null);
  assert.equal(ticketScope("/x/01-a.md", "Scope of the work: big\n"), null);
  assert.deepEqual(ticketScope("/x/01-a.md", "**Scope:** `src/a/`, ./test/*.ts , README.md\n"), ["src/a/**", "test/*.ts", "README.md"]);
  assert.deepEqual(ticketScope("/x/01-a.md", "- **Scope**: lib\n"), ["lib"]);
  assert.throws(() => ticketScope("/x/01-a.md", "Scope:\n"), /lists no paths/);
  assert.throws(() => ticketScope("/x/01-a.md", "Scope: <paths>\n"), /template placeholder/);
  const scope = ["src/a/**", "test/*.ts", "lib", "**/*.md", "src/?.js"];
  for (const p of ["src/a/x.js", "src/a/b/c.js", "test/x.ts", "lib", "lib/y/z.js", "README.md", "docs/x/y.md", "src/b.js"]) assert.ok(inScope(p, scope), p);
  for (const p of ["src/b/x.js", "test/sub/x.ts", "library.js", "src/ab.js", "x.mdx"]) assert.ok(!inScope(p, scope), p);
});

test("the direct-ticket template is refused until its Scope is filled in, then parses", () => {
  const text = readFileSync(join(HERE, "..", "..", "templates", "direct-ticket.md"), "utf8");
  assert.throws(() => ticketScope("/x/01-a.md", text), /template placeholder/);
  const filled = text.replace(/^\*\*Scope:\*\* .*$/m, "**Scope:** src/parser/, test/parser.test.ts");
  assert.deepEqual(ticketScope("/x/01-a.md", filled), ["src/parser/**", "test/parser.test.ts"]);
  assert.deepEqual(parseTicket("/x/01-a.md", filled).refs, []);
});

test("header tolerates markdown emphasis; winQuote is safe for cmd.exe", () => {
  assert.equal(header("**Verdict:** changes-requested\n", "Verdict"), "changes_requested");
  assert.equal(header("x\nStatus: done\n", "Status"), "done");
  assert.equal(winQuote("--json"), "--json");
  assert.equal(winQuote("task=01"), '"task=01"');
  assert.equal(winQuote("C:/Program Files/paseo.cmd"), '"C:/Program Files/paseo.cmd"');
  assert.throws(() => winQuote('say "hi"'));
  assert.throws(() => winQuote("100%"));
});

test("scratch creates the run directory's issues folder and prints its three lines", () => {
  const sb = sandbox({ init: null });
  // A slug the sandbox never touched, so neither the run directory nor issues/ exists yet.
  const runDir = join(sb.root, "wl", "repo", "fresh");
  assert.equal(existsSync(runDir), false);
  const out = sb.ok("scratch", "--feature", "fresh", "--repo", sb.repo);
  assert.equal(out, `run dir: ${runDir}\nspec: ${join(runDir, "spec.md")}\ntickets: ${join(runDir, "issues")}\n`);
  assert.equal(existsSync(join(runDir, "issues")), true);
  assert.equal(statSync(join(runDir, "issues")).isDirectory(), true);
});

test("scratch works for a feature whose run already exists and leaves its state alone", () => {
  const sb = sandbox();
  const state = readFileSync(join(sb.runDir, "state.json"), "utf8");
  const events = readFileSync(join(sb.runDir, "events.jsonl"), "utf8");
  const entries = readdirSync(sb.runDir).sort(); // whatever init laid out, scratch must not add to it
  const out = sb.ok("scratch", "--feature", "feat", "--repo", sb.repo);
  assert.equal(out, `run dir: ${sb.runDir}\nspec: ${join(sb.runDir, "spec.md")}\ntickets: ${join(sb.runDir, "issues")}\n`);
  assert.equal(readFileSync(join(sb.runDir, "state.json"), "utf8"), state);
  assert.equal(readFileSync(join(sb.runDir, "events.jsonl"), "utf8"), events);
  assert.deepEqual(readdirSync(sb.runDir).sort(), entries);
});

test("init reads the run directory's spec and tickets by default", () => {
  const sb = sandbox({ init: null });
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  const s = sb.state();
  assert.equal(s.spec, join(sb.runDir, "spec.md"));
  assert.equal(s.tickets, join(sb.runDir, "issues"));
  assert.equal(s.tasks["01"].file, join(sb.runDir, "issues", "01-schema.md"));
  assert.equal(sb.g(sb.repo, "status", "--porcelain"), ""); // nothing written into the repo
  assert.equal(existsSync(join(sb.repo, ".scratch")), false);
});

test("init honours explicit --spec and --tickets outside the run directory", () => {
  const sb = sandbox({ init: null });
  const elsewhere = join(sb.root, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, "spec.md"), "# Spec elsewhere\n");
  for (const [f, c] of Object.entries(TICKETS)) writeFileSync(join(elsewhere, f), c);
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK, "--spec", join(elsewhere, "spec.md"), "--tickets", elsewhere);
  const s = sb.state();
  assert.equal(s.spec, join(elsewhere, "spec.md"));
  assert.equal(s.tickets, elsewhere);
  assert.equal(s.tasks["03"].file, join(elsewhere, "03-ui.md"));
});

test("init creates the integration worktree on the base and imports the ticket graph", () => {
  const sb = sandbox({ init: null });
  const out = sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  const s = sb.state();
  assert.equal(s.integration.branch, "workloop/feat");
  assert.equal(sb.g(s.integration.worktree, "rev-parse", "HEAD"), sb.g(sb.repo, "rev-parse", "main"));
  assert.deepEqual(Object.values(s.tasks).map((t) => [t.id, t.status, t.blockedBy]), [["01", "ready", []], ["02", "ready", ["01"]], ["03", "ready", ["01", "02"]]]);
  assert.match(out, /next: dispatch 01/);
  sb.no(/already exists/, "init", "--feature", "feat", "--repo", sb.repo);
});

test("init refuses a blocking cycle or failing base checks and keeps nothing", () => {
  const cyc = sandbox({ init: null, tickets: { "01-a.md": "# 01: A\n\nBlocked by: 02\n", "02-b.md": "# 02: B\n\nBlocked by: 01\n" } });
  assert.match(cyc.wl("init", "--feature", "feat", "--repo", cyc.repo).out, /blocking cycle: 01 -> 02 -> 01/);
  const bad = sandbox({ init: null });
  writeFileSync(join(bad.repo, "BROKEN"), "");
  bad.g(bad.repo, "add", "BROKEN");
  bad.g(bad.repo, "commit", "-q", "-m", "broken");
  assert.match(bad.wl("init", "--feature", "feat", "--repo", bad.repo, "--check", CHECK).out, /checks fail on the base/);
  for (const [sb, ticketCount] of [[cyc, 2], [bad, 3]]) {
    assert.equal(spawnSync("git", ["-C", sb.repo, "show-ref", "--verify", "--quiet", "refs/heads/workloop/feat"]).status, 1);
    assert.equal(existsSync(join(sb.runDir, "state.json")), false);
    // A failed init leaves the run's documents alone: they are the user's work, not its own.
    assert.equal(readFileSync(join(sb.runDir, "spec.md"), "utf8"), "# Spec\n");
    assert.equal(readdirSync(join(sb.runDir, "issues")).length, ticketCount);
  }
});

test("dispatch branches off the integration branch, verifies HEAD, writes the brief, labels the agent", () => {
  const sb = sandbox();
  sb.no(/blocked by #01 \(ready\)/, "dispatch", "02");
  sb.ok("dispatch", "01");
  const t = sb.state().tasks["01"];
  const create = sb.db().calls.find((c) => c[0] === "worktree");
  assert.deepEqual(create.slice(create.indexOf("--base"), create.indexOf("--base") + 2), ["--base", "workloop/feat"]);
  assert.equal(t.status, "running");
  assert.equal(t.branch, "wl-feat-01-a1");
  assert.equal(sb.g(t.worktree, "rev-parse", "HEAD"), sb.state().integration.tip);
  const a = sb.agent(t.agentId);
  assert.deepEqual(a.labels, { workloop: "repo-feat", task: "01", attempt: "a1", role: "executor" });
  assert.equal(a.cwd, t.worktree);
  assert.doesNotMatch(a.prompts[0], /\n/);
  const brief = readFileSync(join(sb.runDir, "briefs", "01-a1.md"), "utf8");
  assert.ok(a.prompts[0].includes(slash(join(sb.runDir, "briefs", "01-a1.md"))));
  assert.doesNotMatch(brief, /\{\{/);
  // The ticket path comes from git's --show-toplevel plus the run directory, which on Windows expands a short %TEMP% name (ADMINI~1) that sb.repo keeps.
  assert.match(slash(t.file), /\/wl\/repo\/feat\/issues\/01-schema\.md$/);
  assert.ok(brief.includes(t.worktree) && brief.includes(slash(join(sb.runDir, "reports", "01-a1.md"))) && brief.includes(slash(t.file)));
  sb.no(/running with agent/, "dispatch", "01");
});

test("launch settings come from the wl-<role> profiles; the run and flags override single fields", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n", "02-b.md": "# 02: B\n\nBlocked by: None\n" } });
  let out = sb.ok("status");
  assert.match(out, /executor fake model=exec-model mode=full ← profile "wl-executor"/);
  assert.match(out, /reviewer fake model=review-model mode=full thinking=high ← profile "wl-reviewer"/);

  sb.ok("dispatch", "01");
  let t = sb.state().tasks["01"];
  let args = sb.agent(t.agentId).args;
  assert.deepEqual(["provider", "model", "mode", "thinking"].map((k) => flag(args, k)), ["fake", "exec-model", "full", undefined]);
  assert.match(t.launch, /profile "wl-executor"/);
  assert.match(readFileSync(join(sb.runDir, "events.jsonl"), "utf8"), /"kind":"dispatch".*"launch":"fake model=exec-model/);

  // A flag on one command overrides that field and keeps the rest of the profile.
  sb.ok("dispatch", "02", "--model", "other");
  args = sb.agent(sb.state().tasks["02"].agentId).args;
  assert.deepEqual([flag(args, "model"), flag(args, "mode")], ["other", "full"]);
  assert.match(sb.state().tasks["02"].launch, /profile "wl-executor" \+ model from the run/);

  // The run can name any existing profile (case-insensitive); features it can't pass are reported.
  sb.setProfiles([...PROFILES, { id: "p3", name: "Deep Review", provider: "fake", model: "deep", modeId: "full", featureValues: { fast_mode: true } }]);
  sb.ok("config", "--review-profile", "deep review");
  sb.work("01");
  out = sb.ok("review", "01");
  assert.match(out, /warning: reviewer: profile "Deep Review" sets fast_mode, which the paseo CLI cannot pass.*Tell the user/);
  t = sb.state().tasks["01"];
  assert.equal(flag(sb.agent(t.review.agentId).args, "model"), "deep");
  assert.match(t.review.launch, /profile "Deep Review"/);
});

test("without usable launch settings nothing is created, and the message says to tell the user", () => {
  const sb = sandbox({ init: null, profiles: [] });
  let out = sb.no(/executor: no launch settings: no Paseo profile "wl-executor".*\n {2}\(no profiles in .*config\.json\)\n.*Tell the user/, "init", "--feature", "feat", "--repo", sb.repo);
  assert.doesNotMatch(out, /reviewer/); // stops at the first role
  assert.equal(spawnSync("git", ["-C", sb.repo, "show-ref", "--verify", "--quiet", "refs/heads/workloop/feat"]).status, 1);
  assert.equal(existsSync(join(sb.runDir, "state.json")), false);

  sb.setProfiles(PROFILES);
  out = sb.no(/reviewer: the run names Paseo profile "nope", which does not exist\. Profiles:\n {2}- "wl-executor" \(fake\/exec-model\): workloop executors/, "init", "--feature", "feat", "--repo", sb.repo, "--review-profile", "nope");
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);

  // A provider Paseo can't run stops the dispatch before the worktree is made.
  sb.setProfiles([{ ...PROFILES[0], provider: "down" }, PROFILES[1]]);
  sb.no(/executor: provider "down" \(profile "wl-executor"\) is unavailable in Paseo\. Tell the user/, "dispatch", "01");
  assert.equal(sb.state().tasks["01"].status, "ready");
  assert.equal(sb.db().calls.filter((c) => c[0] === "worktree").length, 0);

  // A profile deleted mid-run shows in status and stops the launch before the candidate is frozen.
  sb.setProfiles([PROFILES[0]]);
  assert.match(sb.ok("status"), /reviewer UNRESOLVED: no launch settings: .*--review-provider\. \(`config` lists the profiles; tell the user\)/);
  assert.match(sb.ok("config"), /reviewer UNRESOLVED: no launch settings: .*\n {2}- "wl-executor" .*\nCreate "wl-reviewer" in Paseo/);
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.no(/reviewer: no launch settings/, "review", "01");
  assert.equal(sb.state().tasks["01"].status, "running");
});

test("init refuses a role with no model before the branch exists, naming the role and its flag", () => {
  const noModel = sandbox({ init: null, profiles: [{ ...PROFILES[0], model: undefined }, PROFILES[1]] });
  let out = noModel.no(/executor: .*no model.*--model/s, "init", "--feature", "feat", "--repo", noModel.repo);
  assert.match(out, /profile "wl-executor"/); // says where the settings came from
  assert.match(out, /Tell the user; don't choose for them/);
  assert.equal(spawnSync("git", ["-C", noModel.repo, "show-ref", "--verify", "--quiet", "refs/heads/workloop/feat"]).status, 1);
  assert.equal(existsSync(join(noModel.runDir, "state.json")), false);

  // The reviewer's flag is --review-model: the message must name the one that fixes it.
  const noReviewModel = sandbox({ init: null, profiles: [PROFILES[0], { ...PROFILES[1], model: undefined }] });
  out = noReviewModel.no(/reviewer: .*no model.*--review-model/s, "init", "--feature", "feat", "--repo", noReviewModel.repo);
  assert.doesNotMatch(out, /executor: .*no model/); // the executor resolved, so it is not complained about
  assert.equal(existsSync(join(noReviewModel.runDir, "state.json")), false);
});

test("init refuses a role with no mode before the branch exists, naming the role and its flag", () => {
  const noMode = sandbox({ init: null, profiles: [{ ...PROFILES[0], modeId: undefined }, PROFILES[1]] });
  let out = noMode.no(/executor: .*no mode.*--mode/s, "init", "--feature", "feat", "--repo", noMode.repo);
  assert.match(out, /Tell the user; don't choose for them/);
  assert.equal(spawnSync("git", ["-C", noMode.repo, "show-ref", "--verify", "--quiet", "refs/heads/workloop/feat"]).status, 1);
  assert.equal(existsSync(join(noMode.runDir, "state.json")), false);

  const noReviewMode = sandbox({ init: null, profiles: [PROFILES[0], { ...PROFILES[1], modeId: undefined }] });
  out = noReviewMode.no(/reviewer: .*no mode.*--review-mode/s, "init", "--feature", "feat", "--repo", noReviewMode.repo);
  assert.doesNotMatch(out, /executor: .*no mode/);
  assert.equal(existsSync(join(noReviewMode.runDir, "state.json")), false);
});

test("config shows a role that lost its model or mode as UNRESOLVED, and the next launch creates nothing", () => {
  const sb = sandbox();
  sb.setProfiles([{ ...PROFILES[0], modeId: undefined }, PROFILES[1]]);
  const out = sb.ok("config");
  assert.match(out, /executor UNRESOLVED: .*no mode.*--mode/s);
  assert.match(out, /reviewer fake model=review-model mode=full thinking=high ← profile "wl-reviewer"/);
  sb.no(/executor: .*no mode.*--mode/s, "dispatch", "01");
  assert.equal(sb.state().tasks["01"].status, "ready");
  assert.equal(sb.db().calls.filter((c) => c[0] === "worktree").length, 0);

  // The same for a reviewer: it fails before freezing the candidate or starting a review agent.
  sb.setProfiles(PROFILES);
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.setProfiles([PROFILES[0], { ...PROFILES[1], model: undefined }]);
  assert.match(sb.ok("status"), /reviewer UNRESOLVED: .*no model.*--review-model/s);
  sb.no(/reviewer: .*no model.*--review-model/s, "review", "01");
  assert.equal(sb.state().tasks["01"].status, "running");
  assert.equal(sb.state().tasks["01"].candidateSha, undefined);
  assert.equal(sb.db().agents.filter((a) => a.labels.role === "reviewer").length, 0);
});

test("status says a review is waiting for the budget instead of suggesting it", () => {
  const sb = sandbox({ init: ["--max-reviewers", "1"], tickets: {
    "01-a.md": "# 01: A\n\nBlocked by: None\n", "02-b.md": "# 02: B\n\nBlocked by: None\n" } });
  sb.ok("dispatch", "01");
  sb.ok("dispatch", "02");
  sb.work("01");
  sb.ok("review", "01"); // 01's review is in progress: the budget is 1/1
  sb.work("02"); // 02 is running with a done report, so it wants a review
  let out = sb.ok("status");
  assert.match(out, /#02 waits for a reviewer \(budget 1\/1\)/);
  assert.doesNotMatch(out, /review 02 --prepare/);

  // Freeing the budget brings the suggestion back.
  sb.reviewed("01");
  out = sb.ok("status");
  assert.match(out, /review 02 --prepare/);
  assert.doesNotMatch(out, /waits for a reviewer/);
});

test("a frozen task with no reviewer yet occupies no budget, so status still suggests starting one", () => {
  const sb = sandbox({ init: ["--max-reviewers", "1"], tickets: {
    "01-a.md": "# 01: A\n\nBlocked by: None\n", "02-b.md": "# 02: B\n\nBlocked by: None\n" } });
  sb.ok("dispatch", "01");
  sb.ok("dispatch", "02");
  sb.work("01");
  sb.ok("freeze", "01"); // in_review, no reviewer started yet: nothing is reviewing, so nothing is spent
  sb.work("02");
  // Counting the frozen task itself would refuse to suggest the very command that would work.
  const out = sb.ok("status");
  assert.match(out, /review 01 --prepare/);
  assert.match(out, /review 02 --prepare/);
  assert.doesNotMatch(out, /waits for a reviewer/);

  // A prepared review nobody has acknowledged yet already holds the only slot.
  const action = JSON.parse(sb.ok("review", "01", "--prepare"));
  const prepared = sb.ok("status");
  assert.match(prepared, /action 01 — reconcile pending MCP action/);
  assert.match(prepared, /#02 waits for a reviewer \(budget 1\/1\)/);
  deliver(sb, action);
  assert.match(sb.ok("status"), /#02 waits for a reviewer \(budget 1\/1\)/);
});

test("an agent that errors at start is flagged at dispatch and by patrol", () => {
  // A provider override makes the launch run-config-only, so it must carry its own model and mode.
  const sb = sandbox({ init: ["--provider", "crashy", "--model", "crash-model", "--mode", "full"] });
  const out = sb.ok("dispatch", "01");
  const t = sb.state().tasks["01"];
  assert.match(out, /warning: executor .* started in status "error"/);
  // Overriding the provider drops the profile's provider-specific fields; the run's own replace them.
  assert.deepEqual([flag(sb.agent(t.agentId).args, "model"), flag(sb.agent(t.agentId).args, "mode")], ["crash-model", "full"]);
  assert.equal(t.launch, "crashy model=crash-model mode=full ← run config");
  assert.match(sb.ok("patrol", "--window", "5", "--interval", "1"), /#01 executor .* error .*the agent errored.*crashy model=crash-model mode=full ← run config.*tell the user/);
});

test("dispatch respects the executor budget and holds", () => {
  const sb = sandbox({ init: ["--max-executors", "1"] });
  writeFileSync(join(sb.runDir, "issues", "04-docs.md"), "# 04: Docs\n\nBlocked by: none\n");
  assert.match(sb.ok("import"), /added #04 Docs/);
  sb.ok("dispatch", "01");
  sb.no(/executor budget full/, "dispatch", "04");
  sb.ok("config", "--max-executors", "2");
  sb.ok("hold", "04", "--reason", "waiting on the user");
  sb.no(/on hold/, "dispatch", "04");
  assert.doesNotMatch(sb.ok("status"), /dispatch 04/);
  sb.ok("unhold", "04");
  sb.ok("dispatch", "04");
});

test("an interrupted dispatch resumes without a second worktree, and adopts an orphan agent", () => {
  const sb = sandbox();
  sb.editDb((d) => { d.failOnce = "agent run"; });
  sb.no(/injected failure/, "dispatch", "01");
  let t = sb.state().tasks["01"];
  assert.equal(t.status, "running");
  assert.equal(t.agentId, undefined);
  sb.ok("dispatch", "01");
  assert.equal(sb.db().calls.filter((c) => c[0] === "worktree").length, 1);
  assert.ok(sb.state().tasks["01"].agentId);

  // The agent was created but its id never reached the state file.
  const sb2 = sandbox();
  sb2.editDb((d) => { d.failOnce = "agent run"; });
  sb2.no(/injected failure/, "dispatch", "01");
  sb2.editDb((d) => d.agents.push({ id: "orphan-agent", title: "wl feat #01 a1", cwd: "x", labels: { workloop: "repo-feat", task: "01", attempt: "a1", role: "executor" }, status: "running", archived: false, prompts: [] }));
  assert.match(sb2.ok("status", "--live"), /orphan-agent .*not recorded/);
  assert.match(sb2.ok("dispatch", "01"), /adopted existing executor orphan-agent/);
  t = sb2.state().tasks["01"];
  assert.equal(t.agentId, "orphan-agent");
  assert.equal(sb2.db().agents.length, 1);
});

test("review only accepts an idle executor, a fresh done report and a clean committed tree", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  const t = sb.state().tasks["01"];
  sb.no(/executor .* is running/, "review", "01");
  sb.setAgent(t.agentId, "idle");
  sb.no(/no report written since the last prompt/, "review", "01");
  sb.work("01", { status: "question" });
  sb.no(/reported "question"/, "review", "01");
  sb.work("01", { commit: false, files: { "loose.txt": "x" } });
  sb.no(/uncommitted or untracked/, "review", "01");
  sb.g(t.worktree, "add", "-A");
  sb.g(t.worktree, "commit", "-q", "-m", "commit it");
  sb.work("01", { files: {} , commit: false });
  sb.ok("review", "01");
  const s = sb.state().tasks["01"];
  assert.equal(s.status, "in_review");
  assert.equal(s.candidateSha, sb.g(t.worktree, "rev-parse", "HEAD"));
  const r = sb.agent(s.review.agentId);
  assert.equal(r.labels.role, "reviewer");
  assert.equal(r.cwd, t.worktree);
  assert.doesNotMatch(readFileSync(join(sb.runDir, "briefs", `01-review-${s.candidateSha.slice(0, 8)}.md`), "utf8"), /\{\{/);
  sb.no(/already has review agent/, "review", "01");
});

test("changes requested: integrate refuses, send waits for idle agents and opens a rework round", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  const t = sb.state().tasks["01"];
  sb.no(/not written yet/, "integrate", "01");
  sb.no(/reviewer .* is running/, "send", "01", "--text", "fix S1");
  sb.reviewed("01", "changes_requested");
  assert.match(sb.ok("status"), /changes requested/);
  sb.no(/verdict is changes_requested/, "integrate", "01");
  sb.ok("send", "01", "--text", "Fix S1: rename x.");
  const s = sb.state().tasks["01"];
  assert.equal(s.status, "running");
  assert.equal(s.rounds, 1);
  assert.equal(s.candidateSha, null);
  const msg = sb.agent(t.agentId).prompts.at(-1);
  assert.match(msg, /^Fix S1: rename x\./);
  assert.ok(msg.includes(slash(join(sb.runDir, "reports", "01-a1.md"))));
  sb.no(/executor .* is running/, "send", "01", "--text", "again");
  // The old report predates the rework prompt, so it doesn't count.
  sb.setAgent(t.agentId, "idle");
  sb.no(/no report written since the last prompt/, "review", "01");
});

test("integrate merges with --no-ff, runs checks, cleans up, and unblocks dependents", () => {
  const sb = sandbox();
  const before = sb.state().integration.tip;
  const out = sb.complete("01");
  assert.match(out, /unblocked: #02/);
  const s = sb.state();
  const t = s.tasks["01"];
  assert.equal(t.status, "done");
  assert.notEqual(s.integration.tip, before);
  assert.equal(sb.g(s.integration.worktree, "rev-parse", "HEAD^1"), before);
  assert.equal(sb.g(s.integration.worktree, "rev-parse", "HEAD^2"), t.candidateSha);
  assert.equal(existsSync(t.worktree), false);
  assert.equal(spawnSync("git", ["-C", sb.repo, "show-ref", "--verify", "--quiet", `refs/heads/${t.branch}`]).status, 1);
  assert.ok(sb.db().workspaces.every((w) => w.archived));
  assert.ok(sb.agent(t.agentId).archived && sb.agent(t.review.agentId).archived);
  assert.ok(t.cleanedAt);
  assert.match(sb.ok("status"), /next: dispatch 02/);
});

test("integrate rolls back when checks fail on the merge", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.work("01", { files: { BROKEN: "" } });
  sb.ok("review", "01");
  sb.reviewed("01");
  const tip = sb.state().integration.tip;
  sb.no(/fails after merging; integration rolled back/, "integrate", "01");
  const s = sb.state();
  assert.equal(s.integration.tip, tip);
  assert.equal(sb.g(s.integration.worktree, "rev-parse", "HEAD"), tip);
  assert.equal(s.tasks["01"].status, "in_review");
});

test("a conflict aborts the merge; --merge-tip routes it back to the executor", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n", "02-b.md": "# 02: B\n\nBlocked by: None\n" } });
  sb.ok("dispatch", "01");
  sb.ok("dispatch", "02");
  sb.work("01", { files: { "shared.txt": "from 01\n" } });
  sb.work("02", { files: { "shared.txt": "from 02\n" } });
  sb.ok("review", "01");
  sb.no(/reviewer budget full \(1\/1\)/, "review", "02");
  assert.equal(sb.state().tasks["02"].status, "running"); // not frozen behind a full budget
  sb.reviewed("01");
  sb.ok("review", "02");
  sb.reviewed("02");
  sb.ok("integrate", "01");
  const tip = sb.state().integration.tip;
  sb.no(/conflicts with workloop\/feat \(shared\.txt\).*\n.*send 02 --merge-tip/, "integrate", "02");
  assert.equal(sb.state().integration.tip, tip);
  assert.equal(sb.g(sb.state().integration.worktree, "status", "--porcelain"), "");
  sb.ok("send", "02", "--merge-tip");
  const t = sb.state().tasks["02"];
  assert.ok(sb.agent(t.agentId).prompts.at(-1).includes(tip));
  // The executor merges the tip and resolves the conflict.
  spawnSync("git", ["-C", t.worktree, "merge", tip], { env: sb.env });
  sb.work("02", { files: { "shared.txt": "from 01\nfrom 02\n" } });
  sb.ok("review", "02");
  sb.reviewed("02");
  sb.ok("integrate", "02");
  assert.equal(readFileSync(join(sb.state().integration.worktree, "shared.txt"), "utf8"), "from 01\nfrom 02\n");
});

test("finish needs every ticket closed and a passing final review of the current tip", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n", "02-b.md": "# 02: B\n\nBlocked by: 01\n" } });
  sb.complete("01");
  sb.no(/not finished: #02 ready/, "finish");
  sb.ok("cancel", "02", "--reason", "out of scope after all");
  sb.no(/write the final review/, "finish");
  const tip = sb.state().integration.tip;
  writeFileSync(join(sb.runDir, "final-review.md"), "Verdict: pass\nIntegration tip: deadbeef\n");
  sb.no(/final review is for integration tip deadbeef/, "finish");
  writeFileSync(join(sb.runDir, "final-review.md"), `Verdict: changes_requested\nIntegration tip: ${tip}\n`);
  sb.no(/repair tickets/, "finish");
  writeFileSync(join(sb.runDir, "final-review.md"), `Verdict: pass\nIntegration tip: ${tip}\n`);
  const out = sb.ok("finish");
  assert.match(out, /Nothing was pushed/);
  assert.equal(existsSync(sb.state().integration.worktree), false);
  assert.equal(sb.g(sb.repo, "rev-parse", "workloop/feat"), tip);
  sb.no(/finished/, "dispatch", "02");
});

test("review refuses files outside the ticket's Scope, renames and deletions included; a widened Scope applies at once", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\n**Blocked by:** None\n\n**Scope:** `f01.txt`, docs/\n" } });
  sb.ok("dispatch", "01");
  sb.g(sb.state().tasks["01"].worktree, "mv", "shared.txt", "moved.txt");
  sb.work("01");
  sb.no(/outside the ticket's Scope \(f01\.txt, docs\/\*\*\):\n  moved\.txt\n  shared\.txt\n/, "review", "01");
  assert.equal(sb.state().tasks["01"].status, "running");
  writeFileSync(sb.state().tasks["01"].file, "# 01: A\n\n**Blocked by:** None\n\n**Scope:** f01.txt, moved.txt, shared.txt\n");
  sb.ok("review", "01");
  const t = sb.state().tasks["01"];
  assert.equal(t.status, "in_review");
  const freeze = readFileSync(join(sb.runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.kind === "freeze");
  assert.deepEqual(freeze.scope, ["f01.txt", "moved.txt", "shared.txt"]);
  assert.doesNotMatch(readFileSync(join(sb.runDir, "briefs", `01-review-${t.candidateSha.slice(0, 8)}.md`), "utf8"), /## Direct run/);
});

test("a direct run takes one ticket with a Scope, briefs the reviewer for it, and finishes without a final review", () => {
  const many = sandbox({ init: null });
  many.no(/exactly one ticket; .* has 3/, "init", "--direct", "--feature", "feat", "--repo", many.repo);
  const bare = sandbox({ init: null, tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  bare.no(/needs a "Scope:" line/, "init", "--direct", "--feature", "feat", "--repo", bare.repo);

  const sb = sandbox({ init: null, tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\nScope: f01.txt\n" } });
  rmSync(join(sb.runDir, "spec.md"));
  assert.match(sb.ok("init", "--direct", "--feature", "feat", "--repo", sb.repo, "--check", CHECK), /run repo\/feat \(direct\)/);
  assert.equal(sb.state().mode, "direct");
  assert.equal(sb.state().spec, sb.state().tasks["01"].file);
  const extra = join(sb.runDir, "issues", "02-b.md");
  writeFileSync(extra, "# 02: B\n\nBlocked by: 01\n");
  sb.no(/holds one ticket/, "import");
  rmSync(extra);

  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  const t = sb.state().tasks["01"];
  const brief = readFileSync(join(sb.runDir, "briefs", `01-review-${t.candidateSha.slice(0, 8)}.md`), "utf8");
  assert.match(brief, /tool\.\n\n## Direct run\n[\s\S]*Re-run every check[\s\S]*`B1`[^\n]*\n\n## Rules/);
  assert.doesNotMatch(brief, /\{\{/);
  sb.reviewed("01");
  sb.ok("integrate", "01");
  assert.match(sb.ok("status"), /next: all tickets closed — `finish` \(a direct run has no final review\)/);
  assert.match(sb.ok("finish"), /Nothing was pushed/);
  assert.equal(existsSync(join(sb.runDir, "final-review.md")), false);
});

test("decisions commits ADR and glossary changes and the next dispatch branches from the new tip", () => {
  const sb = sandbox();
  const wt = sb.state().integration.worktree;
  const before = sb.state().integration.tip;
  assert.match(sb.ok("help"), /decisions/);
  mkdirSync(join(wt, "docs", "adr"), { recursive: true });
  writeFileSync(join(wt, "docs", "adr", "0001-store-decisions.md"), "# 1: Store decisions\n");
  writeFileSync(join(wt, "GLOSSARY.md"), "# Glossary\n\n- decision: a recorded choice\n");
  const out = sb.ok("decisions");
  assert.match(out, /docs\/adr\/0001-store-decisions\.md/);
  assert.match(out, /GLOSSARY\.md/);
  const s = sb.state();
  assert.equal(s.integration.tip, sb.g(wt, "rev-parse", "HEAD"));
  assert.notEqual(s.integration.tip, before);
  assert.equal(sb.g(wt, "rev-list", "--count", `${before}..HEAD`), "1");
  assert.equal(sb.g(wt, "log", "-1", "--format=%s"), "workloop: record decisions for feat");
  assert.equal(sb.g(wt, "status", "--porcelain"), "");
  const event = readFileSync(join(sb.runDir, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).find((e) => e.kind === "decisions");
  assert.equal(event.tip, s.integration.tip);
  assert.deepEqual(event.paths.sort(), ["GLOSSARY.md", "docs/adr/0001-store-decisions.md"]);
  sb.ok("dispatch", "01");
  assert.equal(sb.g(sb.state().tasks["01"].worktree, "rev-parse", "HEAD"), s.integration.tip);
});

test("decisions commits a deleted ADR and an edited history index", () => {
  const sb = sandbox({ init: null });
  mkdirSync(join(sb.repo, "docs", "adr"), { recursive: true });
  writeFileSync(join(sb.repo, "docs", "adr", "0007-old.md"), "# 7: Old\n");
  writeFileSync(join(sb.repo, "docs", "adr-history.md"), "# ADR history\n");
  sb.g(sb.repo, "add", "-A");
  sb.g(sb.repo, "commit", "-q", "-m", "adr");
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  const wt = sb.state().integration.worktree;
  rmSync(join(wt, "docs", "adr", "0007-old.md"));
  writeFileSync(join(wt, "docs", "adr-history.md"), "# ADR history\n\n| 7 | Old | 2024-01-01 | 8 | replaced |\n");
  sb.ok("decisions");
  assert.deepEqual(sb.g(wt, "show", "--name-status", "--format=", "HEAD").split("\n").sort(),
    ["D\tdocs/adr/0007-old.md", "M\tdocs/adr-history.md"]);
});

test("decisions matches both sides of a rename", () => {
  const sb = sandbox({ init: null });
  mkdirSync(join(sb.repo, "docs", "adr"), { recursive: true });
  writeFileSync(join(sb.repo, "docs", "adr", "0007-old.md"), "# 7: Old\n");
  writeFileSync(join(sb.repo, "GLOSSARY.md"), "# Glossary\n");
  sb.g(sb.repo, "add", "-A");
  sb.g(sb.repo, "commit", "-q", "-m", "adr");
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  const wt = sb.state().integration.worktree;
  const tip = sb.state().integration.tip;

  // Moving a decision document out of the decision paths is refused: the destination is what leaves them.
  sb.g(wt, "mv", "docs/adr/0007-old.md", "0007-note.md");
  sb.no(/outside the decision paths[\s\S]*0007-note\.md/, "decisions");
  assert.equal(sb.state().integration.tip, tip);
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), tip);

  // A rename that stays inside them is recorded with both paths.
  sb.g(wt, "mv", "0007-note.md", "docs/adr/0008-renumbered.md");
  sb.ok("decisions");
  const event = readFileSync(join(sb.runDir, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).find((e) => e.kind === "decisions");
  assert.deepEqual(event.paths, ["docs/adr/0007-old.md", "docs/adr/0008-renumbered.md"]);
});

test("decisions is refused on a different branch at the tip's SHA, and on a detached HEAD", () => {
  const sb = sandbox();
  const wt = sb.state().integration.worktree;
  const tip = sb.state().integration.tip;
  const eventsOf = (kind) => readFileSync(join(sb.runDir, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).filter((e) => e.kind === kind);
  const stateBefore = sb.state();

  // Another branch at the very same commit passes a HEAD-vs-tip check, yet a commit would land on it.
  sb.g(wt, "switch", "-q", "-c", "other");
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), tip);
  writeFileSync(join(wt, "GLOSSARY.md"), "# Glossary\n");
  sb.no(/is on branch other, not workloop\/feat/, "decisions");
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), tip);
  assert.equal(sb.g(wt, "rev-parse", "workloop/feat"), tip);
  assert.equal(sb.g(wt, "status", "--porcelain", "--untracked-files=all"), "?? GLOSSARY.md");
  assert.deepEqual(sb.state(), stateBefore);
  assert.deepEqual(eventsOf("decisions"), []);
  assert.deepEqual(eventsOf("decisions_failed"), []);

  // A detached HEAD is not the branch either, even when no branch moved.
  sb.g(wt, "switch", "-q", "--detach");
  sb.no(/detached/i, "decisions");
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), tip);
  assert.equal(sb.g(wt, "rev-parse", "workloop/feat"), tip);
  assert.deepEqual(sb.state(), stateBefore);
  assert.deepEqual(eventsOf("decisions"), []);

  // Back on the branch, the ordinary path works and keeps ref, HEAD and state tip together.
  sb.g(wt, "switch", "-q", "workloop/feat");
  sb.ok("decisions");
  const s = sb.state();
  assert.notEqual(s.integration.tip, tip);
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), s.integration.tip);
  assert.equal(sb.g(wt, "rev-parse", s.integration.branch), s.integration.tip);
  assert.equal(sb.g(wt, "branch", "--show-current"), s.integration.branch);
  assert.equal(sb.g(wt, "rev-list", "--count", `${tip}..${s.integration.tip}`), "1");
  sb.ok("dispatch", "01");
  assert.equal(sb.g(sb.state().tasks["01"].worktree, "rev-parse", "HEAD"), s.integration.tip);
});

test("decisions refuses a path outside the decision areas and commits nothing", () => {
  const sb = sandbox();
  const wt = sb.state().integration.worktree;
  const tip = sb.state().integration.tip;
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src", "x.js"), "x\n");
  sb.no(/outside the decision paths[\s\S]*src\/x\.js/, "decisions");
  assert.equal(sb.state().integration.tip, tip);
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), tip);
  assert.equal(sb.g(wt, "status", "--porcelain", "--untracked-files=all"), "?? src/x.js");
});

test("decisions is refused when there are no changes and after a dispatch", () => {
  const sb = sandbox();
  const wt = sb.state().integration.worktree;
  sb.no(/nothing to record/, "decisions");
  sb.ok("dispatch", "01");
  writeFileSync(join(wt, "GLOSSARY.md"), "# Glossary\n");
  const tip = sb.state().integration.tip;
  sb.no(/#01 is running/, "decisions");
  assert.equal(sb.state().integration.tip, tip);
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), tip);
  assert.equal(sb.g(wt, "status", "--porcelain", "--untracked-files=all"), "?? GLOSSARY.md");
  // A task reset to ready by `retry` was dispatched too: its attempt history keeps decisions out.
  sb.setAgent(sb.state().tasks["01"].agentId, "idle");
  sb.ok("retry", "01", "--reason", "the executor could not continue");
  assert.equal(sb.state().tasks["01"].status, "ready");
  sb.no(/#01 has attempt history/, "decisions");
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), tip);
});

test("decisions rolls the branch back when the checks fail and leaves the changes uncommitted", () => {
  const sb = sandbox({ init: null });
  const badCheck = `node -e "process.exit(require('fs').existsSync('docs/adr/BAD.md') ? 1 : 0)"`;
  mkdirSync(join(sb.repo, "docs"), { recursive: true });
  writeFileSync(join(sb.repo, "docs/adr-history.md"), "# ADR history\n");
  sb.g(sb.repo, "add", "-A");
  sb.g(sb.repo, "commit", "-q", "-m", "history");
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", badCheck);
  const wt = sb.state().integration.worktree;
  const tip = sb.state().integration.tip;
  mkdirSync(join(wt, "docs", "adr"), { recursive: true });
  writeFileSync(join(wt, "docs", "adr", "BAD.md"), "# Bad\n");
  writeFileSync(join(wt, "docs", "adr-history.md"), "# ADR history\n\n| 7 | Old |\n");
  const out = sb.no(/fails after committing[\s\S]*uncommitted/, "decisions");
  assert.match(out, /process\.exit/); // names the check that failed
  assert.equal(sb.state().integration.tip, tip);
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), tip);
  assert.equal(sb.g(wt, "rev-list", "--count", `${tip}..HEAD`), "0");
  assert.equal(sb.g(wt, "status", "--porcelain", "--untracked-files=all"), "M docs/adr-history.md\n?? docs/adr/BAD.md");
  assert.equal(sb.g(wt, "diff", "--cached", "--name-only"), ""); // back to the previous tip means nothing staged
});

test("decisions reports a failed rollback instead of claiming one when Git refuses to reset", () => {
  // The check fails and leaves a real Git index lock behind, so the rollback cannot run.
  // docs/adr/0001-fix.md is the content the check rejects; the fix later is to make it acceptable.
  const lockCheck = `node -e "const fs=require('fs');const f='docs/adr/0001-fix.md';`
    + `if(!fs.existsSync(f)||!fs.readFileSync(f,'utf8').includes('Rejected'))process.exit(0);`
    + `fs.writeFileSync(require('child_process').execSync('git rev-parse --git-path index.lock').toString().trim(),'');`
    + `console.error('REVIEW_CHECK_FAILED');process.exit(9)"`;
  const sb = sandbox({ init: null });
  writeFileSync(join(sb.repo, "README.md"), "# Repo\n");
  sb.g(sb.repo, "add", "-A");
  sb.g(sb.repo, "commit", "-q", "-m", "readme");
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", lockCheck);
  const wt = sb.state().integration.worktree;
  const tip = sb.state().integration.tip;
  mkdirSync(join(wt, "docs", "adr"), { recursive: true });
  writeFileSync(join(wt, "GLOSSARY.md"), "# Glossary\n- decision: a recorded choice\n");
  writeFileSync(join(wt, "docs", "adr", "0001-fix.md"), "# 1: Rejected\n");

  const out = sb.no(/NOT rolled back/, "decisions");
  assert.match(out, /REVIEW_CHECK_FAILED/);       // the original check output survives
  assert.match(out, /index\.lock/);                // and Git's own refusal
  assert.match(out, new RegExp(`expected ${tip.slice(0, 8)}`));
  assert.match(out, new RegExp(`HEAD is ${sb.g(wt, "rev-parse", "HEAD").slice(0, 8)}`));
  assert.match(out, /workloop\/feat/);             // says where the commit actually is
  assert.doesNotMatch(out, /is back at|still in the worktree, uncommitted/); // never claims a rollback
  // S1: no recovery route may ask for a hand-edited tip or state, a blind retry, or an unidentified lock removal.
  assert.doesNotMatch(out, /reconcile the tip|by hand|adopt|edit .*state\.json|events\.jsonl/i);
  assert.doesNotMatch(out, /delete .*lock|remove .*lock/i);
  assert.doesNotMatch(out, /reset --hard/);
  assert.doesNotMatch(out, /retry/i); // rerunning is only ever the step after fixing, never on its own
  // The route it does give, in order: identify the lock, soft reset to the recorded tip, fix, run decisions again.
  assert.match(out, /only this script writes them/);
  assert.match(out, new RegExp(`git -C .* reset --soft ${tip.slice(0, 8)}`));
  assert.match(out, /Fix what .* rejects, then run `decisions` again\. Only that command records the new tip, and only after the checks pass\./s);

  // Nothing was lost and nothing was advanced: the commit is still there, on the branch, tip unmoved.
  const eventsOf = (kind) => readFileSync(join(sb.runDir, "events.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).filter((e) => e.kind === kind);
  assert.equal(sb.state().integration.tip, tip);
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), sb.g(wt, "rev-parse", "workloop/feat"));
  assert.equal(sb.g(wt, "rev-list", "--count", `${tip}..HEAD`), "1");
  assert.equal(readFileSync(join(wt, "docs/adr/0001-fix.md"), "utf8"), "# 1: Rejected\n");
  assert.equal(readFileSync(join(wt, "GLOSSARY.md"), "utf8"), "# Glossary\n- decision: a recorded choice\n");
  // The lock is the check's leftover, not ours to remove: the command must leave it in place.
  const lock = sb.g(wt, "rev-parse", "--git-path", "index.lock");
  const lockPath = isAbsolute(lock) ? lock : join(wt, lock);
  assert.ok(existsSync(lockPath), "decisions must not delete a lock it did not create");
  assert.equal(eventsOf("decisions").length, 0);
  const failed = eventsOf("decisions_failed").at(-1);
  assert.equal(failed.recovered, false);
  assert.match(failed.resetError, /index\.lock/);
  assert.equal(failed.tip, tip);
  assert.equal(failed.head, sb.g(wt, "rev-parse", "HEAD"));

  // A retry still refuses honestly: the command did not delete the lock or adopt anything.
  sb.no(/HEAD [0-9a-f]{8} \(workloop\/feat ref [0-9a-f]{8}\) != recorded tip/, "decisions");

  // Follow the route the message gives. Step 1: identify the lock as the finished check's leftover and remove it.
  rmSync(lockPath);
  assert.equal(existsSync(lockPath), false);
  // Step 2: a data-preserving soft reset back to the recorded tip. The documents become staged, uncommitted.
  sb.g(wt, "reset", "--soft", tip);
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), tip);
  assert.equal(sb.g(wt, "rev-parse", "workloop/feat"), tip);
  assert.equal(sb.state().integration.tip, tip);
  assert.equal(readFileSync(join(wt, "GLOSSARY.md"), "utf8"), "# Glossary\n- decision: a recorded choice\n");
  assert.deepEqual(sb.g(wt, "status", "--porcelain", "--untracked-files=all").split("\n").sort(),
    ["A  GLOSSARY.md", "A  docs/adr/0001-fix.md"]);

  // Step 3: fix what the check rejected, then let the script record the tip again.
  writeFileSync(join(wt, "docs/adr/0001-fix.md"), "# 1: Accepted\n");
  sb.ok("decisions");
  const s = sb.state();
  assert.notEqual(s.integration.tip, tip);
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), s.integration.tip);
  assert.equal(sb.g(wt, "rev-parse", s.integration.branch), s.integration.tip);
  const done = eventsOf("decisions").at(-1);
  assert.equal(done.tip, s.integration.tip);
  assert.deepEqual(done.paths.sort(), ["GLOSSARY.md", "docs/adr/0001-fix.md"]);
  assert.equal(readFileSync(join(wt, "docs/adr/0001-fix.md"), "utf8"), "# 1: Accepted\n");

  // The tip the script advanced is the one dispatch branches from, with the checks having passed.
  sb.ok("dispatch", "01");
  assert.equal(sb.g(sb.state().tasks["01"].worktree, "rev-parse", "HEAD"), s.integration.tip);
});

test("repair tickets after integration go through the normal loop", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  sb.complete("01");
  writeFileSync(join(sb.runDir, "issues", "02-fix-a.md"), "# 02: Fix A\n\nBlocked by: 01\n");
  sb.ok("import");
  sb.ok("dispatch", "02");
  assert.equal(sb.g(sb.state().tasks["02"].worktree, "rev-parse", "HEAD"), sb.state().integration.tip);
});

// A repo whose AGENTS.md carries a registry, committed on the base so the
// integration branch inherits it.
const REGISTRY = [
  "# Repo",
  "",
  "## Documents",
  "",
  "| Path | Type | Domain |",
  "|------|------|--------|",
  "| AGENTS.md | instructions | global |",
  "| docs/adr | adr | global |",
  "| docs/adr-history.md | history | global |",
  "",
].join("\n");

function withRegistry(sb) {
  writeFileSync(join(sb.repo, "AGENTS.md"), REGISTRY);
  sb.g(sb.repo, "add", "AGENTS.md");
  sb.g(sb.repo, "commit", "-q", "-m", "registry");
}

test("a full run refuses to finish while a document it added is unregistered, and a repair ticket fixes it", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" }, init: null });
  withRegistry(sb);
  // An older, unregistered document outside the run must not block: only what the run added counts.
  writeFileSync(join(sb.repo, "OLD-NOTES.md"), "old\n");
  sb.g(sb.repo, "add", "OLD-NOTES.md");
  sb.g(sb.repo, "commit", "-q", "-m", "old notes");
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);

  sb.ok("dispatch", "01");
  sb.work("01", { files: { "PROGRESS.md": "progress\n" } });
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("integrate", "01");

  const message = /1 new documents aren't in the registry \(PROGRESS\.md\): classify them per reference\/tidy-docs\.md and fix them with a repair ticket before the final review/;
  assert.match(sb.ok("status"), message);
  assert.doesNotMatch(sb.ok("status"), /OLD-NOTES\.md/);
  const tip = sb.state().integration.tip;
  writeFileSync(join(sb.runDir, "final-review.md"), `Verdict: pass\nIntegration tip: ${tip}\n`);
  sb.no(message, "finish");
  assert.equal(sb.state().finishedAt, undefined);

  // The repair ticket removes the process document; the final review is redone at the new tip.
  writeFileSync(join(sb.runDir, "issues", "02-fix-docs.md"), "# 02: Fix documents\n\nBlocked by: 01\n");
  sb.ok("import");
  sb.ok("dispatch", "02");
  sb.g(sb.state().tasks["02"].worktree, "rm", "-q", "PROGRESS.md");
  sb.work("02", { files: {} });
  sb.ok("review", "02");
  sb.reviewed("02");
  sb.ok("integrate", "02");
  assert.match(sb.ok("status"), /all tickets closed — do the final review/);
  // The document step is gone; the old review is simply too old for the new tip now.
  sb.no(/write the final review/, "finish");
  writeFileSync(join(sb.runDir, "final-review.md"), `Verdict: pass\nIntegration tip: ${sb.state().integration.tip}\n`);
  assert.match(sb.ok("finish"), /Nothing was pushed/);
});

// A full run with one ticket done and an unregistered document added, at the point
// where only `finish` is left. `prepare` shapes the repo before init.
function finishedRun({ prepare = () => {}, files = { "PROGRESS.md": "progress\n" } } = {}) {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" }, init: null });
  prepare(sb);
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  sb.ok("dispatch", "01");
  sb.work("01", { files });
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("integrate", "01");
  writeFileSync(join(sb.runDir, "final-review.md"), `Verdict: pass\nIntegration tip: ${sb.state().integration.tip}\n`);
  return sb;
}

test("a repo with no registry is never blocked; with /tidy-docs installed it is reminded to run it", () => {
  const reminder = /this repo has no document registry yet; run \/tidy-docs/;
  const bare = finishedRun();
  assert.doesNotMatch(bare.ok("status"), reminder);
  assert.doesNotMatch(bare.ok("finish"), /document registry/);

  // Either installed location counts, and it is the main checkout that is checked:
  // the skill files are excluded from git, so the integration worktree never has them.
  for (const dir of [".agents", ".claude"]) {
    const sb = finishedRun({
      prepare(s) {
        const file = join(s.repo, dir, "skills", "tidy-docs", "SKILL.md");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "---\nname: tidy-docs\n---\n");
      },
    });
    assert.match(sb.ok("finish"), reminder);
    assert.equal(sb.state().finishedAt !== undefined, true);
  }

  // An older unregistered document does not block a registry-less repo either.
  const older = finishedRun({
    prepare(s) {
      writeFileSync(join(s.repo, "OLD-NOTES.md"), "old\n");
      s.g(s.repo, "add", "OLD-NOTES.md");
      s.g(s.repo, "commit", "-q", "-m", "old notes");
    },
  });
  assert.doesNotMatch(older.ok("status"), /aren't in the registry/);
  assert.match(older.ok("finish"), /Nothing was pushed/);
});

test("a direct run adding a Markdown file inside its Scope finishes without the document check", () => {
  const sb = sandbox({ init: null, tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n**Scope:** NOTES.md, src/\n" } });
  writeFileSync(join(sb.repo, "AGENTS.md"), REGISTRY);
  sb.g(sb.repo, "add", "AGENTS.md");
  sb.g(sb.repo, "commit", "-q", "-m", "registry");
  sb.ok("init", "--direct", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  sb.ok("dispatch", "01");
  sb.work("01", { files: { "NOTES.md": "notes\n" } });
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("integrate", "01");
  assert.doesNotMatch(sb.ok("status"), /aren't in the registry/);
  assert.match(sb.ok("finish"), /Nothing was pushed/);
});

test("the run's own registry row and a root instruction file are never the run's problem", () => {
  // A repair ticket may add the registry row itself, and CLAUDE.md is registered by
  // rule, so neither is reported. A stale row elsewhere is not this check's business.
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" }, init: null });
  writeFileSync(join(sb.repo, "AGENTS.md"), `${REGISTRY}| legacy/** | product | global |\n`);
  sb.g(sb.repo, "add", "AGENTS.md");
  sb.g(sb.repo, "commit", "-q", "-m", "registry");
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  sb.ok("dispatch", "01");
  sb.work("01", { files: { "CLAUDE.md": "@AGENTS.md\n", "docs/api/billing.md": "# Billing\n" } });
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("integrate", "01");
  assert.match(sb.ok("status"), /1 new documents aren't in the registry \(docs\/api\/billing\.md\)/);

  // The repair ticket registers it, and the run finishes.
  writeFileSync(join(sb.runDir, "issues", "02-register.md"), "# 02: Register the API doc\n\nBlocked by: 01\n");
  sb.ok("import");
  sb.ok("dispatch", "02");
  const wt = sb.state().tasks["02"].worktree;
  writeFileSync(join(wt, "AGENTS.md"), `${REGISTRY}| docs/api/billing.md | product | billing |\n| legacy/** | product | global |\n`);
  sb.work("02", { files: {} });
  sb.ok("review", "02");
  sb.reviewed("02");
  sb.ok("integrate", "02");
  assert.doesNotMatch(sb.ok("status"), /aren't in the registry/);
  writeFileSync(join(sb.runDir, "final-review.md"), `Verdict: pass\nIntegration tip: ${sb.state().integration.tip}\n`);
  assert.match(sb.ok("finish"), /Nothing was pushed/);
});

test("an inventory that cannot report is a refusal, not an empty report", () => {
  // A registry heading with no table makes tidy-docs.mjs exit 1. That must not read
  // as "no unregistered documents".
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" }, init: null });
  writeFileSync(join(sb.repo, "AGENTS.md"), "# Repo\n\n## Documents\n\nNothing yet.\n");
  sb.g(sb.repo, "add", "AGENTS.md");
  sb.g(sb.repo, "commit", "-q", "-m", "registry");
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("integrate", "01");
  assert.match(sb.ok("status"), /has no table/);
  writeFileSync(join(sb.runDir, "final-review.md"), `Verdict: pass\nIntegration tip: ${sb.state().integration.tip}\n`);
  sb.no(/has no table/, "finish");
  assert.equal(sb.state().finishedAt, undefined);
});

test("a registered document renamed to an unregistered path blocks; a rename inside a registered path does not", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" }, init: null });
  withRegistry(sb);
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  sb.ok("dispatch", "01");
  const wt = sb.state().tasks["01"].worktree;
  sb.g(wt, "mv", "shared.txt", "NOTES.md");
  sb.work("01", { files: {} });
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("integrate", "01");
  assert.match(sb.ok("status"), /1 new documents aren't in the registry \(NOTES\.md\)/);
  writeFileSync(join(sb.runDir, "final-review.md"), `Verdict: pass\nIntegration tip: ${sb.state().integration.tip}\n`);
  sb.no(/aren't in the registry \(NOTES\.md\)/, "finish");

  // The same rename inside a registered directory is covered by its row: nothing to report.
  const inside = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" }, init: null });
  mkdirSync(join(inside.repo, "docs", "adr"), { recursive: true });
  inside.g(inside.repo, "mv", "shared.txt", "docs/adr/shared.txt");
  inside.g(inside.repo, "commit", "-q", "-m", "move into the adr directory");
  writeFileSync(join(inside.repo, "AGENTS.md"), REGISTRY);
  inside.g(inside.repo, "add", "AGENTS.md");
  inside.g(inside.repo, "commit", "-q", "-m", "registry");
  inside.ok("init", "--feature", "feat", "--repo", inside.repo, "--check", CHECK);
  inside.ok("dispatch", "01");
  const wt2 = inside.state().tasks["01"].worktree;
  inside.g(wt2, "mv", "docs/adr/shared.txt", "docs/adr/0002-shared.txt");
  inside.work("01", { files: {} });
  inside.ok("review", "01");
  inside.reviewed("01");
  inside.ok("integrate", "01");
  assert.doesNotMatch(inside.ok("status"), /aren't in the registry/);
});

test("retry starts a new attempt on a new branch and keeps the old one", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  const old = sb.state().tasks["01"];
  sb.no(/needs --reason/, "retry", "01");
  sb.no(/is running/, "retry", "01", "--reason", "session lost");
  sb.setAgent(old.agentId, "closed");
  assert.match(sb.ok("retry", "01", "--reason", "session lost"), /old attempt is kept/);
  sb.ok("dispatch", "01");
  const t = sb.state().tasks["01"];
  assert.equal(t.attempt, "a2");
  assert.equal(t.branch, "wl-feat-01-a2");
  assert.notEqual(t.agentId, old.agentId);
  assert.ok(existsSync(old.worktree));
  assert.equal(t.history[0].reason, "session lost");
});

test("patrol returns as soon as an agent needs attention", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  const t = sb.state().tasks["01"];
  let out = sb.ok("patrol", "--window", "1", "--interval", "1");
  assert.match(out, /#01 executor .* running .*report=none/);
  assert.match(out, /no change/);
  sb.editDb((d) => { d.agents[0].pending = [{ id: "p1" }]; });
  out = sb.ok("patrol", "--window", "30", "--interval", "1");
  assert.match(out, /1 permission request/);
  sb.editDb((d) => { d.agents[0].pending = []; });
  sb.work("01", { status: "question" });
  out = sb.ok("patrol", "--window", "30");
  assert.match(out, /idle .*report=question/);
  assert.match(out, /reported question/);
  sb.setAgent(t.agentId, "idle");
});

test("a stale lock left by a dead process is taken over", () => {
  const sb = sandbox();
  writeFileSync(join(sb.runDir, ".lock"), "999999");
  sb.ok("note", "--text", "still works");
  assert.equal(existsSync(join(sb.runDir, ".lock")), false);
});
