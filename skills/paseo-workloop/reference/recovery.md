# Recovery

Use this after a crash, a restart, a lost session, or any time you're unsure of the state. Reconcile first and act second. Never dispatch on the strength of state you haven't checked.

## Steps

### 1. Run `WL status --live`

For notification-based runs, first inspect any pending MCP action with `WL action NN` and recover its receipt using [async-supervision.md](async-supervision.md). Do not repeat an unacknowledged create/send call. After reconciling, run `WL watch` to restore the fallback wake-up. Notification subscriptions must be re-established or verified after a daemon restart; parentage alone is not a receipt.

`watch` also reconciles its heartbeat ID ledger. A failed deletion retains IDs for the next attempt. If creation has no acknowledged ID and the daemon's local store is unavailable, it stops creating heartbeats until you provide the actual receipt ID with `watch --heartbeat-id <id>`. An empty `paseo schedule ls` is never evidence of successful heartbeat cleanup. See the heartbeat recovery section in the async supervision reference for upgrade and remote-host limits.

It compares the run state with Paseo and with git, and warns about three things.

**An agent that carries the run's labels but isn't recorded.**

- *Cause:* a dispatch was interrupted after `agent run` but before the state was saved.
- *Fix:* For a prepared MCP action, recover the existing worker's ID and acknowledge its receipt. For legacy CLI dispatches, `WL dispatch <NN>` adopts the existing agent instead of starting a second one. Do not mix these recovery paths.

**A running or in-review task whose worktree has gone.**

- *Fix:* Reconcile the path first. If the tree cannot be recovered, use `WL retry <NN> --new-worktree --reason "<evidence>"`; the old attempt remains recorded.

**The integration worktree isn't at the recorded tip.**

- *Look first:* run `git log --oneline <tip>..HEAD` in the integration worktree.
- *If it shows only the `workloop: integrate #NN` merge of a ticket that's still `in_review`:* an `integrate` was interrupted after merging but before recording. Run `git reset --hard <recorded tip>` in the integration worktree, then `WL integrate <NN>` again. The candidate is still on the task's branch, so nothing is lost.
- *If it shows anything else:* something outside the run wrote to the integration branch. Stop and ask the user. Don't reset it.

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

### 4. Leftover `.lock` files

A `.lock` left by a crashed command is taken over automatically once the process that held it has gone.

## The run directory

The run directory is `$WORKLOOP_ROOT/<project>/<feature>/`:

| Path | What it holds |
|---|---|
| `state.json` | The source of truth. Only the script writes it, atomically. Don't hand-edit it; if it's wrong, tell the user. |
| `events.jsonl` | An audit log with one line per state change. It explains how the state was reached. |
| `briefs/` | What each executor and reviewer was told. |
| `reports/` | What each executor reported. |
| `reviews/` | The reviewers' reports. |
| `messages/` | Every message you sent to an executor. |
| `integration/` | The integration worktree. `archive` removes it. |
| `final-review.md` | Your final review. |

Session transcripts and the agent/attempt index live under `evidence/`; retrospective outputs live under `retros/`. They remain after archival.
