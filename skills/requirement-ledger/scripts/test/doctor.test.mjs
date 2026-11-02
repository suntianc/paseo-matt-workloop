// `req doctor` as the ledger's single consistency pass: the four checks it started
// with (duplicate id, unparsable frontmatter, lastIssued, audit gaps) plus the
// cross-file ones — a run whose state.json is gone, one run claimed as primary by
// two requirements, a repository the record no longer belongs to, and refs that no
// longer resolve. Everything runs against a real temp repository and a temp
// WORKLOOP_ROOT; the developer's ~/.workloop is never touched.
// Run: node --test skills/requirement-ledger/scripts/test/doctor.test.mjs
import assert from "node:assert/strict";
import { spawnBounded } from "./spawn.mjs";
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
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

// Assembled at runtime so no credential-shaped literal sits in the source; the
// point is that a remote's userinfo never reaches the record or the report.
const PASSWORD = ["not-a-real", "password"].join("-");

function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "req-doctor-")));
  const repo = join(root, "myapp");
  mkdirSync(repo, { recursive: true });
  const env = {
    ...process.env,
    WORKLOOP_ROOT: join(root, "wl"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  delete env.WORKLOOP_RUN;
  delete env.REQ_LOCK_WAIT_MS;
  const git = (...args) => {
    const result = spawnBounded("git", ["-C", repo, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git("add", "shared.txt");
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");

  const dir = join(root, "wl", "myapp", ".requirements");
  const run = (args, options = {}) => spawnBounded(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? repo, env: { ...env, ...options.env }, encoding: "utf8",
  });
  const ok = (args, options) => {
    const result = run(args, options);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return `${result.stdout}${result.stderr}`;
  };
  const runDir = (feature = "feat") => join(root, "wl", "myapp", feature);

  // A run directory as Workloop leaves it. `completion` makes it delivered.
  function writeRun({ feature = "feat", completion = null } = {}) {
    const path = runDir(feature);
    mkdirSync(join(path, "issues"), { recursive: true });
    const state = {
      version: 1, project: "myapp", feature, runKey: `myapp-${feature}`, mode: "direct",
      repo, baseSha, integration: { branch: `workloop/${feature}`, tip: baseSha },
      createdAt: NOW, ...(completion ? { completion: { at: NOW, ...completion } } : {}),
    };
    writeFileSync(join(path, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    return { dir: path, state };
  }
  // The dangling-run fixture: the relation stays, the run's state.json is moved
  // out of the way, exactly as a pruned or relocated run directory looks.
  const moveStateAway = (feature = "feat") =>
    renameSync(join(runDir(feature), "state.json"), join(root, `${feature}-state.json.moved`));

  let commits = 0;
  const commit = () => {
    commits += 1;
    writeFileSync(join(repo, "shared.txt"), `work ${commits}\n`);
    git("add", "shared.txt");
    git("commit", "-q", "-m", "work");
    return git("rev-parse", "HEAD");
  };

  const recordFile = (n) => {
    const prefix = `REQ-${String(n).padStart(3, "0")}-`;
    const found = readdirSync(dir).find((name) => name.startsWith(prefix));
    assert.ok(found, `${prefix} is in the ledger`);
    return found;
  };
  const fileText = (n) => readFileSync(join(dir, recordFile(n)), "utf8");
  const record = (n) => {
    const { frontmatter, body } = parseRecord(fileText(n));
    return { file: recordFile(n), ...frontmatter, body };
  };
  // A hand edit of the machine fields: the body and rev stay as they are, which is
  // exactly what a person editing frontmatter does, and what `doctor` must report
  // without rewriting.
  function editRecord(n, edit) {
    const { file, body, ...frontmatter } = record(n);
    writeFileSync(join(dir, file), emitRecord(edit(frontmatter), body));
  }
  // A record with no audit line, for states only an interruption produces.
  function writeRecord(n, title = `Hand written ${n}`) {
    mkdirSync(dir, { recursive: true });
    const record = newRecord({ id: idFor(n), title, repoPath: repo, now: NOW });
    writeFileSync(join(dir, fileNameFor(record.id, title)), emitRecord(record, "## Summary\nHand written.\n"));
    return record;
  }
  const writeLog = (entry) => {
    const path = join(dir, "_log.jsonl");
    const previous = readFileSync(path, "utf8");
    const seq = readLog(dir).length + 1;
    writeFileSync(path, `${previous}${JSON.stringify({ seq, at: NOW, ...entry })}\n`);
  };
  const logLines = () => readLog(dir);
  const dropLastLogLine = () => {
    const text = readFileSync(join(dir, "_log.jsonl"), "utf8").trimEnd().split("\n");
    writeFileSync(join(dir, "_log.jsonl"), `${text.slice(0, -1).join("\n")}\n`);
  };
  const writeDoc = (path, text) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const relation = (feature, delivery = { state: "pending" }) => ({
    project: "myapp", feature, relation: "primary", base_sha: baseSha, linked_at: NOW, delivery,
  });

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root, repo, dir, run, ok, git, runDir, writeRun, moveStateAway, commit,
    fileText, record, editRecord, writeRecord, writeLog, logLines, dropLastLogLine, writeDoc, relation,
    reqPath: (n) => join(dir, recordFile(n)),
  };
}

// ------------------------------------------------------------------ a clean ledger

test("a ledger that agrees with itself reports nothing", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.writeRun({ completion: { tip: s.commit() } });
  s.ok(["link", "myapp/feat", "REQ-001"]);
  s.ok(["sync", "myapp/feat"]);
  // Refs that do resolve: the ADR file, and a pitfall entry by its heading.
  s.editRecord(1, (frontmatter) => ({ ...frontmatter, refs: { adr: ["0007-session-tokens"], pitfalls: ["auth-cookie-domain"] } }));
  s.writeDoc("docs/adr/0007-session-tokens.md", "# 0007 Session tokens\n");
  s.writeDoc("docs/pitfalls/auth.md", "# Auth pitfalls\n\n## Auth cookie domain\n\n- **Trigger:** a cookie set on the API host\n");

  const report = s.run(["doctor"]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.match(report.stdout, /^clean: the records/m);
  assert.doesNotMatch(report.stdout, /^  - /m, "a clean ledger has no findings");
});

// ----------------------------------------------------- every check in one pass

test("doctor names every inconsistency of the eight checks in one pass", (t) => {
  const s = sandbox(t);
  s.git("remote", "add", "origin", `https://user:${PASSWORD}@github.com/owner/myapp.git`);
  s.ok(["new", "User login"]); // REQ-001
  s.ok(["new", "Checkout"]); // REQ-002
  s.ok(["new", "Search"]); // REQ-003

  // 2. invalid frontmatter.
  writeFileSync(join(s.dir, "REQ-004-broken.md"), "---\nid: [\n---\n## Summary\n");
  // 3. lastIssued behind the files present (repaired upward, and reported).
  writeFileSync(join(s.dir, "_meta.json"), `${JSON.stringify({ project: "myapp", lastIssued: 1, updated_at: NOW })}\n`);
  // 4. audit gap: a record no CLI write ever logged.
  s.writeRecord(5);
  // 5. dangling run: a relation whose state.json does not exist.
  // 6. double primary: the same run claimed as primary by two requirements.
  // 8. dangling refs: neither the ADR nor the pitfall entry resolves.
  s.editRecord(1, (frontmatter) => ({
    ...frontmatter,
    runs: [s.relation("twin"), s.relation("gone")],
    refs: { adr: ["9999-gone"], pitfalls: ["no-such-pitfall"] },
  }));
  s.editRecord(2, (frontmatter) => ({ ...frontmatter, runs: [s.relation("twin")] }));
  // 7. repo mismatch: this record belongs to another checkout and another remote.
  s.editRecord(3, (frontmatter) => ({
    ...frontmatter,
    repo_path: join(s.root, "elsewhere", "myapp"),
    repo_remote: "github.com/other/myapp",
  }));
  // 1. duplicate id: a copy of REQ-002 under another file name, made last so the
  // edits above address their own records by number.
  copyFileSync(s.reqPath(2), join(s.dir, "REQ-001-copy.md"));

  const report = s.run(["doctor"]);
  assert.equal(report.status, 1, report.stdout + report.stderr);
  const output = report.stdout;
  assert.match(output, /duplicate id REQ-002 in REQ-001-copy\.md and REQ-002-checkout\.md/);
  assert.match(output, /REQ-004-broken\.md: the frontmatter/);
  assert.match(output, /lastIssued 1 is below the highest requirement number 5 \(repaired to 5\)/);
  assert.match(output, /REQ-005: the audit log has no line/);
  assert.match(output, /REQ-001: run myapp\/gone has no state\.json at .*myapp[\\/]gone[\\/]state\.json/);
  assert.match(output, /myapp\/twin is the primary of REQ-001 and REQ-002/);
  assert.match(output, /REQ-003: repo_path .*elsewhere[\\/]myapp is not the repository this ledger is read from/);
  assert.match(output, /REQ-003: repo_remote github\.com\/other\/myapp differs from this repository's github\.com\/owner\/myapp/);
  assert.match(output, /REQ-001: refs\.adr cites "9999-gone"/);
  assert.match(output, /REQ-001: refs\.pitfalls cites "no-such-pitfall"/);

  // The semantic checks are findings, never repairs: repairing them would rewrite
  // a relation, a repository binding or a reference the user wrote.
  for (const pattern of [/run myapp\/gone/, /myapp\/twin/, /repo_path/, /repo_remote/, /refs\.adr/, /refs\.pitfalls/]) {
    const line = output.split("\n").find((text) => pattern.test(text));
    assert.ok(line, `reported: ${pattern}`);
    assert.doesNotMatch(line, /\[repaired\]/, `${pattern} is not a repair`);
  }
});

// ------------------------------------------------------ dangling run (E7, check 3)

test("a moved-away state.json is reported with its path, and the relation is kept", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.writeRun();
  s.ok(["link", "myapp/feat", "REQ-001"]);
  const before = s.fileText(1);
  s.moveStateAway();

  const report = s.run(["doctor"]);
  assert.equal(report.status, 1, report.stdout + report.stderr);
  assert.match(report.stdout, /findings: 1/, "the ledger has exactly one problem");
  const path = join(s.root, "wl", "myapp", "feat", "state.json");
  assert.ok(report.stdout.includes(path), `names the path:\n${report.stdout}`);
  assert.match(report.stdout, /REQ-001: run myapp\/feat has no state\.json/);
  assert.match(report.stdout, /reported, not removed/);

  // Reporting is all it does: the relation stays exactly as the user assembled it.
  assert.equal(s.record(1).runs.length, 1);
  assert.equal(s.fileText(1), before, "doctor does not rewrite the record");
});

// ---------------------------------------------------- double primary (E10, check 4)

test("two primaries on one run are reported once, stably, with the recorded intent as the way out", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]); // REQ-001
  s.ok(["new", "Checkout"]); // REQ-002
  s.writeRun();
  // The state `link --correct` leaves when it stops between its two writes.
  s.editRecord(1, (frontmatter) => ({ ...frontmatter, runs: [s.relation("feat")] }));
  s.editRecord(2, (frontmatter) => ({ ...frontmatter, runs: [s.relation("feat")] }));
  s.writeLog({ op: "correct", run: "myapp/feat", from: "REQ-001", to: "REQ-002", reason: "the ticket was for checkout" });

  const first = s.run(["doctor"]);
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.match(first.stdout, /myapp\/feat is the primary of REQ-001 and REQ-002: a `link --correct` did not finish/);
  assert.match(first.stdout, /req link myapp\/feat REQ-002 --correct --reason "the ticket was for checkout"/);
  assert.match(first.stdout, /intent recorded in _log\.jsonl/);

  const second = s.run(["doctor"]);
  assert.equal(second.stdout, first.stdout, "the same report on every run");
  assert.equal(s.record(1).runs.length, 1);
  assert.equal(s.record(2).runs.length, 1);
});

// -------------------------------------------------------- repo binding (check 8)

test("a changed repository is reported by its sanitised remote, never its credentials", (t) => {
  const s = sandbox(t);
  s.git("remote", "add", "origin", `https://user:${PASSWORD}@github.com/owner/myapp.git`);
  s.ok(["new", "User login"]); // records github.com/owner/myapp
  // Created while the remote still agrees: `new` itself now refuses a ledger from
  // another repository, so this record has to exist before the remote moves.
  s.ok(["new", "Checkout"]);
  assert.equal(s.run(["doctor"]).status, 0, "the remote it recorded is the one it sees");

  s.git("remote", "set-url", "origin", `https://someone:${PASSWORD}@github.com/owner/different.git`);
  const report = s.run(["doctor"]);
  assert.equal(report.status, 1, report.stdout + report.stderr);
  assert.match(report.stdout, /REQ-001: repo_remote github\.com\/owner\/myapp differs from this repository's github\.com\/owner\/different/);
  assert.ok(!`${report.stdout}${report.stderr}`.includes(PASSWORD), "no credential reaches the report");
  assert.doesNotMatch(report.stdout, /someone/);

  // A record bound to another checkout is a separate mismatch, and also only a report.
  s.editRecord(2, (frontmatter) => ({ ...frontmatter, repo_path: join(s.root, "elsewhere", "myapp") }));
  const moved = s.run(["doctor"]);
  assert.match(moved.stdout, /REQ-002: repo_path .*elsewhere[\\/]myapp is not the repository this ledger is read from/);
  assert.match(moved.stdout, /reported, not rewritten/);
});

test("a hand-edited remote is compared and reported in its sanitised form", (t) => {
  const s = sandbox(t);
  s.git("remote", "add", "origin", "https://github.com/owner/myapp.git");
  s.ok(["new", "User login"]);

  // A credential a hand edit left in front of the same host and path is not a
  // different repository.
  s.editRecord(1, (frontmatter) => ({ ...frontmatter, repo_remote: `https://user:${PASSWORD}@github.com/owner/myapp` }));
  assert.equal(s.run(["doctor"]).status, 0, "the sanitised form is the repository it records");

  s.editRecord(1, (frontmatter) => ({ ...frontmatter, repo_remote: `https://user:${PASSWORD}@github.com/owner/other` }));
  const report = s.run(["doctor"]);
  assert.equal(report.status, 1, report.stdout + report.stderr);
  assert.match(report.stdout, /REQ-001: repo_remote github\.com\/owner\/other differs from this repository's github\.com\/owner\/myapp/);
  assert.ok(!`${report.stdout}${report.stderr}`.includes(PASSWORD), "the hand-edited credential is not echoed");
});

// -------------------------------------------------------------- refs (check 7)

test("refs that no longer resolve are reported and left exactly as written", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  const refs = { adr: ["0007-session-tokens"], pitfalls: ["auth-cookie-domain"] };
  s.editRecord(1, (frontmatter) => ({ ...frontmatter, refs }));
  s.writeDoc("docs/adr/0007-session-tokens.md", "# 0007 Session tokens\n");
  s.writeDoc("docs/pitfalls/auth.md", "# Auth pitfalls\n\n## Auth cookie domain\n\n- **Trigger:** a cookie set on the API host\n");
  assert.equal(s.run(["doctor"]).status, 0, "both references resolve");

  // The ADR is superseded and deleted: the reference is now dangling.
  rmSync(join(s.repo, "docs", "adr", "0007-session-tokens.md"));
  const report = s.run(["doctor"]);
  assert.equal(report.status, 1, report.stdout + report.stderr);
  assert.match(report.stdout, /REQ-001: refs\.adr cites "0007-session-tokens", which no longer resolves in .*docs[\\/]adr/);
  assert.doesNotMatch(report.stdout, /refs\.pitfalls/, "a reference that still resolves is not reported");
  assert.deepEqual(s.record(1).refs, refs, "the reference is neither deleted nor replaced");

  // The pitfall page goes too; both are reported, and still nothing is rewritten.
  rmSync(join(s.repo, "docs", "pitfalls", "auth.md"));
  const both = s.run(["doctor"]);
  assert.match(both.stdout, /refs\.adr cites "0007-session-tokens"/);
  assert.match(both.stdout, /refs\.pitfalls cites "auth-cookie-domain", which no longer resolves in .*docs[\\/]pitfalls/);
  assert.deepEqual(s.record(1).refs, refs);
});

// `context` and `doctor` used to resolve refs by different rules: an ADR number was
// dangling here, and a pitfall cited by its heading was dangling in `context`. One
// resolver now answers both, so both cases must resolve in this command too.
test("an ADR by number and a pitfall by heading resolve here, as in context", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.editRecord(1, (frontmatter) => ({ ...frontmatter, refs: { adr: ["0007"], pitfalls: ["auth-cookie-domain"] } }));
  s.writeDoc("docs/adr/0007-session-tokens.md", "# 0007 Session tokens\n");
  s.writeDoc("docs/pitfalls/auth.md", "# Auth pitfalls\n\n## Auth cookie domain\n\n- **Trigger:** a cookie set on the API host\n");

  const report = s.run(["doctor"]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.doesNotMatch(report.stdout, /refs\.(adr|pitfalls)/);
});

// An exact page name beats a prefix sibling here too: `auth` is `auth.md` even
// with `auth-cookie.md` beside it, which `context` now also resolves.
test("an exact pitfall page name wins over a prefix sibling", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  s.editRecord(1, (frontmatter) => ({ ...frontmatter, refs: { pitfalls: ["auth"] } }));
  s.writeDoc("docs/pitfalls/topic/auth.md", "# Auth\n\n## Auth cookie domain\n");
  s.writeDoc("docs/pitfalls/topic/auth-cookie.md", "# Auth cookie\n\n## Cookie domain\n");

  const report = s.run(["doctor"]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.doesNotMatch(report.stdout, /refs\.pitfalls/);
});

// ------------------------------------------------------- --repair-log (AC4)

test("--repair-log fills an audit gap and leaves bodies and delivery SHAs byte-identical", (t) => {
  const s = sandbox(t);
  s.ok(["new", "User login"]);
  const tip = s.commit();
  s.writeRun({ completion: { tip } });
  s.ok(["link", "myapp/feat", "REQ-001"]);
  s.ok(["sync", "myapp/feat"]);
  const recordBefore = s.fileText(1);
  const runBefore = readFileSync(join(s.runDir(), "state.json"), "utf8");
  const logBefore = s.logLines().length;

  // `finish` landed but its audit line did not: the file is authoritative, and the
  // gap is the one thing --repair-log may fill.
  s.dropLastLogLine();
  const gap = s.run(["doctor"]);
  assert.equal(gap.status, 1, gap.stdout + gap.stderr);
  assert.match(gap.stdout, /audit-stale|the audit log stops at rev/);

  const repaired = s.run(["doctor", "--repair-log"]);
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
  assert.match(repaired.stdout, /\[repaired\]/);
  assert.equal(s.fileText(1), recordBefore, "no body, frontmatter or delivery SHA is touched");
  assert.equal(readFileSync(join(s.runDir(), "state.json"), "utf8"), runBefore, "the run is read only");

  const logAfter = s.logLines();
  assert.equal(logAfter.length, logBefore, "the missing line is appended, nothing is removed");
  assert.equal(logAfter.at(-1).op, "log-repair");
  assert.equal(logAfter.at(-1).rev, 3);
  assert.equal(s.record(1).runs[0].delivery.state, "delivered");
  assert.equal(s.record(1).runs[0].delivery.final_tip, tip);
  assert.equal(s.run(["doctor"]).status, 0, "the ledger is consistent again");
});
