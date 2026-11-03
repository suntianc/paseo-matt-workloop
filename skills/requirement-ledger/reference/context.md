# Context

`context` assembles what an agent needs before designing work on an existing requirement: the requirement itself, and pointers to everything that delivered it. It returns pointers; reading them is the agent's job, at the moment it needs them.

```
node scripts/req.mjs context <REQ> [--json] [--include <sections>]
```

## Reply order

1. The requirement's current summary, scope and recent changes, from its own file.
2. Each linked run's spec, tickets and acceptance results, as paths. A run directory survives archival.
3. Valid ADRs from `refs.adr`. A reference that no longer resolves is marked dangling rather than dropped.
4. For delivered runs: the final delivery SHA and the evidence directory.
5. CodeGraph hints from `refs.codegraph` — `symbols` and `paths`. Whether to run a query is the agent's call.
6. Retrospectives, pitfalls and superseded ADRs, when the question reaches back that far.

A reference resolves the same way here and in `doctor`: an explicit or repository-relative path; `<dir>/<name>` or `<dir>/<name>.md` under the kind's directory (`docs/adr/` or `docs/pitfalls/`); or a unique `<name>-*.md` there, tried only when no page is exactly `<name>.md`; or, for a pitfall, the slug of a heading on one of its pages. An exact page name wins over a prefix sibling, and several files matching on the same rule is a question, reported as dangling rather than answered by choosing.

## On-demand sections

The reply stops at step 5 unless `--include` names what to add: `retro` appends each run's retrospective pointer, `pitfalls` the pitfalls the record cites, and `history` its prose changes, Quick outcomes and any delivery a reopened run superseded. Names are comma- or space-separated and may come in any order; an unknown name is refused rather than ignored.

```
node scripts/req.mjs context REQ-001 --include retro,history
```

## Three delivery states

A run's delivery is read from its `state.json`, and nothing else. Three states look alike and mean different things:

| State | Read from `state.json` | What context says |
|---|---|---|
| **Finished, not archived** | `completion` present, `finishedAt` empty | `delivered`, with `evidence_dir` marked *awaiting archive*. An `evidence/index.json` that does not exist yet does not make the delivery a failure, and does not make it history. |
| **Archived, evidence present** | `finishedAt` present and `evidence/index.json` present | `delivered`, with `archived_at` and `evidence_dir`. |
| **Archived, evidence missing** | `finishedAt` present, evidence absent or unreadable | `delivered`, with `evidence_available: false`. Reported, never invented. |

`finish` writes `completion`; `archive` writes `finishedAt`. A run can be delivered for a long time before it is archived, and that interval is normal.

**Legacy runs.** Workloop before `completion` existed archived a run without recording an accepted version. Such a run has `finishedAt` but neither `completion` nor `archiveStartedAt`, which every archive since then writes first. When every ticket is `done` and `integration.tip` moved past `baseSha`, archive froze that tip, so it is the delivery: `final_tip` is `integration.tip`, `delivered_at` is `lastIntegratedAt`, and the delivery carries `basis: legacy-integration-tip`. A legacy run with a cancelled ticket, or with nothing integrated, stays `pending`.

## No worktree required

Archival deletes the run's worktree, its branch and its agent sessions, and keeps the run directory, `state.json`, `events.jsonl`, `evidence/` and the retrospective. Context therefore never assumes a historical worktree still exists: it cites the state file, the commit SHAs, the branch name, the spec path and the evidence directory.

## CodeGraph hints

The ledger stores `symbols` and `paths` as search hints and nothing more — no graph, no cached code. The agent queries CodeGraph live, and treats the index as possibly stale: the current worktree is the truth. Historical technical decisions stay with the ADRs and the document mechanism that owns them.
