// `context`: the pointer set for one requirement. It answers "what do I already
// know about this?" without copying anything — the record's own current state, then
// the run's spec and tickets, the ADR references, the delivery SHA and its evidence,
// and the CodeGraph hints, in the order the frozen design fixes (§5). Retrospectives,
// pitfalls and history come last, and only when asked for.
//
// Read only. The ledger stores hints, never a graph, and never edits Workloop.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { resolveDocRef } from "./refs.mjs";
import { runsOf } from "./relations.mjs";
import { deliveryFrom, readRun, runDirOf } from "./runstate.mjs";

// The sections that cost more to read than they usually earn: a retrospective, a
// pitfall list and the full history are §5.6, "when the question reaches back that
// far". `--include` names them; nothing else is optional.
export const INCLUDE = ["retro", "pitfalls", "history"];

// `retro,history`, `retro history` and `retro, history` all mean the same thing.
// Unknown names are returned rather than ignored: a typo must not silently drop a
// section the reader asked for.
export function parseInclude(value) {
  const asked = String(value ?? "")
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const include = new Set();
  const unknown = [];
  for (const name of asked) {
    if (INCLUDE.includes(name)) include.add(name);
    else unknown.push(name);
  }
  return { include, unknown };
}

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isRun = (run) => typeof run?.project === "string" && typeof run?.feature === "string";

// A ref list may be stored as one string by a hand edit; read both forms, and keep
// only usable names.
const stringList = (value) => {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
};

// ---------------------------------------------------------------- the record's prose

// The body under one `## <name>` heading, trimmed, or null when the section is
// absent or empty. Prose stays in the record: this is a slice of what the reader
// already asked for, not a document body copied into the ledger.
function sectionText(body, name) {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  const heading = `## ${name}`.toLowerCase();
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i] ?? "")) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n").trim() || null;
}

// The dated bullets of `## History`, the record's own log of what moved. A leading
// ISO date is split off when it is there; the rest is left exactly as written.
function historyEntries(body) {
  const history = sectionText(body, "History");
  if (!history) return [];
  return history.split("\n")
    .filter((line) => /^\s*[-*]\s+/.test(line))
    .map((line) => {
      const text = line.replace(/^\s*[-*]\s+/, "").trim();
      const dated = /^(\d{4}-\d\d-\d\d)\s+(.*)$/.exec(text);
      return dated ? { date: dated[1], text: dated[2] } : { date: null, text };
    });
}

// "The latest change" is the last line of History. A requirement whose work came
// through `note --outcome` has no History line to show, so its newest outcome stands
// in; nothing is derived from the audit log, which is not the requirement's prose.
function latestChange(body, frontmatter) {
  const last = historyEntries(body).at(-1);
  if (last) return last;
  const outcomes = Array.isArray(frontmatter?.outcomes) ? frontmatter.outcomes : [];
  const newest = [...outcomes].reverse().find((outcome) => typeof outcome?.summary === "string" && outcome.summary.trim());
  if (!newest) return null;
  const date = typeof newest.date === "string" && /^\d{4}-\d\d-\d\d/.test(newest.date) ? newest.date.slice(0, 10) : null;
  return { date, text: newest.summary.trim() };
}

// ---------------------------------------------------------------- references

// ADRs and pitfalls are named, not embedded: `0007-session-tokens` is an ADR number
// and slug, `auth-cookie-domain` is a pitfall file's name or a heading's slug. A
// name that resolves to no file is reported as dangling — never deleted from the
// record, never replaced with a plausible-looking neighbour. How a name resolves is
// `refs.mjs`'s rule, shared with `doctor` so the two commands cannot disagree.

// Any pointer the record holds as a path: the spec hint, a run's spec, its tickets.
// Existence is reported beside it, because a path the reader will try to open is
// worth checking once here rather than failing at the other end.
function pathEntry(fromDir, value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const path = isAbsolute(text) ? text : resolve(fromDir ?? ".", text);
  return { path, exists: existsSync(path) };
}

// ---------------------------------------------------------------- one run

// Workloop's final review rounds: `finalReview` is the current one and
// `finalReviews` the earlier ones (workloop.mjs:777).
const finalRoundsOf = (state) => [
  ...(Array.isArray(state?.finalReviews) ? state.finalReviews : []),
  ...(state?.finalReview ? [state.finalReview] : []),
];

const uniqueBy = (entries, key) => {
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry || seen.has(key(entry))) return false;
    seen.add(key(entry));
    return true;
  });
};

// Where a run's evidence lives, from the most authoritative source that names it:
// the run's own state, then the ledger's recorded snapshot, then the directory
// Workloop's `evidence` command uses.
function evidenceDirOf(state, dir, recorded) {
  const fromState = state?.evidence?.path;
  if (typeof fromState === "string" && fromState) return dirname(fromState);
  if (recorded && typeof recorded.evidence_dir === "string" && recorded.evidence_dir) return recorded.evidence_dir;
  return dir ? join(dir, "evidence") : null;
}

// §5.1's three states, plus the cases where the run itself is not readable. The
// distinction is made from `state.json` alone:
//
//   - finished, not archived (`completion`, no `finishedAt`) — delivered, evidence
//     awaiting archive; a missing `evidence/index.json` is not a failure;
//   - archived with evidence (`finishedAt`, `evidence/index.json`) — reported with
//     `archived_at` and the evidence directory;
//   - archived without evidence — `evidence_available: false`, reported, invented
//     never.
function evidenceOf({ archived, evidenceDir }) {
  let readable = false;
  let note = null;
  if (!existsSync(evidenceDir)) {
    note = "the evidence directory is gone";
  } else if (!existsSync(join(evidenceDir, "index.json"))) {
    note = "evidence/index.json is not there";
  } else {
    try {
      readFileSync(join(evidenceDir, "index.json"));
      readable = true;
    } catch (error) {
      note = `evidence/index.json cannot be read (${error.code ?? error.message})`;
    }
  }
  if (!archived) {
    // S1: the run is finished, not archived. Nothing is missing yet, so a gap here
    // is not a failure and not history.
    return {
      evidence_dir: evidenceDir, evidence_available: readable, evidence_status: "pending-archive",
      evidence_note: "the run is finished, not archived, so the evidence is captured at archive",
    };
  }
  // S2 and S3: archived, and the index either is there or is reported missing.
  return {
    evidence_dir: evidenceDir, evidence_available: readable,
    evidence_status: readable ? "available" : "missing", evidence_note: readable ? null : note,
  };
}

// One relation, read against the run it names. Everything a missing `state.json`
// would have answered — the spec, the tickets, the reviewer reports — comes back
// null rather than guessed; what the record already holds (the delivery snapshot)
// still stands.
function runView(relation) {
  const { project, feature } = relation;
  const key = `${project}/${feature}`;
  const dir = runDirOf(project, feature);
  const statePath = join(dir, "state.json");
  const recorded = isMapping(relation.delivery) ? relation.delivery : { state: "pending" };

  let state = null;
  try {
    state = readRun({ project, feature }).state;
  } catch {
    // A dangling relation is `doctor`'s finding; context reports what it can still
    // name instead of failing the whole requirement.
  }

  const run = {
    run: key,
    relation: typeof relation.relation === "string" ? relation.relation : "primary",
    linked_at: typeof relation.linked_at === "string" ? relation.linked_at : null,
    state_path: statePath,
    state_available: Boolean(state),
    branch: typeof state?.integration?.branch === "string" ? state.integration.branch : null,
    base_sha: typeof relation.base_sha === "string"
      ? relation.base_sha
      : typeof state?.baseSha === "string" ? state.baseSha : null,
    spec: pathEntry(dir, state?.spec),
    tickets: pathEntry(dir, state?.tickets),
    acceptance: {
      // The acceptance mapping is what the final reviewer verified against, so it is
      // the run's acceptance result; the reviewer reports behind it are the proof.
      mapping: pathEntry(dir, join(dir, "final-review.md")),
      reports: uniqueBy(
        [
          ...finalRoundsOf(state).map((round) => pathEntry(dir, round?.path)),
          ...Object.values(isMapping(state?.tasks) ? state.tasks : {})
            .map((task) => pathEntry(dir, task?.review?.path)),
        ],
        (entry) => entry.path,
      ),
      reviews_dir: pathEntry(dir, join(dir, "reviews")),
    },
  };

  const delivery = deliveryView({ key, state, recorded, dir });
  return { run, delivery, state, dir, relation };
}

// The delivery half of §5.1 and §5.4: the SHA, the times, and the evidence, taken
// from `state.json` when it is there and from the ledger's own snapshot when it is
// not — the point of §5.2, where archival has deleted the worktree and the run
// directory survives. A disagreement between the two is reported, not resolved.
function deliveryView({ key, state, recorded, dir }) {
  const recordedTip = typeof recorded.final_tip === "string" && recorded.final_tip ? recorded.final_tip : null;
  // `deliveryFrom` is `sync`'s own derivation, not a second opinion: delivered if and
  // only if `completion` exists, and a broken completion is reported, not smoothed.
  const from = state ? deliveryFrom(state) : null;
  const fromState = from?.state === "delivered";
  // §5.2: archival deletes the worktree and can leave the run without a state.json;
  // what the ledger was told then stands on its own, and says where it came from.
  const fromLedger = !state && recorded.state === "delivered" && Boolean(recordedTip);
  const delivered = fromState || fromLedger;
  const archivedAt = typeof state?.finishedAt === "string" && state.finishedAt
    ? state.finishedAt
    : fromLedger && typeof recorded.archived_at === "string" ? recorded.archived_at : null;
  const delivery = {
    run: key,
    state: delivered ? "delivered" : "pending",
    final_tip: fromState ? from.final_tip : fromLedger ? recordedTip : null,
    delivered_at: fromState ? from.delivered_at || null
      : fromLedger && typeof recorded.delivered_at === "string" ? recorded.delivered_at : null,
    archived_at: archivedAt,
    source: state ? "state.json" : "ledger",
    recorded: { state: typeof recorded.state === "string" ? recorded.state : "pending", final_tip: recordedTip },
    note: fromLedger ? "recorded in the ledger; state.json is missing" : null,
  };

  const evidence = evidenceOf({ archived: Boolean(archivedAt), evidenceDir: evidenceDirOf(state, dir, recorded) });
  Object.assign(delivery, {
    evidence_dir: evidence.evidence_dir,
    evidence_status: evidence.evidence_status,
    evidence_available: evidence.evidence_available,
    evidence_note: evidence.evidence_note,
  });

  const tip = recordedTip;
  if (!delivery.note && delivery.state === "delivered" && recorded.state !== "delivered") {
    delivery.note = `the ledger has not recorded this delivery${tip ? ` (it records ${short(tip)})` : ""}: run req sync ${key}`;
  }
  if (!delivery.note && delivery.state === "pending" && recorded.state === "delivered") {
    delivery.note = `state.json reports no completion, but the ledger records ${short(tip)}: run req sync ${key} to record the reopening`;
  }
  if (!delivery.note && delivery.state === "delivered" && delivery.final_tip && tip && delivery.final_tip !== tip) {
    delivery.note = `state.json reports ${short(delivery.final_tip)}, but the ledger records ${short(tip)}: run req sync ${key}`;
  }
  return delivery;
}

const short = (sha) => (typeof sha === "string" && sha.length > 7 ? sha.slice(0, 7) : String(sha ?? ""));

// ---------------------------------------------------------------- assembling

// The whole reply. Every key is a pointer or a slice of the record's own prose, and
// the key order is §5's order, so `--json` and the text form cannot drift apart.
export function assembleContext({ requirement, dir, include = new Set() }) {
  const { frontmatter, body } = requirement;
  // The record's own path, so a reader can open the prose this reply only slices.
  const file = join(dir, requirement.file);
  const repo = typeof frontmatter.repo_path === "string" && frontmatter.repo_path ? frontmatter.repo_path : null;
  const refs = isMapping(frontmatter.refs) ? frontmatter.refs : {};

  const context = {
    requirement: {
      id: frontmatter.id,
      title: frontmatter.title,
      status: frontmatter.status,
      rev: frontmatter.rev,
      updated_at: typeof frontmatter.updated_at === "string" ? frontmatter.updated_at : null,
      file,
      scope: {
        repo_path: repo,
        repo_remote: typeof frontmatter.repo_remote === "string" ? frontmatter.repo_remote : null,
        aliases: stringList(frontmatter.aliases),
      },
      summary: { text: sectionText(body, "Summary"), file },
      latest_change: latestChange(body, frontmatter),
      spec_hint: pathEntry(repo ?? ".", refs.spec_hint),
    },
    runs: [],
    adrs: stringList(refs.adr).map((ref) => resolveDocRef(repo, "adr", ref)),
    deliveries: [],
    codegraph: {
      symbols: stringList(refs.codegraph?.symbols),
      paths: stringList(refs.codegraph?.paths),
      // The standing caveat (§5.3): hints only, and the index may be behind the tree.
      note: "hints only: the ledger stores no graph and runs no query. The index may lag the working tree, so read the code there.",
    },
  };

  const views = [];
  for (const relation of runsOf(frontmatter)) {
    if (!isRun(relation)) continue;
    const view = runView(relation);
    views.push(view);
    context.runs.push(view.run);
    context.deliveries.push(view.delivery);
  }

  if (include.has("retro")) {
    context.retrospectives = views.map(({ run, state, dir }) => ({
      run: run.run,
      status: typeof state?.retro?.status === "string" ? state.retro.status : null,
      path: pathEntry(dir, state?.retro?.path),
    }));
  }
  if (include.has("pitfalls")) {
    context.pitfalls = stringList(refs.pitfalls).map((ref) => resolveDocRef(repo, "pitfalls", ref));
  }
  if (include.has("history")) {
    context.history = {
      changes: historyEntries(body),
      outcomes: (Array.isArray(frontmatter.outcomes) ? frontmatter.outcomes : []).map((outcome) => ({
        date: typeof outcome?.date === "string" ? outcome.date : null,
        summary: typeof outcome?.summary === "string" ? outcome.summary : null,
        commit_sha: typeof outcome?.commit_sha === "string" ? outcome.commit_sha : null,
        verification: typeof outcome?.verification === "string" ? outcome.verification : null,
      })),
      // A delivery that a reopened run replaced is still a committed, delivered
      // version; it is history, and it stays visible as such (§6.3, R3).
      superseded: views.flatMap(({ run, relation }) => {
        const entries = Array.isArray(relation?.delivery_history) ? relation.delivery_history : [];
        return entries.map((entry) => ({
          run: run.run,
          final_tip: typeof entry?.final_tip === "string" ? entry.final_tip : null,
          delivered_at: typeof entry?.delivered_at === "string" ? entry.delivered_at : null,
          archived_at: typeof entry?.archived_at === "string" ? entry.archived_at : null,
          superseded_at: typeof entry?.superseded_at === "string" ? entry.superseded_at : null,
          reason: typeof entry?.reason === "string" ? entry.reason : null,
          evidence_dir: typeof entry?.evidence_dir === "string" ? entry.evidence_dir : null,
        }));
      }),
    };
  }
  return context;
}

// ---------------------------------------------------------------- the text form

// The same reply, for a human or an agent reading a terminal. Section headings
// carry §5's numbers so a reader can see the order is the contract's, and each
// section says "(none recorded)" rather than disappearing: an empty section is
// information, and a missing one is indistinguishable from a command that forgot it.
// The evidence status is the one value whose machine name differs from its prose.
const EVIDENCE_LABELS = { available: "available", "pending-archive": "pending archive", missing: "missing" };

export function renderText(context) {
  const lines = [];
  const { requirement } = context;
  const bullet = (entry, description) => {
    const name = !entry.path || entry.ref === entry.path ? entry.ref : `${entry.ref} → ${entry.path}`;
    lines.push(`  ${name}${entry.status === "ok" ? "" : `  dangling: ${entry.reason ?? "not resolved"}`}${description ?? ""}`);
  };
  const LABEL_WIDTH = 12;
  const field = (label, value) => lines.push(`  ${`${label}:`.padEnd(LABEL_WIDTH)}${value}`);
  const continuation = () => " ".repeat(2 + LABEL_WIDTH);
  // A pointer the reader is about to open: say when there is nothing at the far end.
  const present = (entry, empty = "(missing)") => `${entry.path}${entry.exists ? "" : `  ${empty}`}`;

  lines.push("# 1 requirement");
  lines.push(
    `${requirement.id}  ${requirement.title}  [${requirement.status}]  rev ${requirement.rev}` +
    (requirement.updated_at ? `  updated ${requirement.updated_at}` : ""),
  );
  lines.push(`file: ${requirement.file}`);
  const scope = [requirement.scope.repo_path, requirement.scope.repo_remote].filter(Boolean).join("  ");
  lines.push(`scope: ${scope || "(none recorded)"}`);
  if (requirement.scope.aliases.length) lines.push(`aliases: ${requirement.scope.aliases.join(", ")}`);
  lines.push("summary:");
  if (requirement.summary.text) {
    for (const text of requirement.summary.text.split("\n")) lines.push(`  ${text}`.trimEnd());
  } else {
    lines.push("  (no summary in the record)");
  }
  const change = requirement.latest_change;
  lines.push(`latest change: ${change ? [change.date, change.text].filter(Boolean).join(" ") : "(none recorded)"}`);
  if (requirement.spec_hint) lines.push(`spec hint: ${present(requirement.spec_hint)}`);

  lines.push("", "# 2 runs");
  if (!context.runs.length) lines.push("  (no run linked)");
  for (const run of context.runs) {
    lines.push(`${run.run}  (${run.relation}${run.linked_at ? `, linked ${run.linked_at}` : ""})`);
    // A missing state.json is a dangling relation, `doctor`'s finding; one that is
    // there but cannot be read is a different fact, and both are said plainly.
    field("state", `${run.state_path}${run.state_available ? "" : existsSync(run.state_path) ? "  (unreadable)" : "  (missing)"}`);
    if (run.branch || run.base_sha) {
      field("branch", [run.branch ?? "(none recorded)", run.base_sha ? `base ${short(run.base_sha)}` : null].filter(Boolean).join("  "));
    }
    // Spec, tickets and acceptance are the run's own documents, kept in the run
    // directory after archival (§5.2): paths, not contents.
    if (run.spec) field("spec", present(run.spec));
    if (run.tickets) field("tickets", present(run.tickets));
    const acceptance = [run.acceptance.mapping, ...run.acceptance.reports].filter(Boolean);
    if (!acceptance.length) field("acceptance", "(none recorded)");
    acceptance.forEach((entry, index) => {
      if (index === 0) field("acceptance", present(entry));
      else lines.push(`${continuation()}${present(entry)}`);
    });
    if (run.acceptance.reviews_dir) field("reviews", run.acceptance.reviews_dir.path);
  }

  lines.push("", "# 3 adrs");
  if (!context.adrs.length) lines.push("  (no ADR reference recorded)");
  for (const adr of context.adrs) bullet(adr);

  lines.push("", "# 4 deliveries");
  if (!context.deliveries.length) lines.push("  (no run to deliver)");
  for (const delivery of context.deliveries) {
    if (delivery.state !== "delivered") {
      lines.push(`${delivery.run}  pending (no completion in ${delivery.source === "state.json" ? "state.json" : "the ledger"})`);
      continue;
    }
    lines.push(`${delivery.run}  delivered ${short(delivery.final_tip)}${delivery.delivered_at ? `  at ${delivery.delivered_at}` : ""}`);
    if (delivery.archived_at) field("archived", delivery.archived_at);
    const label = EVIDENCE_LABELS[delivery.evidence_status] ?? delivery.evidence_status;
    const evidence = delivery.evidence_status === "available"
      ? label
      : `${label}${delivery.evidence_note ? ` (${delivery.evidence_note})` : ""}`;
    field("evidence", `${delivery.evidence_dir ?? "(none recorded)"}  ${evidence}`);
    if (delivery.note) field("note", delivery.note);
  }

  lines.push("", "# 5 codegraph");
  if (!context.codegraph.symbols.length && !context.codegraph.paths.length) lines.push("  (no hint recorded)");
  if (context.codegraph.symbols.length) field("symbols", context.codegraph.symbols.join(", "));
  if (context.codegraph.paths.length) field("paths", context.codegraph.paths.join(", "));
  field("note", context.codegraph.note);

  if (context.retrospectives) {
    lines.push("", "# 6 retrospectives");
    if (!context.retrospectives.length) lines.push("  (no run to retrospect)");
    for (const retro of context.retrospectives) {
      if (retro.path) lines.push(`  ${retro.run}  ${retro.status ?? "recorded"}  ${present(retro.path)}`);
      else lines.push(`  ${retro.run}  ${retro.status ?? "none recorded"}`);
    }
  }
  if (context.pitfalls) {
    lines.push("", "# 6 pitfalls");
    if (!context.pitfalls.length) lines.push("  (no pitfall reference recorded)");
    for (const pitfall of context.pitfalls) bullet(pitfall);
  }
  if (context.history) {
    lines.push("", "# 6 history");
    const { changes, outcomes, superseded } = context.history;
    if (!changes.length && !outcomes.length && !superseded.length) lines.push("  (no history recorded)");
    for (const entry of changes) lines.push(`  ${[entry.date, entry.text].filter(Boolean).join("  ")}`);
    for (const outcome of outcomes) {
      lines.push(`  ${[outcome.date?.slice(0, 10), outcome.summary ?? "(no summary)"].filter(Boolean).join("  ")}` +
        `${outcome.commit_sha ? `  (outcome, commit ${short(outcome.commit_sha)})` : "  (outcome)"}`);
    }
    for (const entry of superseded) {
      lines.push(`  ${entry.run}  ${short(entry.final_tip)}  superseded${entry.superseded_at ? ` ${entry.superseded_at}` : ""}` +
        `${entry.reason ? `: ${entry.reason}` : ""}${entry.evidence_dir ? `  (evidence ${entry.evidence_dir})` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
