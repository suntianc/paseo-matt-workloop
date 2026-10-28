# Asynchronous supervision

Use completion notifications for ordinary progress and a 55-minute heartbeat for missed notifications, stalled commands and permissions. This is not real-time supervision. View a worker's Paseo conversation for live output; fetch `get_agent_activity` or `paseo agent logs <id> --tail 20` when the user asks for a summary or an anomaly needs investigation. Do not add a monitor model or frequent status summaries unless requested.

## Dispatch, review and rework

Run `WL dispatch NN --prepare`, `WL review NN --prepare`, `WL send NN --prepare --file <message>`, or `WL final-review --prepare` for a full run's independent final reviewer.

The script checks the usual budgets, worktree and review guards, persists a pending action, arms a fallback heartbeat before yielding to the external MCP call, and prints JSON:

```json
{
  "action": "<unique action id>",
  "kind": "dispatch",
  "tool": "create_agent",
  "arguments": {
    "notifyOnFinish": true
  }
}
```

The actual `arguments` also contain the selected provider/model/settings, workspace, labels and task prompt. Pass **only `arguments`**, unchanged, to the named Paseo MCP tool. The call must be agent-scoped to the owning orchestrator on the same daemon. A top-level or remote external MCP call has no equivalent parent callback.

1. Execute that one MCP request. Do not wait or poll for the worker to finish.
2. Once its response has arrived, and in a later tool call than the MCP request itself, pass the response unchanged to `ack` on stdin (`final` instead of `NN` for the final reviewer):

   ```sh
   WL ack NN --receipt - <<'EOF'
   <the MCP response, exactly as the tool returned it>
   EOF
   ```

   The script takes a bare response for the action pending now and saves it as `messages/receipt-<NN>-<action>.json`; acknowledge right after the call, before preparing anything else for that ticket. A receipt file in the `{ "action": "<action id>", "result": <response> }` wrapper still works with `--receipt <file>`, and it is checked against the pending action id. Creation receipts must match the action label and worktree, and a worker the response doesn't name is refused, so never write a receipt before the response exists. Rework changes task state only after dispatch acknowledgement. Duplicate acknowledgement is harmless.
4. Dispatch any other eligible frontier work, then run `WL watch` and end this turn. Report that workers are running and you will resume on notification; do not claim the work is complete.

The executor and reviewer finish with `Result`, `Report`, and `Summary` lines. Read the report and verify the live status before advancing; the notification and three lines do not replace acceptance evidence. A `question`, `blocked`, `changes_requested`, error, or missing report requires a decision by the orchestrator.

Bare dispatch/review/send commands retain the legacy CLI path for existing scripts. That path does not promise a finish callback. The skill's default is `--prepare` plus MCP, not a silent fallback to CLI launches.

## Interruption and errors

Run `WL action NN` (or `WL action final`) to retrieve a pending request. **Printing the request again is not permission to execute it again.**

- If the tool was never called, execute it once and acknowledge it.
- If creation may have succeeded, query the run/task/action labels (including archived agents), recover the matching agent ID and response, and acknowledge the existing worker. Never start another worker just because the acknowledgement was lost. `ack` rejects unrelated IDs and worktrees.
- If a send may have succeeded, inspect its activity and recover its dispatch receipt. Do not resend automatically. A report can already have been rewritten before the acknowledgement arrives.
- A confirmed creation error with no matching agent can be acknowledged with its actual `isError: true` response; no success is recorded and preparation can be retried after correcting the cause. Errors after creation and ambiguous send errors retain the pending action for reconciliation.
- Existing legacy runs can use `WL watch` as a fallback wake-up. Do not assume old CLI workers gained notifications. Restore notifications with an agent-scoped MCP follow-up only after the worker is idle and the intended continuation has been established.

After a daemon restart, treat notification subscriptions as unverified. Reconcile live state and restore the watch; do not assume a stored parent label means a callback is armed. See [recovery.md](recovery.md).

## Heartbeat behavior

`WL watch` performs a current health check and maintains one run-owned single-run heartbeat for about 55 minutes later. **Paseo 0.12 hides heartbeats from both `schedule ls` and `schedule inspect`. Never use their output to infer a heartbeat does not exist.**

[heartbeat.mjs](../scripts/heartbeat.mjs) maintains a durable `heartbeatLedger` in run state:

- Persist a unique creation intent before calling the daemon. After receiving its ID, persist it alongside every old ID before starting deletion.
- Delete each recorded ID through `paseo heartbeat delete`; remove an ID from the ledger only after a matching deletion receipt or the CLI's explicit heartbeat-not-found response. Connection errors and ambiguous replies retain the ID and fail the command. An unfinished cleanup blocks another creation.
- On upgrade, import the old `heartbeat` pointer and all heartbeat receipts in this run's `events.jsonl`. On the daemon machine, read `$PASEO_HOME/schedules/*.json` to recover owned records with this run's name, including a creation interrupted before its ID was saved. These files are read-only; deletion still uses the CLI's ownership checks. This is a dated internal format, not a remote discovery API.
- A successful renewal leaves one tracked heartbeat. When no worker is running, delete all tracked IDs. Finished runs and the Stop hook also retry ledger cleanup even if the old `heartbeat` pointer is empty.

For an ambiguous creation on another daemon, or when its local store cannot confirm the result, `watch` preserves the creation intent and **does not create another heartbeat**. Recover actual IDs from the creation receipt or delivered heartbeat message, then run:

```sh
WL watch --heartbeat-id <actual-id> [--heartbeat-id <another-actual-id>]
```

The supplied IDs are recorded before cleanup and checked by the owning daemon's `heartbeat delete`. Do not supply guessed IDs. If you have positively confirmed that creation never happened, clear only that intent with `WL watch --clear-heartbeat-create --reason "<verification evidence>"`. A timeout or empty schedule list is not such evidence.

For older runs, remote unrecorded IDs missing from both state and audit receipts cannot be enumerated by this CLI. They need the daemon's storage or their original receipts/messages; the fix does not claim it can discover those unknown IDs. Do not edit run state or the daemon's schedule files to hide incomplete cleanup.

At delivery, the prompt runs `WL watch` **again** before deciding what to do:

- Healthy running workers: reply only `好`. The watch has already renewed the fallback.
- At least 45 minutes without activity, missing activity timestamps, permissions, query failures or pending MCP actions: inspect the affected workers and decide what to do. Staleness is a signal to investigate, not grounds to kill or retry automatically.
- Stopped workers: process their reports and continue the workloop. All stopped does not mean all tickets accepted.

A worker's provider/runtime can emit different kinds of activity. Timestamps are only a coarse liveness signal, not proof of useful progress. With a 55-minute check cadence, the 45-minute threshold is noticed at the next heartbeat; detection is not guaranteed at minute 45. Cache pricing and TTL depend on the provider; the heartbeat makes no cost or cache guarantee.

### Optional Claude Code Stop hook

For automatic renewal after every orchestrator turn, merge this entry into the **target project's** `.claude/settings.local.json`, preserving its other settings and hooks. Replace the path with the installed skill path on that machine; quote the script path for that machine's shell.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/paseo-workloop/scripts/stop-hook.mjs", "timeout": 50 }
        ]
      }
    ]
  }
}
```

[stop-hook.mjs](../scripts/stop-hook.mjs) only checks runs owned by the current `PASEO_AGENT_ID`. It is inert outside Paseo, emits no blocking Stop decision, and does not modify configuration. Other providers can use their supported end-of-turn hooks to run the same command. Without a hook, run `WL watch` explicitly before each pause; the heartbeat prompt also renews itself.

## Long commands

Use the provider's own background-command completion notification when supported. Keep the job/session identifier, return control, and collect the real result on completion. `WL integrate` and `WL finish` are such commands: their checks run as a check phase outside the run lock, each check stops at the run's time limit, and `watch` keeps the heartbeat armed while the phase runs and reports it as a problem if its process died. See the Integration section of [run.md](run.md). Providers differ: do not invent a universal background-command notification flag. If unavailable, use a managed job and the same fallback health checks, and state that limitation.

`WL patrol` is now a diagnostic snapshot: default window 1 second, maximum 60 seconds. Its deadline includes `agent inspect` calls; all Paseo CLI calls also have a 30-second timeout (`PASEO_TIMEOUT_MS` override). A timed-out write may already have reached the daemon and must be reconciled before retrying. Never wrap patrol in an hour-long shell loop.
