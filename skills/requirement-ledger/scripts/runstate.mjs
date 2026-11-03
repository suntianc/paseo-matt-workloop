// The ledger's only contact with Workloop. It reads a run's `state.json` — and,
// for the reason a delivery was superseded, its `events.jsonl` — and says what
// that run's delivery is. Read only: nothing here writes, and Workloop is never
// asked twice about the same fact (`status --json` has no `baseSha` and prints
// short SHAs, so the file is read directly).
//
// Workloop's own helpers are not imported because it does not export them
// (`workloopRoot` / `runLocation`, workloop.mjs:345–353); the root rule is
// `store.mjs`'s copy of it, so the ledger has one definition, not two.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { workloopRoot } from "./store.mjs";

export class RunError extends Error {
  constructor(message, code = "run") {
    super(message);
    this.name = "RunError";
    this.code = code;
  }
}

// The commands that clear `state.completion` and reopen a run (workloop.mjs:378).
// Copied, not imported, for the same reason as the root: Workloop keeps it private.
export const CLEARS_COMPLETION = [
  "import", "config", "decisions", "worktree", "prepare", "dispatch", "send", "freeze", "review", "integrate", "retry", "cancel",
];

const NAME = /^[a-z0-9][a-z0-9-]*$/;

// A run is addressed the way `--run` addresses it, `<project>/<feature>`. The
// concatenated runKey is never split back apart: both halves contain hyphens, so
// the split is ambiguous.
export function parseRunKey(text) {
  const trimmed = String(text ?? "").trim();
  const parts = trimmed.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new RunError(`a run is addressed as <project>/<feature>, not ${JSON.stringify(trimmed)}`, "usage");
  }
  const [project, feature] = parts;
  for (const [label, value] of [["project", project], ["feature", feature]]) {
    if (!NAME.test(value)) {
      throw new RunError(
        `${label} ${JSON.stringify(value)} is not a usable Workloop name: lowercase letters, digits and dashes, starting with a letter or digit`,
        "usage",
      );
    }
  }
  return { project, feature };
}

export const runKeyOf = (project, feature) => `${project}/${feature}`;

// The run directory is `<WORKLOOP_ROOT>/<project>/<feature>`, exactly where
// `init` puts it. It is also where a run's retained documents and its evidence
// live, so a reader that must name them still needs it after `state.json` is gone.
export const runDirOf = (project, feature) => join(workloopRoot(), project, feature);

// Its absence is a wrong address or an uninitialised run, and either way there is
// nothing to read.
export function readRun({ project, feature }) {
  const dir = runDirOf(project, feature);
  const path = join(dir, "state.json");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new RunError(error.code === "ENOENT"
      ? `no run at ${path}: Workloop has not initialised ${runKeyOf(project, feature)} (WL init), or the run directory has moved`
      : `${path} cannot be read (${error.message})`);
  }
  let state;
  try {
    state = JSON.parse(text);
  } catch (error) {
    throw new RunError(`${path} is not readable JSON (${error.message}); the ledger reports it rather than guessing at the run`);
  }
  if (state === null || typeof state !== "object" || Array.isArray(state)) throw new RunError(`${path} does not hold a run state object`);
  return { dir, path, state };
}

// `state.evidence = { completion, capturedAt, path }` (`workloop.mjs:2735`); the
// ledger records the directory beside the index, and does not check that it still
// exists — that is `context`'s and `doctor`'s separate question.
function evidenceDirOf(state) {
  const path = state?.evidence?.path;
  return typeof path === "string" && path ? dirname(path) : null;
}

// What the ledger may say about this run's delivery, taken only from Workloop:
//
//   - delivered if `state.completion` exists, or the run is a legacy delivery (below);
//   - `final_tip` / `delivered_at` are `completion.tip` / `completion.at`;
//   - `archived_at` is `state.finishedAt` (a misnomer of Workloop's; `status --json`
//     reports the same field as `archivedAt`, workloop.mjs:2899).
//
// `integration.tip` is otherwise never consulted: it is a working tip that moves
// with every integrate, not an accepted version.
export function deliveryFrom(state) {
  const completion = state?.completion;
  if (completion === null || completion === undefined) return legacyDeliveryFrom(state) ?? { state: "pending" };
  if (typeof completion !== "object" || typeof completion.tip !== "string" || !completion.tip) {
    throw new RunError("state.completion has no tip: the run's delivery cannot be read, and recording it as pending would lose a delivery");
  }
  const delivery = { state: "delivered", final_tip: completion.tip, delivered_at: typeof completion.at === "string" ? completion.at : "" };
  if (typeof state.finishedAt === "string" && state.finishedAt) delivery.archived_at = state.finishedAt;
  const evidence = evidenceDirOf(state);
  if (evidence) delivery.evidence_dir = evidence;
  return delivery;
}

// The basis a legacy delivery records, so a reader can tell it from a completion.
export const LEGACY_BASIS = "legacy-integration-tip";

// Workloop before `completion` existed recorded no accepted version: its archive
// wrote `finishedAt` and left the delivery as `integration.tip`. Such a run is
// recognised by three facts of its own state.json — archived, no completion, and
// no `archiveStartedAt`, which every archive since then writes before `finishedAt`
// (workloop.mjs `cmdArchive`) — so a current run is never read this way. Archive
// froze the tip, and it counts as delivered only when every ticket was integrated
// and the tip moved past the base; a run with a cancelled ticket stays pending.
function legacyDeliveryFrom(state) {
  if (typeof state?.finishedAt !== "string" || !state.finishedAt || state.archiveStartedAt) return null;
  const tip = state.integration?.tip;
  if (typeof tip !== "string" || !tip || tip === state.baseSha) return null;
  const tasks = state.tasks && typeof state.tasks === "object" ? Object.values(state.tasks) : [];
  if (!tasks.length || !tasks.every((task) => task?.status === "done")) return null;
  return {
    state: "delivered",
    final_tip: tip,
    delivered_at: typeof state.lastIntegratedAt === "string" ? state.lastIntegratedAt : "",
    archived_at: state.finishedAt,
    basis: LEGACY_BASIS,
  };
}

// The last Workloop command that reopened the run, for the `reason` a superseded
// snapshot carries ("reopened by integrate"). Read from `events.jsonl`, which is
// Workloop's own record of what happened; `null` when the file is gone or silent.
export function clearingEvent(dir) {
  let text;
  try {
    text = readFileSync(join(dir, "events.jsonl"), "utf8");
  } catch {
    return null;
  }
  let kind = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (CLEARS_COMPLETION.includes(event?.kind)) kind = event.kind;
    } catch {
      // A torn line is Workloop's business; the last readable one still stands.
    }
  }
  return kind;
}

export const supersedeReason = (dir) => {
  const kind = clearingEvent(dir);
  return kind ? `reopened by ${kind}` : "completion cleared";
};
