# Recovery

Use this after a crash, a restart, a lost session, or any time you're unsure of the state. Reconcile first and act second. Never dispatch on the strength of state you haven't checked.

## Steps

### 1. Run `WL status --live`

For notification-based runs, first inspect any pending MCP action with `WL action NN` and recover its receipt using [async-supervision.md](async-supervision.md). Do not repeat an unacknowledged create/send call. After reconciling, run `WL watch` to restore the fallback wake-up. Notification subscriptions must be re-established or verified after a daemon restart; parentage alone is not a receipt.

`watch` also reconciles its heartbeat ID ledger. A failed deletion retains IDs for the next attempt. If creation has no acknowledged ID and the daemon's local store is unavailable, it stops creating heartbeats until you provide the actual receipt ID with `watch --heartbeat-id <id>`. An empty `paseo schedule ls` is never evidence of successful heartbeat cleanup. See the heartbeat recovery section in the async supervision reference for upgrade and remote-host limits.

It compares the run state with Paseo and with git, and warns about these things.

**An interrupted check phase** (`interrupted check phase: integrate on #NN` or `… finish`).

- *Cause:* an `integrate` or `finish` process died while its checks ran, so its result was never recorded.
- *Fix:* rerun the command it names. It first stops whatever is left of that phase's check (its process group on POSIX, its process tree on Windows), so an orphaned check cannot write to the integration worktree afterwards. A recorded pid is signalled only after its command line confirms it is still that check; a pid now used by something else is left alone. On POSIX, a check's process group that outlived its wrapper is still the check's and is stopped too; on Windows, processes left by a wrapper that died on its own cannot be reached. If the stop fails or cannot be confirmed, the command refuses, keeps the phase, and names the process group or pid and the error: stop it yourself, then rerun the command, or ask the user. If the check's pid is alive but its identity cannot be read, the command refuses, changes nothing and names the pid: stop and ask the user to inspect it. A daemon the check detached from its group is not stopped (see the time limit in [run.md](run.md)). `WL integrate <NN>` then resets the integration worktree from the merge that phase left to the tip before it, then integrates from the start; the candidate is still on the task's branch, so nothing is lost. If the worktree is anywhere else, `integrate` refuses: something outside the run wrote to the integration branch, so stop and ask the user. `WL finish` simply runs again, because finish changes nothing in Git. Until you recover it, every command except the read-only and bookkeeping ones (and `config`, should the checks themselves need changing first) refuses and names this command.

**An agent that carries the run's labels but isn't recorded.**

- *Cause:* a dispatch was interrupted after `agent run` but before the state was saved.
- *Fix:* For a prepared MCP action, recover the existing worker's ID and acknowledge its receipt. For legacy CLI dispatches, `WL dispatch <NN>` adopts the existing agent instead of starting a second one. Do not mix these recovery paths.

**A running or in-review task whose worktree has gone.**

- *Fix:* Reconcile the path first. If the tree cannot be recovered, use `WL retry <NN> --new-worktree --reason "<evidence>"`; the old attempt remains recorded.

**The integration worktree isn't at the recorded tip.**

- *Look first:* run `git log --oneline <tip>..HEAD` in the integration worktree.
- *With an interrupted check phase reported:* recover that phase as above; `integrate` handles the reset.
- *Otherwise:* something outside the run wrote to the integration branch. Stop and ask the user. Don't reset it.

### 2. Check each running task's agent

Run `paseo agent inspect <agentId>` and act on what it shows:

- **Running:** arm `WL watch` and end the turn; use the completion notification. Use a bounded patrol only for diagnosis.
- **Idle:** handle it as patrol would; the report tells you what happened.
- **Error:** inspect the actual cause and recover the original session where possible, then `WL send`. A temporary error is not a reason to create a new tree.
- **Unrecoverable session:** after old workers are stopped, `WL retry <NN> --reason "<why>"` replaces the executor but keeps its branch/worktree, including uncommitted changes. Add `--file <handoff>` for context the reports do not carry. Then dispatch the new attempt.
- **Unusable worktree:** add `--new-worktree` to retry, with the reason. Inspect the preserved old work before carrying it forward.

Ordinary review rework uses `send` to the same executor. A defect found after integration is a new repair ticket, new session and new worktree; the completed executor stays as evidence.

### 3. Finish and archive

A done ticket with no cleanup time is normally waiting for the whole run's retrospective, not an interrupted cleanup. `finish` validates delivery and retains sessions. Record retro findings or a brief skip reason, then `archive` captures transcripts and cleans up together.

If archive was interrupted, rerun `WL archive`. It reuses the saved evidence and resumes cleanup. Existing guards protect dirty and unmerged work; cancelled/replaced worktrees are retained for a separate decision while their sessions are archived. Read the retained-path list before deleting anything manually.

### 4. A final review in flight

A full run's verdict belongs to an independent final reviewer. Its current round lives in state as `finalReview`, and earlier rounds in `finalReviews`.

- **A pending final review request.** `WL action final` prints it and `WL ack final --receipt -` (the MCP response on stdin) or `--receipt <file>` records the receipt. Other work refuses until it is reconciled, so do that before preparing another round. To recover a lost receipt, look for an agent carrying the round's labels (`paseo agent ls --label task=final --label attempt=r<round>`) in the round's worktree, and reconcile its id first.
- **A prepare interrupted before its state was saved.** The round's branch is deterministic (`wl-<feature>-final-<round>`), so rerunning `WL final-review --prepare` adopts the worktree it left. A worktree at another commit is refused and named: inspect it, don't reset it.
- **A final reviewer that cannot continue.** Once it is idle, `WL final-review --prepare --again` starts another round for the same tip. The old session, report and worktree stay for the record and for evidence.
- **The tip moved after a round.** The old report is for the old tip and no longer counts. Prepare again without `--again`; the run needs a new verdict for the new tip. Never hand-edit state.
- **A stale or missing report.** `WL status` names what is missing: the mapping, the round, the report, repairs or waivers. Waiving is `WL final-review --waive <IDs> --reason "<why>"`, and only for blocking findings of the current report.

### 5. Leftover `.lock` files

A `.lock` left by a crashed command is taken over automatically once the process that held it has gone.

## The run directory

The run directory is `$WORKLOOP_ROOT/<project>/<feature>/`:

| Path | What it holds |
|---|---|
| `state.json` | The source of truth. Only the script writes it, atomically. Don't hand-edit it; if it's wrong, tell the user. |
| `events.jsonl` | An audit log with one line per state change. It explains how the state was reached. |
| `briefs/` | What each executor and reviewer was told. |
| `reports/` | What each executor reported. |
| `reviews/` | The reviewers' reports, including the final reviewer's `final-<round>-<tipShort>.md`. |
| `messages/` | Every message you sent to an executor. |
| `integration/` | The integration worktree. `archive` removes it. |
| `final-review.md` | Your acceptance mapping: the claims the final reviewer verifies. |

Session transcripts and the agent/attempt index live under `evidence/`; retrospective outputs live under `retros/`. They remain after archival.
