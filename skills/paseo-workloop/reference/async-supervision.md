# Supervising turns

Every executor, reviewer and final reviewer is an **agent**: one conversation with a headless CLI (`dsh`, `devin`, `codex` or `pi`) in one worktree. Each prompt it gets is a **turn**: a process in a tab of the run's Rex session, which exits when the turn is over. Nothing runs between turns, and nothing reports in the middle of one. This is not real-time supervision: do not add a monitor model or frequent status summaries unless the user asks.

## Starting turns

`WL dispatch NN`, `WL review NN`, `WL send NN --file <message>` and `WL final-review` each check the usual budgets and guards, write the brief or message, start the turn in a new tab, record it, and return at once. There is nothing to acknowledge.

A turn after an agent's first goes on in the same conversation: the script reads the conversation id the previous turn recorded and passes it to the CLI (`dsh --session-id`, `devin -r`, `codex exec resume`, `pi --session`). Each of them fails on an id it does not know rather than starting a new conversation, so a lost one shows as an error, never as an executor that forgot its work. If the previous turn left none, `send` refuses and names the file; `retry` the task instead. The previous turn's tab closes when the next one starts; its files stay.

The run's Rex session is `wl-<project>-<feature>`, made the first time a turn needs it, and made again if it was closed. Its first tab is a plain shell the run does not use.

## Turn files

For turn `n` of agent `<id>`, under `<run dir>/turns/`:

| File | Holds |
|---|---|
| `<id>-<n>.prompt.md` | what the turn was told |
| `<id>-<n>.spec.json` | provider, settings, the conversation it goes on in, its paths |
| `<id>-<n>.log` | everything the CLI printed (dsh, codex and pi: their JSON events) |
| `<id>-<n>.json` | the conversation id as soon as it is known, then the exit code and end time |

[agent-run.mjs](../scripts/agent-run.mjs) runs in the tab and writes the last two; the tab shows a readable view of the same output while the turn runs. `evidence` and `archive` gather every agent's turns into `evidence/<id>.txt`.

## Waiting

Run `WL wait [--for <minutes>]` as a background command, then end your turn. It holds no lock, so every other command works meanwhile. It returns:

- **when a running turn ends**, saying how it exited and what it left: the executor's report status, the reviewer's verdict, or, when there is no fresh report, the log to read and the ways on; then the next steps;
- **at once when nothing runs**, naming any turn that ended without a report while nobody was waiting, then the next steps;
- **after the limit** (110 minutes by default, inside the two hours a Claude Code background command may run), saying how long ago each running turn last printed. Arm it again.

A turn ending is a wake-up, not acceptance: read the report and act on the table in [run.md](run.md).

- Arm `wait` before every pause while a turn runs, including after answering an unrelated user message. Nothing else wakes you.
- One `wait` is enough; a second one does no harm.
- Never poll in a shell loop or sleep, and never read logs to pass the time.

## Stopping and taking over

A running turn cannot be steered: every message is a turn of its own. To stop one, press Ctrl-C in its tab (or ask the user to); `wait` reports it as interrupted and `status --live` shows the agent `error:<code>` or `closed`. Then `send` a complete restatement of what remains, or `retry`.

The user may also take over a conversation by hand once its turn has ended: in the tab, run the CLI interactively on the same conversation (`dsh --session-id <id>`, `devin -r <id>`, `codex resume <id>`, `pi --session <id>`). When they are done, `send` the agent a message saying what changed, so its next turn starts from the tree as it is.

## Rex and the orchestrator

The Rex server, not the app window, owns the processes in its tabs: closing the window or quitting the app does not stop a turn. Run Claude Code itself in a Rex tab when you can, so the orchestrator survives the same way. If the Claude Code session does close, turns keep running: reopen the session, run `WL status --live`, and arm `wait` again.

If the Rex server stops, its tabs and their processes go with it. `status --live` then shows those agents `closed`; their turn files remain, and the CLI keeps its own conversation, so `send` goes on in it, or `retry` replaces the agent.

## Errors

- **Rex cannot be asked** (not running, or the CLI not found): commands that need an agent's state refuse with `cannot tell whether … is still running` instead of guessing. Start Rex, or set `REX_CLI`, and run the command again.
- **A command interrupted after it opened a tab but before it saved state** leaves a turn the run does not know. Look at the run's Rex session for a tab the run did not record (`status --live` lists the recorded ones), stop and close it, then run the command again.
- **A turn exits at once with an error**: its log names the cause (a CLI not signed in, a wrong permission preset, an unknown dsh profile). Launch settings are the user's: tell them, then `send` again after they fix it.
