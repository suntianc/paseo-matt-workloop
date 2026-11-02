// E1–E11 of the frozen design (§9), end to end: a real throwaway git repository,
// a throwaway WORKLOOP_ROOT holding runs written the way Workloop writes them, and
// the CLI driven as a subprocess. Each E has its own fixture, so a failure names
// the scenario rather than a shared setup. The developer's real ~/.workloop is
// never read or written.
//
// These tests prove the acceptance matrix; they do not replace the module suites
// beside them. Where a scenario needs a state only an interrupted command produces
// (a double primary, a missing audit line) the fixture is written by hand on
// disk, exactly as the interruption would leave it.
// Run: node --test skills/requirement-ledger/scripts/test/acceptance.test.mjs
import assert from "node:assert/strict";
import { spawnBounded } from "./spawn.mjs";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { emitRecord, fileNameFor, idFor, newRecord, parseRecord } from "../record.mjs";
import { readLog } from "../store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "req.mjs");

const NOW = "2026-11-01T10:00:00+08:00";
const DELIVERED = "2026-11-02T18:00:00+08:00";
const ARCHIVED = "2026-11-02T18:30:00+08:00";
const LATER = "2026-11-05T09:00:00+08:00";

// One or more throwaway repositories plus a throwaway WORKLOOP_ROOT. `myapp` is
// the project under test; a second project exists only for the scope check (E9).
function sandbox(t, projects = ["myapp"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "req-acceptance-")));
  const env = {
    ...process.env,
    WORKLOOP_ROOT: join(root, "wl"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  delete env.WORKLOOP_RUN;
  delete env.REQ_LOCK_WAIT_MS;

  const repos = {};
  for (const name of projects) {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    const git = (...args) => {
      const result = spawnBounded("git", ["-C", path, ...args], { env, encoding: "utf8" });
      assert.equal(result.status, 0, `git ${name} ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(path, "shared.txt"), "base\n");
    git("add", "shared.txt");
    git("commit", "-q", "-m", "base");
    repos[name] = { path, git, baseSha: git("rev-parse", "HEAD"), commits: 0 };
  }
  const main = projects[0];
  const baseSha = repos[main].baseSha;

  const dirOf = (project = main) => join(root, "wl", project, ".requirements");
  const dir = dirOf();
  const runDir = (feature = "feat", project = main) => join(root, "wl", project, feature);

  const run = (args, options = {}) => spawnBounded(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? repos[main].path, env: { ...env, ...options.env }, encoding: "utf8",
  });
  const ok = (args, options) => {
    const result = run(args, options);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return `${result.stdout}${result.stderr}`;
  };
  const stdout = (args, options) => {
    const result = run(args, options);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  const no = (pattern, args, options) => {
    const result = run(args, options);
    assert.notEqual(result.status, 0, `expected a refusal: ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    const text = `${result.stdout}${result.stderr}`;
    assert.match(text, pattern);
    return text;
  };

  // A commit that really exists, so a recorded SHA is one a reader can resolve.
  const commit = (project = main) => {
    const entry = repos[project];
    entry.commits += 1;
    writeFileSync(join(entry.path, "shared.txt"), `work ${entry.commits}\n`);
    entry.git("add", "shared.txt");
    entry.git("commit", "-q", "-m", "work");
    return entry.git("rev-parse", "HEAD");
  };

  // A run directory in the shape `init`/`finish`/`evidence`/`archive` leave it:
  // state.json plus the events Workloop wrote. `completion` is the only thing that
  // makes a run delivered; `integration.tip` is a working tip, not a delivery.
  function writeRun({ feature = "feat", project = main, state = {}, events = [], integrationTip } = {}) {
    const at = runDir(feature, project);
    mkdirSync(join(at, "issues"), { recursive: true });
    const full = {
      version: 1, project, feature, runKey: `${project}-${feature}`, mode: "direct",
      repo: repos[project].path, spec: join(at, "issues", "01-ticket.md"), tickets: join(at, "issues"),
      baseRef: "main", baseSha: repos[project].baseSha,
      integration: { branch: `workloop/${feature}`, worktree: join(at, "tip"), tip: integrationTip ?? repos[project].baseSha },
      config: {}, tasks: {}, seq: events.length + 1, createdAt: NOW,
      ...state,
    };
    writeFileSync(join(at, "state.json"), `${JSON.stringify(full, null, 2)}\n`);
    writeFileSync(join(at, "events.jsonl"), events.map((event, i) => `${JSON.stringify({ seq: i + 1, ts: NOW, ...event })}\n`).join(""));
    return { dir: at, state: full };
  }
  function editRun(feature, edit, project = main) {
    const path = join(runDir(feature, project), "state.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    edit(state);
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }
  function appendEvent(feature, event, project = main) {
    const path = join(runDir(feature, project), "events.jsonl");
    const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
    const seq = previous.split("\n").filter(Boolean).length + 1;
    writeFileSync(path, `${previous}${JSON.stringify({ seq, ts: NOW, ...event })}\n`);
  }
  // `WL evidence` followed by `WL archive`: the index is captured, `finishedAt` is
  // stamped, and the integrated worktree is the only thing archival removes.
  function archiveRun(feature, { completion, at = ARCHIVED, project = main } = {}) {
    const evidenceDir = join(runDir(feature, project), "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const index = { capturedAt: at, completion, format: "Paseo CLI activity transcripts; tool output may be curated.", agents: [] };
    writeFileSync(join(evidenceDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    editRun(feature, (state) => {
      state.finishedAt = at;
      state.evidence = { completion, capturedAt: at, path: join(evidenceDir, "index.json") };
    }, project);
    return evidenceDir;
  }

  const recordFile = (n, project = main) => {
    const prefix = `REQ-${String(n).padStart(3, "0")}-`;
    const found = readdirSync(dirOf(project)).find((name) => name.startsWith(prefix));
    assert.ok(found, `${prefix} is in the ${project} ledger`);
    return found;
  };
  const record = (n, project = main) => {
    const { frontmatter, body } = parseRecord(readFileSync(join(dirOf(project), recordFile(n, project)), "utf8"));
    return { file: recordFile(n, project), ...frontmatter, body };
  };
  // A record the CLI did not write in this process, for a state only an
  // interruption produces. `_meta.json` still records the number as issued.
  function writeRecord(n, { title = `Hand written ${n}`, runs = [], project = main } = {}) {
    const at = dirOf(project);
    mkdirSync(at, { recursive: true });
    const entry = { ...newRecord({ id: idFor(n), title, repoPath: repos[project].path, now: NOW }), runs };
    writeFileSync(join(at, fileNameFor(entry.id, title)), emitRecord(entry, "## Summary\n\n## History\n\n## Notes\n"));
    const metaPath = join(at, "_meta.json");
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : { lastIssued: 0 };
    writeFileSync(metaPath, `${JSON.stringify({ project, lastIssued: Math.max(meta.lastIssued ?? 0, n), updated_at: NOW }, null, 2)}\n`);
    return entry.id;
  }
  function writeLog(entry) {
    const at = dirOf();
    mkdirSync(at, { recursive: true });
    const path = join(at, "_log.jsonl");
    const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
    const seq = previous.split("\n").filter(Boolean).length + 1;
    writeFileSync(path, `${previous}${JSON.stringify({ seq, at: NOW, ...entry })}\n`);
  }
  const dropLogLine = (id) => {
    const path = join(dir, "_log.jsonl");
    const kept = readFileSync(path, "utf8").split("\n")
      .filter((line) => line.trim() && JSON.parse(line).id !== id);
    writeFileSync(path, kept.map((line) => `${line}\n`).join(""));
  };
  // Every file of a ledger, byte for byte: a read command that writes, or a lookup
  // that mints a requirement, shows up here.
  const snapshot = (project = main) => {
    const at = dirOf(project);
    if (!existsSync(at)) return null;
    const files = {};
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (name !== ".lock") files[name] = readFileSync(path, "utf8");
    }
    return files;
  };
  // The prose under `## Summary` is a human field (design §3.2): a person writing
  // it is the normal way a requirement gains a summary.
  const writeSummary = (n, text, project = main) => {
    const path = join(dirOf(project), recordFile(n, project));
    const before = readFileSync(path, "utf8");
    assert.ok(before.includes("## Summary\n\n"), "the record has an empty Summary section");
    writeFileSync(path, before.replace("## Summary\n\n", `## Summary\n${text}\n\n`));
  };

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root, repos, repo: repos[main].path, main, env, baseSha, dir, dirOf, runDir,
    run, ok, stdout, no, commit, writeRun, editRun, appendEvent, archiveRun,
    record, recordFile, writeRecord, writeLog, dropLogLine, snapshot, writeSummary,
  };
}

// ---------------------------------------------------------------- E1

test("E1: create, Direct run, link, finish and archive — show reports the delivered tip", (t) => {
  const s = sandbox(t);
  const feature = "req-001-login";
  s.ok(["new", "User login", "--alias", "登录"]);
  s.writeRun({ feature });

  const linked = s.ok(["link", `myapp/${feature}`, "REQ-001"]);
  assert.match(linked, new RegExp(`linked myapp/${feature} .*REQ-001`));
  assert.match(linked, /delivery pending/);
  const pending = s.record(1).runs[0];
  assert.equal(pending.delivery.state, "pending");
  assert.equal(pending.base_sha, s.baseSha, "the run's own base SHA, not the short form");
  assert.equal(pending.base_sha.length, 40);

  // `WL finish` records a completion. Nothing is archived yet, so no evidence.
  const tip = s.commit();
  s.editRun(feature, (state) => { state.completion = { at: DELIVERED, tip }; });
  const finished = s.ok(["sync", `myapp/${feature}`]);
  assert.ok(finished.includes(`delivered ${tip.slice(0, 7)} at ${DELIVERED}`), finished);
  assert.equal(s.record(1).runs[0].delivery.state, "delivered");
  assert.equal(s.record(1).runs[0].delivery.archived_at, undefined);

  // `WL evidence` then `WL archive`.
  const evidenceDir = s.archiveRun(feature, { completion: DELIVERED });
  const archived = s.ok(["sync", `myapp/${feature}`]);
  assert.ok(archived.includes(`archived ${ARCHIVED}`), archived);
  assert.ok(archived.includes(evidenceDir), archived);

  // `show` prints the record, so the delivery is read back from the file itself.
  const delivery = parseRecord(s.stdout(["show", "REQ-001"])).frontmatter.runs[0].delivery;
  assert.equal(delivery.state, "delivered");
  assert.equal(delivery.final_tip, tip);
  assert.equal(delivery.delivered_at, DELIVERED);
  assert.equal(delivery.archived_at, ARCHIVED);
});

// ---------------------------------------------------------------- E2

test("E2: a reworded request, a Chinese fragment and an alias recall the requirement, and none creates one", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login", "--alias", "sign-in", "--alias", "登录"]);
  s.writeSummary(1, "Sign in with email and password.");
  const before = s.snapshot();

  // Three ways in: prose the title does not use, a Chinese fragment of an alias,
  // and the alias itself. Each must reach REQ-001 and nothing else.
  const queries = {
    reworded: "customers forget their email and password",
    chinese: "登录页打不开",
    alias: "sign in",
  };
  for (const [label, query] of Object.entries(queries)) {
    const answer = JSON.parse(s.stdout(["lookup", query, "--json"]));
    assert.equal(answer.decision, "strong", `${label}: ${query}`);
    assert.deepEqual(answer.candidates.map((candidate) => candidate.id), ["REQ-001"], `${label}: ${query}`);
  }

  // A lookup hands back evidence: it mints no requirement, writes no audit line
  // and assigns no run.
  assert.deepEqual(s.snapshot(), before, "three lookups created nothing");
  assert.deepEqual(readdirSync(s.dir).filter((name) => name.startsWith("REQ-")), ["REQ-001-user-login.md"]);
  assert.deepEqual(s.record(1).runs, []);
});

// ---------------------------------------------------------------- E3

test("E3: an ambiguous request returns both close candidates and assigns nothing", (t) => {
  const s = sandbox(t);
  s.ok(["new", "Checkout", "--alias", "pay"]);
  s.ok(["new", "Checkout confirmation", "--alias", "receipt"]);
  const before = s.snapshot();

  const answer = JSON.parse(s.stdout(["lookup", "checkout", "--json"]));
  assert.equal(answer.decision, "ambiguous");
  assert.deepEqual(answer.candidates.map((candidate) => candidate.id), ["REQ-001", "REQ-002"]);
  assert.equal(answer.candidates.length, 2);
  assert.equal(answer.candidates[0].score, 1, "the exact title leads");
  assert.ok(answer.candidates[1].score >= 0.5, "the runner-up is close enough to be a question");

  const human = s.ok(["lookup", "checkout"]);
  assert.match(human, /decision: ambiguous/);
  assert.match(human, /confirm with the user/);
  assert.deepEqual(s.snapshot(), before, "an ambiguous answer assigns nothing and writes nothing");
  assert.deepEqual(s.record(1).runs, []);
  assert.deepEqual(s.record(2).runs, []);
});

// ---------------------------------------------------------------- E4

test("E4: linking the same run to the same requirement twice leaves one relation", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.writeRun();
  assert.match(s.ok(["link", "myapp/feat", "REQ-001"]), /linked/);
  const once = s.record(1);

  const again = s.ok(["link", "myapp/feat", "REQ-001"]);
  assert.match(again, /already linked/);
  const twice = s.record(1);
  assert.equal(twice.runs.length, 1, "one relation, not two");
  assert.deepEqual(twice.runs, once.runs, "the second link changes nothing");
  assert.equal(twice.rev, once.rev, "and writes nothing");
  assert.equal(readLog(s.dir).filter((entry) => entry.op === "link").length, 1);
});

// ---------------------------------------------------------------- E5

test("E5: a second, different primary requirement for the same run is refused", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.ok(["new", "Checkout"]);
  s.writeRun();
  s.ok(["link", "myapp/feat", "REQ-001"]);
  const before = s.snapshot();

  const refused = s.no(/already the primary of REQ-001/, ["link", "myapp/feat", "REQ-002"]);
  assert.match(refused, /--correct/, "the refusal names the one controlled way to move it");
  assert.deepEqual(s.snapshot(), before, "a refused link writes nothing");
  assert.deepEqual(s.record(2).runs, []);
  assert.equal(s.record(1).runs.length, 1);
});

// ---------------------------------------------------------------- E6

test("E6: a Quick outcome with a real commit SHA is recorded and creates no run", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  const commit = s.commit();
  const before = s.snapshot();

  const out = s.ok(["note", "REQ-001", "--outcome", "Fixed the login button copy", "--commit", commit, "--verification", "clicked through it"]);
  assert.match(out, /no run/);

  const record = s.record(1);
  assert.equal(record.outcomes.length, 1);
  assert.equal(record.outcomes[0].summary, "Fixed the login button copy");
  assert.equal(record.outcomes[0].commit_sha, commit, "the full SHA of a commit that resolves");
  assert.equal(record.outcomes[0].verification, "clicked through it");
  assert.deepEqual(record.runs, [], "an outcome is not a run");

  // No run was made and no requirement was minted: the project holds the ledger,
  // and the ledger holds the same files as before, one of them revised.
  assert.equal(existsSync(s.runDir("feat")), false, "no run directory was created");
  assert.deepEqual(readdirSync(join(s.root, "wl", "myapp")), [".requirements"]);
  assert.deepEqual(Object.keys(s.snapshot()).sort(), Object.keys(before).sort());
  assert.equal(JSON.parse(s.snapshot()["_meta.json"]).lastIssued, 1);
});

// ---------------------------------------------------------------- E7

test("E7: a moved state.json, a duplicated id and a missing audit line are reported; only the audit gap is repaired", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.ok(["new", "Checkout"]);
  s.ok(["new", "Invoice export"]);
  s.writeRun();
  s.ok(["link", "myapp/feat", "REQ-001"]);

  // 1. The run directory is pruned; the relation stays and points nowhere.
  renameSync(join(s.runDir(), "state.json"), join(s.root, "feat-state.json.moved"));
  // 2. A second file carrying a number the ledger already issued.
  writeFileSync(join(s.dir, "REQ-003-invoice-export-copy.md"), readFileSync(join(s.dir, s.recordFile(3)), "utf8"));
  // 3. A write whose audit line never landed.
  s.dropLogLine("REQ-002");
  const loginBefore = readFileSync(join(s.dir, s.recordFile(1)), "utf8");

  const first = s.run(["doctor"]);
  assert.equal(first.status, 1, "findings still need a human");
  const report = `${first.stdout}${first.stderr}`;
  assert.match(report, /has no state\.json at .*feat[\\/]state\.json/);
  assert.match(report, /duplicate id REQ-003/);
  assert.match(report, /REQ-002: the audit log has no line for this file/);
  assert.doesNotMatch(report, /\[repaired\]/, "a plain doctor repairs nothing");

  const repair = s.run(["doctor", "--repair-log"]);
  assert.equal(repair.status, 1, "the two real problems remain");
  const repaired = `${repair.stdout}${repair.stderr}`;
  assert.match(repaired, /REQ-002: the audit log has no line for this file \[repaired\]/);
  assert.match(repaired, /duplicate id REQ-003/);
  assert.match(repaired, /has no state\.json/);

  // The gap is closed and only it: one catch-up line, the record's bytes and the
  // moved run exactly as they were.
  const catchUps = readLog(s.dir).filter((entry) => entry.op === "log-repair");
  assert.equal(catchUps.length, 1);
  assert.equal(catchUps[0].id, "REQ-002");
  assert.equal(catchUps[0].reason, "missing");
  assert.equal(readFileSync(join(s.dir, s.recordFile(1)), "utf8"), loginBefore);
  assert.equal(existsSync(join(s.runDir(), "state.json")), false, "repairing the log does not resurrect a run");

  const second = s.run(["doctor"]);
  assert.equal(second.status, 1);
  const settled = `${second.stdout}${second.stderr}`;
  assert.doesNotMatch(settled, /audit log has no line/);
  assert.match(settled, /duplicate id REQ-003/);
  assert.match(settled, /has no state\.json/);
});

// ---------------------------------------------------------------- E8

test("E8: after archive, show and context still locate the evidence, and sync reads the retained state.json", (t) => {
  const s = sandbox(t);
  const feature = "req-001-login";
  s.ok(["new", "User login"]);
  const tip = s.commit();
  s.writeRun({ feature, state: { completion: { at: DELIVERED, tip } } });
  s.ok(["link", `myapp/${feature}`, "REQ-001"]);
  s.ok(["sync", `myapp/${feature}`]);

  // Archival deletes the integrated worktree; the run directory, state.json and
  // the evidence stay.
  mkdirSync(join(s.runDir(feature), "tip"), { recursive: true });
  writeFileSync(join(s.runDir(feature), "tip", "shared.txt"), "integrated\n");
  const evidenceDir = s.archiveRun(feature, { completion: DELIVERED });
  rmSync(join(s.runDir(feature), "tip"), { recursive: true, force: true });
  assert.equal(existsSync(join(s.runDir(feature), "state.json")), true, "state.json is retained");

  const synced = s.ok(["sync", `myapp/${feature}`]);
  assert.match(synced, /archived/);
  const delivery = s.record(1).runs[0].delivery;
  assert.equal(delivery.final_tip, tip);
  assert.equal(delivery.archived_at, ARCHIVED);
  assert.equal(delivery.evidence_dir, evidenceDir);

  const shown = parseRecord(s.stdout(["show", "REQ-001"])).frontmatter.runs[0].delivery;
  assert.equal(shown.evidence_dir, evidenceDir, "show names the evidence after archive");

  const context = JSON.parse(s.stdout(["context", "REQ-001", "--json"]));
  const [view] = context.deliveries;
  assert.equal(view.state, "delivered");
  assert.equal(view.final_tip, tip);
  assert.equal(view.archived_at, ARCHIVED);
  assert.equal(view.evidence_dir, evidenceDir);
  assert.equal(view.evidence_status, "available");
  assert.equal(view.evidence_available, true);
  assert.equal(view.source, "state.json", "context read the retained state.json, not a worktree");

  const human = s.ok(["context", "REQ-001"]);
  assert.ok(human.includes(`${evidenceDir}  available`), human);
  assert.ok(human.includes(`archived:   ${ARCHIVED}`), human);
});

// ---------------------------------------------------------------- E9

test("E9: lookup stays inside the project — no leak of another project's unique requirement, and a shared title hits only this project's", (t) => {
  const s = sandbox(t, ["myapp", "otherapp"]);
  const other = s.repos.otherapp.path;

  s.ok(["new", "User login", "--alias", "登录"]);
  s.writeSummary(1, "Sign in with email and password.");
  s.ok(["new", "Checkout"]);

  // The other project has a requirement only it has, and one with the same title
  // as ours but different prose.
  s.ok(["new", "User login", "--alias", "登录"], { cwd: other });
  s.writeSummary(1, "Another project's own login notes.", "otherapp");
  s.ok(["new", "Invoice reconciliation", "--alias", "invoicing-only-in-otherapp"], { cwd: other });

  // A word that exists only in the other project finds nothing here — and the
  // same words do find it there, so the answer is scope, not emptiness.
  const leak = JSON.parse(s.stdout(["lookup", "invoice reconciliation", "--json"]));
  assert.equal(leak.project, "myapp");
  assert.deepEqual(leak.candidates, []);
  assert.equal(leak.decision, "none");
  const scoped = JSON.parse(s.stdout(["lookup", "invoice reconciliation", "--json"], { cwd: other }));
  assert.equal(scoped.project, "otherapp");
  assert.deepEqual(scoped.candidates.map((candidate) => candidate.id), ["REQ-002"]);

  // Both projects hold a requirement titled "User login"; only this project's is
  // hit, and the excerpt proves which file answered.
  const shared = JSON.parse(s.stdout(["lookup", "user login", "--json"]));
  assert.equal(shared.project, "myapp");
  assert.equal(shared.candidates.length, 1, "one candidate, not one per project");
  assert.equal(shared.candidates[0].id, "REQ-001");
  assert.match(shared.candidates[0].summary_excerpt, /Sign in with email and password/);
  assert.doesNotMatch(shared.candidates[0].summary_excerpt, /Another project/);

  // The mirror: from the other repository, its own record and only it.
  const mirror = JSON.parse(s.stdout(["lookup", "user login", "--json"], { cwd: other }));
  assert.equal(mirror.project, "otherapp");
  assert.equal(mirror.candidates.length, 1);
  assert.match(mirror.candidates[0].summary_excerpt, /Another project's own login notes/);
});

// ---------------------------------------------------------------- E10

test("E10: a correction adds the new owner before it removes the old one, and an interrupted one refuses reads until it converges", (t) => {
  // The correction itself (R1): intent, then REQ-B, then no REQ-A.
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.ok(["new", "Checkout"]);
  s.writeRun();
  s.ok(["link", "myapp/feat", "REQ-001"]);

  const refused = s.no(/already the primary of REQ-001/, ["link", "myapp/feat", "REQ-002"]);
  assert.match(refused, /--correct/);
  assert.deepEqual(s.record(2).runs, []);

  const corrected = s.ok(["link", "myapp/feat", "REQ-002", "--correct", "--reason", "the ticket was for checkout"]);
  assert.match(corrected, /corrected: myapp\/feat REQ-001 → REQ-002/);
  assert.deepEqual(s.record(1).runs, [], "the old requirement released the run");
  assert.equal(s.record(2).runs.length, 1);
  assert.equal(s.record(2).runs[0].base_sha, s.baseSha, "the run's base SHA survives the move");

  const ops = readLog(s.dir).filter((entry) => !entry.unreadable);
  const intent = ops.findIndex((entry) => entry.op === "correct");
  const added = ops.findIndex((entry) => entry.op === "link" && entry.id === "REQ-002");
  const removed = ops.findIndex((entry) => entry.op === "unlink" && entry.id === "REQ-001");
  assert.ok(intent >= 0 && intent < added && added < removed, `order: intent ${intent}, added ${added}, removed ${removed}`);
  assert.equal(ops[intent].run, "myapp/feat");
  assert.equal(ops[intent].from, "REQ-001");
  assert.equal(ops[intent].to, "REQ-002");
  assert.equal(ops[intent].reason, "the ticket was for checkout");

  // The interruption: the new relation written, the old one not yet removed, the
  // intent on record. No command may pick an owner out of that state.
  const i = sandbox(t);
  const relation = () => ({ project: "myapp", feature: "feat", relation: "primary", base_sha: i.baseSha, linked_at: NOW, delivery: { state: "pending" } });
  i.writeRecord(1, { runs: [relation()] });
  i.writeRecord(2, { runs: [relation()] });
  i.writeRecord(3, { runs: [] });
  i.writeLog({ op: "correct", run: "myapp/feat", from: "REQ-001", to: "REQ-002", reason: "wrong owner" });
  i.writeRun();

  const doctor = i.run(["doctor"]);
  assert.equal(doctor.status, 1);
  const report = `${doctor.stdout}${doctor.stderr}`;
  assert.match(report, /myapp\/feat is the primary of REQ-001 and REQ-002/);
  assert.match(report, /did not finish/);
  assert.match(report, /req link myapp\/feat REQ-002 --correct --reason "wrong owner"/);

  const refusal = /did not finish/;
  const contextRefusal = i.no(refusal, ["context", "REQ-001"]);
  assert.match(contextRefusal, /req link myapp\/feat REQ-002 --correct --reason "wrong owner"/);
  i.no(refusal, ["sync", "myapp/feat"]);
  i.no(refusal, ["link", "myapp/feat", "REQ-003"]);
  i.no(/one reason cannot say which/, ["link", "myapp/feat", "REQ-003", "--correct", "--reason", "tidy up"]);

  // Reading still works, marked, and infers no owner.
  const shown = i.run(["show", "REQ-001"]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /^---\nid: REQ-001/, "show still prints the record");
  assert.match(shown.stderr, /ambiguous/);
  assert.match(shown.stderr, /myapp\/feat/);
  assert.match(i.ok(["list"]), /\[ambiguous myapp\/feat: REQ-002\]/);

  // The retry resumes the recorded intent and converges to one primary; a second
  // retry writes nothing.
  const retried = i.ok(["link", "myapp/feat", "REQ-002", "--correct", "--reason", "wrong owner"]);
  assert.match(retried, /resumed the recorded intent/);
  assert.deepEqual(i.record(1).runs, []);
  assert.equal(i.record(2).runs.length, 1);
  assert.equal(readLog(i.dir).filter((entry) => entry.op === "correct").length, 1, "one intent, not two");
  const converged = i.record(2);
  const again = i.ok(["link", "myapp/feat", "REQ-002", "--correct", "--reason", "wrong owner"]);
  assert.match(again, /already linked/);
  assert.equal(i.record(2).rev, converged.rev, "the converged retry is a no-op");
  assert.doesNotMatch(i.ok(["list"]), /ambiguous/);
});

// ---------------------------------------------------------------- E11

test("E11: finish delivers without evidence, archive only adds to it, a cleared completion supersedes, and a missed sync fabricates nothing", (t) => {
  // finish → sync: delivered, and the evidence index is not required yet.
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  const tip = s.commit();
  s.writeRun({ state: { completion: { at: DELIVERED, tip } } });
  s.ok(["link", "myapp/feat", "REQ-001"]);
  assert.equal(existsSync(join(s.runDir(), "evidence")), false, "finish has captured no evidence index yet");

  const finished = s.ok(["sync", "myapp/feat"]);
  assert.ok(finished.includes(`delivered ${tip.slice(0, 7)} at ${DELIVERED}`), finished);
  const first = s.record(1).runs[0].delivery;
  assert.equal(first.state, "delivered");
  assert.equal(first.archived_at, undefined, "no evidence index is needed for the first sync");
  assert.equal(first.evidence_dir, undefined);

  // archive → sync: the archive time and evidence are added; the SHA stays.
  const evidenceDir = s.archiveRun("feat", { completion: DELIVERED });
  const archived = s.ok(["sync", "myapp/feat"]);
  assert.ok(archived.includes(`archived ${ARCHIVED}`), archived);
  assert.ok(archived.includes(evidenceDir), archived);
  const second = s.record(1).runs[0].delivery;
  assert.equal(second.final_tip, tip, "archive does not move the delivered SHA");
  assert.equal(second.delivered_at, DELIVERED);
  assert.equal(second.archived_at, ARCHIVED);
  assert.equal(second.evidence_dir, evidenceDir);

  // (a) completion cleared before archive: the old snapshot moves to history, the
  // current delivery falls back to pending, and repeating sync writes nothing.
  const a = sandbox(t);
  a.ok(["new", "User login"]);
  const delivered = a.commit();
  a.writeRun({ state: { completion: { at: DELIVERED, tip: delivered } } });
  a.ok(["link", "myapp/feat", "REQ-001"]);
  a.ok(["sync", "myapp/feat"]);
  a.editRun("feat", (state) => { state.completion = null; });
  a.appendEvent("feat", { kind: "integrate" });

  const reopened = a.ok(["sync", "myapp/feat"]);
  assert.match(reopened, /superseded .*\(reopened by integrate\)/);
  assert.match(reopened, /delivery pending/);
  const relation = a.record(1).runs[0];
  assert.deepEqual(relation.delivery, { state: "pending" });
  assert.equal(relation.delivery_history.length, 1);
  const [superseded] = relation.delivery_history;
  assert.equal(superseded.final_tip, delivered);
  assert.equal(superseded.delivered_at, DELIVERED);
  assert.equal(superseded.reason, "reopened by integrate");
  assert.match(superseded.superseded_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);

  const settled = a.record(1);
  const repeated = a.ok(["sync", "myapp/feat"]);
  assert.match(repeated, /in sync: delivery pending/);
  assert.match(repeated, /1 superseded snapshot kept in delivery_history/);
  assert.equal(a.record(1).rev, settled.rev, "a repeated sync writes nothing");
  assert.equal(a.record(1).runs[0].delivery_history.length, 1);

  // (b) finish → no sync → import clears completion: the ledger never saw that
  // delivery, so it invents no snapshot — and later commands still work.
  const b = sandbox(t);
  b.ok(["new", "User login"]);
  const missed = b.commit();
  b.writeRun({ integrationTip: missed, state: { completion: null } });
  b.appendEvent("feat", { kind: "import" });
  b.ok(["link", "myapp/feat", "REQ-001"]);

  const nothing = b.ok(["sync", "myapp/feat"]);
  assert.match(nothing, /state\.json has no completion/);
  assert.match(nothing, /Nothing is recorded and nothing is invented/);
  assert.match(nothing, /delivery pending/);
  const empty = b.record(1).runs[0];
  assert.deepEqual(empty.delivery, { state: "pending" });
  assert.equal(empty.delivery_history ?? undefined, undefined, "no invented history");
  assert.equal(empty.base_sha, b.baseSha);
  assert.equal(existsSync(join(b.runDir(), "evidence")), false, "no evidence or snapshot was fabricated");
  assert.doesNotMatch(readFileSync(join(b.dir, b.recordFile(1)), "utf8"), /final_tip|state: delivered/,
    "the record claims no delivery it never saw");

  const real = b.commit();
  b.editRun("feat", (state) => { state.completion = { at: LATER, tip: real }; });
  b.ok(["sync", "myapp/feat"]);
  assert.equal(b.record(1).runs[0].delivery.state, "delivered");
  assert.equal(b.record(1).runs[0].delivery.final_tip, real);
});
