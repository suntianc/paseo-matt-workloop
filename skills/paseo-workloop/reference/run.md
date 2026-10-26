# Ticketed runs: Direct and Full

## Before you start

- **Daemon check.** `paseo agent ls --json` must print JSON. If it doesn't, the daemon is down or the CLI isn't on your PATH (set `PASEO_CLI`). Stop and tell the user. Don't fall back to in-session subagents, because they have no Paseo identity to rework or clean up.
- **Async prerequisites.** Run inside a Paseo agent session (`PASEO_AGENT_ID` set), with agent-scoped `create_agent` and `send_agent_prompt` tools enabled and `paseo heartbeat` available. These are needed for finish notifications and the fallback wake-up. If unavailable, report that limitation; do not silently replace them with a long polling loop.
- **Version quirks.** Read [reference/paseo-compat.md](paseo-compat.md) for what's known about your Paseo version.
- **Launch settings.** Executors start with the provider, model, mode and thinking level of the Paseo agent profile `wl-executor`, and reviewers with those of `wl-reviewer`. The user creates both in Paseo under Settings → host → Agents → Agent profiles. To use a different profile for a run, the user names it, and you bind it with `--profile <name>` / `--review-profile <name>`. Flags such as `--model` or `--review-model` override one field. Each role's settings must name a provider, a model and a mode; the script refuses a role missing any of them before it creates anything, and `config` and `status` show that role `UNRESOLVED` with the reason. The model is needed because Paseo's `create_agent` takes `provider/model`, and the mode because an agent on another provider can't inherit yours. If the script refuses a step for lack of launch settings, tell the user what it said. The legacy CLI feature warning applies only to CLI launches; prepared MCP requests preserve the selected profile features. Don't choose a provider, model or profile for them; you may suggest one from the profile list the script prints.
- **The `WL` shorthand.** Below, `WL` means `node <this skill's directory>/scripts/workloop.mjs --run <project>/<feature>`. Write it out in full in each command, because shell state may not persist between your tool calls.

## 1. Tickets

Tickets live at `<run dir>/issues/NN-slug.md` and the spec at `<run dir>/spec.md`, in the `to-tickets` local-file format. Each ticket has a "Blocked by" line that lists ticket numbers (or "None"). The script refuses blockers given only by title.

Before writing them, run `WL scratch --feature <slug> --repo <repo>`, which creates and prints the run directory.

to-spec and to-tickets may tell you to publish to an issue tracker or to local files in the repo; write to the run directory instead.

A ticket may have a `Scope:` line: comma-separated globs, relative to the repo root, naming the paths it may change (`src/parser/, test/parser.test.ts`). When a ticket has one, the script refuses to freeze a candidate that changes any other file, renames and deletions included. Direct tickets must have one; for full-run tickets it is optional.

Executors never talk to the user, so every ticket must be implementable without asking anyone. Any gap you leave comes back later as a `question` report.

### A direct run

Write one ticket from [templates/direct-ticket.md](../templates/direct-ticket.md) as `<run dir>/issues/01-<slug>.md`, the only ticket in that directory. There is no spec; the ticket is the spec. Include suitable acceptance evidence so the reviewer can verify the result.

Use the scope and acceptance already agreed with the user. Ask only about material gaps or decisions the request leaves open.

### A full run

The run needs a spec at `<run dir>/spec.md` and its tickets. If these don't exist yet, create them with the user from the grilling's outcome, by reading and following the sibling skills. They may not be invocable as tools from here, so read the files:

1. [to-spec](../../to-spec/SKILL.md) for the spec. Don't stop at its step 2 to confirm the testing seams.
2. [to-tickets](../../to-tickets/SKILL.md) for vertical slices with blocking edges, written to the run directory.

A run's tracker is always its run directory, whatever the repo configures. Ignore to-spec's and to-tickets' requests to run `/setup-matt-pocock-skills`, their tracker publishing and their triage labels.

Skip to-spec's User Stories section: user-visible behaviour goes into the tickets' acceptance criteria. The spec keeps Problem Statement, Solution, Implementation Decisions, Testing Decisions and Out of Scope.

Summarize the testing approach and ticket breakdown. Existing authorization carries forward; resolve material scope or design questions before dispatch. A single bounded ticket may use Direct with a `Scope:` line and `--direct`.

## 2. Start the run

```
WL init --feature <slug> --repo <repo> [--base <ref>] --check "<test command>" [--check "<typecheck>"]
        [--setup "<install command>"] [--profile <name>] [--review-profile <name>] [--max-executors 2] [--max-reviewers 1]
        [--direct]
```

`init` does the following:

- Resolves both roles' launch settings, and checks that Paseo can run their providers, before it creates anything.
- Creates the integration branch `workloop/<feature>` off the base, in a worktree of its own. Your checkout is never touched.
- Imports the ticket graph from the run directory's `issues/`. With `--direct` it requires exactly one ticket, with a `Scope:` line, and uses that ticket as the spec. `WL import` allows one follow-up repair at a time after integration, with a `Scope:` and a dependency on the integrated ticket. Broader scope belongs in Full.
- Sets up the checks. `--check` commands run on the integration tree after every merge, and they must already pass on the base.
- Stores run state in the run directory, `$WORKLOOP_ROOT/<project>/<feature>/` (default `~/.workloop`). The run directory holds everything about the run: the spec and tickets you wrote, briefs, messages, reports, reviews and state. Only the script writes `state.json` and `events.jsonl`. Nothing for the run is written into the repo except code and commits.

Use `WL config` to change budgets, checks or launch settings later; launch changes apply to agents started after that. `WL status` shows which settings each role will start with and where they come from.

### Record decisions

If the grilling decided ADR or glossary changes, write them in the integration worktree (`init` prints its path; `WL status --json` shows it as `integration.worktree`), then run `WL decisions` before the first dispatch. It commits those files to the integration branch as one commit and runs the checks, so the first executors branch off a tip that includes the decisions they explain. Use `WL decisions` for nothing else: it commits only ADR, ADR-history and glossary files, and it refuses once a task is dispatched.

- **Superseding an ADR**, in the same change: write the new ADR, delete the old file, and add a row to `docs/adr-history.md`. Create that file from [templates/adr-history.md](../templates/adr-history.md) if it doesn't exist. `docs/adr/` then holds only valid ADRs; the deleted one stays in git, and the history table points at it.
- **Numbering** the new ADR: the highest number in `docs/adr/` or in the history table, plus one. This replaces domain-modeling's "scan `docs/adr/`", so a number is never reused.
- **`Premise:`** An ADR may carry one optional line, `Premise: <the condition the decision depends on>`, only when the decision depends on a condition that can change. Then a later grilling has a stated condition to test against.
- **Reading history.** Read `docs/adr-history.md` only when superseding an ADR or when the user asks to trace history. It's an index for people, not a constraint for agents.

## 3. The loop

Repeat until every ticket is done or cancelled:

1. **`WL status`.** This prints the task table and suggests next steps. After a restart, or whenever you're unsure, use `WL status --live`.
2. **`WL dispatch <NN> --prepare`** for each frontier ticket the executor budget allows. Execute and acknowledge the returned MCP request as described below.
   - Add task-specific guidance with `--note` or `--note-file`, such as which blocker's interfaces to build on.
   - The executor gets [templates/executor-brief.md](../templates/executor-brief.md), filled in.
3. **`WL watch`.** It checks current worker health once and maintains one single-run heartbeat for 55 minutes later. It journals all heartbeat IDs; if creation or cleanup is unconfirmed, reconcile the reported IDs before continuing. An empty `paseo schedule ls` does not mean heartbeats are gone. With notifications and the heartbeat armed, end this turn. Do not keep a shell tool open waiting for workers.
4. **On a finish, error or permission notification**, run `WL status --live`, read the affected report/activity, and act using the table below. Notifications are wake-ups, not acceptance. Then return to step 1.

Read [reference/async-supervision.md](async-supervision.md) for the MCP receipt procedure, interruption recovery, heartbeat behavior and optional Stop hook. Renew `WL watch` before each pause while workers run, including after responding to an unrelated user message. With the Stop hook installed, that renewal also happens automatically. Heartbeats check timestamps and permissions; they do not continuously judge work quality.

| Notification / current status shows | Do |
|---|---|
| executor idle, `report=done` | Run `WL review <NN> --prepare`, then execute and acknowledge its MCP request. It freezes the commit as the candidate and starts a reviewer with [templates/reviewer-brief.md](../templates/reviewer-brief.md). |
| executor idle, `report=question` | Read the report. Answer it yourself if it's a fact or something the spec or code settles. A conflict with an ADR is the user's decision, like a product decision: ask the user and run `WL hold <NN> --reason "<why>"` while you wait. Answer with `WL send <NN> --prepare --text "<answer>"` or `--file`, then execute and acknowledge it. No ADR is written mid-run: if the user overrules an ADR, note it for the finish report. |
| executor idle, `report=blocked` | Fix the environment or the ticket, then prepare/execute/acknowledge `send`. If the ticket itself is wrong, rewrite it and `send` the change, or `cancel` it. |
| agent idle with no fresh report | Run `paseo agent logs <id> --tail 30`, then send and acknowledge a prepared nudge restating what is missing. |
| agent in `error` | Run `paseo agent logs <id> --tail 30`. Resolve the cause, keeping the original session and worktree where possible. Use the [recovery guidance](recovery.md) when a session cannot continue; a transient error alone is not a reason to replace it. |
| permission request waiting | Run `paseo permit ls`. Allow it if it's within the ticket's scope. Otherwise deny it and `send` a correction. Ask the user if you're unsure. |
| `review` refuses: changes outside the ticket's Scope | If the executor didn't need those files, `send` a correction to revert them. If the ticket does need them, ask the user: widen the `Scope:` line (the next `review` reads it; no import needed), or, in a direct run, switch to a full run. |
| reviewer idle, verdict `pass` | Run `WL integrate <NN>`. |
| reviewer idle, verdict `changes_requested` | Decide which findings are must-fix yourself; `blocking` is only the reviewer's opinion. See below. |
| still running, no change | Run `WL watch`, then end this turn. Do not repeatedly fetch logs. Inspect activity on demand, on an anomaly, or when evidence suggests drift. |

**When review requests changes**, write a rework message containing:

- the finding IDs,
- what to change,
- the evidence that proves each fix.

Send it with `WL send <NN> --prepare --file <message>`, then execute and acknowledge its MCP request. The ticket goes back to running; review it again when it reports `done`. If you judge every finding non-blocking, run `WL integrate <NN> --override "<why>"` instead.

Boundary findings (`B1`, `B2`, … from a direct run's reviewer) follow the Scope rule in the table: an overstep the ticket doesn't need goes back as rework; one it does need goes to the user.

**Drift** to look for in logs and diffs:

- files or refactors outside the ticket's scope;
- tests that are disabled, skipped or weakened;
- repeated attempts that bring no new evidence;
- changes to shared interfaces that another ticket depends on;
- remote writes, credential use, or deletions outside the worktree.

**To intervene**, run `paseo agent stop <id>` and confirm the agent is idle. Then use `WL send --prepare` with a complete restatement of the remaining work and acknowledge its MCP receipt. The workloop still requires idle workers before rework; current Paseo supports steering, but fallback can interrupt an active turn.

**Integration.** `WL integrate` merges the candidate into the integration branch with `--no-ff` and runs the checks. If they fail, it rolls back. On success the next tickets can start. The executor, reviewers and worktree stay available until the whole run has been assessed for retro and archived.

- **On a conflict** nothing is merged. Run `WL send <NN> --prepare --merge-tip` and execute/acknowledge its MCP request. The executor merges the tip and reports `done`; then review again and integrate.
- **On a check failure**, `send` the output to the executor.

**Escalate rather than loop.**

- When rework stops producing useful evidence or progress, revisit the cause; use `hold` if a user decision is needed. If it's a bug hunt, read [diagnosing-bugs](../../diagnosing-bugs/SKILL.md).
- If an executor's session cannot recover, `WL retry <NN> --reason "<why>"` replaces the agent while retaining the worktree, branch and handoff. Dispatch again with `--prepare`. Add `--file <handoff>` for useful context; use `--new-worktree` only when the existing tree cannot safely continue. Reconcile and stop old workers before replacement.
- If a direct run outgrows its ticket (a `question` report, a Scope refusal or a Boundary finding shows the change needs more than the ticket says) and the user wants the larger change, stop the executor if it's running, then cancel the open ticket and close the run through finish, retro assessment and archive. Start a full run under a new feature name, because `workloop/<feature>` still exists. `archive` leaves unmerged or dirty attempts intact and lists them for the user.

## 4. Final review and finish

**A direct run has no final review.** Its reviewer already re-ran the acceptance checks, and any follow-up repair is reviewed independently against the current integration tip. Once the ticket is integrated, go to `WL finish` below.

**Documents come first.** In a full run, once every ticket is closed, `WL status` lists the documents the run added that the repo's registry doesn't hold. For each one, classify it per [reference/tidy-docs.md](tidy-docs.md) and fix it with a repair ticket before the final review: remove process documents, and add a registry row for real ones, merging into an existing document of the same type and domain where there is one. `finish` refuses until that's done. A repo with no registry is never blocked; if `/tidy-docs` is installed in it, `finish` reminds you to run it. Direct runs skip this, because their `Scope:` line already refuses files outside the ticket.

Then review the whole run yourself. Don't dispatch an agent for this.

1. Copy [templates/final-review.md](../templates/final-review.md) into the run directory as `final-review.md`.
2. Fill it in from `git diff <baseSha>..<tip>` in the integration worktree:
   - check every acceptance item in the spec against the integrated tree;
   - look for cross-ticket problems that per-ticket reviews can't see;
   - run the full regression, plus a real run of the changed surface.

**If you find defects**, fix them with repair tickets:

1. Write `NN-fix-<cause>.md` next to the other tickets, from [templates/repair-ticket.md](../templates/repair-ticket.md), blocked by the ticket it repairs. Run the reproduction yourself on the integration tip and paste what it printed. The executor has only the ticket to go on, so a secondhand or guessed repro sends it after the wrong thing.
2. Run `WL import`.
3. Take the repair tickets through the loop.

A post-integration repair always gets a new ticket, agent session and worktree based on the current integration tip. Include the original acceptance behavior that the repair must preserve. The original sessions remain read-only evidence. The original tickets stay done. When the repairs are integrated, review again: `finish` only accepts a passing review of the current tip.

**`WL finish`** re-runs the checks and records that delivery is complete. It retains the integration tree and all child sessions, and removes tracked supervision heartbeats when the workers have stopped.

Assess the whole run with [retro](../../retro/SKILL.md): recurring third-party failures, business pitfalls, repeated wrong behavior or repeated exploration are useful signals; a serious one-off loss or unauthorized action also deserves a look. If none apply, record `WL retro --skip --reason "<brief reason>"`. Otherwise present the findings and suggested destinations to the user, save them with `WL retro --file <report>`, and leave implementation to the user's decision.

Then `WL archive` saves CLI session transcripts and an agent/attempt index under `evidence/`, archives child sessions together and removes integrated worktrees. Unmerged or dirty cancelled/replaced work is retained and listed. An interrupted archive can be rerun. `WL evidence` can also capture transcripts before retro; CLI transcripts may curate tool output, so inspect the original sessions when a detail matters.

Report the branch, checks, any accepted findings, retro result and retained work. Retro suggestions need no approval before archiving; implementing them is a separate task. Publishing remains the user's call.

## Rules

- Executors and reviewers never talk to the user. You are their only contact, and the only contact the user has about the run.
- Never fake progress. A ticket is done when it's integrated with the checks passing. Delivery completes at `finish`; archival completes separately after retro assessment.
- No remote writes (pushes, PRs, issue comments) unless the user asks for them separately.
- Launch settings are the user's. When they're missing, refused, or make an agent fail, tell the user; don't substitute your own.
- Use provider-native background completion notifications for your own long checks when available. Collect their exit codes and output before continuing; never equate dispatch with success. Do not replace a long check with a shell polling loop.
- After any interruption, reconcile before acting: see [reference/recovery.md](recovery.md).
- If the script refuses a step, fix the cause; don't work around it by hand. If the script itself is wrong, tell the user.
