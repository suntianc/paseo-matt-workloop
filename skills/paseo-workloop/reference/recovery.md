# Recovery

Use this after a crash, a restart, a lost session, or any time you're unsure of the state. Reconcile first and act second. Never dispatch on the strength of state you haven't checked.

## Steps

### 1. Run `WL status --live`

It asks Rex about each task's current agent (`running`, `idle`, `error:<code>`, `closed`, `missing`) and compares the run state with git, and warns about the things below. Then arm `WL wait` in the background again if any turn is running: after a restart nothing else will wake you. See [async-supervision.md](async-supervision.md) for turns, tabs and `wait`.

**An interrupted check phase** (`interrupted check phase: integrate on #NN` or `… finish`).

- *Cause:* an `integrate` or `finish` process died while its checks ran, so its result was never recorded.
- *Fix:* rerun the command it names. It first stops whatever is left of that phase's check (its process group on POSIX, including one that outlived its wrapper, its process tree on Windows), so an orphaned check cannot write to the integration worktree afterwards; a recorded pid is signalled only after its command line confirms it is still that check, and a daemon the check detached from its group is not stopped (see the time limit in [run.md](run.md)). If the stop fails, the command refuses, keeps the phase and names the process group or pid and the error: stop it yourself, then rerun, or ask the user. If the check's pid is alive but its identity cannot be read, it refuses, changes nothing and names the pid: stop and ask the user to inspect it. `WL integrate <NN>` then resets the integration worktree from the merge that phase left to the tip before it, then integrates from the start; the candidate is still on the task's branch, so nothing is lost. `WL finish` simply runs again, because finish changes nothing in Git. Until you recover it, every command except the read-only and bookkeeping ones (and `config`, should the checks themselves need changing first — an interrupted phase admits it, a live one refuses it) refuses and names this command.

**A tab in the run's Rex session that the run did not record.**

- *Cause:* a command was interrupted after it opened the tab but before it saved state.
- *Fix:* stop that tab's turn (Ctrl-C) and close it, then run the command again. A task left `running` with no executor recorded is dispatched again by `WL dispatch <NN>`, which adopts the worktree the interrupted dispatch made.

**A running or in-review task whose worktree has gone.**

- *Fix:* Reconcile the path first. If the tree cannot be recovered, use `WL retry <NN> --new-worktree --reason "<evidence>"`; the old attempt remains recorded.

**The integration worktree isn't at the recorded tip.**

- *Look first:* run `git log --oneline <tip>..HEAD` in the integration worktree.
- *With an interrupted check phase reported:* recover that phase as above; `integrate` handles the reset.
- *Otherwise:* something outside the run wrote to the integration branch. Stop and ask the user. Don't reset it.

### 2. Check each running task's agent

`WL status --live` shows each one; act on it:

- **running:** arm `WL wait` in the background and end the turn.
- **idle:** its turn ended; the report tells you what happened (`WL wait` prints it at once).
- **error:<code>** or **closed:** read the turn's log (`turns/<agent>-<n>.log`) for the actual cause and go on in the same conversation where possible with `WL send`. A temporary error is not a reason to create a new tree.
- **Unrecoverable conversation** (the CLI lost it, or the turn left no conversation id): once no turn of it runs, `WL retry <NN> --reason "<why>"` replaces the executor but keeps its branch/worktree, including uncommitted changes. Add `--file <handoff>` for context the reports do not carry. Then dispatch the new attempt.
- **Unusable worktree:** add `--new-worktree` to retry, with the reason. Inspect the preserved old work before carrying it forward.

Ordinary review rework uses `send` to the same executor. A defect found after integration is a new repair ticket, new agent and new worktree; the completed executor stays as evidence.

### Platform or safety interruption

A platform refusal is an interrupted operation, not a code-review verdict. Preserve the exact error and its step/tool identifier when supplied. If the platform does not identify the action, record that uncertainty. Keep the same conversation and settings; do not disguise rejected work or change models/providers to evade the restriction.

First request a diagnostic handoff using [the interruption template](../templates/interruption-handoff.md): completed commands and their real exits, durable log/receipt paths, first failures, unfinished criteria, observations separated from confirmed reproductions, and owned processes still running. Capture temporary logs before their workspace can disappear. A later success does not overwrite a failed occurrence.

Assess whether a narrower, permitted scope can continue ordinary existing checks and source inspection. Leave the refused or uncertain experiment paused. If the required scope remains unavailable, report the exact missing step and stop that dependent work. Resume only the permitted scope; the final report must state what ran and what remained unverified. Do not infer a pass from a process ending or a prepared experiment.

### 3. Finish and archive

A done ticket with no cleanup time is normally waiting for the whole run's retrospective, not an interrupted cleanup. `finish` validates delivery and retains every agent's turns. Record retro findings or a brief skip reason, then `archive` gathers the turns into evidence and cleans up together.

If archive was interrupted, rerun `WL archive`. It reuses the saved evidence and resumes cleanup. Existing guards protect dirty and unmerged work; cancelled/replaced worktrees are retained for a separate decision while their tabs are closed. Read the retained-path list before deleting anything manually.

### 4. A final review in flight

A full run's verdict belongs to an independent final reviewer. Its current round lives in state as `finalReview`, and earlier rounds in `finalReviews`.

- **A start interrupted before its state was saved.** The round's branch is deterministic (`wl-<feature>-final-<round>`), so rerunning `WL final-review` adopts the worktree it left. A worktree at another commit is refused and named: inspect it, don't reset it. Close any tab the interrupted start left first.
- **A final reviewer that cannot continue.** Once its turn has ended, `WL final-review --again` starts another round for the same tip. The old turns, report and worktree stay for the record and for evidence.
- **The tip moved after a round.** The old report is for the old tip and no longer counts. Start again without `--again`; the run needs a new verdict for the new tip. Never hand-edit state.
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
| `turns/` | Every agent turn: its prompt, spec, output log and meta (conversation id, exit). |
| `worktrees/` | The worktrees of tickets and final review rounds. `archive` removes the integrated and clean ones. |
| `tip/` | The integration worktree (older runs used `integration/`; `state.json` records the actual path). `archive` removes it. |
| `final-review.md` | Your acceptance mapping: the claims the final reviewer verifies. |

Agent transcripts and the agent/attempt index live under `evidence/`; retrospective outputs live under `retros/`. They remain after archival.
