# Authorization and the Workloop boundary

## Zero core change

The ledger is a sibling skill, `skills/requirement-ledger/`. Workloop's state machine and core commands are not modified. The only edits it makes to existing files are pointers: a line in the workloop skill naming the lookup entry point, and a sentence in its run procedure where the workflow needs one. The upstream Matt Pocock skills are untouched.

## Who may change what

| Fact | Written by |
|---|---|
| A requirement's identity, summary, aliases and refs | the ledger, through its CLI or by a person editing human fields |
| Run, ticket, attempt, review, verdict, completion and archive time | Workloop only |
| Which requirement a run delivered, and that delivery's projection | the ledger, read from the run's `state.json` |

The ledger has no write path into Workloop: it never reopens, retries, retitles, cancels or archives a run.

## The main flow

```
the user states a requirement
  → lookup "<the request>"            evidence about which requirement this is
  → Main decides the owner, asking the user when it matters
  → Quick / Direct / Full as usual
      ├─ Quick:        note --outcome …              a lightweight record, no run
      └─ Direct/Full:  WL init …
                       link myapp/req-007-login REQ-007
                       … the run proceeds; Workloop owns its state …
                       sync myapp/req-007-login        after finish
                       sync myapp/req-007-login        after archive
```

## `link`

`req link <project>/<feature> <REQ>` records that this run delivers that requirement.

- **Idempotent.** Linking the same requirement to the same run again adds nothing.
- **Unique.** A run that already has a different valid primary requirement is refused.
- **Recoverable.** If `WL init` succeeded and the link failed, confirm the run exists and retry the link. Re-initialising is not the fix.
- **Reads `state.json` directly.** `status --json` carries no `baseSha`, and a task shows only a seven-character short SHA, so the link reads `state.json` for `baseSha` and records `delivery.state: pending`.
- **Never treats `integration.tip` as the delivery.** At init it is a working tip, not an accepted one.

A run is addressed as `<project>/<feature>`, the way Workloop's `--run` addresses it. The concatenated `runKey` is never parsed back apart, because both halves contain hyphens and the split is ambiguous.

## `sync`

`req sync <project>/<feature>` copies the run's authoritative delivery into the ledger, reading `state.json` and, when present, the evidence index.

- `delivered` if and only if `state.completion` exists.
- `final_tip` from `state.completion.tip`; `delivered_at` from `state.completion.at`.
- `archived_at` from `state.finishedAt`. The name is a leftover: this is the archive time, and `status --json` reports the same field as `archivedAt`.
- `evidence_dir` when it exists.
- **Idempotent.** An unchanged `final_tip` writes nothing. After archival a sync only fills `archived_at` and evidence; the final SHA never moves.

**Non-monotonic, with snapshots.** A dozen Workloop commands — `import`, `config`, `decisions`, `worktree`, `prepare`, `dispatch`, `send`, `freeze`, `review`, `integrate`, `retry` and `cancel` — clear `state.completion`, which reopens the run. The ledger must follow: `delivered` falls back to `pending`, and a delivery that was already verified is not thrown away.

- The old `{final_tip, delivered_at, archived_at}` moves into `delivery_history[]` with `superseded_at` and a `reason` such as `reopened by integrate`.
- The current delivery returns to `pending`, with no `final_tip` and no `delivered_at`.
- History is append-only. Re-syncing the same old snapshot does not add it twice: entries are deduplicated by `final_tip` and `superseded_at`.
- After archival the window closes. Workloop refuses its own commands and freezes `completion`, so `delivered` and the final SHA stop moving.

**`finish` followed by `sync` is one step, not two.** A snapshot can only preserve what a sync has seen: `finish`, then no sync, then `import` leaves the ledger with nothing to move into history, and only verifiable Workloop evidence (the retained `state.json`, `events.jsonl`, a commit SHA) can restore it. That is why the sync after `finish` is a fixed step rather than a tidying-up.

## `note`

`req note <REQ> [--outcome]` records a Quick delivery — date, summary, an optional `commit_sha` that must really exist, and how it was verified — or a free-form note. It creates no run and fabricates none. Work that is not going to be tracked does not get a requirement created just to have somewhere to write it.

## Correcting a wrong relation

A plain `link` refuses to give a run a second primary requirement. The one way to move a run from `REQ-A` to `REQ-B` is:

```
req link myapp/req-007-login REQ-B --correct --reason "<why>"
```

Two Markdown files cannot change atomically, so the order is fixed: **add the new relation first, remove the old one second**. An interruption then leaves the run attached to both requirements — visible, reported by `doctor`, and converged by retrying — and never attached to neither, which nothing would notice.

The intent is recorded in `_log.jsonl` as `{op: "correct", run, from, to, reason}` before either file moves. A retry reads it, skips the add when the new relation is already present, skips the remove when the old one is gone, and converges on one primary relation.

Correction moves metadata only. It never touches the run's execution facts, its acceptance results or its delivery SHA, including for a run that has already delivered.

## Double primary means ambiguous

While a correction is unfinished, a run can be the primary requirement of two records. That state is a question the ledger must not answer by choosing:

- `context`, `sync` and `link` **refuse to run**, and report that a `link --correct` is unfinished and how to converge it.
- `show`, `list`, `doctor` and `lookup` still read, and mark the run `ambiguous: true`. Nothing is inferred from its ownership.
- `doctor` reports it under check 4. Converging the relation from the logged intent clears it.

## What the ledger never does

- Execute, schedule or delegate work, own a run state machine, or compete with Workloop for task state.
- Edit Workloop state, its events, its verdicts or a delivery SHA.
- Copy the body of an ADR, spec, review or retrospective into the ledger.
- Push, open a pull request, merge or deploy.
- Answer an ambiguous ownership question by picking one.
