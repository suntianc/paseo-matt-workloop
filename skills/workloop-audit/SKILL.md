---
name: workloop-audit
description: Read-only health check of Workloop runs. Counts what each run's records show about its reviews, rework and delivery, and flags what the workflow's rules expect but the records contradict. Use at a run's retro, or when the user asks to check how the workflow is doing across runs.
---

# Workloop audit

Workloop's rules are partly enforced by its script and partly followed by agents. This skill reads the records a run leaves — `state.json`, `events.jsonl`, reviews, messages, reports and Git — and reports facts, so whether a rule held is checked rather than remembered. It never writes to a run, a repository or the requirement ledger, and the workflow runs the same without it.

`AUDIT` below means `node <this skill's directory>/scripts/audit.mjs`. It needs the `paseo-workloop` skill beside it, whose parser it uses to preserve the gates' raw report interpretation. Audit-only checks identify ambiguous cells without changing any execution gate. Runs live under `$WORKLOOP_ROOT` (default `~/.workloop`).

## One run: at retro

The [retro](../retro/SKILL.md) skill starts a run's assessment with `AUDIT run <project>/<feature>`. It prints:

- **Counts:** tickets, reviews, rework rounds, rounds past the cap, final review rounds, waivers by kind, failed and conflicting integrations, retries, takeovers, integration-check time, and ledger sync state. Raw gate-parsed blocking records are kept separately from records with an unambiguous Blocking cell; neither count establishes a semantic repair-failure rate.
- **Every blocking finding of every re-review, by where it lands:**
  - `carried` — the previous review blocked on the same ID: the fix fell short.
  - `in-change` — it names a line the change since the previous review touched: the fix broke something nearby, which the re-review method allows.
  - `late` — it names tracked code the change left alone. Check the actual brief, failing commands, acceptance evidence and assigned repairs before deciding whether it exceeded that round's method. Historical full reviews keep their original scope.
  - `outside-repo` — it names only files outside the repository, such as run-directory evidence, so where it lands cannot be checked.
  - `unplaced` / `unverifiable` — its location names no file, or a commit is gone.
  - `out` — outside the review boundary: a suggestion, which gates nothing.
- **Flags.** A `check` flag needs verification: a `late` finding under a retained narrowed brief, a confirmed rework answer missing `## Findings`, an ambiguous Blocking cell, a missed retrospective, an actual ledger sync difference/conflict, or leftover `scratch/`. An `info` flag is context, including historical or unknown review scope, an unconfirmed rework answer, and archive capacity above 200 MiB.
- **Capacity.** Sizes cover the whole run, deduplicate hard links by inode where available, and label logical and allocated MiB separately. The largest entries are children of the run root. Named retention/cleanup records are pointers to inspect, not automatic proof of necessity or deletion permission. Capacity alone says nothing about references, deletability or reclaimable space.

Answer each `check` flag in the retro with its cause or why it was expected. Read the original report and the brief that applied then; distinguish a confirmed contradiction, an explained fact and an audit false positive. Keep these human conclusions separate from raw script counts.

A send snapshots whatever report already exists. An interrupted turn may leave the old candidate's report unchanged. The audit follows continuations until a new rework begins and looks for an updated completed report, checking recorded turn completion when available. The candidate SHA may stay the same for an evidence-only answer. If an answer cannot be established, report that uncertainty as context rather than a missing-method violation.

Ledger checks use the requirement ledger's pure delivery/sync functions. A cancelled archive whose expected delivery is `pending` needs no `archived_at`; `changes: []` means there is nothing to sync. A frozen archived-SHA conflict requires investigation, not a promise that rerunning sync will fix it.

## Across runs: when the user asks

When the user asks how the workflow is doing, run the check in a session that did not orchestrate the runs it judges — a separate agent, so no orchestrator grades its own work.

1. `AUDIT all` for the counts across runs, the change since the last saved check, and every `check` flag. Add `--project <name>` to narrow it.
2. **Verify before concluding.** Read the records behind every `check` flag and sample each nonempty category. For review scope, use the brief issued for that round. For capacity, inspect actual files, report references, retention decisions and later cleanup receipts before suggesting any exact cleanup. For `carried`, compare both rows: old IDs may have been reused. A cell such as `yes → fixed` is ambiguous even though the gate parser counts it; exclude it from failed-rework conclusions until manually resolved. Say how many items you checked and how many held.
3. Write the result for the user: raw counts, manual findings, explained items and false positives, with evidence. Compare with the last saved check and `$WORKLOOP_ROOT/.workloop-audit/baseline.md` when present, separating compatible measurements from changed counting rules. Older snapshots count ambiguous cells and hard links differently; their category shares are not a like-for-like trend. Suggestions are the user's to decide; change nothing.
4. When the user accepts the result, `AUDIT all --save` keeps it as the point the next check compares against.

`AUDIT run` prints a reminder once three or more runs have finished since the last saved check. Retro passes it to the user; it is a suggestion, not a schedule.

## Limits

- Where a finding lands is read from its `Location` cell. A vague location is `unplaced`, and a finding about run-directory evidence is `outside-repo`; neither is guessed.
- IDs identify a finding across rounds only in reviews whose brief asked for unique IDs. Older `carried` counts include reused IDs, and the output says how many.
- A confirmed answer's `## Findings` section records the method; assess execution from the report and the next review. Missing turn/report evidence stays unconfirmed.
- Standard Blocking values are `yes` and `no — fixed`. Noncanonical gate-positive values are format questions, not automatically unresolved defects. Execution gates remain unchanged.
