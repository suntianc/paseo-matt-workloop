---
name: paseo-workloop
description: Take a change from conversation to integrated code with Paseo agents. After grilling the user, either run a single scoped ticket (a direct run) or write a spec and tickets for parallel executors. Each ticket runs in its own worktree, passes an independent review, and is merged serially onto a local integration branch. Use when the user wants code, small or large, implemented by Paseo-managed agents (omp, Claude Code, Codex or any other provider) rather than by in-session subagents.
---

# Paseo Workloop

This does what upstream's `implement-spec` does with in-session subagents, but with Paseo agents, and you are the orchestrator. Executors and reviewers are Paseo agents. You dispatch and supervise them, answer their questions, decide on review findings, and integrate their work. You don't write the code yourself, however small the change: small changes go through a direct run.

Every mechanical step goes through [scripts/workloop.mjs](scripts/workloop.mjs): run state, base verification, budgets, freezing candidates, merging, checks and cleanup. The script prepares guarded MCP requests; you execute them in your own Paseo agent scope and acknowledge their receipts. Do not launch untracked workers or edit run state by hand.

## Before you start

- **Daemon check.** `paseo agent ls --json` must print JSON. If it doesn't, the daemon is down or the CLI isn't on your PATH (set `PASEO_CLI`). Stop and tell the user. Don't fall back to in-session subagents, because they have no Paseo identity to rework or clean up.
- **Async prerequisites.** Run inside a Paseo agent session (`PASEO_AGENT_ID` set), with agent-scoped `create_agent` and `send_agent_prompt` tools enabled and `paseo heartbeat` available. These are needed for finish notifications and the fallback wake-up. If unavailable, report that limitation; do not silently replace them with a long polling loop.
- **Version quirks.** Read [reference/paseo-compat.md](reference/paseo-compat.md) for what's known about your Paseo version.
- **Launch settings.** Executors start with the provider, model, mode and thinking level of the Paseo agent profile `wl-executor`, and reviewers with those of `wl-reviewer`. The user creates both in Paseo under Settings → host → Agents → Agent profiles. To use a different profile for a run, the user names it, and you bind it with `--profile <name>` / `--review-profile <name>`. Flags such as `--model` or `--review-model` override one field. Each role's settings must name a provider, a model and a mode; the script refuses a role missing any of them before it creates anything, and `config` and `status` show that role `UNRESOLVED` with the reason. The model is needed because Paseo's `create_agent` takes `provider/model`, and the mode because an agent on another provider can't inherit yours. If the script refuses a step for lack of launch settings, tell the user what it said. The legacy CLI feature warning applies only to CLI launches; prepared MCP requests preserve the selected profile features. Don't choose a provider, model or profile for them; you may suggest one from the profile list the script prints.
- **The `WL` shorthand.** Below, `WL` means `node <this skill's directory>/scripts/workloop.mjs --run <project>/<feature>`. Write it out in full in each command, because shell state may not persist between your tool calls.

## 0. Grill and route

Start every request by reaching a shared understanding with the user: read [grill-me](../grill-me/SKILL.md) and follow it. It may not be invocable as a tool from here, so read the file. Grilling scales with the request; a small change runs out of questions in a round or two.

During grilling, read the ADRs in `docs/adr/` that the change touches. If the request contradicts one, or a premise it states no longer holds, tell the user and let them decide: keep it, or supersede it with a new ADR (via [domain-modeling](../domain-modeling/SKILL.md)). Superseding deletes the old ADR and adds a row to `docs/adr-history.md`, as described under "Record decisions" in step 2. Record the outcome in the spec or ticket, so executors don't meet the conflict.

Don't write ADR or glossary files in the repo during grilling, even though domain-modeling says to write them as they happen. Put the decided changes in the spec's Implementation Decisions, or in the direct ticket; step 2 commits them to the integration worktree.

End the grilling with one message that states the shared understanding and recommends a route with your reasons. The user confirms both at once.

- **A direct run** when all of these hold:
  - **The goal is clear.** You can say in one sentence what done means, and no product decision is open.
  - **The scope is clear.** You can name the paths that change, and no public behaviour or shared interface changes.
  - **The check is clear.** A test or command will prove each acceptance criterion.
- **A full run** otherwise, or when the work splits into tickets that can run in parallel. Decisions worth an ADR, or new domain terms, also point to a full run; switch to [grill-with-docs](../grill-with-docs/SKILL.md) to record them.

A direct run skips the spec, the ticket breakdown and your final review. It keeps the executor, the independent review and gated integration, so most of its cost falls on the executor and reviewer, not on you.

When the user runs `/tidy-docs`, follow [reference/tidy-docs.md](reference/tidy-docs.md). It classifies and fixes the repo's documents and carries the work out as its own full run.

## 1. Tickets

Tickets live at `<run dir>/issues/NN-slug.md` and the spec at `<run dir>/spec.md`, in the `to-tickets` local-file format. Each ticket has a "Blocked by" line that lists ticket numbers (or "None"). The script refuses blockers given only by title.

Before writing them, run `WL scratch --feature <slug> --repo <repo>`, which creates and prints the run directory.

to-spec and to-tickets may tell you to publish to an issue tracker or to local files in the repo; write to the run directory instead.

A ticket may have a `Scope:` line: comma-separated globs, relative to the repo root, naming the paths it may change (`src/parser/, test/parser.test.ts`). When a ticket has one, the script refuses to freeze a candidate that changes any other file, renames and deletions included. Direct tickets must have one; for full-run tickets it is optional.

Executors never talk to the user, so every ticket must be implementable without asking anyone. Any gap you leave comes back later as a `question` report.

### A direct run

Write one ticket from [templates/direct-ticket.md](templates/direct-ticket.md) as `<run dir>/issues/01-<slug>.md`, the only ticket in that directory. There is no spec; the ticket is the spec. Give each acceptance criterion the command that proves it, because the reviewer re-runs them and nobody reviews the change after that.

Show the ticket to the user. Their approval is how they confirm you understood them, so don't start the run without it.

### A full run

The run needs a spec at `<run dir>/spec.md` and its tickets. If these don't exist yet, create them with the user from the grilling's outcome, by reading and following the sibling skills. They may not be invocable as tools from here, so read the files:

1. [to-spec](../to-spec/SKILL.md) for the spec. Don't stop at its step 2 to confirm the testing seams.
2. [to-tickets](../to-tickets/SKILL.md) for vertical slices with blocking edges, written to the run directory.

A run's tracker is always its run directory, whatever the repo configures. Ignore to-spec's and to-tickets' requests to run `/setup-matt-pocock-skills`, their tracker publishing and their triage labels.

Skip to-spec's User Stories section: user-visible behaviour goes into the tickets' acceptance criteria. The spec keeps Problem Statement, Solution, Implementation Decisions, Testing Decisions and Out of Scope.

Present the testing seams together with the ticket breakdown. The user's approval of both is the one approval the run needs before `init`. If it comes to a single ticket, offer a direct run instead: add a `Scope:` line and start with `--direct` (and `--spec` to keep the spec). That skips the final review. Again, the user decides.

## 2. Start the run

```
WL init --feature <slug> --repo <repo> [--base <ref>] --check "<test command>" [--check "<typecheck>"]
        [--setup "<install command>"] [--profile <name>] [--review-profile <name>] [--max-executors 2] [--max-reviewers 1]
        [--direct]
```

`init` does the following:

- Resolves both roles' launch settings, and checks that Paseo can run their providers, before it creates anything.
- Creates the integration branch `workloop/<feature>` off the base, in a worktree of its own. Your checkout is never touched.
- Imports the ticket graph from the run directory's `issues/`. With `--direct` it requires exactly one ticket, with a `Scope:` line, and uses that ticket as the spec. `WL import` then refuses a second ticket.
- Sets up the checks. `--check` commands run on the integration tree after every merge, and they must already pass on the base.
- Stores run state in the run directory, `$WORKLOOP_ROOT/<project>/<feature>/` (default `~/.workloop`). The run directory holds everything about the run: the spec and tickets you wrote, briefs, messages, reports, reviews and state. Only the script writes `state.json` and `events.jsonl`. Nothing for the run is written into the repo except code and commits.

Use `WL config` to change budgets, checks or launch settings later; launch changes apply to agents started after that. `WL status` shows which settings each role will start with and where they come from.

### Record decisions

If the grilling decided ADR or glossary changes, write them in the integration worktree (`init` prints its path; `WL status --json` shows it as `integration.worktree`), then run `WL decisions` before the first dispatch. It commits those files to the integration branch as one commit and runs the checks, so the first executors branch off a tip that includes the decisions they explain. Use `WL decisions` for nothing else: it commits only ADR, ADR-history and glossary files, and it refuses once a task is dispatched.

- **Superseding an ADR**, in the same change: write the new ADR, delete the old file, and add a row to `docs/adr-history.md`. Create that file from [templates/adr-history.md](templates/adr-history.md) if it doesn't exist. `docs/adr/` then holds only valid ADRs; the deleted one stays in git, and the history table points at it.
- **Numbering** the new ADR: the highest number in `docs/adr/` or in the history table, plus one. This replaces domain-modeling's "scan `docs/adr/`", so a number is never reused.
- **`Premise:`** An ADR may carry one optional line, `Premise: <the condition the decision depends on>`, only when the decision depends on a condition that can change. Then a later grilling has a stated condition to test against.
- **Reading history.** Read `docs/adr-history.md` only when superseding an ADR or when the user asks to trace history. It's an index for people, not a constraint for agents.

## 3. The loop

Repeat until every ticket is done or cancelled:

1. **`WL status`.** This prints the task table and suggests next steps. After a restart, or whenever you're unsure, use `WL status --live`.
2. **`WL dispatch <NN> --prepare`** for each frontier ticket the executor budget allows. Execute and acknowledge the returned MCP request as described below.
   - Add task-specific guidance with `--note` or `--note-file`, such as which blocker's interfaces to build on.
   - The executor gets [templates/executor-brief.md](templates/executor-brief.md), filled in.
3. **`WL watch`.** It checks current worker health once and maintains one single-run heartbeat for 55 minutes later. It journals all heartbeat IDs; if creation or cleanup is unconfirmed, reconcile the reported IDs before continuing. An empty `paseo schedule ls` does not mean heartbeats are gone. With notifications and the heartbeat armed, end this turn. Do not keep a shell tool open waiting for workers.
4. **On a finish, error or permission notification**, run `WL status --live`, read the affected report/activity, and act using the table below. Notifications are wake-ups, not acceptance. Then return to step 1.

Read [reference/async-supervision.md](reference/async-supervision.md) for the MCP receipt procedure, interruption recovery, heartbeat behavior and optional Stop hook. Renew `WL watch` before each pause while workers run, including after responding to an unrelated user message. With the Stop hook installed, that renewal also happens automatically. Heartbeats check timestamps and permissions; they do not continuously judge work quality.

| Notification / current status shows | Do |
|---|---|
| executor idle, `report=done` | Run `WL review <NN> --prepare`, then execute and acknowledge its MCP request. It freezes the commit as the candidate and starts a reviewer with [templates/reviewer-brief.md](templates/reviewer-brief.md). |
| executor idle, `report=question` | Read the report. Answer it yourself if it's a fact or something the spec or code settles. A conflict with an ADR is the user's decision, like a product decision: ask the user and run `WL hold <NN> --reason "<why>"` while you wait. Answer with `WL send <NN> --prepare --text "<answer>"` or `--file`, then execute and acknowledge it. No ADR is written mid-run: if the user overrules an ADR, note it for the finish report. |
| executor idle, `report=blocked` | Fix the environment or the ticket, then prepare/execute/acknowledge `send`. If the ticket itself is wrong, rewrite it and `send` the change, or `cancel` it. |
| agent idle with no fresh report | Run `paseo agent logs <id> --tail 30`, then send and acknowledge a prepared nudge restating what is missing. |
| agent in `error` | Run `paseo agent logs <id> --tail 30`. If the recorded launch settings are the cause (an unknown model, a mode the provider lacks, a provider that isn't logged in), tell the user and wait for them to fix the profile. Then start again: `WL retry <NN> --reason "<why>"` for an executor, `WL review <NN> --prepare --again` for a reviewer. |
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

**Integration.** `WL integrate` merges the candidate into the integration branch with `--no-ff` and runs the checks. If they fail, it rolls back. On success it archives the ticket's Paseo workspace and deletes the ticket's branch.

- **On a conflict** nothing is merged. Run `WL send <NN> --prepare --merge-tip` and execute/acknowledge its MCP request. The executor merges the tip and reports `done`; then review again and integrate.
- **On a check failure**, `send` the output to the executor.

**Escalate rather than loop.**

- After two rework rounds with no real progress on the same findings, `hold` the ticket and take it to the user. If it's a bug hunt, read [diagnosing-bugs](../diagnosing-bugs/SKILL.md).
- If an executor's session can't be recovered, run `paseo agent stop <id>`, then `WL retry <NN> --reason "<why>"`. That resets the ticket to a new attempt and preserves the old one. Dispatch it again with `--prepare` and acknowledge the MCP receipt.
- If a direct run outgrows its ticket (a `question` report, a Scope refusal or a Boundary finding shows the change needs more than the ticket says) and the user wants the larger change, stop the executor if it's running, then `WL cancel 01 --reason "<why>"` and `WL finish`. Start a full run under a new feature name, because `workloop/<feature>` still exists. `finish` lists the cancelled attempt's branch for the user.

## 4. Final review and finish

**A direct run has no final review.** Its reviewer already re-ran the acceptance checks, and there are no other tickets to cross-check. Once the ticket is integrated, go to `WL finish` below.

**Documents come first.** In a full run, once every ticket is closed, `WL status` lists the documents the run added that the repo's registry doesn't hold. For each one, classify it per [reference/tidy-docs.md](reference/tidy-docs.md) and fix it with a repair ticket before the final review: remove process documents, and add a registry row for real ones, merging into an existing document of the same type and domain where there is one. `finish` refuses until that's done. A repo with no registry is never blocked; if `/tidy-docs` is installed in it, `finish` reminds you to run it. Direct runs skip this, because their `Scope:` line already refuses files outside the ticket.

Then review the whole run yourself. Don't dispatch an agent for this.

1. Copy [templates/final-review.md](templates/final-review.md) into the run directory as `final-review.md`.
2. Fill it in from `git diff <baseSha>..<tip>` in the integration worktree:
   - check every acceptance item in the spec against the integrated tree;
   - look for cross-ticket problems that per-ticket reviews can't see;
   - run the full regression, plus a real run of the changed surface.

**If you find defects**, fix them with repair tickets:

1. Write `NN-fix-<cause>.md` next to the other tickets, from [templates/repair-ticket.md](templates/repair-ticket.md), blocked by the ticket it repairs. Run the reproduction yourself on the integration tip and paste what it printed. The executor has only the ticket to go on, so a secondhand or guessed repro sends it after the wrong thing.
2. Run `WL import`.
3. Take the repair tickets through the loop.

The original tickets stay done. When the repairs are integrated, review again: `finish` only accepts a passing review of the current tip.

**`WL finish`** re-runs the checks, completes cleanup and removes the integration worktree. The branch `workloop/<feature>` stays, unpushed and unmerged. Report to the user:

- the branch,
- a summary of the run,
- any findings you accepted without fixing,
- anything left over, such as kept attempts and cancelled tickets,
- ADRs the user overruled during the run, for the next grilling.

Publishing is the user's call.

## Rules

- Executors and reviewers never talk to the user. You are their only contact, and the only contact the user has about the run.
- Never fake progress. A ticket is done when it's integrated with the checks passing. A full run is finished when the current tip has a passing final review; a direct run, when its ticket is integrated.
- No remote writes (pushes, PRs, issue comments) unless the user asks for them separately.
- Launch settings are the user's. When they're missing, refused, or make an agent fail, tell the user; don't substitute your own.
- Use provider-native background completion notifications for your own long checks when available. Collect their exit codes and output before continuing; never equate dispatch with success. Do not replace a long check with a shell polling loop.
- After any interruption, reconcile before acting: see [reference/recovery.md](reference/recovery.md).
- If the script refuses a step, fix the cause; don't work around it by hand. If the script itself is wrong, tell the user.
