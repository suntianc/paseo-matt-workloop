#!/usr/bin/env node
// Workloop audit: read-only facts about how Workloop runs went, for a run's retro
// and for a health check across runs. It reads run directories and Git and never
// writes either; `all --save` writes only its own report under
// $WORKLOOP_ROOT/.workloop-audit/. Nothing in the workloop depends on it.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, "..", "..");

// Findings are read with the workloop's own parsers, so the audit and the gates
// never disagree about what a report says.
let wl;
try {
  wl = await import(pathToFileURL(join(SKILLS, "paseo-workloop", "scripts", "workloop.mjs")).href);
} catch (error) {
  console.error(`workloop-audit needs the paseo-workloop skill beside it: ${error.message}`);
  process.exit(2);
}
const { parseFindings, inBoundary, inFinalBoundary, outOfScope, isMain } = wl;

export const workloopRoot = () => {
  const root = process.env.WORKLOOP_ROOT;
  return root ? root.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".workloop");
};
const AUDIT_DIR = () => join(workloopRoot(), ".workloop-audit");

// A re-review brief written after the numbering rule: from then on an ID names one
// finding for the whole task, so a repeated ID is the same finding carried over.
const NUMBERING_RULE = /no ID ever names two different findings/;
const REWORK_METHOD = /^## Rework\b/m;
const REPORT_FINDINGS = /^## Findings\b/m;
// How close a finding has to be to a changed line to count as in the change.
const NEAR = 3;
// Finished runs since the last saved cross-run check that make one worth suggesting.
const CHECK_AFTER = 3;
// A run directory kept this large after archive is holding something it should not.
const SIZE_MB = 200;
const MB = 1024 * 1024;
const inMb = (bytes) => Math.round((bytes / MB) * 10) / 10;

const short = (sha) => String(sha ?? "").slice(0, 8);
const readText = (path) => (path && existsSync(path) ? readFileSync(path, "utf8") : null);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// ------------------------------------------------- Git, read-only

const gitCache = new Map();
function git(repo, args) {
  const key = [repo, ...args].join("\0");
  if (!gitCache.has(key)) {
    let value;
    try {
      value = execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      value = null;
    }
    gitCache.set(key, value);
  }
  return gitCache.get(key);
}

// The new-side line ranges `from..to` changed, per file.
function changedLines(repo, from, to) {
  const out = git(repo, ["diff", "-U0", "--find-renames", "--no-color", from, to]);
  if (out === null) return null;
  const files = new Map();
  let file = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) {
      const name = line.slice(4).trim();
      file = name === "/dev/null" ? null : name.replace(/^b\//, "");
      if (file && !files.has(file)) files.set(file, []);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      files.get(file).push([start, count === 0 ? start : start + count - 1]);
    }
  }
  return files;
}

const trackedFiles = (repo, sha) => {
  const out = git(repo, ["ls-tree", "-r", "--name-only", sha]);
  return out === null ? null : out.split("\n").filter(Boolean);
};

// ------------------------------------------------- where a finding points

const EXT = "ts|tsx|js|jsx|mjs|cjs|py|pyi|md|mdx|json|jsonl|yml|yaml|rs|go|sh|bash|zsh|toml|cfg|ini|css|scss|sass|less|html|sql|lock|txt|env|mk|proto|graphql|vue|svelte|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|ex|exs|lua|php|pl|r|jl|ipynb|xml|gradle|tf";
const BARE = "Makefile|Dockerfile|Justfile|Procfile|LICENSE|Gemfile|Rakefile";
const PATH_RE = new RegExp(
  String.raw`((?:\.{0,2}\/)?(?:[\w.@+\-]+\/)*(?:[\w.@+\-]+\.(?:${EXT})|(?:[\w.@+\-]+\/)?(?:${BARE})))(?![A-Za-z0-9])`
  + String.raw`(?::L?(\d+)(?:\s*[-–]\s*(\d+))?)?`, "g");
// A bare `:512` or `:L12-30` that continues the previous path.
const MORE_LINES_RE = /(?<![\w/.:]):L?(\d+)(?:\s*[-–]\s*(\d+))?/g;

// The files and lines a Location cell names. Lines may be missing: a finding about
// a whole file still names the file.
export function placesIn(location) {
  const text = String(location ?? "").replace(/[`*]/g, "").replace(/\s+/g, " ");
  const places = [];
  for (const m of text.matchAll(PATH_RE)) {
    const from = m[2] ? Number(m[2]) : null;
    places.push({ at: m.index, end: m.index + m[0].length, file: m[1].replace(/^\.\//, ""), from, to: m[3] ? Number(m[3]) : from });
  }
  for (const m of text.matchAll(MORE_LINES_RE)) {
    const host = places.filter((p) => p.end <= m.index).at(-1);
    if (!host || places.some((p) => m.index >= p.at && m.index < p.end)) continue;
    const from = Number(m[1]);
    places.push({ at: m.index, end: m.index + m[0].length, file: host.file, from, to: m[2] ? Number(m[2]) : from });
  }
  return places.map(({ file, from, to }) => ({ file, from, to }));
}

// The repository path a named file is, among `paths`: exact, then a unique path
// ending (a location may name a worktree's absolute path, or only the tail of one).
function resolvePath(file, paths) {
  if (paths.includes(file)) return file;
  const tails = paths.filter((p) => p.endsWith(`/${file}`) || file.endsWith(`/${p}`));
  if (tails.length === 1) return tails[0];
  if (tails.length > 1) return null;
  const named = paths.filter((p) => basename(p) === basename(file));
  return named.length === 1 ? named[0] : null;
}

const near = (place, ranges) => ranges.some(([a, b]) => (place.from ?? a) - NEAR <= b && (place.to ?? b) + NEAR >= a);
const overlaps = (x, y) => x.file === y.file && x.from != null && y.from != null && x.from - 5 <= y.to && x.to + 5 >= y.from;

// ------------------------------------------------- one re-review, classified

// Each blocking finding of a re-review, placed against the previous review and the
// change since it:
//   carried   — the previous review blocked on the same ID (trusted once IDs are unique);
//   in-change — it names a line the change since touches, which the method allows;
//   late      — it names tracked code the change since left alone; the method allows it
//               only for a failing command, so it is worth a look;
//   outside-repo — it names nothing tracked (run-directory evidence, a report);
//   unplaced  — its Location names no file;
//   out       — outside the review's boundary: a suggestion, which gates nothing.
export function classifyReReview({ repo, prevSha, sha, text, prevText, brief, boundaryCheck }) {
  const findings = parseFindings(text) || [];
  const before = (parseFindings(prevText) || []).filter((f) => f.blocking);
  const uniqueIds = NUMBERING_RULE.test(brief ?? "");
  const changes = prevSha && sha ? changedLines(repo, prevSha, sha) : null;
  const tracked = sha ? trackedFiles(repo, sha) : null;
  const changedPaths = changes ? [...changes.keys()] : [];
  const prevPlaces = before.flatMap((f) => placesIn(f.location).map((p) => ({ ...p, id: f.id })));
  return findings.filter((f) => f.blocking).map((f) => {
    const places = placesIn(f.location);
    const row = { id: f.id, axis: f.axis, location: f.location, basis: f.basis };
    if (boundaryCheck && !boundaryCheck(f)) return { ...row, category: "out" };
    if (before.some((b) => b.id.toLowerCase() === f.id.toLowerCase())) return { ...row, category: "carried", trusted: uniqueIds };
    // A new ID landing where the previous round already blocked: the fix and the
    // findings keep meeting in the same code.
    const samePlace = prevPlaces.find((p) => places.some((q) => overlaps(p, q)))?.id;
    const extra = samePlace ? { samePlace } : {};
    if (!places.length) return { ...row, category: "unplaced", ...extra };
    if (!changes || !tracked) return { ...row, category: "unverifiable", ...extra };
    const inChange = places.some((p) => {
      const path = resolvePath(p.file, changedPaths);
      return path && (p.from == null || near(p, changes.get(path)));
    });
    if (inChange) return { ...row, category: "in-change", ...extra };
    const inRepo = places.some((p) => resolvePath(p.file, tracked));
    return { ...row, category: inRepo ? "late" : "outside-repo", ...extra };
  });
}

// ------------------------------------------------- one run

// A task's reviews in the order they were written: its history, then the current one.
function reviewsOf(t) {
  const seen = new Set();
  const out = [];
  for (const entry of [...(t.history || []).map((h) => ({ h, r: h.review })), { h: {}, r: t.review }]) {
    let r = entry.r;
    if (!r) continue;
    if (typeof r === "string") r = { path: r, candidateSha: entry.h.candidateSha };
    if (!r.path || seen.has(r.path)) continue;
    seen.add(r.path);
    out.push({ ...r, candidateSha: r.candidateSha ?? entry.h.candidateSha });
  }
  return out;
}

const numbered = (s) => Boolean(s.reviewBoundary) || Object.values(s.tasks || {}).some((t) => reviewsOf(t).some((r) => r.criteria));

// The executor's report written in answer to message `n`: the copy `send` keeps when
// it sends message n+1, or the current report when n was the last.
function answerTo(dir, t, n) {
  return readText(join(dir, "reports", `${t.id}-${t.attempt}-before-${n + 1}.md`))
    ?? (n === (t.messages || 0) ? readText(join(dir, "reports", `${t.id}-${t.attempt}.md`)) : null);
}

function ticketAudit(dir, s, t) {
  const reviews = reviewsOf(t);
  const rounds = [];
  for (let i = 1; i < reviews.length; i++) {
    const prev = reviews[i - 1];
    const cur = reviews[i];
    const text = readText(cur.path);
    if (text === null) continue;
    const ids = cur.criteria ?? null;
    rounds.push({
      review: i + 1, path: cur.path, from: short(prev.candidateSha), to: short(cur.candidateSha),
      findings: classifyReReview({
        repo: s.repo, prevSha: prev.candidateSha, sha: cur.candidateSha, text, prevText: readText(prev.path),
        brief: readText(join(dir, "briefs", `${t.id}-review-${short(cur.candidateSha)}.md`)),
        boundaryCheck: ids ? (f) => inBoundary(f, ids) : null,
      }),
    });
  }
  // Every rework message that carried the method, and whether the report answering it
  // gave each finding its line.
  const reworks = [];
  for (let n = 1; n <= (t.messages || 0); n++) {
    const message = readText(join(dir, "messages", `${t.id}-${t.attempt}-${n}.md`));
    if (!message || !REWORK_METHOD.test(message)) continue;
    const report = answerTo(dir, t, n);
    reworks.push({ message: n, answered: report !== null, findingsSection: report !== null && REPORT_FINDINGS.test(report) });
  }
  return { id: t.id, title: t.title, status: t.status, reviews: reviews.length, reworkRounds: t.rounds || 0, rounds, reworks };
}

function finalAudit(dir, s) {
  const all = [...(s.finalReviews || []), ...(s.finalReview ? [s.finalReview] : [])].sort((a, b) => a.round - b.round);
  const written = all.filter((r) => readText(r.path) !== null);
  const rounds = [];
  for (let i = 1; i < written.length; i++) {
    const prev = written[i - 1];
    const cur = written[i];
    rounds.push({
      review: cur.round, path: cur.path, from: short(prev.tip), to: short(cur.tip),
      findings: classifyReReview({
        repo: s.repo, prevSha: prev.tip, sha: cur.tip, text: readText(cur.path), prevText: readText(prev.path),
        brief: readText(join(dir, "briefs", `final-${cur.round}-${short(cur.tip)}.md`)),
        boundaryCheck: cur.boundary ? (f) => inFinalBoundary(f, { ...cur.boundary, waivers: s.waivers || [] }) : null,
      }),
    });
  }
  return { rounds: all.length, reported: written.length, reReviews: rounds };
}

function readEvents(dir) {
  const text = readText(join(dir, "events.jsonl")) ?? "";
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// How long each integration's checks took: from its `checking` event to the
// `integrate` that recorded it.
function checkDurations(events) {
  const open = new Map();
  const out = [];
  for (const e of events) {
    if (e.kind === "checking" && e.phase === "integrate") open.set(e.task, e);
    if (e.kind === "integrate" && open.has(e.task)) {
      out.push({ task: e.task, minutes: Math.round((Date.parse(e.ts) - Date.parse(open.get(e.task).startedAt ?? open.get(e.task).ts)) / 6000) / 10 });
      open.delete(e.task);
    }
  }
  return out;
}

// The requirement ledger's view of this run, when the project keeps one: whether
// `req sync` caught up with finish and with archive. Optional, like the ledger.
async function ledgerAudit(project, feature, s) {
  const dir = join(workloopRoot(), project, ".requirements");
  if (!existsSync(dir)) return null;
  let readRequirements;
  try {
    ({ readRequirements } = await import(pathToFileURL(join(SKILLS, "requirement-ledger", "scripts", "store.mjs")).href));
  } catch {
    return { checked: false, reason: "requirement-ledger skill not found beside this one" };
  }
  let records;
  try { records = readRequirements(dir); } catch (error) { return { checked: false, reason: error.message }; }
  const links = records.flatMap((r) => (r.frontmatter?.runs || []).filter((x) => x.project === project && x.feature === feature).map((x) => ({ id: r.frontmatter.id, ...x })));
  if (!links.length) return { checked: true, linked: false };
  const primary = links.find((x) => x.relation === "primary") ?? links[0];
  const delivery = primary.delivery || {};
  return {
    checked: true, linked: true, requirement: primary.id,
    syncedFinish: !s.completion || (delivery.state === "delivered" && delivery.final_tip === s.completion.tip),
    syncedArchive: !s.finishedAt || Boolean(delivery.archived_at),
  };
}

// ------------------------------------------------- how much a run keeps
//
// A run directory is meant to hold records, not code. Sizes are read here rather
// than from `du`, so the audit runs on Windows too: symbolic links are not followed
// (a link into a repository must not pull the repository in), and anything that
// disappears or cannot be read is skipped instead of failing the run.
function bytesIn(dir, { skip = null } = {}) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let total = 0;
  for (const entry of entries) {
    if (skip && entry.name === skip) continue;
    const path = join(dir, entry.name);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) total += bytesIn(path);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

// The biggest `count` direct children of `dir`, by the bytes under each.
function largestIn(dir, count) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const items = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    const bytes = stat.isDirectory() ? bytesIn(path) : stat.size;
    items.push({ path: `${basename(dir)}/${entry.name}`, bytes });
  }
  return items.sort((a, b) => b.bytes - a.bytes).slice(0, count).map(({ path, bytes }) => ({ path, mb: inMb(bytes) }));
}

// What the run directory holds: everything but `scratch/` (which archive deletes),
// how much `scratch/` still holds, and the largest things under `evidence/`.
function diskFacts(dir) {
  return {
    mb: inMb(bytesIn(dir, { skip: "scratch" })),
    scratchMb: inMb(bytesIn(join(dir, "scratch"))),
    largest: largestIn(join(dir, "evidence"), 3),
  };
}

export async function auditRun(project, feature) {
  const dir = join(workloopRoot(), project, feature);
  const s = readJson(join(dir, "state.json"));
  const events = readEvents(dir);
  const tasks = Object.values(s.tasks || {}).sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const tickets = tasks.map((t) => ticketAudit(dir, s, t));
  const final = finalAudit(dir, s);
  const waivers = s.waivers || [];
  const count = (kind) => events.filter((e) => e.kind === kind).length;
  const facts = {
    run: `${project}/${feature}`, mode: s.mode || "full", bounded: numbered(s), cap: s.config?.maxReworkRounds ?? (numbered(s) ? 2 : null),
    created: s.createdAt ?? null, finished: s.completion?.at ?? null, archived: s.finishedAt ?? null,
    tickets: tickets.length, extraRounds: (s.extraRounds || []).length,
    waivers: { rework: waivers.filter((w) => w.kind === "rework").length, override: waivers.filter((w) => w.kind === "override").length, final: waivers.filter((w) => w.kind === "final").length },
    integrateFailures: count("integrate_failed"), conflicts: count("integrate_conflict"), checkMinutes: checkDurations(events),
    retries: count("retry"), takeovers: count("takeover") + count("orchestrator-transfer"), localRework: count("local-rework"), holds: count("hold"),
    criteriaChanges: count("criteria"),
    retro: s.retro ? (s.retro.status === "skipped" || s.retro.skipped ? "skipped" : "done") : "none",
    suggestions: tickets.reduce((n, t) => n + reviewsOf(s.tasks[t.id]).reduce((m, r) => m + outOfScope(readText(r.path) ?? "").length, 0), 0),
  };
  const ledger = await ledgerAudit(project, feature, s);
  const result = { ...facts, ledger, disk: diskFacts(dir), tickets, final };
  result.flags = flagsFor(result);
  return result;
}

// ------------------------------------------------- what is worth a look

// Each flag names what the rules expect and what the record shows. A flag is a
// question for whoever reads the run, not a verdict: open the report it names.
export function flagsFor(run) {
  const flags = [];
  const add = (kind, level, where, text) => flags.push({ kind, level, where, text });
  const reReviews = [
    ...run.tickets.flatMap((t) => t.rounds.map((r) => ({ who: `#${t.id}`, ...r }))),
    ...run.final.reReviews.map((r) => ({ who: "final", ...r })),
  ];
  for (const r of reReviews) {
    for (const f of r.findings) {
      const at = `${r.who} review ${r.review} ${f.id}`;
      if (f.category === "late") {
        add("narrowing", "check", at, `${f.location} is tracked code the change ${r.from}..${r.to} left alone: a re-review blocks there only on a failing command; read ${r.path}`);
      }
      if (f.samePlace) add("same-place", "info", at, `new finding where ${f.samePlace} blocked the round before (${f.location}): the fix and the findings keep meeting in the same code`);
    }
    const carried = r.findings.filter((f) => f.category === "carried");
    if (carried.length) {
      add("not-fixed", "info", `${r.who} review ${r.review}`, `${carried.map((f) => f.id).join(", ")} blocked again after ${r.who === "final" ? "repairs" : "a rework"}`
        + (carried.some((f) => !f.trusted) ? " (written before IDs were unique: compare each with the previous row of the same ID)" : ""));
    }
  }
  for (const t of run.tickets) {
    for (const w of t.reworks) {
      if (w.answered && !w.findingsSection) add("rework-method", "check", `#${t.id} message ${w.message}`, "the report answering this rework has no `## Findings` section, so the rework method was not followed or not reported");
    }
  }
  if (run.extraRounds) add("past-cap", "info", "run", `${run.extraRounds} round(s) went past the cap, each with the user's decision`);
  if (run.final.rounds > 1) add("final-rounds", "info", "run", `${run.final.rounds} final review rounds`);
  if (run.waivers.override) add("override", "info", "run", `${run.waivers.override} candidate(s) integrated over an in-boundary blocking finding`);
  if (run.localRework) add("local-rework", "info", "run", `the orchestrator reworked ${run.localRework} candidate(s) itself`);
  // An archived run should keep its records and little else. `run.disk` is absent
  // from a hand-built run, which simply has nothing measured to flag.
  if (run.disk && run.archived) {
    if (run.disk.mb > SIZE_MB) {
      const largest = (run.disk.largest || []).map((e) => `${e.path} ${e.mb} MB`).join(", ");
      add("size", "check", "run", `archived, but the run directory still holds ${run.disk.mb} MB`
        + (largest ? `; largest under evidence/: ${largest}` : "")
        + ": other commits' trees, installs, caches and test artifacts no report cites belong in the scratch folder the brief names, which `archive` deletes");
    }
    if (run.disk.scratchMb > 0) {
      add("size", "check", "run", `scratch/ still holds ${run.disk.scratchMb} MB after archive: archive could not delete it; delete it by hand`);
    }
  }
  const signals = run.extraRounds + run.waivers.override + run.waivers.rework + run.waivers.final + flags.filter((f) => f.level === "check").length;
  if (run.finished && run.retro !== "done" && signals) {
    add("retro", "check", "run", `retro is ${run.retro}, though the run has ${signals} signal(s) above worth assessing`);
  }
  if (run.ledger?.linked && !run.ledger.syncedFinish) add("ledger-sync", "check", "run", `${run.ledger.requirement} does not record this run's delivery: run \`req sync ${run.run}\``);
  if (run.ledger?.linked && run.ledger.syncedFinish && !run.ledger.syncedArchive) add("ledger-sync", "check", "run", `${run.ledger.requirement} has no archived_at for this archived run: run \`req sync ${run.run}\` again`);
  return flags;
}

// ------------------------------------------------- every run

export function listRuns(root = workloopRoot()) {
  if (!existsSync(root)) return [];
  const runs = [];
  for (const project of readdirSync(root).sort()) {
    if (project.startsWith(".")) continue;
    let features;
    try { features = readdirSync(join(root, project)); } catch { continue; }
    for (const feature of features.sort()) {
      if (!feature.startsWith(".") && existsSync(join(root, project, feature, "state.json"))) runs.push([project, feature]);
    }
  }
  return runs;
}

const CATEGORIES = ["carried", "in-change", "late", "outside-repo", "unplaced", "unverifiable", "out"];

export function totals(runs) {
  const t = { reReviewFindings: 0, byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, 0])), untrustedCarried: 0, flags: {} };
  for (const run of runs) {
    for (const r of [...run.tickets.flatMap((x) => x.rounds), ...run.final.reReviews]) {
      for (const f of r.findings) {
        t.reReviewFindings++;
        t.byCategory[f.category]++;
        if (f.category === "carried" && !f.trusted) t.untrustedCarried++;
      }
    }
    for (const f of run.flags) t.flags[f.kind] = (t.flags[f.kind] || 0) + 1;
  }
  return t;
}

function lastCheck() {
  const dir = AUDIT_DIR();
  if (!existsSync(dir)) return null;
  const saved = readdirSync(dir).filter((f) => /^\d{4}-.*\.json$/.test(f)).sort();
  return saved.length ? { file: join(dir, saved.at(-1)), ...readJson(join(dir, saved.at(-1))) } : null;
}

// ------------------------------------------------- output

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "–");

function printRun(run) {
  const lines = [`# ${run.run}  (${run.mode}${run.bounded ? `, cap ${run.cap}` : ", before the review boundary"})`];
  lines.push(`tickets ${run.tickets.length} · reviews ${run.tickets.reduce((n, t) => n + t.reviews, 0)} · most rework rounds ${Math.max(0, ...run.tickets.map((t) => t.reworkRounds))} · past the cap ${run.extraRounds} · final rounds ${run.final.rounds}`);
  lines.push(`waivers rework ${run.waivers.rework} / override ${run.waivers.override} / final ${run.waivers.final} · integrate failures ${run.integrateFailures} · conflicts ${run.conflicts} · retries ${run.retries} · takeovers ${run.takeovers} · retro ${run.retro}`);
  const minutes = run.checkMinutes.map((c) => c.minutes);
  if (minutes.length) lines.push(`integration checks: ${minutes.length}, longest ${Math.max(...minutes)} min, total ${Math.round(minutes.reduce((a, b) => a + b, 0))} min`);
  if (run.ledger) lines.push(`ledger: ${!run.ledger.checked ? `not checked (${run.ledger.reason})` : run.ledger.linked ? `${run.ledger.requirement}, finish ${run.ledger.syncedFinish ? "synced" : "NOT synced"}, archive ${run.ledger.syncedArchive ? "synced" : "NOT synced"}` : "this run is not linked to a requirement"}`);
  if (run.disk) lines.push(`disk: ${run.disk.mb} MB (scratch ${run.disk.scratchMb} MB)`);
  const t = totals([run]);
  if (t.reReviewFindings) {
    lines.push("", `re-review blocking findings: ${t.reReviewFindings} — ${CATEGORIES.filter((c) => t.byCategory[c]).map((c) => `${c} ${t.byCategory[c]}`).join(", ")}`);
    if (t.untrustedCarried) lines.push(`  ${t.untrustedCarried} "carried" come from reviews written before IDs were unique: read both rows before trusting them`);
  }
  lines.push("", run.flags.length ? "flags:" : "flags: none");
  for (const f of run.flags) lines.push(`- [${f.level}] ${f.kind} · ${f.where}: ${f.text}`);
  return lines.join("\n");
}

function reminder() {
  const last = lastCheck();
  const finished = listRuns().map(([p, f]) => {
    try { return readJson(join(workloopRoot(), p, f, "state.json")).completion?.at ?? null; } catch { return null; }
  }).filter(Boolean);
  const since = last ? finished.filter((at) => at > last.at).length : finished.length;
  if (since < CHECK_AFTER) return null;
  return `${since} run(s) finished ${last ? `since the last cross-run check (${last.at.slice(0, 10)})` : "and no cross-run check has been saved"}: suggest one to the user.`;
}

function compare(now, before) {
  const lines = [`compared with the check of ${before.at.slice(0, 10)} (${before.runs} runs):`];
  for (const c of CATEGORIES) {
    const a = before.totals.byCategory[c] ?? 0;
    const b = now.totals.byCategory[c];
    if (a || b) lines.push(`  ${c}: ${a} (${pct(a, before.totals.reReviewFindings)}) → ${b} (${pct(b, now.totals.reReviewFindings)})`);
  }
  return lines.join("\n");
}

const USAGE = `Usage:
  audit.mjs run <project>/<feature> [--json]    one run: facts, re-review findings by category, flags
  audit.mjs all [--project <p>] [--json] [--save]
                                              every run; --save keeps the report under
                                              $WORKLOOP_ROOT/.workloop-audit/ for the next comparison`;

export async function main(argv) {
  const [command, ...rest] = argv;
  const flag = (name) => rest.includes(`--${name}`);
  const value = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (command === "run") {
    const key = rest.find((a) => !a.startsWith("--"));
    if (!key || !/^[^/]+\/[^/]+$/.test(key)) throw new Error(`run needs <project>/<feature>\n${USAGE}`);
    const [project, feature] = key.split("/");
    if (!existsSync(join(workloopRoot(), project, feature, "state.json"))) throw new Error(`no run at ${join(workloopRoot(), project, feature)}`);
    const run = await auditRun(project, feature);
    if (flag("json")) return console.log(JSON.stringify(run, null, 2));
    console.log(printRun(run));
    const note = reminder();
    if (note) console.log(`\n${note}`);
    return;
  }
  if (command === "all") {
    const only = value("project");
    const runs = [];
    for (const [project, feature] of listRuns()) {
      if (only && project !== only) continue;
      try { runs.push(await auditRun(project, feature)); } catch (error) { runs.push({ run: `${project}/${feature}`, error: error.message, tickets: [], final: { reReviews: [], rounds: 0 }, flags: [] }); }
    }
    const report = { at: new Date().toISOString(), runs: runs.length, totals: totals(runs.filter((r) => !r.error)), unreadable: runs.filter((r) => r.error).map((r) => ({ run: r.run, error: r.error })) };
    const before = lastCheck();
    if (flag("save")) {
      mkdirSync(AUDIT_DIR(), { recursive: true });
      writeFileSync(join(AUDIT_DIR(), `${report.at.replace(/[:.]/g, "-")}.json`), `${JSON.stringify({ ...report, detail: runs }, null, 2)}\n`);
    }
    if (flag("json")) return console.log(JSON.stringify({ ...report, detail: runs }, null, 2));
    const t = report.totals;
    console.log(`${runs.length} runs · ${t.reReviewFindings} re-review blocking findings: ${CATEGORIES.map((c) => `${c} ${t.byCategory[c]} (${pct(t.byCategory[c], t.reReviewFindings)})`).join(", ")}`);
    if (t.untrustedCarried) console.log(`  ${t.untrustedCarried} of the carried come from reviews written before IDs were unique: read both rows before trusting them`);
    console.log(`flags: ${Object.entries(t.flags).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
    for (const u of report.unreadable) console.log(`unreadable: ${u.run}: ${u.error}`);
    if (before) console.log(compare(report, before));
    const baseline = join(AUDIT_DIR(), "baseline.md");
    if (existsSync(baseline)) console.log(`baseline notes: ${baseline}`);
    for (const run of runs.filter((r) => !r.error && r.flags.some((f) => f.level === "check"))) {
      console.log(`\n${run.run}:`);
      for (const f of run.flags.filter((x) => x.level === "check")) console.log(`- ${f.kind} · ${f.where}: ${f.text}`);
    }
    if (flag("save")) console.log(`\nsaved under ${AUDIT_DIR()}`);
    return;
  }
  console.log(USAGE);
  if (command && command !== "help" && command !== "--help") process.exitCode = 2;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
