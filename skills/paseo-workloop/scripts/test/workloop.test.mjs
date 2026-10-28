// End-to-end tests for workloop.mjs against real git and a fake paseo CLI.
// Run: node --test paseo-workloop/scripts/test/
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { acceptanceCommands, acceptanceCriteria, alive, citedBasis, decisionsResetCommand, finalCitation, header, inBoundary, inFinalBoundary, initCleanupCommands, inScope, mappingRows, outOfScope, parseFindings, parseTicket, processIdentity, stopCheckNow, ticketScope, winQuote } from "../workloop.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "workloop.mjs");
const FAKE = join(HERE, "fake-paseo.mjs");
const CHECK = `node -e "process.exit(require('fs').existsSync('BROKEN') ? 1 : 0)"`;

const TICKETS = {
  "01-schema.md": "# 01: Schema\n\n**What to build:** the table.\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n\n- [ ] AC1: works\n",
  "02-api.md": "# 02: API\n\n**What to build:** endpoints.\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n",
  "03-ui.md": "# 03: UI over OAuth2\n\n## What to build\n\nScreens.\n\n## Blocked by\n\n- 01 (schema)\n- [02: API](./02-api.md)\n",
};

const PROFILES = [
  { id: "p1", name: "wl-executor", provider: "fake", model: "exec-model", modeId: "full", notes: "workloop executors" },
  { id: "p2", name: "wl-reviewer", provider: "fake", model: "review-model", modeId: "full", thinkingOptionId: "high", notes: "workloop reviewers" },
];
const flag = (args, name) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
const slash = (p) => p.replace(/\\/g, "/");
// A cleanup-failure message names the check's token and how to list the group's
// processes to confirm it, and never prints a kill to run as is.
function assertSafeCleanupHint(out, pid, token) {
  assert.match(out, new RegExp(`list the candidates \\(\`ps -o pid=,pgid=,command= -g ${pid}\`\\)`));
  assert.match(out, new RegExp(`carries the check's token ${token}`));
  assert.doesNotMatch(out, /kill -KILL|kill -9|taskkill/);
} // paths reach agents with forward slashes (pathArg); join() gives backslashes on Windows

// The findings table a review or final-review report carries.
function findingsTable(findings, axis = "Standards") {
  return ["", "## Findings", "| ID | Axis | Location | Basis | Blocking | Fix acceptance |", "|----|------|----------|-------|----------|----------------|",
    ...findings.map((f) => `| ${f.id} | ${f.axis ?? axis} | ${f.location ?? "src/x.ts:1"} | ${f.basis ?? f.id + ": quoted"} | ${f.blocking ? "yes" : "no"} | fixed |`), ""].join("\n");
}

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
  // Rewrite state as a run created before numbered criteria: no marker, no sets.
  function legacy() {
    const file = join(runDir, "state.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    delete raw.reviewBoundary;
    for (const t of Object.values(raw.tasks)) delete t.criteria;
    writeFileSync(file, JSON.stringify(raw, null, 2));
  }
  // Long commands: start one and return control instead of blocking the test.
  const sleepCmd = (seconds) => `node -e "setTimeout(() => {}, ${seconds * 1000})"`;
  const start = (...args) => {
    const child = spawn(process.execPath, [...nodeArgs, CLI, "--run", "repo/feat", ...args], { env, cwd: repo });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
    return { child, done, out: () => out };
  };
  const waitFor = async (what, fn, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const sb = { root, repo, env, nodeArgs, runDir, g, wl, ok, no, db, editDb, agent, setAgent, state, setProfiles, sleepCmd, start, waitFor, legacy };

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
  // A verdict, and a findings table when the review has findings.
  sb.reviewed = (id, verdict = "pass", findings = []) => {
    const t = state().tasks[id];
    writeFileSync(t.review.path, `**Verdict:** ${verdict}\nCandidate: ${t.candidateSha}\n${findings.length ? findingsTable(findings) : ""}`);
    setAgent(t.review.agentId, "idle");
  };
  sb.complete = (id, workOpts) => { ok("dispatch", id); sb.work(id, workOpts); ok("review", id); sb.reviewed(id); return ok("integrate", id); };
  // A check that waits until `release()` creates its sentinel, outside every
  // worktree so the integration worktree stays clean.
  sb.heldCheck = () => {
    const sentinel = slash(join(root, `release-${Math.random().toString(36).slice(2)}`));
    const cmd = `node -e "const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync('${sentinel}'))clearInterval(t)},50)"`;
    return { cmd, release: () => writeFileSync(sentinel, "") };
  };
  // A held check whose child process (its pid in `pidFile`) waits for release()
  // and then writes orphan-write.txt into the check's working directory.
  sb.orphaningCheck = () => {
    const sentinel = slash(join(root, "release-orphan"));
    const pidFile = slash(join(root, "orphan.pid"));
    writeFileSync(join(root, "held-child.cjs"), "const fs = require('fs');\n"
      + "const t = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(t); fs.writeFileSync('orphan-write.txt', 'late\\n'); } }, 50);\n");
    writeFileSync(join(root, "held-parent.cjs"), "const { spawn } = require('child_process');\n"
      + "const c = spawn(process.execPath, [__dirname + '/held-child.cjs', process.argv[2]], { stdio: 'ignore' });\n"
      + "require('fs').writeFileSync(process.argv[3], String(c.pid));\nc.on('exit', (code) => process.exit(code ?? 1));\n");
    const cmd = `node "${slash(join(root, "held-parent.cjs"))}" "${sentinel}" "${pidFile}"`;
    return { cmd, release: () => writeFileSync(sentinel, ""), pid: () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0) };
  };
  // Fails the events.jsonl append once, in the batch that records a `send`: the
  // crash a command sees between its state save and its audit line, through the
  // --require seam. Returns the undo.
  sb.failEventAppend = (needle = '"kind":"send"') => {
    const preload = join(root, "fail-event-append.cjs");
    writeFileSync(preload, "const fs = require('node:fs');\n"
      + "const original = fs.appendFileSync;\n"
      + "fs.appendFileSync = (file, data, ...rest) => {\n"
      + `  if (String(file).endsWith('events.jsonl') && String(data).includes(${JSON.stringify(needle)})) {\n`
      + "    fs.appendFileSync = original;\n"
      + "    throw Object.assign(new Error('injected event append failure'), { code: 'EIO' });\n"
      + "  }\n"
      + "  return original(file, data, ...rest);\n};\n"
      + "require('node:module').syncBuiltinESMExports();\n");
    sb.nodeArgs.push("--require", preload);
    return () => sb.nodeArgs.splice(sb.nodeArgs.indexOf("--require"), 2);
  };
  // Makes every SIGKILL to a process group fail with EPERM in workloop processes
  // started after this call, through the --require seam; returns the undo.
  sb.failGroupKills = () => {
    const preload = join(root, "fail-group-kills.cjs");
    writeFileSync(preload, "const kill = process.kill;\n"
      + "process.kill = function (pid, signal) {\n"
      + "  if (pid < 0 && signal !== 0) {\n"
      + "    try { kill.call(process, pid, 0); } catch { return kill.call(process, pid, signal); } // a gone group stays ESRCH\n"
      + "    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' });\n  }\n"
      + "  return kill.call(process, pid, signal);\n};\n");
    sb.nodeArgs.push("--require", preload);
    return () => sb.nodeArgs.splice(sb.nodeArgs.indexOf("--require"), 2);
  };
  // #01 reviewed with a pass, #02 ready, and integrate's check held until release().
  sb.heldIntegrate = (held = sb.heldCheck()) => {
    ok("dispatch", "01");
    sb.work("01");
    ok("review", "01");
    sb.reviewed("01");
    ok("config", "--check", held.cmd);
    return held.release;
  };
  // #01 integrated with a passing final review, and finish's check held until release().
  sb.heldFinish = (held = sb.heldCheck()) => {
    sb.complete("01");
    sb.finalPass();
    ok("config", "--check", held.cmd);
    return held.release;
  };
  // The orchestrator's acceptance mapping: the final reviewer's input, no verdict.
  sb.finalMapping = (tip = state().integration.tip, rows = ["M1"]) => {
    const body = rows.map((m) => `| ${m} | spec item ${m} | evidence for ${m} |`).join("\n");
    writeFileSync(join(runDir, "final-review.md"),
      `Integration tip: ${tip}\n\n## Acceptance\n\n| Row | Spec item | Evidence on the integrated tree |\n|-----|-----------|---------------------------------|\n${body}\n`);
  };
  // The external create_agent call and its receipt: an agent in the round's worktree.
  sb.ackFinal = (action, { idle = true } = {}) => {
    const id = `mcp-final-${db().n + 1}`;
    editDb((d) => {
      d.n++;
      d.agents.push({ id, title: action.arguments.title, cwd: state().finalReview.worktree, labels: action.arguments.labels,
        parentAgentId: env.PASEO_AGENT_ID, status: "running", archived: false, updatedAt: new Date().toISOString(),
        prompts: [action.arguments.initialPrompt] });
    });
    const receipt = join(root, "receipt-final.json");
    writeFileSync(receipt, JSON.stringify({ action: action.action, result: { agentId: id, status: "running" } }));
    ok("ack", "final", "--receipt", receipt);
    if (idle) setAgent(id, "idle");
    return state().finalReview;
  };
  // A whole final review round, the way the orchestrator runs it: the mapping, the
  // prepared action, the external create_agent, its receipt, then the report.
  sb.finalReview = ({ verdict = "pass", findings = [], tip = state().integration.tip, rows = ["M1"], again = false, report = true, idle = true } = {}) => {
    sb.finalMapping(tip, rows);
    const action = JSON.parse(ok("final-review", "--prepare", ...(again ? ["--again"] : [])));
    const round = sb.ackFinal(action, { idle });
    if (report) writeFileSync(round.path, `Verdict: ${verdict}\nIntegration tip: ${tip}\n${findings.length ? findingsTable(findings, "Cross-ticket") : ""}`);
    return round;
  };
  // The mapping, a passing final reviewer and its report: what finish waits for.
  sb.finalPass = (opts = {}) => sb.finalReview({ ...opts, verdict: "pass" });
  sb.events = (kind) => readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((e) => !kind || e.kind === kind);

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

test("acceptance: lines yield their command; a line without one is manual; a placeholder is refused", () => {
  const text = [
    "# 02: Thing",
    "",
    "- [ ] the parser reads `x` — check: `node --test a.test.mjs`",
    "- [ ] either dash works -- CHECK: `npm run lint`",
    "- [ ] a single dash too - check: `npm test`",
    "- [ ] one command per line, the first backtick span — check: `npm test` (not `npm run check:links`)",
    "- [ ] a criterion with no command is manual",
    "- [ ] the pre-check: `npm run check:links`",
    "1. [ ] not a checklist line — check: `ignored`",
    "- [x] a ticked line still names a command — check: `node -e \"0\"`",
  ].join("\n");
  assert.deepEqual(acceptanceCommands("/x/02-b.md", text), [
    { criterion: "the parser reads `x`", command: "node --test a.test.mjs" },
    { criterion: "either dash works", command: "npm run lint" },
    { criterion: "a single dash too", command: "npm test" },
    { criterion: "one command per line, the first backtick span", command: "npm test" },
    { criterion: "a ticked line still names a command", command: 'node -e "0"' },
  ]);
  assert.throws(() => acceptanceCommands("/x/03-c.md", "- [ ] it works — check: `<command that proves it>`\n"), /template placeholder/);
  assert.throws(() => acceptanceCommands("/x/03-c.md", "- [ ] it works — check:\n"), /names no command/);
  assert.throws(() => acceptanceCommands("/x/01-a.md", readFileSync(join(HERE, "..", "..", "templates", "direct-ticket.md"), "utf8")), /template placeholder/);
});

test("criteria: a numbered line yields its ID, criterion and command; a numbered run refuses one without an ID or with a repeated one", () => {
  const text = [
    "# 02: Thing",
    "",
    "- [ ] AC1: the parser reads `x` — check: `node --test a.test.mjs`",
    "- [ ] AC2: a manual criterion",
    "- [ ] AC10: ten -- check: `npm test`",
  ].join("\n");
  assert.deepEqual(acceptanceCriteria("/x/02-b.md", text, { numbered: true }), [
    { id: "AC1", criterion: "the parser reads `x`", command: "node --test a.test.mjs" },
    { id: "AC2", criterion: "a manual criterion", command: null },
    { id: "AC10", criterion: "ten", command: "npm test" },
  ]);
  // Without the ID requirement a criterion reads as before, with no ID.
  assert.deepEqual(acceptanceCriteria("/x/02-b.md", "- [ ] works — check: `npm test`\n"), [{ id: null, criterion: "works", command: "npm test" }]);
  // An older run keeps the whole line's text, ID prefix and all.
  assert.deepEqual(acceptanceCriteria("/x/02-b.md", "- [ ] AC1: works — check: `npm test`\n"), [{ id: null, criterion: "AC1: works", command: "npm test" }]);
  // The refusal names the ticket and the line, and shows the line to write.
  assert.throws(() => acceptanceCriteria("/x/01-a.md", "# 01: A\n\n- [ ] works\n", { numbered: true }),
    /01-a\.md:3: the acceptance criterion "works" has no ID; write "- \[ \] AC1: works"/);
  assert.throws(() => acceptanceCriteria("/x/01-a.md", "- [ ] AC1: one\n- [ ] ac1: two\n", { numbered: true }),
    /01-a\.md:2: AC1 is already the ID of the criterion on line 1/);
  // A placeholder command is still refused, numbered or not.
  assert.throws(() => acceptanceCriteria("/x/01-a.md", "- [ ] AC1: it works — check: `<cmd>`\n", { numbered: true }), /template placeholder/);
});

test("criteria: init and import refuse an un-numbered or repeated criterion, naming the ticket and line", () => {
  const bad = sandbox({ init: null, tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] works — check: `npm test`\n" } });
  bad.no(/01-a\.md:5: the acceptance criterion "works" has no ID/, "init", "--feature", "feat", "--repo", bad.repo, "--check", CHECK);
  assert.equal(existsSync(join(bad.runDir, "state.json")), false);
  assert.equal(spawnSync("git", ["-C", bad.repo, "rev-parse", "--verify", "workloop/feat"], { env: bad.env }).status, 128);

  const dup = sandbox({ init: null, tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one — check: `npm test`\n- [ ] AC1: two\n" } });
  dup.no(/01-a\.md:6: AC1 is already the ID of the criterion on line 5/, "init", "--feature", "feat", "--repo", dup.repo, "--check", CHECK);

  const sb = sandbox();
  writeFileSync(join(sb.runDir, "issues", "04-d.md"), "# 04: D\n\nBlocked by: None\n\n- [ ] works — check: `npm test`\n");
  sb.no(/04-d\.md:5: the acceptance criterion "works" has no ID/, "import");
  assert.equal(sb.state().tasks["04"], undefined);
});

test("criteria: the direct and repair ticket templates number their criteria", () => {
  const templates = join(HERE, "..", "..", "templates");
  const direct = readFileSync(join(templates, "direct-ticket.md"), "utf8").replace("`<command that proves it>`", "`npm test`");
  assert.deepEqual(acceptanceCriteria("/x/01-a.md", direct, { numbered: true }), [
    { id: "AC1", criterion: "<criterion>", command: "npm test" },
    { id: "AC2", criterion: "The run's checks pass.", command: null },
  ]);
  const repair = readFileSync(join(templates, "repair-ticket.md"), "utf8").replace("`<the command under Reproduce>`", "`npm test`");
  assert.deepEqual(acceptanceCriteria("/x/02-fix-a.md", repair, { numbered: true }).map((c) => [c.id, c.criterion]), [
    ["AC1", "The command under Reproduce gives the expected result"],
    ["AC2", "A regression test fails on `<sha>` and passes with the fix."],
    ["AC3", "The run's checks pass."],
  ]);
});

test("criteria: init and import record each ticket's confirmed set", () => {
  const sb = sandbox();
  assert.deepEqual(sb.state().tasks["01"].criteria, [{ id: "AC1", criterion: "works", command: null }]);
  assert.deepEqual(sb.state().tasks["02"].criteria, [], "a ticket with no checklist confirms an empty set");
  writeFileSync(join(sb.runDir, "issues", "04-d.md"), "# 04: D\n\nBlocked by: None\n\n- [ ] AC1: works — check: `node --version`\n- [ ] AC2: manual\n");
  sb.ok("import");
  assert.deepEqual(sb.state().tasks["04"].criteria, [
    { id: "AC1", criterion: "works", command: "node --version" },
    { id: "AC2", criterion: "manual", command: null },
  ]);
  // An import leaves the confirmed set of a ticket already in the run alone: only
  // `criteria <NN>` replaces it, after the user agreed.
  writeFileSync(join(sb.runDir, "issues", "04-d.md"), "# 04: D\n\nBlocked by: None\n\n- [ ] AC1: reworded — check: `node --version`\n");
  sb.ok("import");
  assert.deepEqual(sb.state().tasks["04"].criteria, [
    { id: "AC1", criterion: "works", command: "node --version" },
    { id: "AC2", criterion: "manual", command: null },
  ]);
});

test("criteria: dispatch, freeze and integrate refuse a changed set, naming the ticket, the changed IDs and the command", () => {
  const sb = sandbox({ tickets: {
    "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one — check: `node --version`\n- [ ] AC2: two\n",
    "02-b.md": "# 02: B\n\nBlocked by: None\n\n- [ ] AC1: three — check: `node --version`\n- [ ] AC2: four\n",
  } });
  const two = join(sb.runDir, "issues", "02-b.md");
  const twoTicket = (criteria) => `# 02: B\n\nBlocked by: None\n\n${criteria}`;
  const refused = (out, id, ids) => {
    assert.match(out, new RegExp(`^workloop: #${id}: its acceptance criteria changed since the user confirmed them \\(${ids}\\)\\.`));
    assert.match(out, new RegExp(`\`criteria ${id} --reason "<the user's decision>"\``));
  };
  // A reworded criterion, an added ID, a removed ID and a changed command all count.
  writeFileSync(two, twoTicket("- [ ] AC1: three, reworded — check: `node --version`\n- [ ] AC2: four\n"));
  refused(sb.no(/#02: its acceptance criteria changed/, "dispatch", "02"), "02", "AC1");
  writeFileSync(two, twoTicket("- [ ] AC1: three — check: `node --version`\n"));
  refused(sb.no(/#02: its acceptance criteria changed/, "dispatch", "02"), "02", "AC2");
  writeFileSync(two, twoTicket("- [ ] AC1: three — check: `node --version`\n- [ ] AC2: four\n- [ ] AC3: new\n"));
  refused(sb.no(/#02: its acceptance criteria changed/, "dispatch", "02"), "02", "AC3");
  writeFileSync(two, twoTicket("- [ ] AC1: three — check: `node -e \"0\"`\n- [ ] AC2: four\n"));
  refused(sb.no(/#02: its acceptance criteria changed/, "dispatch", "02"), "02", "AC1");
  writeFileSync(two, twoTicket("- [ ] AC1: three — check: `node --version`\n- [ ] AC2: four\n"));
  sb.ok("dispatch", "02");

  // freeze, reached through `review`.
  sb.ok("dispatch", "01");
  sb.work("01");
  const one = join(sb.runDir, "issues", "01-a.md");
  writeFileSync(one, "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one — check: `node -e \"0\"`\n- [ ] AC2: two\n");
  refused(sb.no(/#01: its acceptance criteria changed/, "review", "01"), "01", "AC1");
  assert.equal(sb.state().tasks["01"].status, "running", "a refused freeze leaves the task running");
  sb.ok("criteria", "01", "--reason", "the user chose the cheaper command");
  assert.match(sb.ok("review", "01"), /#01 frozen at/);
  sb.reviewed("01");

  // integrate.
  writeFileSync(one, "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one — check: `node -e \"0\"`\n- [ ] AC2: two, reworded\n");
  refused(sb.no(/#01: its acceptance criteria changed/, "integrate", "01"), "01", "AC2");
  assert.equal(sb.state().tasks["01"].status, "in_review", "a refused integrate merges nothing");
  sb.ok("criteria", "01", "--reason", "the user reworded AC2");
  assert.match(sb.ok("integrate", "01"), /#01 integrated: /);
});

test("criteria: criteria records the new set only after the user's agreement, and finish lists every change", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one — check: `node --version`\n" } });
  sb.ok("dispatch", "01");
  const file = join(sb.runDir, "issues", "01-a.md");
  writeFileSync(file, "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one, reworded — check: `node --version`\n");
  sb.no(/^workloop: criteria needs --reason/, "criteria", "01");
  assert.deepEqual(sb.state().tasks["01"].criteria, [{ id: "AC1", criterion: "one", command: "node --version" }], "no reason, no change");
  assert.match(sb.ok("criteria", "01", "--reason", "the user reworded AC1"), /#01: recorded the user's change to AC1/);
  const s = sb.state();
  assert.deepEqual(s.tasks["01"].criteria, [{ id: "AC1", criterion: "one, reworded", command: "node --version" }]);
  assert.deepEqual(s.criteriaChanges.map(({ task, ids, reason }) => ({ task, ids, reason })), [{ task: "01", ids: ["AC1"], reason: "the user reworded AC1" }]);
  assert.deepEqual(sb.events("criteria").map(({ task, ids, reason }) => ({ task, ids, reason })), [{ task: "01", ids: ["AC1"], reason: "the user reworded AC1" }]);
  // A run of `criteria` that finds nothing changed records nothing.
  assert.match(sb.ok("criteria", "01", "--reason", "nothing new"), /unchanged; nothing recorded/);
  assert.equal(sb.state().criteriaChanges.length, 1);

  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("integrate", "01");
  sb.finalPass();
  assert.match(sb.ok("finish"), /acceptance criteria changed during the run — each followed the user's agreement:\n- #01 AC1: the user reworded AC1/);
});

test("criteria: a run whose state predates numbered criteria reads tickets as before and finish says none changed", () => {
  const sb = sandbox();
  sb.legacy();
  // An un-numbered criterion is accepted, and a changed one gates nothing.
  writeFileSync(join(sb.runDir, "issues", "01-schema.md"), "# 01: Schema\n\n**Blocked by:** None\n\n- [ ] works, reworded — check: `node --version`\n");
  writeFileSync(join(sb.runDir, "issues", "04-d.md"), "# 04: D\n\nBlocked by: None\n\n- [ ] works — check: `node --version`\n");
  assert.match(sb.ok("import"), /added #04 D/);
  assert.equal(sb.state().tasks["04"].criteria, undefined);
  sb.ok("dispatch", "01");
  assert.equal(sb.state().tasks["01"].criteria, undefined);
  assert.match(sb.no(/^workloop: this run predates numbered acceptance criteria/, "criteria", "01"), /reads its tickets as before/);
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("integrate", "01");
  for (const id of ["02", "03", "04"]) sb.ok("cancel", id, "--reason", "not needed");
  sb.finalPass();
  assert.match(sb.ok("finish"), /acceptance criteria changed during the run: none/);
});

test("criteria: an older run keeps the whole criterion text, AC prefix and all", () => {
  const sb = sandbox();
  sb.legacy();
  writeFileSync(join(sb.runDir, "issues", "01-schema.md"),
    "# 01: Schema\n\n**Blocked by:** None\n\n- [ ] AC1: first — check: `node --version`\n- [ ] second, un-numbered — check: `node --version`\n");
  sb.ok("import");
  assert.equal(sb.state().tasks["01"].criteria, undefined, "an older run records no confirmed set");
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("integrate", "01");
  const acceptance = [
    { criterion: "AC1: first", command: "node --version" },
    { criterion: "second, un-numbered", command: "node --version" },
  ];
  assert.deepEqual(sb.state().tasks["01"].acceptance, acceptance, "integrate stores the line's complete text");
  assert.deepEqual(JSON.parse(sb.ok("status", "--json")).tasks.find((t) => t.id === "01").acceptance, acceptance);
});

test("criteria: integrate re-checks the confirmed criteria after its checks and rolls back on drift", async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one — check: `node --version`\n" } });
  const held = sb.heldCheck();
  sb.ok("config", "--check", held.cmd);
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01");
  const tip = sb.state().integration.tip;
  const run = sb.start("integrate", "01");
  await sb.waitFor("the check's identity", () => sb.state().checking?.check && sb.state().checking);
  // The ticket changes while the checks run, which `criteria` cannot be asked to
  // record meanwhile: the drift is caught when the result is recorded.
  writeFileSync(join(sb.runDir, "issues", "01-a.md"),
    "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one, reworded — check: `node -e \"0\"`\n- [ ] AC2: added — check: `node --version`\n");
  sb.no(/check phase: integrate on #01/, "criteria", "01", "--reason", "tried during the checks");
  held.release();
  const { code, out } = await run.done;
  assert.notEqual(code, 0, out);
  assert.match(out, /#01: its acceptance criteria changed since the user confirmed them \(AC1, AC2\)/);
  assert.match(out, /`criteria 01 --reason "<the user's decision>"`/);
  assert.match(out, /integration rolled back to/);
  const s = sb.state();
  assert.equal(s.integration.tip, tip);
  assert.equal(sb.g(s.integration.worktree, "rev-parse", "HEAD"), tip);
  assert.equal(s.tasks["01"].status, "in_review");
  assert.equal(s.checking, null);
  const failed = sb.events("integrate_failed").at(-1);
  assert.equal(failed.rolledBack, true);
  assert.match(failed.gate, /its acceptance criteria changed .*\(AC1, AC2\)/);
  // Recorded after the fact, the same integrate goes through.
  sb.ok("criteria", "01", "--reason", "the user reworded AC1 and added AC2");
  assert.match(sb.ok("integrate", "01"), /#01 integrated: /);
  assert.equal(sb.state().tasks["01"].status, "done");
});

test("waiver: the findings table is read by header name, and a row is blocking when Blocking starts with yes", () => {
  const text = [
    "Verdict: changes_requested",
    "Candidate: 1234",
    "",
    "| **ID** | _Axis_ | Location | **Basis** | Blocking | Fix acceptance |",
    "|:-------|:-------|:---------|:----------|:---------|:---------------|",
    "| **S1** | Standards | src/a.ts:12 | Dead branch, `if (x) return;` is unreachable | **yes** — must fix | dead branch gone |",
    "| P2 | Spec | src/b.ts:3 | AC2: \"the parser reads `x`\", quoted | no | none |",
    "| S3 | Standards | src/c.ts:9 | Regression: `npm test` fails | YES | green |",
    "| not-a-finding | Standards | src/d.ts:1 | prose, not a finding | yes | none |",
    "",
    "| ID | Axis | Location | Basis | Blocking |",
    "|----|------|----------|-------|----------|",
    "| S9 | Standards | src/e.ts:1 | a later table is not this one | yes |",
  ].join("\n");
  assert.deepEqual(parseFindings(text), [
    { id: "S1", axis: "Standards", location: "src/a.ts:12", basis: "Dead branch, `if (x) return;` is unreachable", blocking: true },
    { id: "P2", axis: "Spec", location: "src/b.ts:3", basis: 'AC2: "the parser reads `x`", quoted', blocking: false },
    { id: "S3", axis: "Standards", location: "src/c.ts:9", basis: "Regression: `npm test` fails", blocking: true },
  ]);
  // An escaped pipe stays in its cell; emphasis around a header name is tolerated.
  assert.deepEqual(parseFindings("| ID | Basis | Blocking |\n|---|---|---|\n| P1 | spec says a \\| b | yes |\n"),
    [{ id: "P1", axis: "", location: "", basis: "spec says a | b", blocking: true }]);
  // No table with both columns is unparseable, not an empty findings list.
  assert.equal(parseFindings("Verdict: pass\n\nNo findings.\n"), null);
  assert.equal(parseFindings("| ID | Axis |\n|---|---|\n| S1 | Standards |\n"), null);
  assert.deepEqual(parseFindings("| ID | Axis | Basis | Blocking |\n|---|---|---|---|\n"), []);
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

// #01 dispatched, reviewed with a changes_requested whose table holds blocking
// S1 and S3 and non-blocking P2. Its two confirmed criteria are what S3 cites, so
// every blocking finding here is inside the review's boundary.
function reworkable() {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\n**Blocked by:** None\n\n- [ ] AC1: the first criterion\n- [ ] AC2: the parser reads `x`\n" } });
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01", "changes_requested", [
    { id: "S1", blocking: true, basis: "Regression: `npm test` fails" },
    { id: "P2", blocking: false, basis: "AC1: the criterion" },
    { id: "S3", blocking: true, axis: "Spec", basis: "AC2: the parser reads `x`" },
  ]);
  return sb;
}

test("waiver: a rework send must name or waive every blocking finding of the review", () => {
  const sb = reworkable();
  // Nothing named: refused, listing both blocking IDs and how to account for them.
  const out = sb.no(/the rework message does not account for blocking findings S1, S3/, "send", "01", "--text", "Please rework.");
  assert.match(out, /--waive <IDs> --reason/);
  // One named is not enough, and a longer word is not the finding.
  sb.no(/does not account for blocking finding S1/, "send", "01", "--text", "S12 is a different identifier; S3 is real.");
  sb.no(/does not account for blocking finding S3/, "send", "01", "--text", "S1 is fixed?");
  assert.equal(sb.state().tasks["01"].status, "in_review");
  // Both named: the rework proceeds and opens a round.
  sb.ok("send", "01", "--text", "Fix S1 and S3, per the review.");
  assert.equal(sb.state().tasks["01"].status, "running");
  assert.equal(sb.state().tasks["01"].rounds, 1);
});

test("waiver: --waive needs a reason, and an ID that is a blocking finding of that review", () => {
  const sb = reworkable();
  sb.no(/--waive needs --reason/, "send", "01", "--text", "Please rework.", "--waive", "S1");
  sb.no(/P2 is not a blocking finding of #01's review; blocking: S1, S3/, "send", "01", "--text", "Please rework.", "--waive", "P2", "--reason", "it is fine");
  sb.no(/P9 is not a blocking finding/, "send", "01", "--text", "Please rework.", "--waive", "S1,P9", "--reason", "typo in the ID");
  // A waived finding need not be named in the message; the rest still must be.
  sb.no(/does not account for blocking finding S3/, "send", "01", "--text", "Please rework.", "--waive", "S1", "--reason", "pre-existing defect, tracked separately");
  sb.ok("send", "01", "--text", "Fix S3 only.", "--waive", "S1", "--reason", "pre-existing defect, tracked separately");
  const w = sb.state().waivers;
  assert.equal(w.length, 1);
  assert.deepEqual(Object.keys(w[0]).sort(), ["at", "findings", "kind", "reason", "review", "sha", "task"]);
  assert.equal(w[0].kind, "rework");
  assert.equal(w[0].task, "01");
  assert.equal(w[0].sha, sb.state().tasks["01"].history[0].candidateSha);
  assert.equal(w[0].review, sb.state().tasks["01"].history[0].review.path);
  assert.equal(w[0].reason, "pre-existing defect, tracked separately");
  assert.deepEqual(w[0].findings, [{ id: "S1", axis: "Standards", location: "src/x.ts:1", basis: "Regression: `npm test` fails", blocking: true }]);
  assert.equal(sb.events("waiver").length, 1);
  assert.equal(sb.events("waiver")[0].waiver, "rework");
  assert.deepEqual(sb.events("waiver")[0].findings.map((f) => f.id), ["S1"]);
});

test("waiver: a review whose findings cannot be read only warns, and the send proceeds", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\n**Blocked by:** None\n" } });
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01", "changes_requested"); // no findings table
  const out = sb.ok("send", "01", "--text", "Please rework, per the attached review.");
  assert.match(out, /warning: #01: cannot read the blocking findings/);
  assert.equal(sb.state().tasks["01"].status, "running");
  assert.equal(sb.state().waivers, undefined);
});

test("waiver: a prepared rework send records its waivers at ack, a legacy one at once", () => {
  const sb = reworkable();
  const action = JSON.parse(sb.ok("send", "01", "--prepare", "--text", "Fix S3.", "--waive", "S1", "--reason", "pre-existing"));
  assert.equal(action.waiver.kind, "rework");
  assert.deepEqual(action.waiver.findings.map((f) => f.id), ["S1"]);
  // Prepared: the message is not sent yet, so nothing is let through yet.
  assert.equal(sb.state().waivers, undefined);
  deliver(sb, action);
  const s = sb.state();
  assert.equal(s.waivers.length, 1);
  assert.equal(s.waivers[0].reason, "pre-existing");
  assert.equal(s.tasks["01"].status, "running");

  // Second round, sent through the legacy CLI: recorded with the send.
  sb.setAgent(s.tasks["01"].agentId, "idle");
  sb.work("01", { files: { "f01.txt": "reworked\n" } });
  sb.ok("review", "01", "--again");
  sb.reviewed("01", "changes_requested", [{ id: "S5", blocking: true, basis: "AC1: the first criterion" }]);
  sb.ok("send", "01", "--text", "Fix the rest.", "--waive", "S5", "--reason", "cosmetic, accepted");
  assert.equal(sb.state().waivers.length, 2);
  assert.equal(sb.state().waivers[1].findings[0].id, "S5");
});

test("waiver: a prepared send keeps its waiver when the event append fails after the save", () => {
  const sb = reworkable();
  const action = JSON.parse(sb.ok("send", "01", "--prepare", "--text", "Fix S3.", "--waive", "S1", "--reason", "pre-existing"));
  const receipt = join(sb.root, "receipt.json");
  writeFileSync(receipt, JSON.stringify({ action: action.action, result: { success: true } }));
  const undo = sb.failEventAppend();
  const crashed = sb.wl("ack", "01", "--receipt", receipt);
  assert.notEqual(crashed.code, 0, crashed.out);
  assert.match(crashed.out, /injected event append failure/);

  // The state write that acknowledged the send carried the waiver with it, so the
  // crash cost the log lines and nothing else.
  const s = sb.state();
  assert.equal(s.tasks["01"].status, "running");
  assert.equal(s.tasks["01"].pendingAction, null);
  assert.equal(s.tasks["01"].lastAction, action.action);
  assert.equal(s.waivers.length, 1);
  assert.equal(s.waivers[0].findings[0].id, "S1");
  assert.equal(sb.events("send").length, 0);
  assert.equal(sb.events("waiver").length, 0);
  undo();

  // Retrying the receipt finds the action acknowledged and records nothing twice.
  assert.match(sb.ok("ack", "01", "--receipt", receipt), /already acknowledged/);
  assert.equal(sb.state().waivers.length, 1);
  assert.match(sb.ok("status"), /waived findings: 1/);
});

test("waiver: a legacy send keeps its waiver when the event append fails after the save", () => {
  const sb = reworkable();
  const undo = sb.failEventAppend();
  const crashed = sb.wl("send", "01", "--text", "Fix S3.", "--waive", "S1", "--reason", "pre-existing");
  assert.notEqual(crashed.code, 0, crashed.out);
  assert.match(crashed.out, /injected event append failure/);

  const s = sb.state();
  assert.equal(s.tasks["01"].status, "running");
  assert.equal(s.tasks["01"].rounds, 1);
  assert.equal(s.tasks["01"].messages, 1);
  assert.equal(s.waivers.length, 1);
  assert.equal(s.waivers[0].reason, "pre-existing");
  assert.equal(sb.events("send").length, 0);
  assert.equal(sb.events("waiver").length, 0);
  // Retrying the same send cannot record it twice: the task is running now, so the
  // waiver is not re-accounted, and the ledger already holds it.
  sb.no(/--waive applies only to a rework send/, "send", "01", "--text", "Fix S3.", "--waive", "S1", "--reason", "pre-existing");
  assert.equal(sb.state().waivers.length, 1);
  undo();

  // The next commands see one waiver, and a later send cannot record it again.
  assert.match(sb.ok("status"), /waived findings: 1/);
  sb.setAgent(s.tasks["01"].agentId, "idle");
  sb.ok("send", "01", "--text", "Carry on with S3.");
  assert.equal(sb.state().waivers.length, 1);
  assert.match(sb.ok("status"), /waived findings: 1/);
});

test("waiver: integrate --override records every blocking finding it lets through", () => {
  const sb = reworkable();
  sb.ok("send", "01", "--text", "Fix S1 and S3.", "--waive", "S1", "--reason", "accepted once");
  sb.work("01", { files: { "f01.txt": "reworked\n" } });
  sb.ok("review", "01", "--again");
  sb.reviewed("01", "changes_requested", [{ id: "S6", blocking: true, basis: "AC2: still wrong" }, { id: "P7", blocking: false }]);
  const t = sb.state().tasks["01"];
  sb.no(/verdict is changes_requested/, "integrate", "01");
  sb.ok("integrate", "01", "--override", "S6 is a known limitation the user accepted");
  const w = sb.state().waivers.at(-1);
  assert.equal(w.kind, "override");
  assert.equal(w.task, "01");
  assert.equal(w.review, t.review.path);
  assert.equal(w.sha, t.candidateSha);
  assert.equal(w.reason, "S6 is a known limitation the user accepted");
  assert.deepEqual(w.findings, [{ id: "S6", axis: "Standards", location: "src/x.ts:1", basis: "AC2: still wrong", blocking: true }]);
  // Recorded with the integration result, on the reloaded state.
  assert.equal(sb.state().tasks["01"].override, "S6 is a known limitation the user accepted");
});

test("waiver: an override of a missing or unreadable review is noted in the ledger", () => {
  const never = sandbox({ tickets: { "01-a.md": "# 01: A\n\n**Blocked by:** None\n" } });
  never.ok("dispatch", "01");
  never.work("01");
  never.ok("freeze", "01"); // a candidate with no review at all
  never.no(/review verdict is missing/, "integrate", "01");
  never.ok("integrate", "01", "--override", "the user read the diff themselves");
  const missing = never.state().waivers.at(-1);
  assert.equal(missing.kind, "override");
  assert.equal(missing.review, null);
  assert.deepEqual(missing.findings, []);
  assert.match(missing.note, /review was missing/);

  const unreadable = sandbox({ tickets: { "01-a.md": "# 01: A\n\n**Blocked by:** None\n" } });
  unreadable.ok("dispatch", "01");
  unreadable.work("01");
  unreadable.ok("review", "01");
  unreadable.reviewed("01", "changes_requested"); // prose, no findings table
  unreadable.ok("integrate", "01", "--override", "the reviewer's prose covers it");
  const poor = unreadable.state().waivers.at(-1);
  assert.deepEqual(poor.findings, []);
  assert.match(poor.note, /could not be read/);
});

test("waiver: status counts the ledger, --json carries it, and finish lists every entry", () => {
  const sb = reworkable();
  assert.doesNotMatch(sb.ok("status"), /waived findings/);
  sb.ok("send", "01", "--text", "Fix S3.", "--waive", "S1", "--reason", "pre-existing defect");
  assert.match(sb.ok("status"), /waived findings: 1/);
  const json = JSON.parse(sb.ok("status", "--json"));
  assert.equal(json.waivers.length, 1);
  assert.equal(json.waivers[0].findings[0].id, "S1");
  sb.work("01", { files: { "f01.txt": "reworked\n" } });
  sb.ok("review", "01", "--again");
  sb.reviewed("01");
  sb.ok("integrate", "01");
  assert.match(sb.ok("status"), /waived findings: 1/);
  sb.finalPass();
  const out = sb.ok("finish");
  assert.match(out, /waived findings — the user should review this entry:/);
  assert.match(out, /#01 S1 · rework · Standards · src\/x\.ts:1 · Regression: `npm test` fails · reason: pre-existing defect/);
});

test("waiver: a run whose state has no ledger finishes as before and says there are none", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\n**Blocked by:** None\n" } });
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("integrate", "01");
  const st = sb.state();
  delete st.waivers;
  writeFileSync(join(sb.runDir, "state.json"), JSON.stringify(st));
  assert.doesNotMatch(sb.ok("status"), /waived findings/);
  assert.deepEqual(JSON.parse(sb.ok("status", "--json")).waivers, []);
  sb.finalPass();
  assert.match(sb.ok("finish"), /waived findings: none/);
});

// ---------------------------------------------- review boundary (ticket #07)

test("boundary: a Basis cites a confirmed criterion or a floor class; anything else is a suggestion", () => {
  const ids = ["AC1", "AC2"];
  const inB = (basis) => inBoundary({ basis }, ids);
  // A confirmed ID, however it is emphasised or cased, leads the cell.
  for (const basis of ["AC2: the parser reads `x`", "**AC1:** one", "ac2: lower case still cites", "_AC2_: emphasised", "  AC1 : spaced before the colon"]) {
    assert.equal(inB(basis), true, basis);
  }
  // Another ticket's ID, or an ID this ticket never confirmed, is out of boundary.
  assert.equal(inB("AC3: the parser reads `x`"), false);
  assert.equal(inB("AC12: ten"), false);
  // The four floor classes hold, in the spellings a reviewer reaches for.
  for (const basis of ["Regression: `npm test` fails", "Data loss: deletes the worktree", "Data-loss: drops a branch", "Security: shell injection", "ADR: docs/adr/0003-x.md forbids this", "ADR-0003: contradicts the ADR"]) {
    assert.equal(inB(basis), true, basis);
  }
  assert.equal(citedBasis("ADR-0003: contradicts it").floor, "ADR");
  // Everything else: a smell in no floor class, a citation that does not lead, a bare ID.
  for (const basis of ["the function is long", "see AC1 for why", "S1: quoted", "", "AC: no number", "AC1 - no colon"]) {
    assert.equal(inB(basis), false, basis);
  }
  assert.deepEqual(citedBasis("AC2: x"), { id: "AC2", floor: null });
  assert.deepEqual(citedBasis("Regression: x"), { id: null, floor: "Regression" });
  // A review's `## Out of scope` list, one suggestion per line, up to the next heading.
  const report = "Verdict: pass\n\n## Out of scope\n- the helper could move to its own module\n2) naming in src/b.ts\n\n## Notes\nnot a suggestion\n";
  assert.deepEqual(outOfScope(report), ["the helper could move to its own module", "naming in src/b.ts"]);
  assert.deepEqual(outOfScope("## Spec\nnothing here\n"), []);
});

test("boundary: status reports an out-of-boundary blocking finding as a suggestion, and integrate needs no override", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n" } });
  assert.equal(sb.state().config.maxReworkRounds, 2, "the cap defaults to 2 rounds");
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01", "changes_requested", [{ id: "S1", blocking: true, basis: "the function is long and could be split" }]);
  const out = sb.ok("status");
  assert.match(out, /out-of-boundary findings: 1 blocking finding outside the reviews' boundary — the user decides these, and nothing gates on them:/);
  assert.match(out, /- #01 S1 · Standards · src\/x\.ts:1 · the function is long and could be split/);
  assert.deepEqual(JSON.parse(sb.ok("status", "--json")).suggestions.map((f) => [f.task, f.id]), [["01", "S1"]]);
  // The next step is integration, not another rework round.
  assert.match(out, /integrate 01 — the review's blocking findings are all outside its boundary/);
  // No override, no waiver: the finding never gated anything.
  assert.match(sb.ok("integrate", "01"), /#01: 1 blocking finding out of the review's boundary \(S1\); it is a suggestion/);
  const s = sb.state();
  assert.equal(s.tasks["01"].status, "done");
  assert.equal(s.tasks["01"].override ?? null, null);
  assert.equal(s.waivers, undefined);
});

test("boundary: a rework accounts for, and an override records, only the in-boundary blocking findings", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n- [ ] AC2: two\n" } });
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01", "changes_requested", [
    { id: "S1", blocking: true, basis: "AC2: two" },
    { id: "S2", blocking: true, basis: "the naming could be clearer" },
  ]);
  // S2 is a suggestion, so only S1 needs accounting.
  sb.no(/does not account for blocking finding S1;/, "send", "01", "--text", "Rework please.");
  sb.no(/S2 is out of #01's review boundary .* it is a suggestion and needs no waiver/, "send", "01", "--text", "Fix S1.", "--waive", "S2", "--reason", "cosmetic");
  assert.equal(sb.state().tasks["01"].status, "in_review");
  sb.ok("send", "01", "--text", "Fix S1: quote the criterion.");
  assert.equal(sb.state().tasks["01"].rounds, 1);

  sb.work("01", { files: { "f01.txt": "reworked\n" } });
  sb.ok("review", "01");
  sb.reviewed("01", "changes_requested", [
    { id: "S5", blocking: true, axis: "Spec", basis: "**Regression:** `npm test` fails" },
    { id: "S6", blocking: true, basis: "a smell in no floor class" },
  ]);
  sb.no(/verdict is changes_requested/, "integrate", "01");
  sb.ok("integrate", "01", "--override", "S5 is a known limitation the user accepted");
  assert.deepEqual(sb.state().waivers.at(-1).findings.map((f) => f.id), ["S5"]);
});

test("boundary: the reviewer brief states the boundary, the floor classes and the verdict rule", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n" } });
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  const brief = readFileSync(join(sb.runDir, "briefs", `01-review-${sb.state().tasks["01"].candidateSha.slice(0, 8)}.md`), "utf8");
  assert.doesNotMatch(brief, /\{\{/);
  assert.match(brief, /## Boundary\n/);
  // A Basis leads with the citation, a confirmed criterion or a floor class.
  assert.match(brief, /A finding's `Basis` cell starts with what it cites/);
  assert.match(brief, /`AC2: <the criterion, quoted>`/);
  for (const floor of ["Regression", "Data loss", "Security", "ADR"]) {
    assert.match(brief, new RegExp("`" + floor + ": <[^`]*>`"), floor);
  }
  // The ADR rule: valid on the base, superseded ones never, a needed change is the user's.
  assert.match(brief, /valid on the candidate's base/);
  assert.match(brief, /Superseded ADRs .* are never grounds/);
  assert.match(brief, /the decision is the user's/);
  // Everything else under `## Out of scope`, with no ID, never blocking.
  assert.match(brief, /Write each one as a line under `## Out of scope`, with no finding ID and never blocking/);
  assert.match(brief, /## Out of scope\n- /);
  // The verdict tracks in-boundary blocking findings only.
  assert.match(brief, /`Verdict: changes_requested` exactly when a finding that cites a criterion or a floor class is blocking, and `Verdict: pass` otherwise/);
});

test("boundary: a direct run's reviewer brief carries the same boundary, and a scope overstep needs a basis to block", () => {
  const sb = sandbox({ init: null, tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\nScope: f01.txt\n\n- [ ] AC1: one\n" } });
  rmSync(join(sb.runDir, "spec.md"));
  sb.ok("init", "--direct", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  const brief = readFileSync(join(sb.runDir, "briefs", `01-review-${sb.state().tasks["01"].candidateSha.slice(0, 8)}.md`), "utf8");
  assert.doesNotMatch(brief, /\{\{/);
  assert.match(brief, /## Boundary\n/);
  assert.match(brief, /`Data loss: <[^`]*>`/);
  const addendum = brief.slice(brief.indexOf("## Direct run"));
  // A B finding blocks only on a confirmed criterion or a floor class.
  assert.match(addendum, /A Boundary finding blocks only when its `Basis` cites a confirmed criterion or a floor class/);
  assert.match(addendum, /Any other overstep, and any open product decision, is a line under `## Out of scope` for the user, never a finding ID/);
  // A direct re-review keeps the three-part limit.
  assert.match(addendum, /The three-part limit still applies\.[^\n]*previous in-boundary blocking finding still unfixed, an acceptance command, or a floor-class problem the change introduced/);
});

test("boundary: a re-review brief adds the previous review, its candidate and the change since, and raises nothing else", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one — check: `node --version`\n" } });
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  const first = sb.state().tasks["01"];
  const firstBrief = readFileSync(join(sb.runDir, "briefs", `01-review-${first.candidateSha.slice(0, 8)}.md`), "utf8");
  assert.doesNotMatch(firstBrief, /## Re-review/);
  sb.reviewed("01", "changes_requested", [{ id: "S1", blocking: true, basis: "AC1: one" }]);
  sb.ok("send", "01", "--text", "Fix S1.");
  sb.work("01", { files: { "f01.txt": "reworked\n" } });
  sb.ok("review", "01");
  const second = sb.state().tasks["01"];
  assert.notEqual(second.candidateSha, first.candidateSha);
  const brief = readFileSync(join(sb.runDir, "briefs", `01-review-${second.candidateSha.slice(0, 8)}.md`), "utf8");
  assert.match(brief, /## Re-review\n/);
  assert.ok(brief.includes(`The previous review is \`${slash(first.review.path)}\``), brief);
  assert.ok(brief.includes(`written for candidate \`${first.candidateSha}\``));
  assert.ok(brief.includes(`git diff ${first.candidateSha}..${second.candidateSha}`));
  assert.match(brief, /\*\*Confirm each previous in-boundary blocking finding\*\*: fixed, or not fixed[\s\S]*\*\*Re-run every acceptance command\*\*[\s\S]*\*\*Look for floor-class problems/);
  assert.match(brief, /Raise no other new findings/);
});

test("boundary: a re-review cites the most recent completed review, and every displaced review survives to finish", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n" } });
  const briefOf = (sha) => readFileSync(join(sb.runDir, "briefs", `01-review-${sha.slice(0, 8)}.md`), "utf8");
  const suggest = (review, text) => writeFileSync(review.path, `${readFileSync(review.path, "utf8")}\n## Out of scope\n- ${text}\n`);
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  const one = sb.state().tasks["01"];
  sb.reviewed("01", "changes_requested", [{ id: "S1", blocking: true, basis: "a smell in no floor class" }]);
  suggest(one.review, "suggestion from review one");
  sb.ok("send", "01", "--text", "Rework, per the review.");
  assert.equal(sb.state().tasks["01"].rounds, 1);

  sb.work("01", { files: { "f01.txt": "reworked\n" } });
  sb.ok("review", "01");
  const two = sb.state().tasks["01"];
  sb.reviewed("01", "changes_requested", [{ id: "P9", blocking: true, basis: "another smell in no floor class" }]);
  suggest(two.review, "suggestion from review two");
  // After a rework, the re-review cites the review it answers.
  assert.ok(briefOf(two.candidateSha).includes(`The previous review is \`${slash(one.review.path)}\``));

  // `--again` on the CLI: the newest review is the one it follows, not the oldest.
  sb.ok("review", "01", "--again");
  const again = sb.state().tasks["01"];
  const againBrief = briefOf(again.candidateSha);
  assert.ok(againBrief.includes(`The previous review is \`${slash(two.review.path)}\``), againBrief);
  assert.ok(!againBrief.includes(slash(one.review.path)), "the older review is not the one it follows");
  sb.reviewed("01", "changes_requested");
  suggest(again.review, "suggestion from review three");

  // `--again` through a prepared action: the displaced review is kept at ack, and
  // the brief still cites the newest one.
  const action = JSON.parse(sb.ok("review", "01", "--prepare", "--again"));
  assert.deepEqual(action.criteria, ["AC1"]);
  const before = sb.state().tasks["01"];
  assert.equal(before.review.agentId, again.review.agentId, "the action has not displaced the review yet");
  deliver(sb, action);
  const after = sb.state().tasks["01"];
  assert.ok(after.history.some((h) => h.review?.path === again.review.path), "the displaced review stays in history");
  const preparedBrief = briefOf(after.candidateSha);
  assert.ok(preparedBrief.includes(`The previous review is \`${slash(again.review.path)}\``), preparedBrief);
  // The cited reviews are untouched, so their blocking finding IDs are still there.
  for (const [path, id] of [[one.review.path, "S1"], [two.review.path, "P9"]]) {
    assert.match(readFileSync(path, "utf8"), new RegExp(`\\| ${id} \\|`), path);
  }
  assert.match(readFileSync(again.review.path, "utf8"), /suggestion from review three/);
  sb.reviewed("01");

  sb.ok("integrate", "01");
  sb.finalPass();
  const out = sb.ok("finish");
  // Every displaced review's finding and suggestion, each named exactly once.
  const once = (needle) => (out.split(needle).length - 1);
  assert.equal(once("- #01 S1 · Standards"), 1, out);
  assert.equal(once("suggestion from review one"), 1);
  assert.equal(once("- #01 P9 · Standards"), 1);
  assert.equal(once("suggestion from review two"), 1);
  assert.equal(once("suggestion from review three"), 1);
});

test("boundary: a rework send past the cap refuses and says to ask the user; --extra-round --reason records it", () => {
  const sb = sandbox({ init: ["--max-rework-rounds", "1"], tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n" } });
  assert.equal(sb.state().config.maxReworkRounds, 1);
  sb.ok("dispatch", "01");
  const round = (n) => {
    sb.work("01", { files: { "f01.txt": `round ${n}\n` } });
    sb.ok("review", "01");
    sb.reviewed("01", "changes_requested", [{ id: "S1", blocking: true, basis: "AC1: one" }]);
  };
  round(1);
  sb.ok("send", "01", "--text", "Fix S1.");
  assert.equal(sb.state().tasks["01"].rounds, 1);

  round(2);
  // Round 2 would pass the cap of 1: the task waits for the user.
  const out = sb.no(/rework round 2 would pass the run's cap of 1\. The task waits for the user/, "send", "01", "--text", "Fix S1 again.");
  assert.match(sb.ok("status"), /#01 changes requested, and at the rework cap \(1\) — ask the user, then `send 01 --prepare --extra-round --reason "<their decision>"`/);
  assert.match(out, /`send 01 --extra-round --reason "<the user's decision>"`/);
  sb.no(/--extra-round needs --reason/, "send", "01", "--text", "Fix S1 again.", "--extra-round");
  assert.equal(sb.state().tasks["01"].rounds, 1);
  // The user decided to go on: the round proceeds and is recorded with their reason.
  assert.match(sb.ok("send", "01", "--text", "Fix S1 again.", "--extra-round", "--reason", "the user chose one more round"), /rework round 2 goes past the cap of 1: the user chose one more round/);
  const s = sb.state();
  assert.equal(s.tasks["01"].rounds, 2);
  assert.deepEqual(s.extraRounds.map(({ task, round, cap, reason }) => ({ task, round, cap, reason })), [{ task: "01", round: 2, cap: 1, reason: "the user chose one more round" }]);
  assert.deepEqual(sb.events("extra_round").map((e) => e.round), [2]);

  // A cap of 0 waits from the first round; a cap within reach leaves --extra-round unused.
  sb.ok("config", "--max-rework-rounds", "0");
  assert.equal(sb.state().config.maxReworkRounds, 0);
  round(3);
  sb.no(/rework round 3 would pass the run's cap of 0/, "send", "01", "--text", "Fix S1 once more.");
  sb.ok("config", "--max-rework-rounds", "2");
  assert.match(sb.ok("send", "01", "--text", "Fix S1 once more.", "--extra-round", "--reason", "the user asked for it"), /round 3 goes past the cap of 2/);
  // A cap raised past the next round makes --extra-round the wrong flag: it records
  // a user decision that was never needed.
  sb.ok("config", "--max-rework-rounds", "6");
  round(4);
  sb.no(/rework round 4 is within the run's cap of 6, so --extra-round is not needed/, "send", "01", "--text", "Fix S1.", "--extra-round", "--reason", "unneeded");
  // A plain nudge is not a rework, so it cannot claim an extra round.
  sb.ok("send", "01", "--text", "Carry on; S1 is unchanged.");
  sb.no(/--extra-round applies only to a rework send/, "send", "01", "--text", "Carry on again.", "--extra-round", "--reason", "no rework to extend");
  sb.no(/--max-rework-rounds takes a whole number of rounds/, "config", "--max-rework-rounds", "many");
  sb.no(/--max-rework-rounds takes a whole number of rounds/, "config", "--max-rework-rounds", "1.5");
});

test("boundary: only a rework send opens a round, so a send after a pass and a merge-tip send leave the cap intact", () => {
  const sb = sandbox({ init: ["--max-rework-rounds", "1"], tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n" } });
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01"); // pass

  // A prepared nudge after a pass sends the task back to running without a round.
  const action = JSON.parse(sb.ok("send", "01", "--prepare", "--text", "Also mention the flag in the README."));
  assert.equal(action.rework, false);
  deliver(sb, action);
  assert.equal(sb.state().tasks["01"].status, "running");
  assert.equal(sb.state().tasks["01"].rounds ?? 0, 0);

  // A merge-tip send is not a rework either.
  sb.ok("send", "01", "--merge-tip");
  assert.equal(sb.state().tasks["01"].rounds ?? 0, 0);

  sb.work("01", { files: { "f01.txt": "with the README note\n" } });
  sb.ok("review", "01");
  sb.reviewed("01", "changes_requested", [{ id: "S1", blocking: true, basis: "AC1: one" }]);
  // The first actual rework is round 1 of a cap of 1, so it proceeds.
  assert.match(sb.ok("send", "01", "--text", "Fix S1."), /rework round 1/);
  assert.equal(sb.state().tasks["01"].rounds, 1);

  sb.work("01", { files: { "f01.txt": "S1 fixed\n" } });
  sb.ok("review", "01");
  sb.reviewed("01", "changes_requested", [{ id: "S1", blocking: true, basis: "AC1: one" }]);
  // The next one is the first past the cap, and it says so with the right number.
  sb.no(/rework round 2 would pass the run's cap of 1/, "send", "01", "--text", "Fix S1 again.");
  sb.ok("send", "01", "--text", "Fix S1 again.", "--extra-round", "--reason", "the user chose one more round");
  const s = sb.state();
  assert.equal(s.tasks["01"].rounds, 2);
  assert.deepEqual(s.extraRounds.map(({ round, cap }) => ({ round, cap })), [{ round: 2, cap: 1 }]);
});

test("boundary: a run without the marker keeps the reviewer brief it always had, first review and re-review alike", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n" } });
  sb.legacy();
  const briefOf = (sha) => readFileSync(join(sb.runDir, "briefs", `01-review-${sha.slice(0, 8)}.md`), "utf8");
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  const one = sb.state().tasks["01"];
  const first = briefOf(one.candidateSha);
  assert.doesNotMatch(first, /## Boundary/);
  assert.doesNotMatch(first, /## Re-review/);
  assert.doesNotMatch(first, /## Out of scope/);
  assert.doesNotMatch(first, /AC2:/);
  assert.match(first, /- The verdict is `Verdict: changes_requested` if any finding is blocking, and `Verdict: pass` otherwise\./);
  assert.match(first, /- ADRs in `docs\/adr\/` are constraints: a change that contradicts one is a blocking finding unless the ticket says that ADR is superseded\./);
  assert.match(first, /\| S1 \| Standards \| src\/x\.ts:12 \| the standard or smell, quoted \| yes \|/);
  assert.doesNotMatch(first, /\{\{/);

  // The next review after a rework is a full review again, not a re-review.
  sb.reviewed("01", "changes_requested", [{ id: "S1", blocking: true, basis: "the standard, quoted" }]);
  sb.ok("send", "01", "--text", "Fix S1.");
  sb.work("01", { files: { "f01.txt": "reworked\n" } });
  sb.ok("review", "01");
  const second = briefOf(sb.state().tasks["01"].candidateSha);
  assert.doesNotMatch(second, /## Re-review/);
  assert.doesNotMatch(second, /## Boundary/);
  assert.match(second, /- A finding is blocking if the work shouldn't be integrated until it's fixed\./);

  // A direct legacy run keeps the addendum it always had, with no basis rule.
  const direct = sandbox({ init: null, tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\nScope: f01.txt\n\n- [ ] AC1: one\n" } });
  rmSync(join(direct.runDir, "spec.md"));
  direct.ok("init", "--direct", "--feature", "feat", "--repo", direct.repo, "--check", CHECK);
  direct.legacy();
  direct.ok("dispatch", "01");
  direct.work("01");
  direct.ok("review", "01");
  const dbrief = readFileSync(join(direct.runDir, "briefs", `01-review-${direct.state().tasks["01"].candidateSha.slice(0, 8)}.md`), "utf8");
  assert.match(dbrief, /Report each as a finding with Axis `Boundary`, numbered `B1`, `B2`, …, and mark it blocking\./);
  assert.doesNotMatch(dbrief, /## Boundary/);
  assert.doesNotMatch(dbrief, /confirmed criterion or a floor class/);
});

test("boundary: a prepared send past the cap records its extra round only when the send is confirmed", () => {
  const sb = sandbox({ init: ["--max-rework-rounds", "0"], tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n" } });
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01", "changes_requested", [{ id: "P2", blocking: false, basis: "AC1: one" }]);
  const action = JSON.parse(sb.ok("send", "01", "--prepare", "--text", "Rework it.", "--extra-round", "--reason", "the user chose one round"));
  assert.deepEqual([action.extraRound.round, action.extraRound.cap, action.extraRound.reason], [1, 0, "the user chose one round"]);
  // Prepared: nothing is sent yet, so no extra round is recorded yet.
  assert.equal(sb.state().extraRounds, undefined);
  deliver(sb, action);
  assert.deepEqual(sb.state().extraRounds.map(({ task, round, cap, reason }) => ({ task, round, cap, reason })), [{ task: "01", round: 1, cap: 0, reason: "the user chose one round" }]);
  assert.deepEqual(sb.events("extra_round").map((e) => e.round), [1]);
});

test("boundary: a review is judged against the criteria confirmed when it started, so a later criteria change does not reclassify it", () => {
  // (a) A finding outside the boundary when raised stays outside after AC2 is confirmed.
  const later = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n" } });
  const ticket = join(later.runDir, "issues", "01-a.md");
  later.ok("dispatch", "01");
  later.work("01");
  later.ok("review", "01");
  later.reviewed("01", "changes_requested", [{ id: "S1", blocking: true, basis: "AC2: a criterion that came later" }]);
  assert.match(later.ok("status"), /out-of-boundary findings: 1 blocking finding/);
  later.ok("integrate", "01"); // nothing in-boundary was blocking
  writeFileSync(ticket, "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n- [ ] AC2: a criterion that came later\n");
  later.ok("criteria", "01", "--reason", "the user added AC2");
  later.finalPass();
  const out = later.ok("finish");
  assert.match(out, /out-of-boundary findings — raised outside the confirmed criteria and floor classes; the user decides:\n- #01 S1 · Standards · src\/x\.ts:1 · AC2: a criterion that came later/);

  // (b) A finding inside the boundary when raised stays inside after AC2 is removed.
  const earlier = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n- [ ] AC2: two\n" } });
  const file = join(earlier.runDir, "issues", "01-a.md");
  earlier.ok("dispatch", "01");
  earlier.work("01");
  earlier.ok("review", "01");
  earlier.reviewed("01", "changes_requested", [{ id: "S1", blocking: true, basis: "AC2: two" }]);
  assert.doesNotMatch(earlier.ok("status"), /out-of-boundary findings/);
  writeFileSync(file, "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n");
  earlier.ok("criteria", "01", "--reason", "the user dropped AC2");
  // The review still gates: it was issued against AC2, which the user has since removed.
  earlier.no(/verdict is changes_requested/, "integrate", "01");
  earlier.ok("integrate", "01", "--override", "S1 stands, as the user accepted the criteria change");
  earlier.finalPass();
  const second = earlier.ok("finish");
  assert.match(second, /out-of-boundary findings: none/);
  assert.match(second, /#01 S1 · override · Standards · src\/x\.ts:1 · AC2: two · reason: S1 stands/);
});

test("boundary: a run without the marker keeps unbounded reviews, suggestions and no cap", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n" } });
  sb.legacy();
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01", "changes_requested", [{ id: "S1", blocking: true, basis: "the function is long" }]);
  // Nothing is a suggestion here: the finding stands as written.
  assert.doesNotMatch(sb.ok("status"), /out-of-boundary/);
  assert.deepEqual(JSON.parse(sb.ok("status", "--json")).suggestions, []);
  sb.no(/verdict is changes_requested/, "integrate", "01");
  sb.no(/does not account for blocking finding S1/, "send", "01", "--text", "Rework please.");
  // Rounds are uncapped, and no extra round is recorded.
  for (const n of [1, 2, 3]) {
    sb.ok("send", "01", "--text", `Fix S1, round ${n}.`);
    sb.work("01", { files: { "f01.txt": `rework ${n}\n` } });
    sb.ok("review", "01");
    sb.reviewed("01", "changes_requested", [{ id: "S1", blocking: true, basis: "the function is still long" }]);
  }
  assert.equal(sb.state().tasks["01"].rounds, 3);
  assert.equal(sb.state().extraRounds, undefined);
  sb.ok("send", "01", "--text", "Fix S1, round 4.");
  assert.equal(sb.state().tasks["01"].rounds, 4);
});

test("boundary: finish lists every extra round, out-of-boundary finding and Out of scope suggestion, or says there were none", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n" } });
  sb.ok("config", "--max-rework-rounds", "0");
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01", "changes_requested", [{ id: "S1", blocking: true, basis: "the naming could be clearer" }]);
  const first = sb.state().tasks["01"].review.path;
  writeFileSync(first, `${readFileSync(first, "utf8")}\n## Out of scope\n- src/a.ts could be split into two modules\n- the README could mention this\n`);
  // The only blocking finding is out of boundary, so the rework needs no accounting;
  // the cap is 0, so the round itself needs the user's decision.
  sb.ok("send", "01", "--text", "Rename it; S1 is a suggestion the user accepts.", "--extra-round", "--reason", "the user chose one round");
  sb.work("01", { files: { "f01.txt": "renamed\n" } });
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("integrate", "01");
  sb.finalPass();
  const out = sb.ok("finish");
  assert.match(out, /rework past the cap — the user decided each one:\n- #01 round 1 of cap 0: the user chose one round/);
  assert.match(out, /out-of-boundary findings — raised outside the confirmed criteria and floor classes; the user decides:\n- #01 S1 · Standards · src\/x\.ts:1 · the naming could be clearer/);
  assert.match(out, /suggestions from `## Out of scope` — the user decides:\n- #01: src\/a\.ts could be split into two modules\n- #01: the README could mention this/);

  const none = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one\n" } });
  none.ok("dispatch", "01");
  none.work("01");
  none.ok("review", "01");
  none.reviewed("01");
  none.ok("integrate", "01");
  none.finalPass();
  const clean = none.ok("finish");
  assert.match(clean, /rework past the cap: none/);
  assert.match(clean, /out-of-boundary findings: none/);
  assert.match(clean, /out-of-scope suggestions: none/);
});

test("integrate merges with --no-ff, retains sessions, and unblocks dependents", () => {
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
  assert.equal(existsSync(t.worktree), true);
  assert.equal(sb.g(sb.repo, "rev-parse", t.branch), t.candidateSha);
  assert.ok(sb.db().workspaces.every((w) => !w.archived));
  assert.ok(!sb.agent(t.agentId).archived && !sb.agent(t.review.agentId).archived);
  assert.equal(t.cleanedAt, undefined);
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

test("acceptance: init and import refuse a placeholder command and warn, without refusing, on a ticket with none", () => {
  const bad = sandbox({ init: null, tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: works — check: `<command that proves it>`\n" } });
  bad.no(/template placeholder/, "init", "--feature", "feat", "--repo", bad.repo, "--check", CHECK);
  assert.equal(existsSync(join(bad.runDir, "state.json")), false);
  assert.equal(spawnSync("git", ["-C", bad.repo, "rev-parse", "--verify", "workloop/feat"], { env: bad.env }).status, 128);

  const sb = sandbox({ init: null, tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: works\n", "02-b.md": "# 02: B\n\nBlocked by: None\n\n- [ ] AC1: works — check: `npm test`\n" } });
  const out = sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  assert.match(out, /warning: ticket 01 \(A\) names no acceptance command/);
  assert.doesNotMatch(out, /ticket 02 \(B\) names no acceptance command/);
  sb.ok("dispatch", "01");
  // Import refuses a newly written ticket whose command is still a placeholder.
  writeFileSync(join(sb.runDir, "issues", "03-c.md"), "# 03: C\n\nBlocked by: None\n\n- [ ] AC1: works — check: `<cmd>`\n");
  sb.no(/template placeholder/, "import");
  assert.equal(sb.state().tasks["03"], undefined);
  writeFileSync(join(sb.runDir, "issues", "03-c.md"), "# 03: C\n\nBlocked by: None\n");
  assert.match(sb.ok("import"), /warning: ticket 03 \(C\) names no acceptance command/);
  // A direct run's reviewer re-runs the ticket's commands either way; the warning is for full runs.
  const direct = sandbox({ init: null, tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\nScope: f01.txt\n" } });
  rmSync(join(direct.runDir, "spec.md"));
  assert.doesNotMatch(direct.ok("init", "--direct", "--feature", "feat", "--repo", direct.repo, "--check", CHECK), /names no acceptance command/);
});

test("acceptance: integrate runs the checks, then this ticket's commands, then the regression set, and stores them", () => {
  const sb = sandbox({ init: null, tickets: {} });
  const log = slash(join(sb.root, "ran.log"));
  const run = (label) => `node -e "require('fs').appendFileSync('${log}','${label}\\n')"`;
  const ticket = (id, blocked, label) => `# ${id}: T${id}\n\nBlocked by: ${blocked}\n\n- [ ] AC1: ${label} works — check: \`${run(label)}\`\n`;
  writeFileSync(join(sb.runDir, "issues", "01-a.md"), ticket("01", "None", "01"));
  writeFileSync(join(sb.runDir, "issues", "02-b.md"), ticket("02", "01", "02"));
  writeFileSync(join(sb.runDir, "issues", "03-c.md"), "# 03: T03\n\nBlocked by: None\n\n- [ ] AC2: never — check: `node -e \"process.exit(1)\"`\n");
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", run("check"));
  const ran = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(ran(), ["check"], "init runs only the run's checks");

  sb.complete("01");
  assert.deepEqual(ran(), ["check", "check", "01"]);
  const one = sb.state().tasks["01"];
  assert.deepEqual(one.acceptance, [{ criterion: "01 works", command: run("01") }]);
  assert.equal(sb.state().tasks["02"].acceptance, undefined, "a ticket's commands are stored when it integrates, not before");

  sb.ok("cancel", "03", "--reason", "no longer needed");
  // The ticket is re-read at integrate, so a command added after init (and recorded
  // as the user's agreed change) is the one that runs.
  writeFileSync(join(sb.runDir, "issues", "02-b.md"), ticket("02", "01", "02") + `- [ ] AC2: more — check: \`${run("02b")}\`\n`);
  sb.ok("criteria", "02", "--reason", "the user added AC2");
  writeFileSync(log, "");
  sb.ok("dispatch", "02");
  sb.work("02");
  sb.ok("review", "02");
  sb.reviewed("02");
  sb.ok("integrate", "02");
  assert.deepEqual(ran(), ["check", "02", "02b", "01"], "checks, then this ticket's commands, then the integrated ticket's, in ticket order");
  assert.deepEqual(sb.state().tasks["02"].acceptance.map((a) => a.command), [run("02"), run("02b")]);
});

test("acceptance: a later ticket that breaks an earlier command rolls back, naming the command and its ticket", () => {
  const sb = sandbox({ tickets: {
    "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: the guard holds — check: `node -e \"process.exit(require('fs').existsSync('REGRESSED') ? 1 : 0)\"`\n",
    "02-b.md": "# 02: B\n\nBlocked by: 01\n",
  } });
  sb.complete("01");
  sb.ok("dispatch", "02");
  sb.work("02", { files: { REGRESSED: "" } });
  sb.ok("review", "02");
  sb.reviewed("02");
  const tip = sb.state().integration.tip;
  const out = sb.no(/#01 acceptance `[^`]*` fails after merging #02; integration rolled back to/, "integrate", "02");
  assert.match(out, /REGRESSED/, "the output names the failing command");
  const s = sb.state();
  assert.equal(s.integration.tip, tip);
  assert.equal(sb.g(s.integration.worktree, "rev-parse", "HEAD"), tip);
  assert.equal(s.tasks["02"].status, "in_review");
  assert.equal(s.tasks["02"].acceptance, undefined, "a failed integration stores no commands");
  const failed = sb.events("integrate_failed").at(-1);
  assert.equal(failed.task, "02");
  assert.equal(failed.acceptanceTask, "01");
  assert.match(failed.check, /REGRESSED/);
  assert.equal(failed.rolledBack, true);
});

test("acceptance: finish runs the checks and the whole regression set, and fails when a command fails on the tip", () => {
  const sb = sandbox({ init: null, tickets: {} });
  const log = slash(join(sb.root, "ran.log"));
  const broke = slash(join(sb.root, "broke"));
  const run = (label) => `node -e "require('fs').appendFileSync('${log}','${label}\\n')"`;
  const guard = `node -e "require('fs').appendFileSync('${log}','01\\n');process.exit(require('fs').existsSync('${broke}') ? 1 : 0)"`;
  writeFileSync(join(sb.runDir, "issues", "01-a.md"), `# 01: A\n\nBlocked by: None\n\n- [ ] AC1: guard — check: \`${guard}\`\n`);
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", run("check"));
  sb.complete("01");
  sb.finalPass();
  writeFileSync(log, "");
  sb.ok("finish");
  assert.deepEqual(readFileSync(log, "utf8").split("\n").filter(Boolean), ["check", "01"], "the checks, then the regression set");

  // The same commands run again on the tip at finish, so a regression the tip carries fails it.
  const done = sb.state().completion;
  writeFileSync(broke, "");
  sb.no(/#01 acceptance `[^`]*` fails on the integration tip/, "finish");
  assert.deepEqual(sb.state().completion, done, "a failing acceptance command records no delivery");
  rmSync(broke);
  assert.match(sb.ok("finish"), /delivery checked/);
});

test("check phase: init, config and status carry the time limit, and state without one reads as 30", () => {
  const sb = sandbox({ init: null });
  // The maximum is one day: Node fires a longer timer at once.
  sb.no(/--check-timeout takes a positive number of minutes up to 1440/, "init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK, "--check-timeout", "1441");
  assert.equal(existsSync(join(sb.runDir, "state.json")), false);
  const out = sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK, "--check-timeout", "12.5");
  assert.equal(sb.state().config.checkTimeout, 12.5);
  assert.match(out, /checks stop after 12\.5m/);
  assert.match(sb.ok("config"), /"checkTimeout": 12\.5/);
  assert.equal(JSON.parse(sb.ok("status", "--json")).config.checkTimeout, 12.5);
  sb.ok("config", "--check-timeout", "0.05");
  assert.equal(sb.state().config.checkTimeout, 0.05);
  assert.equal(JSON.parse(sb.ok("status", "--json")).config.checkTimeout, 0.05);
  // A run from before the setting existed has no checkTimeout, and behaves as 30 minutes.
  const s = sb.state();
  delete s.config.checkTimeout;
  writeFileSync(join(sb.runDir, "state.json"), `${JSON.stringify(s, null, 2)}\n`);
  assert.equal(JSON.parse(sb.ok("status", "--json")).config.checkTimeout, 30);
  assert.match(sb.ok("config"), /"checkTimeout": 30/);
  for (const bad of ["0", "-1", "soon", "1441"]) {
    sb.no(/--check-timeout takes a positive number of minutes up to 1440/, "config", `--check-timeout=${bad}`);
    assert.equal(JSON.parse(sb.ok("status", "--json")).config.checkTimeout, 30);
  }
  sb.ok("config", "--check-timeout", "1440");
  assert.equal(sb.state().config.checkTimeout, 1440);
});

test("check phase: a check that outlives the limit is stopped with its grandchild, and integrate rolls back", async () => {
  const sb = sandbox();
  const pidFile = slash(join(sb.root, "grandchild.pid"));
  // The check spawns a grandchild, then sleeps well past its 0.05-minute (3 second) limit.
  const slow = `node -e "const {spawn}=require('child_process');`
    + `const g=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});`
    + `require('fs').writeFileSync('${pidFile}',String(g.pid));setTimeout(()=>{},60000)"`;
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("config", "--check", slow, "--check-timeout", "0.05");
  const tip = sb.state().integration.tip;
  const started = Date.now();
  const out = sb.no(/timed out after 0\.05 minutes/, "integrate", "01");
  assert.match(out, /integration rolled back to/);
  assert.ok(Date.now() - started < 30000, "integrate stops at the limit instead of waiting out the check");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(pid > 0);
  await sb.waitFor(`grandchild ${pid} to be stopped`, () => !alive(pid), 5000);
  const s = sb.state();
  assert.equal(s.integration.tip, tip);
  assert.equal(sb.g(s.integration.worktree, "rev-parse", "HEAD"), tip);
  assert.equal(s.tasks["01"].status, "in_review");
  assert.equal(s.checking, null);
  assert.equal(sb.events("integrate_failed").at(-1).timedOut, true);
});

test("check phase: a check that times out at init keeps nothing", () => {
  const sb = sandbox({ init: null });
  sb.no(/timed out after 0\.02 minutes[\s\S]*nothing kept/, "init", "--feature", "feat", "--repo", sb.repo,
    "--check", `node -e "setTimeout(()=>{},60000)"`, "--check-timeout", "0.02");
  assert.equal(existsSync(join(sb.runDir, "state.json")), false);
  assert.equal(spawnSync("git", ["-C", sb.repo, "rev-parse", "--verify", "workloop/feat"], { env: sb.env }).status, 128);
});

test("check phase: status, watch, note and hold work while integrate's checks run; other commands refuse", async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n", "02-b.md": "# 02: B\n\nBlocked by: None\n" } });
  const release = sb.heldIntegrate();
  const before = sb.state();
  const run = sb.start("integrate", "01");
  const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && sb.state().checking);
  assert.equal(processIdentity(checking.check.pid, [checking.check.token]), "match", "check.pid is the running check, carrying its token");
  assert.deepEqual({ ...checking, startedAt: undefined, check: undefined }, {
    kind: "integrate", task: "01", candidateSha: before.tasks["01"].candidateSha, prevTip: before.integration.tip,
    mergeSha: sb.g(before.integration.worktree, "rev-parse", "HEAD"), pid: run.child.pid, startedAt: undefined, check: undefined,
  });
  const phase = new RegExp(`check phase: integrate on #01 is running its checks \\(pid ${run.child.pid}`);

  assert.match(sb.ok("status"), phase);
  assert.equal(JSON.parse(sb.ok("status", "--json")).checking.interrupted, false);
  sb.ok("note", "--text", "recorded during the checks");
  sb.ok("hold", "02", "--reason", "held during the checks");
  sb.ok("watch");
  assert.equal(sb.db().heartbeats.length, 1, "watch keeps the heartbeat armed while the checks run");
  // `config` refuses, so the checks that run are the checks configured; so does a
  // rework `send` to the task under check.
  const refused = [["dispatch", "02"], ["review", "01"], ["integrate", "02"], ["integrate", "01"], ["finish"],
    ["config", "--check", CHECK], ["config", "--check-timeout", "1"], ["send", "01", "--prepare", "--text", "Please revise"]];
  for (const args of refused) sb.no(phase, ...args);
  assert.equal(sb.state().tasks["01"].pendingAction, undefined);
  assert.deepEqual(sb.state().config, before.config);

  release();
  const { code, out } = await run.done;
  assert.equal(code, 0, out);
  assert.match(out, /#01 integrated/);
  const s = sb.state();
  assert.equal(s.checking, null);
  assert.equal(s.tasks["01"].status, "done");
  // What other commands recorded during the checks survives integrate's result.
  assert.equal(s.tasks["02"].hold, "held during the checks");
  assert.ok(sb.events("note").some((e) => e.note === "recorded during the checks"));
  const seqs = sb.events().map((e) => e.seq);
  assert.equal(new Set(seqs).size, seqs.length, "every event has its own seq");
  assert.equal(s.seq, seqs.at(-1));
});

test("check phase: an interrupted integrate is reported, and rerunning it resets the merge and integrates", async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n", "02-b.md": "# 02: B\n\nBlocked by: None\n" } });
  const release = sb.heldIntegrate();
  const run = sb.start("integrate", "01");
  const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && sb.state().checking);
  run.child.kill("SIGKILL");
  await run.done;
  release(); // lets the orphaned check end

  const interrupted = new RegExp(`interrupted check phase: integrate on #01 \\(pid ${checking.pid} is gone\\); rerun \`integrate 01\``);
  assert.match(sb.ok("status", "--live"), interrupted);
  assert.equal(JSON.parse(sb.ok("status", "--json")).checking.interrupted, true);
  assert.match(sb.ok("watch"), interrupted);
  assert.equal(sb.db().heartbeats.length, 1, "an interrupted phase keeps the heartbeat armed until it is recovered");
  for (const args of [["dispatch", "02"], ["integrate", "02"], ["finish"]]) sb.no(interrupted, ...args);
  assert.equal(sb.g(sb.state().integration.worktree, "rev-parse", "HEAD"), checking.mergeSha);

  const out = sb.ok("integrate", "01");
  assert.match(out, /recovered the interrupted check phase of #01/);
  assert.match(out, /#01 integrated/);
  const s = sb.state();
  assert.equal(s.checking, null);
  assert.equal(s.tasks["01"].status, "done");
  assert.equal(sb.g(s.integration.worktree, "rev-parse", "HEAD"), s.integration.tip);
  assert.equal(sb.g(s.integration.worktree, "rev-parse", "HEAD^1"), checking.prevTip);
  assert.equal(sb.g(s.integration.worktree, "status", "--porcelain"), "");
  assert.deepEqual(sb.events("checking").map((e) => e.phase), ["integrate", "integrate"]);
  assert.equal(sb.events("check_recovered").length, 1);
});

test("check phase: recovery refuses and says to ask the user when the branch moved elsewhere", async () => {
  const sb = sandbox();
  const release = sb.heldIntegrate();
  const run = sb.start("integrate", "01");
  const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && sb.state().checking);
  run.child.kill("SIGKILL");
  await run.done;
  release();

  // Something outside the run commits to the integration branch.
  const wt = sb.state().integration.worktree;
  writeFileSync(join(wt, "outside.txt"), "outside\n");
  sb.g(wt, "add", "outside.txt");
  sb.g(wt, "commit", "-q", "-m", "outside change");
  const moved = sb.g(wt, "rev-parse", "HEAD");
  const out = sb.no(/cannot recover the interrupted check phase of #01[\s\S]*ask the user/, "integrate", "01");
  assert.match(out, new RegExp(moved.slice(0, 8)));
  assert.equal(sb.g(wt, "rev-parse", "HEAD"), moved, "the refusal leaves a branch it did not move alone");
  assert.deepEqual(sb.state().checking, checking);
});

test("check phase: an interrupted finish is cleared by rerunning finish", async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  sb.complete("01");
  sb.finalPass();
  const held = sb.heldCheck();
  sb.ok("config", "--check", held.cmd);
  const run = sb.start("finish");
  const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && sb.state().checking);
  assert.equal(checking.kind, "finish");
  run.child.kill("SIGKILL");
  await run.done;
  held.release();

  assert.match(sb.ok("status", "--live"), /interrupted check phase: finish \(pid \d+ is gone\); rerun `finish`/);
  assert.match(sb.ok("finish"), /delivery checked/);
  assert.equal(sb.state().checking, null);
  assert.ok(sb.state().completion);
});

test("check phase: integrate rolls back when the task under check carries a pending action at the end", async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  const release = sb.heldIntegrate();
  const run = sb.start("integrate", "01");
  const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && sb.state().checking);
  // No command can prepare an action for #01 while its checks run (send, dispatch
  // and review refuse), so the state is written the way a concurrent writer would.
  const s = sb.state();
  s.tasks["01"].pendingAction = { action: "injected-send", kind: "send", tool: "send_agent_prompt", arguments: {}, preparedAt: new Date().toISOString() };
  writeFileSync(join(sb.runDir, "state.json"), `${JSON.stringify(s, null, 2)}\n`);
  release();
  const { code, out } = await run.done;
  assert.notEqual(code, 0, out);
  assert.match(out, /gate no longer holds after the checks: #01: pending MCP action injected-send/);
  assert.match(out, /integration rolled back to/);
  const after = sb.state();
  assert.equal(after.checking, null);
  assert.equal(after.tasks["01"].status, "in_review");
  assert.equal(after.integration.tip, checking.prevTip);
  assert.equal(sb.g(after.integration.worktree, "rev-parse", "HEAD"), checking.prevTip);
  assert.equal(sb.events("integrate_failed").at(-1).gate, "#01: pending MCP action injected-send; reconcile with action/ack first");
});

test("check phase: finish refuses config while its checks run and records no delivery when a ticket was imported meanwhile", async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  const release = sb.heldFinish();
  const run = sb.start("finish");
  const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && sb.state().checking);
  assert.equal(checking.kind, "finish");
  const phase = new RegExp(`check phase: finish is running its checks \\(pid ${run.child.pid}`);
  sb.no(phase, "config", "--check", `node -e "process.exit(23)"`);
  writeFileSync(join(sb.runDir, "issues", "02-b.md"), "# 02: B\n\nBlocked by: None\n");
  sb.ok("import");
  release();
  const { code, out } = await run.done;
  assert.notEqual(code, 0, out);
  assert.match(out, /a delivery gate no longer holds, so delivery is not recorded: not finished: #02 ready/);
  const s = sb.state();
  assert.equal(s.checking, null);
  assert.equal(s.completion ?? null, null);
  assert.equal(sb.events("finish").length, 0);
});

test("check phase: recovering an interrupted integrate stops the orphaned check before it can write", async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  const held = sb.orphaningCheck();
  sb.heldIntegrate(held);
  const run = sb.start("integrate", "01");
  const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && held.pid() && sb.state().checking);
  const orphan = held.pid();
  run.child.kill("SIGKILL");
  await run.done;
  assert.ok(alive(orphan), "the check's child outlives the killed integrate");

  sb.ok("config", "--check", CHECK); // an interrupted phase admits config
  const out = sb.ok("integrate", "01");
  assert.match(out, /recovered the interrupted check phase of #01/);
  await sb.waitFor(`orphan ${orphan} to be stopped`, () => !alive(orphan), 5000);
  held.release();
  await new Promise((r) => setTimeout(r, 500)); // longer than the orphan's 50 ms poll
  const s = sb.state();
  assert.equal(s.tasks["01"].status, "done");
  assert.equal(existsSync(join(s.integration.worktree, "orphan-write.txt")), false);
  assert.equal(sb.g(s.integration.worktree, "status", "--porcelain"), "");
  assert.equal(sb.g(s.integration.worktree, "rev-parse", "HEAD^1"), checking.prevTip);
});

test("check phase: recovering an interrupted finish stops the orphaned check before it can write", async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  const held = sb.orphaningCheck();
  sb.heldFinish(held);
  const run = sb.start("finish");
  await sb.waitFor("the check's identity", () => sb.state().checking?.check && held.pid());
  const orphan = held.pid();
  run.child.kill("SIGKILL");
  await run.done;
  assert.ok(alive(orphan), "the check's child outlives the killed finish");

  sb.ok("config", "--check", CHECK);
  assert.match(sb.ok("finish"), /delivery checked/);
  await sb.waitFor(`orphan ${orphan} to be stopped`, () => !alive(orphan), 5000);
  held.release();
  await new Promise((r) => setTimeout(r, 500));
  const s = sb.state();
  assert.ok(s.completion);
  assert.equal(existsSync(join(s.integration.worktree, "orphan-write.txt")), false);
  assert.equal(sb.g(s.integration.worktree, "status", "--porcelain"), "");
});

test("check phase: a check whose identity was not recorded never runs when integrate dies first", async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  const first = sb.heldCheck();
  const ran = slash(join(sb.root, "second-check-ran.txt"));
  sb.heldIntegrate(first);
  sb.ok("config", "--check", first.cmd, "--check", `node -e "require('fs').writeFileSync('${ran}', 'ran')"`);
  const run = sb.start("integrate", "01");
  const checking = await sb.waitFor("the first check's identity", () => sb.state().checking?.check && sb.state().checking);
  // Hold the run lock, so integrate cannot record the second check's identity.
  writeFileSync(join(sb.runDir, ".lock"), String(process.pid));
  first.release();
  await new Promise((r) => setTimeout(r, 1500)); // the second check is started and waits for its "go"
  run.child.kill("SIGKILL");
  await run.done;
  unlinkSync(join(sb.runDir, ".lock"));
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(existsSync(ran), false, "the second check never ran its command");
  assert.equal(sb.state().checking.check.token, checking.check.token, "only the first check's identity was recorded");

  sb.ok("config", "--check", CHECK);
  assert.match(sb.ok("integrate", "01"), /#01 integrated/);
  assert.equal(existsSync(ran), false);
});

test("check phase: a reused pid is neither signalled nor taken for a live phase", async (t) => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  const release = sb.heldIntegrate();
  const run = sb.start("integrate", "01");
  const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && sb.state().checking);
  run.child.kill("SIGKILL");
  await run.done;
  release();
  await sb.waitFor("the check to end", () => processIdentity(checking.check.pid, [checking.check.token]) !== "match", 5000);

  // An unrelated process now holds the recorded pids of both the phase owner and its check.
  const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => decoy.kill("SIGKILL"));
  const s = sb.state();
  Object.assign(s.checking, { pid: decoy.pid, check: { ...s.checking.check, pid: decoy.pid } });
  writeFileSync(join(sb.runDir, "state.json"), `${JSON.stringify(s, null, 2)}\n`);

  assert.match(sb.ok("status"), new RegExp(`interrupted check phase: integrate on #01 \\(pid ${decoy.pid} is gone\\)`));
  assert.match(sb.ok("integrate", "01"), /recovered the interrupted check phase of #01[\s\S]*#01 integrated/);
  assert.ok(alive(decoy.pid), "recovery left the unrelated process alone");
});

test("check phase: recovery refuses and names a check pid whose identity cannot be read", { skip: process.platform === "win32" && "fakes ps(1)" }, async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  const release = sb.heldIntegrate();
  const run = sb.start("integrate", "01");
  const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && sb.state().checking);
  run.child.kill("SIGKILL");
  await run.done;
  // A `ps` that cannot report: the check is alive, but nothing can confirm it is ours.
  const bin = join(sb.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "ps"), 0o755);
  const path = sb.env.PATH;
  sb.env.PATH = `${bin}${delimiter}${path}`;
  const out = sb.no(new RegExp(`pid ${checking.check.pid} is alive but its command line cannot be read[\\s\\S]*ask the user`), "integrate", "01");
  sb.env.PATH = path;
  assert.match(out, /Nothing was signalled or changed/);
  assert.equal(processIdentity(checking.check.pid, [checking.check.token]), "match", "the check was not signalled");
  assert.equal(sb.g(sb.state().integration.worktree, "rev-parse", "HEAD"), checking.mergeSha);
  assert.deepEqual(sb.state().checking, checking);
  release();
});

test("check phase: a pending action on another task is not re-printed by --prepare while the checks run", async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n", "02-b.md": "# 02: B\n\nBlocked by: None\n" } });
  const release = sb.heldIntegrate();
  assert.match(sb.ok("dispatch", "02", "--prepare"), /"tool": "create_agent"/);
  const run = sb.start("integrate", "01");
  await sb.waitFor("the check's identity", () => sb.state().checking?.check && sb.state().checking);
  const out = sb.no(new RegExp(`check phase: integrate on #01 is running its checks \\(pid ${run.child.pid}`), "dispatch", "02", "--prepare");
  assert.doesNotMatch(out, /create_agent/);
  assert.match(sb.ok("action", "02"), /"tool": "create_agent"/);
  release();
  const { code, out: done } = await run.done;
  assert.equal(code, 0, done);
  assert.equal(sb.state().tasks["02"].pendingAction.kind, "dispatch");
});

test("check phase: a timed-out check that cannot be stopped keeps the phase and names the group and error", { skip: process.platform === "win32" && "POSIX kill" }, async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01");
  sb.ok("config", "--check", `node -e "setTimeout(()=>{},60000)"`, "--check-timeout", "0.05");
  const undo = sb.failGroupKills();
  const out = sb.no(/timed out after 0\.05 minutes, and cleanup failed: process group (\d+) could not be stopped \(kill\(-\d+, SIGKILL\): EPERM\)/, "integrate", "01");
  undo();
  const checking = sb.state().checking;
  assert.equal(checking.kind, "integrate", "the phase stays recorded");
  assert.match(out, new RegExp(`process group ${checking.check.pid} could not be stopped`));
  assertSafeCleanupHint(out, checking.check.pid, checking.check.token);
  assert.equal(processIdentity(checking.check.pid, [checking.check.token]), "match", "the check is still running");
  assert.equal(sb.g(sb.state().integration.worktree, "rev-parse", "HEAD"), checking.mergeSha, "nothing was rolled back");
  assert.equal(sb.state().tasks["01"].status, "in_review");
  assert.equal(sb.events("check_cleanup_failed").length, 1);

  // Without the fault, recovery stops the check and integrates.
  sb.ok("config", "--check", CHECK);
  assert.match(sb.ok("integrate", "01"), /recovered the interrupted check phase of #01[\s\S]*#01 integrated/);
  assert.notEqual(processIdentity(checking.check.pid, [checking.check.token]), "match");
});

test("check phase: recovery refuses and keeps the phase when the check cannot be stopped", { skip: process.platform === "win32" && "POSIX kill" }, async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  const release = sb.heldIntegrate();
  const run = sb.start("integrate", "01");
  const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && sb.state().checking);
  run.child.kill("SIGKILL");
  await run.done;
  const undo = sb.failGroupKills();
  const out = sb.no(/cannot recover the interrupted check phase \(integrate on #01\): its check's process group (\d+) could not be stopped \(kill\(-\d+, SIGKILL\): EPERM\)/, "integrate", "01");
  undo();
  assert.match(out, new RegExp(`process group ${checking.check.pid} could not be stopped[\\s\\S]*Nothing was reset or cleared`));
  assertSafeCleanupHint(out, checking.check.pid, checking.check.token);
  assert.deepEqual(sb.state().checking, checking);
  assert.equal(sb.g(sb.state().integration.worktree, "rev-parse", "HEAD"), checking.mergeSha);
  assert.equal(processIdentity(checking.check.pid, [checking.check.token]), "match", "the check was not reported stopped");
  release();
});

test("check phase: a taskkill that exits non-zero is a failed stop", { skip: process.platform === "win32" && "fakes taskkill with a shell script" }, (t) => {
  const sb = sandbox({ init: null });
  const bin = join(sb.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "taskkill"), "#!/bin/sh\necho 'ERROR: injected taskkill failure' >&2\nexit 1\n");
  chmodSync(join(bin, "taskkill"), 0o755);
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => sleeper.kill("SIGKILL"));
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  let r;
  try { r = stopCheckNow(sleeper.pid, true); } finally { process.env.PATH = path; }
  assert.equal(r.ok, false);
  assert.match(r.error, /taskkill exited 1: ERROR: injected taskkill failure/);
  assert.ok(alive(sleeper.pid));
});

for (const kind of ["integrate", "finish"]) {
  test(`check phase: recovering ${kind} stops a check group whose wrapper died on its own`, { skip: process.platform === "win32" && "POSIX process groups" }, async () => {
    const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
    const held = sb.orphaningCheck();
    if (kind === "integrate") sb.heldIntegrate(held); else sb.heldFinish(held);
    const run = sb.start(...(kind === "integrate" ? ["integrate", "01"] : ["finish"]));
    const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && held.pid() && sb.state().checking);
    const orphan = held.pid();
    // Only the wrapper dies; the rest of its group lives on. Then the owner is interrupted.
    process.kill(checking.check.pid, "SIGKILL");
    run.child.kill("SIGKILL");
    await run.done;
    await sb.waitFor("the wrapper to be gone", () => processIdentity(checking.check.pid, [checking.check.token]) === "gone", 5000);
    assert.ok(alive(orphan), "the check's child outlives its wrapper");

    sb.ok("config", "--check", CHECK);
    assert.match(sb.ok(...(kind === "integrate" ? ["integrate", "01"] : ["finish"])), kind === "integrate" ? /#01 integrated/ : /delivery checked/);
    await sb.waitFor(`orphan ${orphan} to be stopped`, () => !alive(orphan), 5000);
    held.release();
    await new Promise((r) => setTimeout(r, 500)); // longer than the orphan's 50 ms poll
    const s = sb.state();
    assert.equal(existsSync(join(s.integration.worktree, "orphan-write.txt")), false);
    assert.equal(sb.g(s.integration.worktree, "status", "--porcelain"), "");
  });
}

for (const kind of ["integrate", "finish"]) {
  test(`check phase: when only the wrapper dies, ${kind} stops its group before recording the result`, { skip: process.platform === "win32" && "POSIX process groups" }, async () => {
    const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
    const held = sb.orphaningCheck();
    if (kind === "integrate") sb.heldIntegrate(held); else sb.heldFinish(held);
    const tip = sb.state().integration.tip;
    const run = sb.start(...(kind === "integrate" ? ["integrate", "01"] : ["finish"]));
    const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && held.pid() && sb.state().checking);
    const orphan = held.pid();
    process.kill(checking.check.pid, "SIGKILL"); // the owner stays alive
    const { code, out } = await run.done;
    assert.notEqual(code, 0, out);
    assert.equal(alive(orphan), false, "the wrapper's surviving group was stopped before the result");
    held.release();
    await new Promise((r) => setTimeout(r, 500)); // longer than the orphan's 50 ms poll
    const s = sb.state();
    assert.equal(s.checking, null, "the result was recorded");
    assert.equal(existsSync(join(s.integration.worktree, "orphan-write.txt")), false);
    assert.equal(sb.g(s.integration.worktree, "status", "--porcelain"), "");
    assert.equal(sb.g(s.integration.worktree, "rev-parse", "HEAD"), tip);
    if (kind === "integrate") {
      assert.match(out, /integration rolled back to/);
      assert.equal(s.tasks["01"].status, "in_review");
    } else {
      assert.equal(s.completion ?? null, null);
      assert.equal(sb.events("finish_failed").length, 1);
    }
  });
}

test("check phase: when the dead wrapper's group cannot be stopped, integrate keeps the phase and rolls nothing back", { skip: process.platform === "win32" && "POSIX kill" }, async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  const held = sb.orphaningCheck();
  sb.heldIntegrate(held);
  const undo = sb.failGroupKills();
  const run = sb.start("integrate", "01");
  undo();
  const checking = await sb.waitFor("the check's identity", () => sb.state().checking?.check && held.pid() && sb.state().checking);
  const orphan = held.pid();
  process.kill(checking.check.pid, "SIGKILL");
  const { code, out } = await run.done;
  assert.notEqual(code, 0, out);
  assert.match(out, new RegExp(`ended, and cleanup failed: process group ${checking.check.pid} could not be stopped \\(kill\\(-${checking.check.pid}, SIGKILL\\): EPERM\\)[\\s\\S]*rerun \`integrate 01\``));
  assertSafeCleanupHint(out, checking.check.pid, checking.check.token);
  assert.deepEqual(sb.state().checking, checking, "the phase stays recorded");
  assert.equal(sb.g(sb.state().integration.worktree, "rev-parse", "HEAD"), checking.mergeSha, "nothing was rolled back");
  assert.equal(sb.state().tasks["01"].status, "in_review");
  assert.ok(alive(orphan));

  // Recovery stops the group the dead wrapper left, then integrates.
  sb.ok("config", "--check", CHECK);
  assert.match(sb.ok("integrate", "01"), /#01 integrated/);
  await sb.waitFor(`orphan ${orphan} to be stopped`, () => !alive(orphan), 5000);
  held.release();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(existsSync(join(sb.state().integration.worktree, "orphan-write.txt")), false);
});

test("check phase: init keeps its worktree and branch when a timed-out check cannot be stopped", { skip: process.platform === "win32" && "POSIX kill" }, async () => {
  const sb = sandbox({ init: null });
  const undo = sb.failGroupKills();
  const out = sb.no(/timed out after 0\.02 minutes, and cleanup failed: process group (\d+) could not be stopped \(kill\(-\d+, SIGKILL\): EPERM\)/,
    "init", "--feature", "feat", "--repo", sb.repo, "--check", `node -e "setTimeout(()=>{},60000)"`, "--check-timeout", "0.02");
  undo();
  const pid = Number(out.match(/process group (\d+)/)[1]);
  const token = out.match(/token (wl-check-[0-9a-f-]+)/)[1];
  assertSafeCleanupHint(out, pid, token);
  assert.equal(processIdentity(pid, [token]), "match", "the printed token is the check's");
  assert.match(out, /were kept, and no run was created/);
  assert.match(out, /worktree remove --force '[^']+'` and `git -C '[^']+' branch -D 'workloop\/feat'`/);
  assert.doesNotMatch(out, /every process it spawned were stopped/);
  assert.ok(existsSync(join(sb.runDir, "integration")), "the worktree is kept");
  assert.equal(spawnSync("git", ["-C", sb.repo, "rev-parse", "--verify", "workloop/feat"], { env: sb.env }).status, 0, "the branch is kept");
  assert.equal(existsSync(join(sb.runDir, "state.json")), false);
  process.kill(-pid, "SIGKILL");
});

test("check phase: decisions keeps its commit and changes when a timed-out check cannot be stopped", { skip: process.platform === "win32" && "POSIX kill" }, async () => {
  const sb = sandbox({ init: null });
  mkdirSync(join(sb.repo, "docs"), { recursive: true });
  writeFileSync(join(sb.repo, "docs/adr-history.md"), "# ADR history\n");
  sb.g(sb.repo, "add", "-A");
  sb.g(sb.repo, "commit", "-q", "-m", "history");
  sb.ok("init", "--feature", "feat", "--repo", sb.repo, "--check", CHECK);
  const wt = sb.state().integration.worktree;
  const tip = sb.state().integration.tip;
  mkdirSync(join(wt, "docs", "adr"), { recursive: true });
  writeFileSync(join(wt, "docs", "adr", "0001-x.md"), "# X\n");
  sb.ok("config", "--check", `node -e "setTimeout(()=>{},60000)"`, "--check-timeout", "0.02");
  const undo = sb.failGroupKills();
  const out = sb.no(/timed out after 0\.02 minutes, and cleanup failed: process group (\d+) could not be stopped \(kill\(-\d+, SIGKILL\): EPERM\)/, "decisions");
  undo();
  const pid = Number(out.match(/process group (\d+)/)[1]);
  const token = out.match(/token (wl-check-[0-9a-f-]+)/)[1];
  assertSafeCleanupHint(out, pid, token);
  assert.equal(processIdentity(pid, [token]), "match", "the printed token is the check's");
  assert.match(out, /was NOT rolled back[\s\S]*reset --soft/);
  assert.doesNotMatch(out, /every process it spawned were stopped/);
  assert.equal(sb.state().integration.tip, tip);
  assert.notEqual(sb.g(wt, "rev-parse", "HEAD"), tip, "the decisions commit is kept");
  assert.equal(sb.g(wt, "diff", "--name-only", `${tip}..HEAD`), "docs/adr/0001-x.md");
  assert.equal(sb.events("decisions_failed").at(-1).cleanupFailed.pid, pid);
  process.kill(-pid, "SIGKILL");
});

test("check phase: finish keeps its phase and names the check's token when a timed-out check cannot be stopped", { skip: process.platform === "win32" && "POSIX kill" }, async () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  sb.complete("01");
  sb.finalPass();
  sb.ok("config", "--check", `node -e "setTimeout(()=>{},60000)"`, "--check-timeout", "0.02");
  const undo = sb.failGroupKills();
  const out = sb.no(/timed out after 0\.02 minutes, and cleanup failed: process group (\d+) could not be stopped \(kill\(-\d+, SIGKILL\): EPERM\)[\s\S]*rerun `finish`/, "finish");
  undo();
  const checking = sb.state().checking;
  assert.equal(checking.kind, "finish", "the phase stays recorded");
  assertSafeCleanupHint(out, checking.check.pid, checking.check.token);
  assert.equal(sb.state().completion ?? null, null);
  process.kill(-checking.check.pid, "SIGKILL");
});

test("check phase: printed recovery commands quote paths for the shell", { skip: process.platform === "win32" && "runs the commands through sh" }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workloop-quote-")));
  const odd = "a b'$(touch injected)";
  const repo = join(root, `repo ${odd}`);
  const integ = join(root, `integration ${odd}`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  writeFileSync(join(root, "gitconfig"), "");
  const git = (...args) => {
    const r = spawnSync("git", args, { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const sh = (cmd) => {
    const r = spawnSync("sh", ["-c", cmd], { cwd: root, env, encoding: "utf8" });
    assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
  };
  git("init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "f.txt"), "base\n");
  git("-C", repo, "add", "f.txt");
  git("-C", repo, "commit", "-q", "-m", "base");
  const prev = git("-C", repo, "rev-parse", "HEAD");
  git("-C", repo, "worktree", "add", "-q", "-b", "workloop/feat", integ, prev);

  // decisions: the soft reset moves the worktree's branch back and keeps the change.
  writeFileSync(join(integ, "f.txt"), "decided\n");
  git("-C", integ, "commit", "-q", "-am", "decisions");
  sh(decisionsResetCommand(integ, prev));
  assert.equal(git("-C", integ, "rev-parse", "HEAD"), prev);
  assert.equal(git("-C", integ, "diff", "--cached", "--name-only"), "f.txt");
  git("-C", integ, "reset", "-q", "--hard");

  // init: removes exactly that worktree and branch.
  for (const cmd of initCleanupCommands(repo, integ, "workloop/feat")) sh(cmd);
  assert.equal(existsSync(integ), false);
  assert.equal(spawnSync("git", ["-C", repo, "rev-parse", "--verify", "workloop/feat"], { env }).status, 128);
  assert.ok(existsSync(join(repo, "f.txt")), "the repository itself is untouched");
  assert.deepEqual(readdirSync(root).filter((f) => f.includes("injected") && !f.includes(" ")), [], "no injected command ran");
  assert.equal(existsSync(join(root, "injected")), false);
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
  sb.no(/no final review round for the current tip .*final-review --prepare/, "finish");
  const tip = sb.state().integration.tip;
  // The reviewer's pass counts only for the tip its report names.
  const round = sb.finalReview({ report: false });
  writeFileSync(round.path, `Verdict: pass\nIntegration tip: deadbeef\n`);
  sb.no(/final review's report is for integration tip deadbeef/, "finish");
  // changes_requested gates until its blocking findings are waived.
  writeFileSync(round.path, `Verdict: changes_requested\nIntegration tip: ${tip}\n${findingsTable([{ id: "X1", blocking: true, basis: "M1: spec item M1" }])}`);
  sb.no(/requested changes and X1 is not waived/, "finish");
  sb.no(/write repair tickets .*final-review --waive X1/, "finish");
  sb.ok("final-review", "--waive", "X1", "--reason", "the user accepted the interface drift");
  const out = sb.ok("finish");
  assert.match(out, /Nothing was pushed/);
  assert.ok(existsSync(sb.state().integration.worktree));
  sb.no(/assess retro/, "archive");
  sb.ok("retro", "--skip", "--reason", "No recurring problem in this fixture");
  sb.ok("archive");
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

test("acceptance: an acceptance command falls under the check time limit", () => {
  const sb = sandbox({ tickets: {
    "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: slow — check: `node -e \"setTimeout(() => {}, 60000)\"`\n",
  } });
  sb.ok("config", "--check-timeout", "0.02");
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01");
  const tip = sb.state().integration.tip;
  const out = sb.no(/#01 acceptance `node -e "setTimeout[^`]*` timed out after 0\.02 minutes[\s\S]*integration rolled back to/, "integrate", "01");
  assert.doesNotMatch(out, /fails after merging/);
  assert.equal(sb.state().integration.tip, tip);
  assert.equal(sb.state().tasks["01"].status, "in_review");
  assert.equal(sb.events("integrate_failed").at(-1).timedOut, true);
});

test("acceptance: status shows the regression set's size, and --json lists each task's commands", () => {
  const sb = sandbox({ tickets: {
    "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one works — check: `node -e \"0\"`\n- [ ] AC2: a manual criterion, no command\n- [ ] AC3: two works — check: `node --version`\n",
    "02-b.md": "# 02: B\n\nBlocked by: 01\n",
  } });
  assert.doesNotMatch(sb.ok("status"), /regression set/);
  sb.complete("01");
  assert.match(sb.ok("status"), /regression set: 2 commands from 1 ticket\b/);
  const json = JSON.parse(sb.ok("status", "--json"));
  assert.deepEqual(json.tasks.find((t) => t.id === "01").acceptance, [
    { criterion: "one works", command: 'node -e "0"' },
    { criterion: "two works", command: "node --version" },
  ]);
  assert.deepEqual(json.tasks.find((t) => t.id === "02").acceptance, []);
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
  // Both modes get the acceptance rule; the direct addendum no longer repeats it.
  assert.match(brief, /\*\*Acceptance commands\.\*\* Re-run every command the ticket's criteria name[\s\S]*## Direct run\n/);
  const addendum = brief.slice(brief.indexOf("## Direct run"));
  assert.match(addendum, /One thing is added to the method:[\s\S]*`B1`, `B2`, …[\s\S]*The three-part limit still applies[^\n]*\n\n## Rules/);
  assert.doesNotMatch(addendum, /Re-run every/);
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
  // The document step is finish's first gate: no final review is needed to be refused here.
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
  assert.match(sb.ok("status"), /do the acceptance mapping: write the acceptance mapping/);
  // The document step is gone; without a round, finish still refuses.
  sb.no(/no final review round for the current tip/, "finish");
  sb.finalPass();
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
  sb.finalPass();
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
    assert.ok(sb.state().completion);
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
  sb.finalPass();
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
  assert.match(sb.ok("retry", "01", "--new-worktree", "--reason", "session and worktree unusable"), /old attempt is kept/);
  sb.ok("dispatch", "01");
  const t = sb.state().tasks["01"];
  assert.equal(t.attempt, "a2");
  assert.equal(t.branch, "wl-feat-01-a2");
  assert.notEqual(t.agentId, old.agentId);
  assert.ok(existsSync(old.worktree));
  assert.equal(t.history[0].reason, "session and worktree unusable");
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

test("session recovery handles Git worktree output with CRLF line endings", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  const old = sb.state().tasks["01"];
  writeFileSync(join(old.worktree, "uncommitted.txt"), "keep this recovery work\n");
  sb.setAgent(old.agentId, "error");
  sb.ok("retry", "01", "--reason", "provider session cannot be resumed");
  const preload = join(sb.root, "git-worktree-crlf.cjs");
  writeFileSync(preload, `
    const cp = require('node:child_process');
    const original = cp.spawnSync;
    cp.spawnSync = (command, args, options) => {
      const result = original(command, args, options);
      if (command === 'git' && args.includes('worktree') && args.includes('list') && !args.includes('-z')) {
        result.stdout = result.stdout.replace(/\\r?\\n/g, '\\r\\n');
      }
      return result;
    };
    require('node:module').syncBuiltinESMExports();
  `);
  sb.nodeArgs.push("--require", preload);
  sb.ok("dispatch", "01");
  const fresh = sb.state().tasks["01"];
  assert.equal(fresh.worktree, old.worktree);
  assert.equal(fresh.branch, old.branch);
  assert.notEqual(fresh.agentId, old.agentId);
  assert.equal(readFileSync(join(fresh.worktree, "uncommitted.txt"), "utf8"), "keep this recovery work\n");
  assert.equal(sb.db().workspaces.length, 1);
});

test("session replacement reuses committed and dirty work and retains review history", () => {
  const sb = sandbox();
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("review", "01");
  sb.reviewed("01", "changes_requested");
  const old = sb.state().tasks["01"];
  sb.ok("send", "01", "--text", "Fix S1 using the existing implementation");
  const rework = sb.state().tasks["01"];
  assert.equal(rework.agentId, old.agentId);
  assert.equal(rework.worktree, old.worktree);
  assert.equal(rework.branch, old.branch);
  writeFileSync(join(old.worktree, "uncommitted.txt"), "keep this recovery work\n");
  sb.setAgent(old.agentId, "error");
  sb.ok("retry", "01", "--reason", "provider session cannot be resumed");
  sb.ok("dispatch", "01");
  const fresh = sb.state().tasks["01"];
  assert.notEqual(fresh.agentId, old.agentId);
  assert.equal(fresh.worktree, old.worktree);
  assert.equal(fresh.branch, old.branch);
  assert.equal(sb.g(fresh.worktree, "rev-parse", "HEAD"), old.candidateSha);
  assert.equal(readFileSync(join(fresh.worktree, "uncommitted.txt"), "utf8"), "keep this recovery work\n");
  assert.equal(fresh.rounds, 1);
  assert.ok(fresh.history.some((h) => h.reviewers?.includes(old.review.agentId)));
  const brief = readFileSync(join(sb.runDir, "briefs", "01-a2.md"), "utf8");
  assert.ok(brief.includes(old.agentId));
  assert.ok(brief.includes(old.candidateSha));
  assert.ok(existsSync(join(sb.runDir, "reports", "01-a1-before-1.md")));
  assert.equal(sb.db().workspaces.length, 1);
});

test("whole-run retro precedes archival, preserves evidence, and never applies suggestions", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# A\n\nBlocked by: None\nScope: f01.txt\n" }, init: ["--direct"] });
  sb.complete("01");
  const t = sb.state().tasks["01"];
  sb.no(/run finish/, "archive");
  const report = join(sb.root, "retro.md");
  writeFileSync(report, "Repeated behavior: suggest an AGENTS.md rule and a hook. User decides.\n");
  sb.ok("retro", "--file", report);
  sb.ok("finish");
  sb.no(/assess retro/, "archive"); // interim report is not a close assessment
  assert.ok(!sb.agent(t.agentId).archived);
  sb.ok("retro", "--file", report);
  const retroPath = sb.state().retro.path;
  assert.equal(existsSync(join(sb.repo, "AGENTS.md")), false);
  sb.editDb((d) => { d.failOnce = "agent logs"; });
  sb.no(/injected failure/, "archive");
  assert.ok(sb.db().agents.every((a) => !a.archived));
  assert.ok(existsSync(t.worktree));
  sb.editDb((d) => { d.failOnce = "workspace archive"; });
  sb.no(/injected failure/, "archive");
  assert.ok(existsSync(join(sb.runDir, "evidence", "index.json")));
  const logCalls = sb.db().calls.filter((a) => a[0] === "agent" && a[1] === "logs").length;
  sb.ok("archive");
  assert.equal(sb.db().calls.filter((a) => a[0] === "agent" && a[1] === "logs").length, logCalls);
  assert.ok(sb.db().agents.every((a) => a.archived));
  assert.equal(existsSync(t.worktree), false);
  assert.equal(existsSync(sb.state().integration.worktree), false);
  const index = JSON.parse(readFileSync(join(sb.runDir, "evidence", "index.json")));
  assert.equal(index.agents.length, 2);
  for (const a of index.agents) assert.ok(readFileSync(join(sb.runDir, "evidence", a.file), "utf8").length);
  assert.equal(readFileSync(retroPath, "utf8"), readFileSync(report, "utf8"));
  assert.equal(existsSync(join(sb.repo, "AGENTS.md")), false);
  assert.match(sb.ok("archive"), /already archived/);
  sb.editDb((d) => { d.failOnce = "agent logs"; });
  assert.match(sb.ok("evidence"), /preserved evidence/);
  assert.equal(sb.db().failOnce, "agent logs"); // archived reads never need the provider
  sb.ok("retro", "--file", report); // explicit retro also works after archival
  assert.ok(existsSync(retroPath)); // prior output retained
});

test("post-integration repair gets a new session and tree; stale retro cannot close new work", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# A\n\nBlocked by: None\nScope: f01.txt\n" }, init: ["--direct"] });
  sb.complete("01");
  sb.ok("finish");
  sb.ok("retro", "--skip", "--reason", "No repeat issues so far");
  const old = sb.state().tasks["01"];
  const tip = sb.state().integration.tip;
  writeFileSync(join(sb.runDir, "issues", "02-repair.md"), "# Repair\n\nBlocked by: 01\nScope: f02.txt\n");
  sb.ok("import");
  sb.no(/run finish/, "archive");
  sb.no(/is done/, "send", "01", "--text", "reuse the integrated executor");
  sb.ok("dispatch", "02");
  const repair = sb.state().tasks["02"];
  assert.notEqual(repair.agentId, old.agentId);
  assert.notEqual(repair.worktree, old.worktree);
  assert.equal(repair.baseSha, tip);
  assert.ok(existsSync(old.worktree));
  sb.work("02"); sb.ok("review", "02"); sb.reviewed("02"); sb.ok("integrate", "02");
  sb.ok("finish");
  sb.no(/assess retro/, "archive");
  sb.ok("retro", "--skip", "--reason", "Reviewed the repair evidence; no recurring process issue");
  sb.ok("archive");
  assert.ok(sb.db().agents.every((a) => a.archived));
});

test("archival retains cancelled dirty work but archives its sessions with all attempts", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# A\n\nBlocked by: None\nScope: f01.txt\n" }, init: ["--direct"] });
  sb.ok("dispatch", "01");
  const old = sb.state().tasks["01"];
  writeFileSync(join(old.worktree, "valuable.txt"), "not integrated\n");
  sb.setAgent(old.agentId, "error");
  sb.ok("retry", "01", "--new-worktree", "--reason", "need a separate clean attempt");
  sb.ok("dispatch", "01");
  const next = sb.state().tasks["01"];
  sb.setAgent(next.agentId, "idle");
  sb.ok("cancel", "01", "--reason", "user changed scope");
  sb.ok("finish");
  sb.ok("retro", "--skip", "--reason", "No recurring issue in this synthetic fixture");
  sb.ok("archive");
  assert.ok(sb.db().agents.every((a) => a.archived));
  assert.equal(readFileSync(join(old.worktree, "valuable.txt"), "utf8"), "not integrated\n");
  assert.ok(existsSync(next.worktree));
  assert.equal(sb.state().retainedWorktrees.length, 2);
  const evidence = JSON.parse(readFileSync(join(sb.runDir, "evidence/index.json")));
  assert.equal(evidence.agents.length, 2);
});

test("a missing provider session can be replaced without losing its tree; evidence discloses the gap", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# A\n\nBlocked by: None\nScope: f01.txt\n" }, init: ["--direct"] });
  sb.ok("dispatch", "01");
  const old = sb.state().tasks["01"];
  sb.editDb((d) => { d.agents = d.agents.filter((a) => a.id !== old.agentId); });
  sb.ok("retry", "01", "--reason", "provider session has been deleted");
  sb.ok("dispatch", "01");
  assert.equal(sb.state().tasks["01"].worktree, old.worktree);
  sb.work("01"); sb.ok("review", "01"); sb.reviewed("01"); sb.ok("integrate", "01");
  sb.ok("finish");
  const report = join(sb.root, "retro.md");
  writeFileSync(report, "Session was deleted; original transcript unavailable. Suggest investigating provider retention.\n");
  sb.ok("retro", "--file", report);
  assert.match(sb.ok("archive"), /evidence gap/);
  const index = JSON.parse(readFileSync(join(sb.runDir, "evidence/index.json")));
  assert.equal(index.agents.find((a) => a.id === old.agentId).missing, true);
});

test("archival does not sweep agents in another checkout with colliding run labels", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# A\n\nBlocked by: None\nScope: f01.txt\n" }, init: ["--direct"] });
  sb.complete("01");
  sb.editDb((d) => d.agents.push({ id: "foreign", cwd: "/other/repo", status: "idle", archived: false, labels: { workloop: sb.state().runKey, task: "01" }, prompts: ["unrelated work"] }));
  sb.ok("finish"); sb.ok("retro", "--skip", "--reason", "No recurring issue"); sb.ok("archive");
  assert.equal(sb.agent("foreign").archived, false);
  const index = JSON.parse(readFileSync(join(sb.runDir, "evidence/index.json")));
  assert.equal(index.agents.some((a) => a.id === "foreign"), false);
});

// ------------------------------------------ independent final review (ticket #04)

// A full run with one ticket, closed and integrated: everything the final review needs.
function finalRun(ticket = "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one — check: `node --version`\n") {
  const sb = sandbox({ tickets: { "01-a.md": ticket } });
  sb.complete("01");
  return sb;
}

test("final review: prepare refuses in a direct run, with an open ticket, pending document work, during a check phase, and without a current mapping", async () => {
  const direct = sandbox({ init: null, tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\nScope: f01.txt\n" } });
  rmSync(join(direct.runDir, "spec.md"));
  direct.ok("init", "--direct", "--feature", "feat", "--repo", direct.repo, "--check", CHECK);
  direct.complete("01");
  direct.no(/a direct run has no final review/, "final-review", "--prepare");

  const open = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n", "02-b.md": "# 02: B\n\nBlocked by: 01\n" } });
  open.complete("01");
  open.no(/final-review needs every ticket closed: #02 ready/, "final-review", "--prepare");
  open.ok("cancel", "02", "--reason", "out of scope after all");
  // The mapping is the reviewer's input, so it comes first.
  open.no(/write the acceptance mapping to .*final-review\.md first/, "final-review", "--prepare");
  open.finalMapping("deadbeef");
  open.no(/is for integration tip deadbeef, but the tip is/, "final-review", "--prepare");
  open.finalMapping();
  const stale = new Date(Date.parse(open.state().lastIntegratedAt) - 60000);
  utimesSync(join(open.runDir, "final-review.md"), stale, stale);
  open.no(/is older than the last integration .*rewrite the mapping for the current tip/, "final-review", "--prepare");
  open.no(/final-review starts an independent final reviewer; pass --prepare/, "final-review");

  const docs = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" }, init: null });
  withRegistry(docs);
  docs.ok("init", "--feature", "feat", "--repo", docs.repo, "--check", CHECK);
  docs.ok("dispatch", "01");
  docs.work("01", { files: { "PROGRESS.md": "progress\n" } });
  docs.ok("review", "01");
  docs.reviewed("01");
  docs.ok("integrate", "01");
  docs.finalMapping();
  docs.no(/the end-of-run document step still reports work: 1 new documents aren't in the registry/, "final-review", "--prepare");

  const held = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n" } });
  const release = held.heldIntegrate();
  const run = held.start("integrate", "01");
  await held.waitFor("the check's identity", () => held.state().checking?.check && held.state().checking);
  held.no(/check phase: integrate on #01/, "final-review", "--prepare");
  release();
  const { code, out } = await run.done;
  assert.equal(code, 0, out);
});

test("final review: prepare starts a round at the tip with its own branch, worktree, brief and labelled request", () => {
  const sb = finalRun();
  sb.finalMapping();
  const action = JSON.parse(sb.ok("final-review", "--prepare"));
  const s = sb.state();
  const f = s.finalReview;
  assert.equal(f.round, 1);
  assert.equal(f.branch, "wl-feat-final-1");
  assert.equal(f.tip, s.integration.tip);
  assert.equal(f.path, join(sb.runDir, "reviews", `final-1-${s.integration.tip.slice(0, 8)}.md`));
  assert.ok(existsSync(f.worktree));
  assert.notEqual(f.worktree, s.integration.worktree);
  assert.equal(sb.g(f.worktree, "rev-parse", "HEAD"), f.tip, "branched at the integration tip");
  assert.equal(sb.g(f.worktree, "branch", "--show-current"), "wl-feat-final-1");
  assert.ok(sb.db().calls.some((c) => c[0] === "workspace" && c[1] === "create" && c.includes("wl-feat-final-1")), "created through Paseo");

  // The create_agent request the orchestrator executes: reviewer settings and labels.
  assert.equal(action.tool, "create_agent");
  assert.equal(action.arguments.provider, "fake/review-model");
  assert.equal(action.arguments.settings.modeId, "full");
  assert.equal(action.arguments.settings.thinkingOptionId, "high");
  assert.equal(action.arguments.notifyOnFinish, true);
  assert.ok(action.arguments.workspaceId);
  const { action: actionId, ...labels } = action.arguments.labels;
  assert.deepEqual(labels, { workloop: s.runKey, task: "final", attempt: "r1", role: "reviewer" });
  assert.ok(actionId);

  // The brief: every input the spec names, the method, the rules and the report shape.
  const brief = readFileSync(join(sb.runDir, "briefs", `final-1-${s.integration.tip.slice(0, 8)}.md`), "utf8");
  assert.doesNotMatch(brief, /\{\{/);
  for (const input of [f.worktree, f.tip, s.spec, s.tickets, join(sb.runDir, "final-review.md"), `git diff ${s.baseSha}..${s.integration.tip}`,
    "node --version", s.tasks["01"].review.path, f.path]) {
    assert.ok(brief.includes(slash(input)), `${input}\n${brief}`);
  }
  assert.match(brief, /The waiver ledger, every finding the run let through, to re-assess:\n {2}waived findings: none/);
  for (const step of ["Cross-ticket review", "Verify the acceptance mapping", "Re-run the checks and the regression set", "Re-assess every waiver", "Run the changed surface for real"]) {
    assert.ok(brief.includes(`**${step}`), `${step}\n${brief}`);
  }
  assert.match(brief, /## Boundary\n/);
  assert.match(brief, /#02 AC3: <the criterion, quoted>/);
  assert.match(brief, /M2: <the mapping row, quoted>/);
  assert.match(brief, /Waiver L3: <the entry's label in the ledger, and why it still stands>/);
  // P6: all three waiver outcomes, each with what to do.
  assert.match(brief, /does the finding still hold on this tree, and does the reason it was let through still hold/);
  assert.match(brief, /the finding still holds and its reason still holds: a note, no finding/);
  assert.match(brief, /the finding still holds and its reason no longer does: a blocking `Waiver` finding citing the entry/);
  assert.match(brief, /the finding is already fixed on this tree: a note that it is fixed, with what shows it, and no finding/);
  for (const floor of ["Regression", "Data loss", "Security", "ADR"]) assert.match(brief, new RegExp("`" + floor + ": <[^`]*>`"), floor);
  assert.match(brief, /\*\*Read-only\.\*\* Don't edit, commit, check out, stash or reset anything/);
  assert.match(brief, /Never ask the user anything/);
  assert.match(brief, /`X1`, `X2`, …/);
  assert.match(brief, /`A1`, `A2`, …/);
  assert.match(brief, /`W1`, `W2`, …/);
  assert.match(brief, /Result: <pass \| changes_requested>/);
});

test("final review: a second round at the same tip needs --again, earlier rounds stay in history, and a moved tip allows a new round", () => {
  const sb = finalRun();
  const first = sb.finalReview();
  sb.no(/the final review already has round 1 for the current tip .*pass --again/, "final-review", "--prepare");

  const second = sb.finalReview({ again: true, report: false });
  assert.equal(second.round, 2);
  assert.equal(second.branch, "wl-feat-final-2");
  assert.equal(sb.g(second.worktree, "branch", "--show-current"), "wl-feat-final-2");
  assert.notEqual(second.worktree, first.worktree);
  const s = sb.state();
  assert.deepEqual(s.finalReviews.map((r) => r.round), [1]);
  assert.equal(s.finalReviews[0].agentId, first.agentId, "the earlier round keeps its session");
  assert.ok(existsSync(first.worktree), "and its worktree, until archive");

  // A repair moves the tip, so the next round needs no --again.
  writeFileSync(join(sb.runDir, "issues", "02-fix.md"), "# 02: Fix\n\nBlocked by: 01\n\n- [ ] AC1: still works — check: `node --version`\n");
  sb.ok("import");
  sb.ok("dispatch", "02");
  sb.work("02");
  sb.ok("review", "02");
  sb.reviewed("02");
  sb.ok("integrate", "02");
  // A round exists for the old tip, so --again is not what starts the next one.
  sb.no(/--again starts a second round at the same tip, and no round covers the current tip/, "final-review", "--prepare", "--again");
  const third = sb.finalReview({ report: false });
  assert.equal(third.round, 3);
  assert.equal(third.tip, sb.state().integration.tip);
  assert.deepEqual(sb.state().finalReviews.map((r) => r.round), [1, 2]);
});

test("final review: action final shows the request, and ack final refuses a receipt for the wrong labels, worktree or parent", () => {
  const sb = finalRun();
  sb.finalMapping();
  const action = JSON.parse(sb.ok("final-review", "--prepare"));
  assert.deepEqual(JSON.parse(sb.ok("action", "final")), action);
  // While the request waits, nothing else starts: it needs its receipt first.
  sb.no(/the final review has pending MCP action .*action final/, "finish");
  sb.no(/the final review has pending MCP action .*action final/, "final-review", "--prepare");
  sb.ok("note", "--text", "recorded while the request waits");

  const receipt = (payload) => {
    writeFileSync(join(sb.root, "final-receipt.json"), JSON.stringify(payload));
    return join(sb.root, "final-receipt.json");
  };
  sb.no(/receipt action does not match the pending action/, "ack", "final", "--receipt", receipt({ action: "nope", result: { agentId: "x" } }));
  // An agent with another run's labels is not this reviewer.
  sb.editDb((d) => d.agents.push({ id: "stray", cwd: sb.state().finalReview.worktree, labels: { workloop: "other", task: "final" }, status: "idle", archived: false, parentAgentId: sb.env.PASEO_AGENT_ID, updatedAt: new Date().toISOString(), prompts: ["x"] }));
  sb.no(/does not match the prepared labels and worktree/, "ack", "final", "--receipt", receipt({ action: action.action, result: { agentId: "stray", status: "idle" } }));
  // The right labels, but in another directory.
  sb.editDb((d) => d.agents.push({ id: "elsewhere", cwd: sb.repo, labels: action.arguments.labels, status: "idle", archived: false, parentAgentId: sb.env.PASEO_AGENT_ID, updatedAt: new Date().toISOString(), prompts: ["x"] }));
  sb.no(/does not match the prepared labels and worktree/, "ack", "final", "--receipt", receipt({ action: action.action, result: { agentId: "elsewhere", status: "idle" } }));
  sb.editDb((d) => { d.agents = d.agents.filter((a) => a.id !== "elsewhere"); });
  // The right labels and worktree, but another orchestrator's child.
  sb.editDb((d) => d.agents.push({ id: "orphan", cwd: sb.state().finalReview.worktree, labels: action.arguments.labels, status: "idle", archived: false, parentAgentId: "someone-else", updatedAt: new Date().toISOString(), prompts: ["x"] }));
  sb.no(/does not belong to this orchestrator/, "ack", "final", "--receipt", receipt({ action: action.action, result: { agentId: "orphan", status: "idle" } }));
  assert.ok(sb.state().finalReview.pendingAction, "a refused receipt retains the request");
  sb.editDb((d) => { d.agents = d.agents.filter((a) => a.id !== "orphan"); });

  // The real launch: an agent in the round's worktree, under this orchestrator.
  sb.editDb((d) => d.agents.push({ id: "good", title: action.arguments.title, cwd: sb.state().finalReview.worktree, labels: action.arguments.labels, status: "running", archived: false, parentAgentId: sb.env.PASEO_AGENT_ID, updatedAt: new Date().toISOString(), prompts: ["p"] }));
  const out = sb.ok("ack", "final", "--receipt", receipt({ action: action.action, result: { agentId: "good", status: "running" } }));
  assert.match(out, /final review round 1: reviewer good acknowledged/);
  const f = sb.state().finalReview;
  assert.equal(f.agentId, "good");
  assert.equal(f.pendingAction, null);
  assert.equal(f.launch, "fake model=review-model mode=full thinking=high ← profile \"wl-reviewer\"");
  assert.deepEqual(sb.events("final_review").map((e) => e.round), [1]);
  assert.deepEqual(sb.events("final_reviewer").map((e) => [e.round, e.agent]), [[1, "good"]]);
});

test("final review: finish needs this round's report for this tip, and accepts changes_requested once every blocking finding is waived", () => {
  const sb = finalRun();
  const round = sb.finalReview({ report: false });
  sb.no(/the final reviewer \(round 1\) has not written .* yet since/, "finish");
  writeFileSync(round.path, `Verdict: pass\nIntegration tip: deadbeef\n`);
  sb.no(/the final review's report is for integration tip deadbeef, but the tip is/, "finish");
  writeFileSync(round.path, `Verdict: changes_requested\nIntegration tip: ${round.tip}\n${findingsTable([
    { id: "X1", blocking: true, basis: "#01 AC1: one" },
    { id: "A1", blocking: true, axis: "Acceptance", basis: "M1: spec item M1" },
    { id: "X2", blocking: false, basis: "M1: a nit" },
  ], "Cross-ticket")}`);
  sb.no(/the final review requested changes and X1, A1 are not waived/, "finish");
  sb.no(/write repair tickets .*final-review --waive X1, A1 --reason/, "finish");
  assert.match(sb.ok("status"), /final review changes requested \(X1, A1\): read .*final-review --waive X1, A1/);

  // Only a blocking finding of this report may be waived, and only with a reason.
  sb.no(/final-review --waive takes finding IDs/, "final-review", "--waive", ",");
  sb.no(/final-review --waive needs --reason/, "final-review", "--waive", "X1");
  sb.no(/NOPE is not a blocking finding of the final review; blocking: X1, A1/, "final-review", "--waive", "NOPE", "--reason", "x");
  sb.no(/X2 is not a blocking finding of the final review/, "final-review", "--waive", "X2", "--reason", "x");
  assert.equal(sb.state().waivers, undefined, "a refused waiver records nothing");

  assert.match(sb.ok("final-review", "--waive", "X1", "--reason", "the user accepted the interface drift"), /final review: waived X1/);
  sb.no(/and A1 is not waived/, "finish");
  sb.ok("final-review", "--waive", "A1", "--reason", "the mapping row still holds on the tree");
  const out = sb.ok("finish");
  assert.match(out, /waived findings — the user should review these 2 entries:/);
  assert.match(out, /final review X1 · final · Cross-ticket · src\/x\.ts:1 · #01 AC1: one · reason: the user accepted the interface drift/);
  assert.match(out, /final review A1 · final · Acceptance · src\/x\.ts:1 · M1: spec item M1 · reason: the mapping row still holds on the tree/);
  assert.match(out, /out-of-boundary findings: none/);
  const s = sb.state();
  assert.deepEqual(s.waivers.map((w) => [w.kind, w.task, w.sha, w.review, w.findings.map((x) => x.id)]), [
    ["final", "final", round.tip, round.path, ["X1"]],
    ["final", "final", round.tip, round.path, ["A1"]],
  ]);
  assert.deepEqual(sb.events("waiver").filter((e) => e.waiver === "final").map((e) => e.findings[0].id), ["X1", "A1"]);
  assert.match(sb.ok("status"), /waived findings: 2/);
});

test("final review: a finding outside the mapping, criteria, ledger and floor classes is a suggestion; finish neither gates on it nor waives it", () => {
  assert.deepEqual(finalCitation("#02 AC3: the writer keeps the header"), { ticket: "02", criterion: "AC3" });
  assert.deepEqual(finalCitation("**M2:** the mapping row"), { mapping: "M2" });
  assert.deepEqual(finalCitation("Waiver #01 S3: the entry still stands"), { waiver: { task: "01", id: "S3" } });
  assert.deepEqual(finalCitation("Waiver L3: the entry still stands"), { waiver: { entry: "L3" } });
  assert.deepEqual(finalCitation("Waiver final W1: it stands"), { waiver: { task: "final", id: "W1" } });
  assert.deepEqual(finalCitation("Data-loss: drops a branch"), { floor: "Data loss" });
  for (const basis of ["see #02 AC3", "the modules are laid out oddly", "", "M1 - no colon"]) assert.deepEqual(finalCitation(basis), {}, basis);
  const boundary = { mappings: ["M1"], criteria: { "01": ["AC1"] }, waivers: [{ task: "01", findings: [{ id: "S3" }] }] };
  assert.equal(inFinalBoundary({ basis: "#01 AC1: one" }, boundary), true);
  assert.equal(inFinalBoundary({ basis: "#02 AC3: another ticket's" }, boundary), false);
  assert.equal(inFinalBoundary({ basis: "M1: the row" }, boundary), true);
  assert.equal(inFinalBoundary({ basis: "M7: no such row" }, boundary), false);
  assert.equal(inFinalBoundary({ basis: "Waiver #01 S3: reason" }, boundary), true);
  assert.equal(inFinalBoundary({ basis: "Waiver #01 S9: no such entry" }, boundary), false);
  assert.equal(inFinalBoundary({ basis: "Security: injection" }, boundary), true);
  assert.equal(inFinalBoundary({ basis: "the modules are laid out oddly" }, boundary), false);
  // The mapping's rows are the ones it numbers, wherever the number sits.
  assert.deepEqual(mappingRows("| Row | Item |\n|---|---|\n| M1 | a |\n| M12 | b |\n| not-a-row | c |\n"), ["M1", "M12"]);

  const sb = finalRun();
  const round = sb.finalReview({ verdict: "changes_requested", findings: [
    { id: "X1", blocking: true, basis: "the modules are laid out oddly" },
    { id: "X2", blocking: false, basis: "M1: a nit" },
  ] });
  writeFileSync(round.path, `${readFileSync(round.path, "utf8")}\n## Out of scope\n- src/x.ts could be split into two modules\n`);
  // It gates nothing: the run is as ready as a pass, and the report says so.
  assert.match(sb.ok("status"), /finish — the final review's blocking findings are all outside its boundary \(suggestions for the user\)/);
  sb.no(/X1 is outside the final review's boundary .* it is a suggestion and needs no waiver/, "final-review", "--waive", "X1", "--reason", "user accepted it");
  const out = sb.ok("finish");
  assert.match(out, /out-of-boundary findings — raised outside the confirmed criteria and floor classes; the user decides:\n- final review X1 · Cross-ticket · src\/x\.ts:1 · the modules are laid out oddly/);
  assert.match(out, /suggestions from `## Out of scope` — the user decides:\n- final review: src\/x\.ts could be split into two modules/);
  assert.doesNotMatch(out, /waived findings — /);
  assert.equal(sb.state().waivers, undefined);
});

test("final review: status leads through the mapping, the round, finish, repairs and waivers, and watch treats the reviewer as a worker", () => {
  const sb = finalRun();
  assert.match(sb.ok("status"), /do the acceptance mapping: write the acceptance mapping to .*final-review\.md first/);
  sb.finalMapping();
  assert.match(sb.ok("status"), /final-review --prepare — start the independent final reviewer at/);
  const action = JSON.parse(sb.ok("final-review", "--prepare"));
  assert.match(sb.ok("status"), /action final — reconcile pending MCP action .*; do not repeat an unacknowledged call/);
  assert.match(sb.ok("watch"), /final review round 1: pending MCP action/);

  const round = sb.ackFinal(action, { idle: false });
  const running = sb.ok("watch");
  assert.match(running, /【保温心跳】正常/);
  // The live view knows the final reviewer; it is not an unrecorded dispatch.
  assert.doesNotMatch(sb.ok("status", "--live"), /carries this run's label but is not recorded/);
  assert.equal(JSON.parse(sb.ok("status", "--json")).finalReview.agentId, round.agentId);
  assert.match(sb.ok("status"), /wait for the final reviewer \(round 1\) to write .*watch.*; then finish, write repair tickets or waive its findings/);
  sb.setAgent(round.agentId, "idle");
  assert.match(sb.ok("watch"), new RegExp(`final review ${round.agentId.slice(0, 8)}: idle; read .* and continue the loop`));

  writeFileSync(round.path, `Verdict: changes_requested\nIntegration tip: ${round.tip}\n${findingsTable([{ id: "X1", blocking: true, basis: "M1: spec item M1" }])}`);
  assert.match(sb.ok("status"), /final review changes requested \(X1\): read .*write repair tickets .*final-review --waive X1 .*--prepare --again/);
  sb.ok("final-review", "--waive", "X1", "--reason", "the user accepted the drift");
  assert.match(sb.ok("status"), /finish — the final review's blocking findings are all waived/);

  // A pass says finish; --again says review this tip once more.
  writeFileSync(round.path, `Verdict: pass\nIntegration tip: ${round.tip}\n`);
  assert.match(sb.ok("status"), /finish — the final reviewer passed the current tip/);
});

test("final review: evidence captures the reviewer session and archive removes a clean final worktree and its branch", () => {
  const sb = finalRun();
  const round = sb.finalPass();
  assert.ok(round.agentId);
  sb.ok("finish");
  sb.ok("retro", "--skip", "--reason", "No recurring problem in this fixture");
  sb.ok("archive");
  assert.equal(sb.agent(round.agentId).archived, true, "the session is archived with the run");
  assert.equal(existsSync(round.worktree), false, "the clean worktree goes");
  assert.equal(spawnSync("git", ["-C", sb.repo, "rev-parse", "--verify", round.branch], { env: sb.env }).status, 128, "and its branch");
  const index = JSON.parse(readFileSync(join(sb.runDir, "evidence", "index.json"), "utf8"));
  const entry = index.agents.find((a) => a.id === round.agentId);
  assert.ok(entry, "evidence carries the reviewer session");
  assert.deepEqual(entry.tasks, [{ task: "final", attempt: "r1", role: "reviewer" }]);
  assert.ok(readFileSync(join(sb.runDir, "evidence", entry.file), "utf8").length);
});

test("final review: archive retains and lists a dirty final worktree", () => {
  const sb = finalRun();
  const round = sb.finalPass();
  writeFileSync(join(round.worktree, "leftover.txt"), "keep this\n");
  sb.ok("finish");
  sb.ok("retro", "--skip", "--reason", "No recurring problem in this fixture");
  const out = sb.ok("archive");
  assert.match(out, /unmerged or dirty work retained for your decision:/);
  assert.ok(out.includes(round.worktree), out);
  assert.equal(readFileSync(join(round.worktree, "leftover.txt"), "utf8"), "keep this\n");
  assert.deepEqual(sb.state().retainedWorktrees.map((w) => [w.worktree, w.branch]), [[round.worktree, round.branch]]);
  assert.equal(sb.agent(round.agentId).archived, true, "its session is archived anyway");
});

test("final review: finish re-checks the final gate after its checks and records no delivery when the report is gone", async () => {
  const sb = finalRun();
  const round = sb.finalPass();
  const held = sb.heldCheck();
  sb.ok("config", "--check", held.cmd);
  const run = sb.start("finish");
  await sb.waitFor("the check's identity", () => sb.state().checking?.check && sb.state().checking);
  rmSync(round.path);
  held.release();
  const { code, out } = await run.done;
  assert.notEqual(code, 0, out);
  assert.match(out, /finish's checks passed, but a delivery gate no longer holds[\s\S]*the final reviewer \(round 1\) has not written/);
  const s = sb.state();
  assert.equal(s.checking, null);
  assert.equal(s.completion ?? null, null);
  assert.equal(sb.events("finish").length, 0);
});

// ---------------------------------- rework round 1: review findings P1-P6 (#04)

test("final review: archive keeps a final branch that holds work of its own", () => {
  const sb = finalRun();
  const round = sb.finalPass();
  // A clean tree whose HEAD has moved: only the branch ref keeps this commit alive.
  writeFileSync(join(round.worktree, "unique.txt"), "work only the final reviewer made\n");
  sb.g(round.worktree, "add", "unique.txt");
  sb.g(round.worktree, "commit", "-q", "-m", "a commit the run never integrated");
  const unique = sb.g(round.worktree, "rev-parse", "HEAD");
  assert.notEqual(unique, round.tip);
  assert.equal(sb.g(round.worktree, "status", "--porcelain"), "", "the tree is clean, so status alone would have passed it");
  sb.ok("finish");
  sb.ok("retro", "--skip", "--reason", "No recurring problem in this fixture");
  const out = sb.ok("archive");
  assert.match(out, /unmerged or dirty work retained for your decision:/);
  assert.ok(out.includes(round.worktree), out);
  assert.ok(existsSync(round.worktree), "the worktree is kept");
  assert.equal(sb.g(sb.repo, "rev-parse", `refs/heads/${round.branch}`), unique, "its branch still reaches the commit");
  assert.equal(sb.g(sb.repo, "cat-file", "-t", unique), "commit");
  assert.deepEqual(sb.state().retainedWorktrees.map((w) => [w.worktree, w.branch]), [[round.worktree, round.branch]]);
});

test("final review: finish refuses a report for a round whose reviewer was never acknowledged", () => {
  const sb = finalRun();
  sb.finalMapping();
  const action = JSON.parse(sb.ok("final-review", "--prepare"));
  const receipt = join(sb.root, "failed-final.json");
  writeFileSync(receipt, JSON.stringify({ action: action.action, result: { isError: true, content: [{ type: "text", text: "the provider rejected the launch" }] } }));
  assert.match(sb.ok("ack", "final", "--receipt", receipt), /failed; no success recorded/);
  const f = sb.state().finalReview;
  assert.equal(f.agentId, undefined);
  writeFileSync(f.path, `Verdict: pass\nIntegration tip: ${f.tip}\n`);
  // A fresh pass file is not a verdict: no independent reviewer ever ran.
  sb.no(/round 1 has no acknowledged reviewer: .*final-review --prepare --again/, "finish");
  assert.match(sb.ok("status"), /final review round 1 has no acknowledged reviewer/);
  assert.equal(sb.state().completion ?? null, null);

  // Recovery: a new round, this time acknowledged, takes the same pass.
  const round = sb.finalReview({ again: true });
  assert.equal(round.round, 2);
  assert.ok(round.agentId);
  assert.match(sb.ok("finish"), /Nothing was pushed/);
});

test("final review: a waiver covers the finding it waived, not a later finding that reuses its ID", () => {
  const sb = finalRun();
  const round = sb.finalReview({ verdict: "changes_requested", findings: [
    { id: "X1", blocking: true, basis: "M1: the original issue" },
    { id: "X2", blocking: true, axis: "Acceptance", basis: "#01 AC1: one" },
  ] });
  sb.ok("final-review", "--waive", "X1", "--reason", "the user accepted the original issue");
  sb.ok("final-review", "--waive", "X2", "--reason", "the criterion holds as written");
  assert.match(sb.ok("status"), /finish — the final review's blocking findings are all waived/);

  // The same ID now names a different, new blocking finding.
  writeFileSync(round.path, `Verdict: changes_requested\nIntegration tip: ${round.tip}\n${findingsTable([
    { id: "X1", blocking: true, basis: "Security: a new, unrelated injection" },
    { id: "X2", blocking: true, axis: "Acceptance", basis: "#01 AC1: one" },
  ], "Cross-ticket")}`);
  sb.no(/requested changes and X1 is not waived/, "finish");
  // The unchanged X2 is still covered; the rewritten X1 needs its own waiver.
  sb.ok("final-review", "--waive", "X1", "--reason", "the user accepted the rewritten finding too");
  const out = sb.ok("finish");
  assert.match(out, /waived findings — the user should review these 3 entries:/);
  assert.match(out, /final review X1 · final · Cross-ticket · src\/x\.ts:1 · Security: a new, unrelated injection · reason: the user accepted the rewritten finding too/);
});

test("final review: an interrupted prepare adopts its worktree only when it is clean", () => {
  const sb = finalRun();
  sb.finalMapping();
  const action = JSON.parse(sb.ok("final-review", "--prepare"));
  assert.equal(action.tool, "create_agent");
  const wt = sb.state().finalReview.worktree;
  // Simulate a crash before the state was saved: the branch and worktree exist, the round does not.
  const crashed = sb.state();
  delete crashed.finalReview;
  writeFileSync(join(sb.runDir, "state.json"), `${JSON.stringify(crashed, null, 2)}\n`);

  writeFileSync(join(wt, "shared.txt"), "edited by hand\n");
  sb.no(/left by an interrupted prepare with uncommitted or untracked changes[\s\S]*Nothing was changed/, "final-review", "--prepare");
  assert.equal(readFileSync(join(wt, "shared.txt"), "utf8"), "edited by hand\n", "refused without touching the tree");
  assert.match(sb.g(wt, "status", "--porcelain"), /M shared\.txt/);
  sb.g(wt, "checkout", "--", "shared.txt");

  writeFileSync(join(wt, "untracked.txt"), "new\n");
  sb.no(/uncommitted or untracked changes/, "final-review", "--prepare");
  assert.ok(existsSync(join(wt, "untracked.txt")), "refused without touching the tree");
  rmSync(join(wt, "untracked.txt"));

  // Clean again: the round adopts the worktree the interrupted prepare left.
  const resumed = JSON.parse(sb.ok("final-review", "--prepare"));
  assert.equal(resumed.tool, "create_agent");
  assert.equal(sb.state().finalReview.worktree, wt);
  assert.equal(sb.state().finalReview.pendingAction.action, resumed.action);
});

test("final review: every ledger entry has a label the reviewer can cite, including an override with no findings", () => {
  const sb = sandbox({ tickets: { "01-a.md": "# 01: A\n\nBlocked by: None\n\n- [ ] AC1: one — check: `node --version`\n" } });
  sb.ok("dispatch", "01");
  sb.work("01");
  sb.ok("freeze", "01"); // a candidate with no review at all
  sb.ok("integrate", "01", "--override", "the user read the diff themselves");
  const entry = sb.state().waivers[0];
  assert.deepEqual(entry.findings, [], "an override of a missing review holds no finding");
  assert.equal(entry.kind, "override");

  // Its label is the citation: `L1` for the first entry.
  assert.deepEqual(finalCitation("Waiver L1: the override's reason no longer covers the change"), { waiver: { entry: "L1" } });
  assert.equal(inFinalBoundary({ basis: "Waiver L1: ..." }, { waivers: sb.state().waivers }), true);
  assert.equal(inFinalBoundary({ basis: "Waiver L9: ..." }, { waivers: sb.state().waivers }), false);

  const round = sb.finalReview({ verdict: "changes_requested", findings: [
    { id: "W1", blocking: true, axis: "Waiver", location: "#01", basis: "Waiver L1: the override's reason no longer covers the change" },
  ] });
  const brief = readFileSync(join(sb.runDir, "briefs", `final-1-${round.tip.slice(0, 8)}.md`), "utf8");
  assert.match(brief, /- L1 · #01 - · override · - · - · the review was missing · reason: the user read the diff themselves/);
  assert.match(brief, /Waiver L3: <the entry's label in the ledger/);
  // A blocking finding that cites the entry gates finish.
  sb.no(/requested changes and W1 is not waived/, "finish");
  sb.ok("final-review", "--waive", "W1", "--reason", "the user re-read the override and accepts it");
  const out = sb.ok("finish");
  assert.match(out, /final review W1 · final · Waiver · #01 · Waiver L1: the override's reason no longer covers the change/);
});

// The orchestrator's view of `ack --receipt -`: the MCP response goes in on stdin.
function wlStdin(sb, input, ...args) {
  const r = spawnSync(process.execPath, [...sb.nodeArgs, CLI, "--run", "repo/feat", ...args], { env: sb.env, cwd: sb.repo, encoding: "utf8", input });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
// The external create_agent call: an agent carrying the prepared labels in the worktree.
function createAgent(sb, action, cwd) {
  const id = `mcp-${sb.db().n + 1}`;
  sb.editDb((d) => { d.n++; d.agents.push({ id, title: action.arguments.title, cwd, labels: action.arguments.labels,
    parentAgentId: sb.env.PASEO_AGENT_ID, status: "running", archived: false, updatedAt: new Date().toISOString() }); });
  return id;
}

test("ack: a bare MCP response on stdin acknowledges the pending action and is kept under messages/", () => {
  const sb = sandbox();
  let r = wlStdin(sb, JSON.stringify({ agentId: "x" }), "ack", "02", "--receipt", "-");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /#02 has no pending MCP action to acknowledge/);
  const action = JSON.parse(sb.ok("dispatch", "01", "--prepare"));
  const id = createAgent(sb, action, sb.state().tasks["01"].worktree);
  r = wlStdin(sb, "not json", "ack", "01", "--receipt", "-");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /the receipt is not JSON/);
  assert.ok(sb.state().tasks["01"].pendingAction, "a bad receipt leaves the action pending");
  // The tool's whole response, unchanged: structuredContent is read as before.
  r = wlStdin(sb, JSON.stringify({ structuredContent: { agentId: id, status: "running" } }), "ack", "01", "--receipt", "-");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /#01: dispatch acknowledged/);
  const t = sb.state().tasks["01"];
  assert.equal(t.agentId, id);
  assert.equal(t.pendingAction, null);
  const saved = JSON.parse(readFileSync(join(sb.runDir, "messages", `receipt-01-${action.action}.json`), "utf8"));
  assert.deepEqual(saved, { action: action.action, result: { structuredContent: { agentId: id, status: "running" } } });
  // A repeat is harmless, bare or wrapped.
  r = wlStdin(sb, JSON.stringify({ agentId: id }), "ack", "01", "--receipt", "-");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /#01 has no pending MCP action; its last one, .* is already acknowledged/);
  r = wlStdin(sb, JSON.stringify({ action: action.action, result: { agentId: id } }), "ack", "01", "--receipt", "-");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already acknowledged/);
});

test("ack: a wrapped receipt on stdin is checked against the pending action id, and a bare send response confirms the send", () => {
  const sb = sandbox();
  const dispatch = JSON.parse(sb.ok("dispatch", "01", "--prepare"));
  const id = createAgent(sb, dispatch, sb.state().tasks["01"].worktree);
  assert.equal(wlStdin(sb, JSON.stringify({ agentId: id }), "ack", "01", "--receipt", "-").code, 0);
  sb.setAgent(id, "idle");
  const send = JSON.parse(sb.ok("send", "01", "--prepare", "--text", "Also add a test for the empty case."));
  let r = wlStdin(sb, JSON.stringify({ action: "some-other-action", result: { success: true } }), "ack", "01", "--receipt", "-");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /receipt action does not match the pending action/);
  assert.ok(sb.state().tasks["01"].pendingAction);
  r = wlStdin(sb, JSON.stringify({ success: true, deliveryStatus: "queued", messageId: "m-1" }), "ack", "01", "--receipt", "-");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /#01: send acknowledged/);
  assert.equal(sb.state().tasks["01"].pendingAction, null);
  assert.ok(existsSync(join(sb.runDir, "messages", `receipt-01-${send.action}.json`)));
});

test("ack: ack final reads the final reviewer's MCP response from stdin", () => {
  const sb = finalRun();
  sb.finalMapping();
  const action = JSON.parse(sb.ok("final-review", "--prepare"));
  const id = createAgent(sb, action, sb.state().finalReview.worktree);
  const r = wlStdin(sb, JSON.stringify({ agentId: id, status: "running" }), "ack", "final", "--receipt", "-");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /final review round 1: reviewer .* acknowledged/);
  assert.equal(sb.state().finalReview.agentId, id);
  assert.ok(existsSync(join(sb.runDir, "messages", `receipt-final-${action.action}.json`)));
});

test("status: a prepared action that was never acknowledged says how long it has waited", () => {
  const sb = sandbox();
  JSON.parse(sb.ok("dispatch", "01", "--prepare"));
  assert.match(sb.ok("status"), /action 01 — reconcile pending MCP action \S+ \(prepared just now\)/);
  const file = join(sb.runDir, "state.json");
  const s = JSON.parse(readFileSync(file, "utf8"));
  s.tasks["01"].pendingAction.preparedAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  writeFileSync(file, JSON.stringify(s));
  assert.match(sb.ok("status"), /\(prepared 3h ago\)/);
});

test("config: --clear-launch drops a role's run overrides, so it follows its edited Paseo profile again", () => {
  const sb = sandbox();
  const launch = (role) => JSON.parse(sb.ok("status", "--json")).launch.find((l) => l.role === role);
  sb.ok("config", "--model", "pinned-model", "--review-model", "pinned-review");
  assert.equal(launch("executor").model, "pinned-model");
  sb.setProfiles([{ ...PROFILES[0], model: "edited-model" }, PROFILES[1]]);
  assert.equal(launch("executor").model, "pinned-model", "the run's override still wins over the edited profile");
  sb.no(/--clear-launch takes executor or reviewer, not "planner"/, "config", "--clear-launch", "planner");
  const out = sb.ok("config", "--clear-launch", "executor");
  assert.match(out, /executor: the run's launch overrides were dropped; agents started from now on use its Paseo profile/);
  assert.equal(launch("executor").model, "edited-model");
  assert.match(launch("executor").source, /^profile "wl-executor"$/);
  assert.equal(launch("reviewer").model, "pinned-review", "the other role keeps its overrides");
  // Flags in the same command apply after the clear.
  sb.ok("config", "--clear-launch", "reviewer", "--review-thinking", "low");
  assert.equal(launch("reviewer").model, "review-model");
  assert.equal(launch("reviewer").thinking, "low");
  assert.deepEqual(sb.state().config.reviewer, { thinking: "low" });
  assert.ok(readFileSync(join(sb.runDir, "events.jsonl"), "utf8").includes('"clearedLaunch":["executor"]'));
});
