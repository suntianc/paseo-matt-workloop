// Tests for the read-only Workloop audit: where a finding lands, how a re-review
// is classified, the flags one run raises, the cross-run report, and that nothing
// it reads is changed.
// Run: node --test skills/workloop-audit/scripts/test/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { inBoundary } from "../../../paseo-workloop/scripts/workloop.mjs";
import { auditRun, classifyReReview, flagsFor, listRuns, main, placesIn, totals, workloopRoot } from "../audit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT = join(HERE, "..", "audit.mjs");
const REQ = join(HERE, "..", "..", "..", "requirement-ledger", "scripts", "req.mjs");
const NUMBERING = "Number each new finding after the highest number the previous review used for its letter (after `P4` comes `P5`), so that no ID ever names two different findings.";

// The findings table parseFindings reads: columns by name, blocking when the cell
// starts with "yes".
function table(findings) {
  return [
    "## Findings",
    "| ID | Axis | Location | Basis | Blocking | Fix acceptance |",
    "|----|------|----------|-------|----------|----------------|",
    ...findings.map((f) => `| ${f.id} | ${f.axis ?? "Standards"} | ${f.location} | ${f.basis} | ${f.blocking === false ? "no" : "yes"} | fixed |`),
  ].join("\n");
}

// A temp WORKLOOP_ROOT and a real git repo with three commits: `base`, `c1` and
// `c2`, where c1..c2 changes src/app.ts lines 12-13 and adds src/fixed.ts.
// A finding at src/app.ts:13 is therefore in the change, and one at src/old.ts:2
// is tracked code the change left alone.
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workloop-audit-")));
  const repo = join(root, "repo");
  const wl = join(root, "wl");
  writeFileSync(join(root, "gitconfig"), "");
  const env = {
    ...process.env,
    WORKLOOP_ROOT: wl,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  delete env.WORKLOOP_RUN;
  // audit.mjs reads WORKLOOP_ROOT and runs git with this process's environment.
  Object.assign(process.env, env);
  const git = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, timeout: 120_000 });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const rev = () => git(repo, "rev-parse", "HEAD");

  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "docs", "notes.md"), "# Notes\n");
  writeFileSync(join(repo, "src", "old.ts"), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const base = rev();

  git(repo, "checkout", "-q", "-b", "workloop/feat");
  writeFileSync(join(repo, "src", "app.ts"), Array.from({ length: 30 }, (_, i) => `export const a${i} = ${i};`).join("\n") + "\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "candidate A");
  const c1 = rev();

  const app = readFileSync(join(repo, "src", "app.ts"), "utf8").split("\n");
  app[11] = "export const a11 = 110;";
  app[12] = "export const a12 = 120;";
  writeFileSync(join(repo, "src", "app.ts"), app.join("\n"));
  writeFileSync(join(repo, "src", "fixed.ts"), "export const fixed = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "candidate B");
  const c2 = rev();
  git(repo, "checkout", "-q", "main");

  return { root, repo, wl, env, git, shas: { base, c1, c2 } };
}

const short = (sha) => sha.slice(0, 8);

// A run directory with hand-written records. `state.json` carries only what the
// audit reads; the review, brief, message and report names are the ones the
// workloop writes.
function writeRun(wl, project, feature, state, dirs = ["briefs", "reports", "reviews", "messages"]) {
  const dir = join(wl, project, feature);
  mkdirSync(dir, { recursive: true });
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
  return dir;
}

// One run with everything the audit classifies: a ticket re-reviewed at c2 whose
// re-review repeats S1 (trusted, the brief asks for unique IDs) and raises L1 on
// code the change left alone; a second ticket whose rework report has no
// `## Findings`; two written final rounds at c1 -> c2; a round past the cap; and
// a completion with no retro.
function smallRun(sb) {
  const { wl, repo, shas: { c1, c2 } } = sb;
  const dir = writeRun(wl, "repo", "feat", {});
  const s1 = short(c1);
  const s2 = short(c2);
  const review1 = join(dir, "reviews", `01-${s1}.md`);
  const review2 = join(dir, "reviews", `01-${s2}.md`);
  const review02 = join(dir, "reviews", `02-${s2}.md`);
  const final1 = join(dir, "reviews", `final-1-${s1}.md`);
  const final2 = join(dir, "reviews", `final-2-${s2}.md`);
  writeFileSync(review1, `**Verdict:** changes_requested\n\n${table([{ id: "S1", location: "src/app.ts:12", basis: "AC1: one" }])}\n`);
  writeFileSync(review2, `**Verdict:** changes_requested\n\n${table([
    { id: "S1", location: "src/app.ts:12", basis: "AC1: one" },
    { id: "L1", location: "src/old.ts:2", basis: "AC1: one" },
  ])}\n`);
  writeFileSync(review02, `**Verdict:** pass\n\n${table([])}\n`);
  writeFileSync(final1, `**Verdict:** changes_requested\n\n${table([{ id: "X1", location: "src/old.ts:2", basis: "M1: spec item" }])}\n`);
  writeFileSync(final2, `**Verdict:** pass\n\n${table([{ id: "X1", location: "src/old.ts:2", basis: "M1: spec item" }])}\n`);
  writeFileSync(join(dir, "briefs", `01-review-${s2}.md`), `## Re-review\n\n${NUMBERING}\n`);
  writeFileSync(join(dir, "briefs", `final-2-${s2}.md`), `## Re-review\n\n${NUMBERING}\n`);
  writeFileSync(join(dir, "messages", "01-a1-1.md"), "Fix S1.\n\n## Rework\n\nReproduce each finding first.\n");
  writeFileSync(join(dir, "messages", "01-a1-2.md"), "Fix L1 too.\n");
  writeFileSync(join(dir, "reports", "01-a1-before-2.md"), "Status: done\n\n## Findings\n- S1 fixed\n");
  writeFileSync(join(dir, "reports", "01-a1.md"), "Status: done\n\n## Summary\nDid it.\n");
  // Rechecked after the rework: answered, but the method is not reported.
  writeFileSync(join(dir, "messages", "02-a1-1.md"), "Fix the smell.\n\n## Rework\n\nReproduce each finding first.\n");
  writeFileSync(join(dir, "reports", "02-a1.md"), "Status: done\n\n## Summary\nDid it.\n");
  writeFileSync(join(dir, "events.jsonl"), [
    { kind: "checking", phase: "integrate", task: "01", startedAt: "2024-01-02T00:00:00.000Z", ts: "2024-01-02T00:00:00.000Z" },
    { kind: "integrate", task: "01", ts: "2024-01-02T00:12:00.000Z" },
    { kind: "integrate_failed", task: "02", ts: "2024-01-03T00:00:00.000Z" },
    { kind: "integrate_conflict", task: "02", ts: "2024-01-03T00:05:00.000Z" },
    { kind: "retry", task: "02", ts: "2024-01-03T00:06:00.000Z" },
    { kind: "takeover", task: "02", ts: "2024-01-03T00:07:00.000Z" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");

  const state = {
    version: 1, project: "repo", feature: "feat", runKey: "repo-feat", mode: "full",
    repo, spec: join(dir, "spec.md"), tickets: join(dir, "issues"), baseRef: "main", baseSha: sb.shas.base,
    integration: { branch: "workloop/feat", worktree: join(dir, "tip"), tip: c2 },
    config: { maxExecutors: 2, maxReviewers: 1, checkTimeout: 30, maxReworkRounds: 2, setup: [], checks: [] },
    tasks: {
      "01": {
        id: "01", title: "Schema", file: join(dir, "issues", "01-schema.md"), blockedBy: [], status: "done",
        attempt: "a1", rounds: 1, messages: 2, candidateSha: c2, criteria: ["AC1"],
        history: [{ attempt: "a1", candidateSha: c1, review: { path: review1, candidateSha: c1, criteria: ["AC1"] } }],
        review: { path: review2, candidateSha: c2, criteria: ["AC1"] },
      },
      "02": {
        id: "02", title: "API", file: join(dir, "issues", "02-api.md"), blockedBy: [], status: "done",
        attempt: "a1", rounds: 0, messages: 1, candidateSha: c2, criteria: ["AC1"], history: [],
        review: { path: review02, candidateSha: c2, criteria: ["AC1"] },
      },
    },
    seq: 2, createdAt: "2024-01-01T00:00:00.000Z", reviewBoundary: 1,
    extraRounds: [{ task: "01", attempt: "a1", round: 3, cap: 2, reason: "the user agreed", at: "2024-01-04T00:00:00.000Z" }],
    waivers: [],
    finalReviews: [{ round: 1, tip: c1, path: final1, boundary: { mappings: ["M1"], criteria: {} } }],
    finalReview: { round: 2, tip: c2, path: final2, boundary: { mappings: ["M1"], criteria: {} } },
    completion: { at: "2024-01-05T00:00:00.000Z", tip: c2 },
    finishedAt: "2024-01-06T00:00:00.000Z",
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
  return { dir, state };
}

// A finished run with no tasks and no signals, for the cross-run count.
function simpleRun(wl, project, feature, at) {
  return writeRun(wl, project, feature, {
    version: 1, project, feature, runKey: `${project}-${feature}`, mode: "direct",
    config: { maxReworkRounds: 2 }, tasks: {}, seq: 0, createdAt: "2024-01-01T00:00:00.000Z", reviewBoundary: 1,
    completion: { at, tip: "0".repeat(40) }, finishedAt: at,
  });
}

// main() prints; keep its output for assertions and restore the console after.
async function capture(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

// Every file under a directory, by path, with its content hash.
function snapshot(dir) {
  const files = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files[relative(dir, path).split(sep).join("/")] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return files;
}

test("placesIn: paths with lines, ranges, continuations, absolute worktree paths and Chinese separators", () => {
  assert.deepEqual(placesIn("src/x.ts:12"), [{ file: "src/x.ts", from: 12, to: 12 }]);
  assert.deepEqual(placesIn("src/x.ts:12-20"), [{ file: "src/x.ts", from: 12, to: 20 }]);
  // A bare `:L30-40` continues the file before it.
  assert.deepEqual(placesIn("src/x.ts:12、:L30-40"), [
    { file: "src/x.ts", from: 12, to: 12 },
    { file: "src/x.ts", from: 30, to: 40 },
  ]);
  // A second `:34` on the same file is another place in that file.
  assert.deepEqual(placesIn("src/x.ts:12, :34"), [
    { file: "src/x.ts", from: 12, to: 12 },
    { file: "src/x.ts", from: 34, to: 34 },
  ]);
  // An absolute worktree path is kept whole; the audit resolves it to the repo path.
  assert.deepEqual(placesIn("/tmp/wl-abc/repo/src/app.ts:13"), [{ file: "/tmp/wl-abc/repo/src/app.ts", from: 13, to: 13 }]);
  // Both Chinese separators end a path.
  assert.deepEqual(placesIn("src/a.ts:1、src/b.ts:2；src/c.ts:3"), [
    { file: "src/a.ts", from: 1, to: 1 },
    { file: "src/b.ts", from: 2, to: 2 },
    { file: "src/c.ts", from: 3, to: 3 },
  ]);
  // Markdown emphasis is stripped, and a file without a line still names the file.
  assert.deepEqual(placesIn("`src/app.ts:12-20` and `src/other.ts`"), [
    { file: "src/app.ts", from: 12, to: 20 },
    { file: "src/other.ts", from: null, to: null },
  ]);
  // A location naming no file yields no place, rather than a guess.
  assert.deepEqual(placesIn("the reviewer's brief, line 4"), []);
  assert.deepEqual(placesIn(""), []);
});

test("classifyReReview: carried, in-change, late, outside-repo, unplaced and out", () => {
  const { repo, shas: { c1, c2 } } = sandbox();
  const prevText = table([{ id: "S1", location: "src/app.ts:12", basis: "AC1: one" }]);
  const text = table([
    { id: "S1", location: "src/old.ts:2", basis: "AC1: one" },
    { id: "A1", location: "src/app.ts:13", basis: "Regression: `npm test`" },
    { id: "L1", location: "src/old.ts:2", basis: "AC1: one" },
    { id: "O1", location: "reports/01-a1-before-2.md:5", basis: "AC1: one" },
    { id: "U1", location: "the reviewer's brief", basis: "AC1: one" },
    // 3 lines from the hunk's last line (13) still counts as the change; 4 does not.
    { id: "N2", location: "src/app.ts:16", basis: "AC1: one" },
    { id: "N3", location: "src/app.ts:17", basis: "AC1: one" },
  ]);
  const rows = classifyReReview({ repo, prevSha: c1, sha: c2, text, prevText, brief: "no rule here" });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));

  // The previous review blocked on S1, so a repeated ID is that finding carried;
  // without the numbering sentence the brief cannot promise it names one finding.
  assert.equal(by.S1.category, "carried");
  assert.equal(by.S1.trusted, false);
  // A1 names a line the change touched.
  assert.equal(by.A1.category, "in-change");
  assert.equal(by.A1.samePlace, "S1");
  // L1 names tracked code the change left alone.
  assert.equal(by.L1.category, "late");
  // O1 names a file outside the repository: the run's own report.
  assert.equal(by.O1.category, "outside-repo");
  // U1 names no file at all.
  assert.equal(by.U1.category, "unplaced");
  // The change is read from the diff: within three lines of a hunk is in it.
  assert.equal(by.N2.category, "in-change");
  assert.equal(by.N3.category, "late");
  // Every row keeps the finding's own cells.
  assert.equal(by.L1.location, "src/old.ts:2");
  assert.equal(by.L1.axis, "Standards");

  // With the numbering sentence in the brief, the same repeat is trusted.
  const trusted = classifyReReview({ repo, prevSha: c1, sha: c2, text, prevText, brief: NUMBERING });
  assert.equal(trusted.find((r) => r.id === "S1").trusted, true);

  // A new ID landing where the previous round blocked is flagged, whether or not
  // the change touches the line.
  const samePlace = classifyReReview({
    repo, prevSha: c1, sha: c2, prevText, brief: "",
    text: table([{ id: "N1", location: "src/app.ts:12", basis: "AC1: one" }]),
  });
  assert.equal(samePlace[0].category, "in-change");
  assert.equal(samePlace[0].samePlace, "S1");

  // `out` wins over every other category: the finding cites nothing the ticket confirmed.
  const out = classifyReReview({
    repo, prevSha: c1, sha: c2, prevText,
    text: table([
      { id: "S1", location: "src/old.ts:2", basis: "AC9: never confirmed" },
      { id: "X1", location: "src/old.ts:2", basis: "AC1: one" },
    ]),
    brief: "",
    boundaryCheck: (f) => inBoundary(f, ["AC1"]),
  });
  assert.equal(out.find((r) => r.id === "S1").category, "out");
  assert.equal(out.find((r) => r.id === "X1").category, "late");
});

test("auditRun: facts, categories and the flags one run raises", async () => {
  const sb = sandbox();
  smallRun(sb);

  const run = await auditRun("repo", "feat");
  assert.equal(run.run, "repo/feat");
  assert.equal(run.mode, "full");
  assert.equal(run.bounded, true);
  assert.equal(run.cap, 2);
  assert.equal(run.tickets.length, 2);
  assert.equal(run.extraRounds, 1);
  assert.equal(run.integrateFailures, 1);
  assert.equal(run.conflicts, 1);
  assert.equal(run.retries, 1);
  assert.equal(run.takeovers, 1);
  assert.deepEqual(run.checkMinutes, [{ task: "01", minutes: 12 }]);
  assert.equal(run.retro, "none");
  assert.equal(run.suggestions, 0);
  // No ledger beside this project.
  assert.equal(run.ledger, null);

  assert.equal(run.final.rounds, 2);
  assert.equal(run.final.reported, 2);

  const kinds = run.flags.map((f) => `${f.kind}:${f.level}`);
  // L1 is tracked code the change left alone: a `check` flag for a narrowed method.
  assert.ok(kinds.includes("narrowing:check"), kinds.join(", "));
  assert.match(run.flags.find((f) => f.kind === "narrowing").text, /src\/old\.ts:2 is tracked code the change [0-9a-f]{8}\.\.[0-9a-f]{8} left alone/);
  // #02's rework is answered by a report with no `## Findings`; #01's has one.
  const rework = run.flags.filter((f) => f.kind === "rework-method");
  assert.equal(rework.length, 1, JSON.stringify(rework));
  assert.equal(rework[0].where, "#02 message 1");
  // The finished run has no retro and signals worth assessing.
  assert.ok(kinds.includes("retro:check"), kinds.join(", "));
  assert.match(run.flags.find((f) => f.kind === "retro").text, /retro is none, though the run has 3 signal\(s\)/);
  // Context, not contradiction.
  assert.ok(kinds.includes("past-cap:info"), kinds.join(", "));
  assert.ok(kinds.includes("final-rounds:info"), kinds.join(", "));
  assert.ok(kinds.includes("not-fixed:info"), kinds.join(", "));
  assert.ok(!kinds.some((k) => k.startsWith("ledger-sync")), "no ledger, no ledger flag");

  // The two written final rounds are compared prevTip..tip.
  assert.equal(run.final.reReviews.length, 1);
  assert.equal(run.final.reReviews[0].from, short(sb.shas.c1));
  assert.equal(run.final.reReviews[0].to, short(sb.shas.c2));
  assert.equal(run.final.reReviews[0].review, 2);
  assert.deepEqual(run.final.reReviews[0].findings.map((f) => [f.id, f.category, f.trusted]), [["X1", "carried", true]]);

  // Totals count the same rows the run printed.
  const t = totals([run]);
  assert.equal(t.reReviewFindings, 3);
  assert.equal(t.byCategory.carried, 2);
  assert.equal(t.byCategory["in-change"], 0);
  assert.equal(t.byCategory.late, 1);
  assert.equal(t.untrustedCarried, 0);
  assert.equal(t.flags.narrowing, 1);
  assert.equal(t.flags["rework-method"], 1);

  // flagsFor is a pure reading of the run it is given.
  assert.deepEqual(flagsFor(run), run.flags);
});

test("auditRun: a carried finding is untrusted when its brief predates the numbering rule", async () => {
  const sb = sandbox();
  const { dir } = smallRun(sb);
  // Rewrite the re-review brief without the sentence.
  writeFileSync(join(dir, "briefs", `01-review-${short(sb.shas.c2)}.md`), "## Re-review\n\nConfirm each previous finding.\n");
  const run = await auditRun("repo", "feat");
  const s1 = run.tickets.find((t) => t.id === "01").rounds[0].findings.find((f) => f.id === "S1");
  assert.equal(s1.category, "carried");
  assert.equal(s1.trusted, false);
  assert.equal(totals([run]).untrustedCarried, 1);
  assert.match(run.flags.find((f) => f.kind === "not-fixed").text, /written before IDs were unique/);
});

test("main run: prints the counts, the categories, the flags and the JSON of one run", async () => {
  const sb = sandbox();
  smallRun(sb);

  const out = await capture(() => main(["run", "repo/feat"]));
  assert.match(out, /^# repo\/feat {2}\(full, cap 2\)$/m);
  assert.match(out, /^tickets 2 · reviews 3 · most rework rounds 1 · past the cap 1 · final rounds 2$/m);
  assert.match(out, /^waivers rework 0 \/ override 0 \/ final 0 · integrate failures 1 · conflicts 1 · retries 1 · takeovers 1 · retro none$/m);
  assert.match(out, /^integration checks: 1, longest 12 min, total 12 min$/m);
  assert.match(out, /^re-review blocking findings: 3 — carried 2, late 1$/m);
  assert.match(out, /^flags:$/m);
  assert.match(out, /^- \[check\] narrowing · #01 review 2 L1:/m);
  assert.match(out, /^- \[check\] rework-method · #02 message 1:/m);
  assert.match(out, /^- \[check\] retro · run:/m);
  // One finished run is below the three that make a cross-run check worth suggesting.
  assert.doesNotMatch(out, /suggest one to the user/);

  const json = JSON.parse(await capture(() => main(["run", "repo/feat", "--json"])));
  assert.equal(json.run, "repo/feat");
  assert.equal(json.tickets.length, 2);
  assert.equal(json.flags.filter((f) => f.level === "check").length, 3);
});

test("main all: --save writes one report, the next all compares, and run reminds after three finished runs", async () => {
  const sb = sandbox();
  smallRun(sb);
  simpleRun(sb.wl, "repo", "one", "2024-01-02T00:00:00.000Z");
  simpleRun(sb.wl, "repo", "two", "2024-01-03T00:00:00.000Z");
  assert.deepEqual(listRuns().sort(), [["repo", "feat"], ["repo", "one"], ["repo", "two"]]);

  // Three finished runs and no saved check: `run` passes the suggestion on.
  const before = await capture(() => main(["run", "repo/feat"]));
  assert.match(before, /\n3 run\(s\) finished and no cross-run check has been saved: suggest one to the user\.$/);

  const saved = await capture(() => main(["all", "--save"]));
  assert.match(saved, /^3 runs · 3 re-review blocking findings:/m);
  assert.match(saved, /^flags: narrowing 1, not-fixed 2, rework-method 1, past-cap 1, final-rounds 1, retro 1$/m);
  assert.match(saved, new RegExp(`saved under ${sb.wl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]\\.workloop-audit`));
  const dir = join(sb.wl, ".workloop-audit");
  const files = readdirSync(dir);
  assert.deepEqual(files.filter((f) => f.endsWith(".json")).length, 1);
  const report = JSON.parse(readFileSync(join(dir, files.find((f) => f.endsWith(".json"))), "utf8"));
  assert.equal(report.runs, 3);
  assert.equal(report.totals.reReviewFindings, 3);
  assert.equal(report.detail.length, 3);

  // A second `all` compares against what was saved.
  const compared = await capture(() => main(["all"]));
  assert.match(compared, /compared with the check of \d{4}-\d{2}-\d{2} \(3 runs\):/);
  assert.match(compared, /  carried: 2 \(67%\) → 2 \(67%\)/);

  // The check is newer than every completion, so `run` no longer reminds.
  const after = await capture(() => main(["run", "repo/feat"]));
  assert.doesNotMatch(after, /suggest one to the user/);
});

test("read-only: run and all change neither the run directory, the ledger nor the repository", async () => {
  const sb = sandbox();
  smallRun(sb);
  // A saved check and a baseline note are inputs too.
  mkdirSync(join(sb.wl, ".workloop-audit"), { recursive: true });
  writeFileSync(join(sb.wl, ".workloop-audit", "baseline.md"), "# Baseline\n");

  const status = () => sb.git(sb.repo, "status", "--porcelain");
  const statusBefore = status();
  const before = snapshot(sb.root);
  await capture(() => main(["run", "repo/feat"]));
  await capture(() => main(["all"]));
  const after = snapshot(sb.root);
  assert.deepEqual(after, before, "no file under WORKLOOP_ROOT or the repo may change");
  assert.equal(status(), statusBefore, "the repository's status may not change");
  // Neither command saved anything.
  assert.deepEqual(readdirSync(join(sb.wl, ".workloop-audit")), ["baseline.md"]);
});

// What `flagsFor` must do with the ledger facts `auditRun` is meant to supply:
// the flag, checked apart from how `ledgerAudit` reads the ledger.
test("flagsFor: a linked ledger behind the run's finish or archive is a check flag", () => {
  const run = (ledger) => ({
    run: "repo/feat", tickets: [], final: { reReviews: [], rounds: 0 }, extraRounds: 0,
    waivers: { rework: 0, override: 0, final: 0 }, localRework: 0,
    finished: "2024-01-05T00:00:00.000Z", retro: "none", ledger,
  });
  const pending = flagsFor(run({ checked: true, linked: true, requirement: "REQ-001", syncedFinish: false, syncedArchive: true }));
  assert.equal(pending.length, 1, JSON.stringify(pending));
  assert.deepEqual({ kind: pending[0].kind, level: pending[0].level, where: pending[0].where }, { kind: "ledger-sync", level: "check", where: "run" });
  assert.match(pending[0].text, /REQ-001 does not record this run's delivery: run `req sync repo\/feat`/);

  const archive = flagsFor(run({ checked: true, linked: true, requirement: "REQ-001", syncedFinish: true, syncedArchive: false }));
  assert.match(archive[0].text, /REQ-001 has no archived_at for this archived run: run `req sync repo\/feat` again/);

  // Synced on both ends, or no ledger at all: nothing to flag.
  assert.deepEqual(flagsFor(run({ checked: true, linked: true, requirement: "REQ-001", syncedFinish: true, syncedArchive: true })), []);
  assert.deepEqual(flagsFor(run(null)), []);
});

// BUG (reported, not fixed): audit.mjs reads `r.record.runs`, but store.mjs's
// readRequirements returns `{ file, number, frontmatter, body, error }` — there is
// no `record`. `ledger.linked` is therefore always false and `ledger-sync` can
// never fire, which also makes the ledger line in `run` always say "not linked".
test("auditRun: a ledger record whose delivery is pending for a completed run flags ledger-sync", async () => {
  const sb = sandbox();
  const { state } = smallRun(sb);
  writeFileSync(join(join(sb.wl, "repo", "feat"), "state.json"), JSON.stringify(state, null, 2));

  const req = (...args) => {
    const r = spawnSync(process.execPath, [REQ, ...args, "--project", "repo"], { cwd: sb.repo, env: sb.env, encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  req("new", "Feature health");
  // `link` opens a pending delivery and never syncs it; the run already completed.
  req("link", "repo/feat", "REQ-001");

  const run = await auditRun("repo", "feat");
  assert.deepEqual({ checked: run.ledger.checked, linked: run.ledger.linked, requirement: run.ledger.requirement }, { checked: true, linked: true, requirement: "REQ-001" });
  assert.equal(run.ledger.syncedFinish, false);
  const flag = run.flags.find((f) => f.kind === "ledger-sync");
  assert.ok(flag, JSON.stringify(run.flags));
  assert.match(flag.text, /REQ-001 does not record this run's delivery: run `req sync repo\/feat`/);
  assert.equal(flag.level, "check");
});

// The paths the skill and the tests name still resolve, so a moved script fails
// here rather than in a user's session.
test("audit.mjs and req.mjs exist where the skill and the tests name them, and WORKLOOP_ROOT is read at call time", () => {
  assert.ok(existsSync(AUDIT), AUDIT);
  assert.ok(existsSync(REQ), REQ);
  const before = process.env.WORKLOOP_ROOT;
  const probe = join(tmpdir(), "workloop-audit-root-probe");
  process.env.WORKLOOP_ROOT = probe;
  try {
    assert.equal(workloopRoot(), probe);
  } finally {
    process.env.WORKLOOP_ROOT = before;
  }
});
