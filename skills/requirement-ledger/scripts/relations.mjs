// The requirement side of the Workloop connection: which record a run is written
// into, the single-primary rule, the unfinished correction that leaves two, and
// the delivery snapshot `sync` maintains. Pure functions over frontmatter — the
// filesystem and the project lock belong to the commands, so these can be read
// and tested without either.
import { nowIso } from "./time.mjs";

export const runsOf = (frontmatter) => (Array.isArray(frontmatter?.runs) ? frontmatter.runs : []);
export const outcomesOf = (frontmatter) => (Array.isArray(frontmatter?.outcomes) ? frontmatter.outcomes : []);

const isRun = (run) => typeof run?.project === "string" && typeof run?.feature === "string";
const sameRun = (run, project, feature) => isRun(run) && run.project === project && run.feature === feature;

// ---------------------------------------------------------------- primaries

// Every requirement that claims this run as its primary, in id order. More than
// one is the ambiguous state below, not a set to choose from.
export function primaryHolders(requirements, project, feature) {
  const ids = [];
  for (const requirement of requirements) {
    const id = requirement?.frontmatter?.id;
    if (!id || requirement.error) continue;
    if (runsOf(requirement.frontmatter).some((run) => sameRun(run, project, feature) && run.relation === "primary") && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids.sort();
}

// §6.5, named once: while one run is the primary of two records, `link --correct`
// did not finish. This is the predicate `doctor` (check 4), `context`, `lookup` and
// the guards in `link`/`sync` all ask, and they must not answer it differently.
export function ambiguousRuns(requirements) {
  const owners = new Map();
  for (const requirement of requirements) {
    const id = requirement?.frontmatter?.id;
    if (!id || requirement.error) continue;
    for (const run of runsOf(requirement.frontmatter)) {
      if (!isRun(run) || run.relation !== "primary") continue;
      const key = `${run.project}/${run.feature}`;
      const ids = owners.get(key) ?? [];
      if (!ids.includes(id)) ids.push(id);
      owners.set(key, ids);
    }
  }
  const ambiguous = new Map();
  for (const [key, ids] of owners) if (ids.length > 1) ambiguous.set(key, ids.sort());
  return ambiguous;
}

export const isAmbiguous = (requirements, project, feature) => ambiguousRuns(requirements).has(`${project}/${feature}`);

// The ambiguous runs one record holds, with the other requirements that also hold
// them: `show` and `list` keep reading (§6.5), but they say which run is in doubt
// instead of presenting its ownership as settled.
export function ambiguousIn(frontmatter, ambiguous) {
  return runsOf(frontmatter)
    .filter((run) => isRun(run) && ambiguous.has(`${run.project}/${run.feature}`))
    .map((run) => {
      const key = `${run.project}/${run.feature}`;
      return { key, also: ambiguous.get(key).filter((id) => id !== frontmatter?.id) };
    });
}

// ---------------------------------------------------------------- writing a relation

// A new relation opens a pending delivery: `base_sha` is the commit the run
// started from, and nothing is delivered until `state.completion` exists.
export const newRelation = ({ project, feature, baseSha, now = nowIso() }) => {
  const relation = { project, feature, relation: "primary", base_sha: baseSha, linked_at: now, delivery: { state: "pending" } };
  return relation;
};

// One entry per run: adding a relation the record already holds replaces it in
// place rather than stacking a second one.
export function withRelation(frontmatter, relation) {
  const runs = runsOf(frontmatter);
  const kept = runs.filter((run) => !sameRun(run, relation.project, relation.feature));
  return { ...frontmatter, runs: [...kept, relation] };
}

export function withoutRelation(frontmatter, project, feature) {
  return { ...frontmatter, runs: runsOf(frontmatter).filter((run) => !sameRun(run, project, feature)) };
}

export const relationIn = (frontmatter, project, feature) =>
  runsOf(frontmatter).find((run) => sameRun(run, project, feature)) ?? null;

// ---------------------------------------------------------------- delivery

const isDelivered = (delivery) => delivery?.state === "delivered" && typeof delivery.final_tip === "string" && Boolean(delivery.final_tip);

// A superseded delivery keeps what it was, plus when and why it stopped being the
// current one. Append-only: nothing already in the history is rewritten.
function snapshot(delivery, { now, reason }) {
  const entry = { final_tip: delivery.final_tip, delivered_at: delivery.delivered_at };
  if (delivery.archived_at) entry.archived_at = delivery.archived_at;
  if (delivery.evidence_dir) entry.evidence_dir = delivery.evidence_dir;
  entry.superseded_at = now;
  entry.reason = reason;
  return entry;
}

// One sync applied to one run's relation: the delivery `state.json` describes, and
// the changes that forces. No changes means the record already agrees, which is
// what makes a repeated sync write nothing at all.
//
//  - a delivery already recorded with the same tip is filled in, never rewritten
//    (`archived_at` and the evidence directory may still be missing after finish);
//  - an archived delivery is frozen: `final_tip` never moves, so a disagreement is
//    reported as `conflict` instead of overwriting it;
//  - a completion that disappeared, or a different one before any sync saw the
//    last, supersedes the recorded snapshot into `delivery_history[]`.
export function syncDelivery(relation, target, { now = nowIso(), reason = "completion cleared" } = {}) {
  const current = relation.delivery && typeof relation.delivery === "object" ? relation.delivery : { state: "pending" };
  const history = Array.isArray(relation.delivery_history) ? [...relation.delivery_history] : [];
  const applied = (delivery, changes) => ({ relation: { ...relation, delivery, delivery_history: history }, changes });

  if (target.state === "delivered") {
    if (isDelivered(current) && current.final_tip === target.final_tip) {
      // After archive this only fills what is missing; it never moves the SHA.
      const filled = {};
      for (const field of ["archived_at", "evidence_dir"]) {
        if (!current[field] && target[field]) filled[field] = target[field];
      }
      if (!Object.keys(filled).length) return { relation, changes: [] };
      return applied({ ...current, ...filled }, Object.keys(filled));
    }
    if (isDelivered(current) && current.archived_at) {
      return { relation, changes: [], conflict: { recorded: current.final_tip, reported: target.final_tip } };
    }
    const changes = [];
    if (isDelivered(current)) {
      pushSnapshot(history, current, { now, reason });
      changes.push("superseded");
    }
    changes.push("delivered");
    return applied({ ...target }, changes);
  }

  // No completion in state.json: `delivered` falls back to `pending`.
  if (!isDelivered(current)) return { relation, changes: [] };
  pushSnapshot(history, current, { now, reason });
  return applied({ state: "pending" }, ["superseded", "pending"]);
}

// Append-only, and the same old snapshot is not recorded twice: identity is the
// delivery SHA together with the moment it was superseded.
function pushSnapshot(history, delivery, options) {
  const entry = snapshot(delivery, options);
  if (history.some((old) => old?.final_tip === entry.final_tip && old?.superseded_at === entry.superseded_at)) return history;
  history.push(entry);
  return history;
}

// ---------------------------------------------------------------- outcomes

// A Quick delivery: the date, what changed, and — only when it can be checked —
// the commit. No run is created, and none is implied.
export function newOutcome({ summary, commitSha = null, verification = null, now = nowIso() }) {
  const outcome = { date: now, summary };
  if (commitSha) outcome.commit_sha = commitSha;
  if (verification) outcome.verification = verification;
  return outcome;
}

export const withOutcome = (frontmatter, outcome) => ({ ...frontmatter, outcomes: [...outcomesOf(frontmatter), outcome] });

// What a correction is trying to do, recorded before either file moves so a retry
// can converge on it (`{op:"correct", run, from, to, reason}`).
export function lastCorrection(entries, runKey) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry && !entry.unreadable && entry.op === "correct" && entry.run === runKey) return entry;
  }
  return null;
}
