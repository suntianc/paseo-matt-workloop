// The CLIs an executor or reviewer runs as. An adapter says what differs about one:
// the settings it takes, its command line for a turn (a new conversation, or the
// same one again), how the prompt reaches it, and where the conversation's id
// shows up so a later turn can go on in it.
//
// A turn is one headless process: it gets its prompt, works, and exits. The run
// learns that a turn ended from the process exiting, and what it did from the
// report file its brief names.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Settings: "required" must be in the launch settings; "optional" may be;
// anything else is refused, so a setting a CLI ignores is never silently dropped.
export const ADAPTERS = {
  // DeepSeek Harness. Its model and reasoning effort come from the dsh profile
  // (`~/.dsh/profiles/<profile>`); `mode` is a permission preset.
  dsh: {
    settings: { mode: "required", profile: "optional" },
    argv: ({ mode, profile }, session) => [
      "dsh", "--profile", profile || "headless", "--json", "--permission-mode", mode, "--approval-policy", "never",
      ...(session ? ["--session-id", session] : []), "-",
    ],
    stdin: true,
    // The first event names the session: {"type":"session","sessionId":"session-…"}.
    sessionFromLine(line) {
      try {
        const e = JSON.parse(line);
        return e?.type === "session" && typeof e.sessionId === "string" ? e.sessionId : null;
      } catch { return null; }
    },
    render: renderDsh,
  },
  // Devin CLI. `mode` is its permission mode (auto, accept-edits, smart, dangerous).
  // Print mode cannot answer the workspace-trust prompt, and a fresh worktree is
  // never trusted, so the check is off.
  devin: {
    settings: { mode: "required", model: "optional" },
    argv: ({ mode, model }, session, promptFile) => [
      "devin", "--permission-mode", mode, "--respect-workspace-trust=false",
      ...(model ? ["--model", model] : []), ...(session ? ["-r", session] : []), "--prompt-file", promptFile, "-p",
    ],
    stdin: false,
    // Print mode does not print its session; the newest one in the working directory
    // is this turn's. A worktree runs one Devin turn at a time, so it is never another's.
    sessionAfter(cwd) {
      const r = spawnSync("devin", ["list", "--format", "json"], { cwd, encoding: "utf8", timeout: 30000 });
      try {
        const list = JSON.parse(r.stdout || "[]");
        const newest = list.sort((a, b) => (a.last_activity_at ?? 0) - (b.last_activity_at ?? 0)).at(-1);
        return newest?.id ?? null;
      } catch { return null; }
    },
  },
  // Codex CLI. `mode` is its sandbox (read-only, workspace-write, danger-full-access),
  // set through config because `exec resume` takes no --sandbox; `thinking` is its
  // reasoning effort. Approvals are off: nobody is there to answer them.
  codex: {
    settings: { mode: "required", model: "optional", thinking: "optional" },
    argv: ({ mode, model, thinking }, session) => [
      "codex", "exec", ...(session ? ["resume"] : []), "--json",
      "-c", `sandbox_mode="${mode}"`, "-c", 'approval_policy="never"',
      ...(model ? ["-m", model] : []), ...(thinking ? ["-c", `model_reasoning_effort="${thinking}"`] : []),
      ...(session ? [session] : []), "-",
    ],
    stdin: true,
    // {"type":"thread.started","thread_id":"…"} opens every turn, a resumed one too.
    sessionFromLine: (line) => field(line, "thread.started", "thread_id"),
    render: renderCodex,
  },
  // pi. It has no permission modes: its tools run as the user. `model` is a pattern
  // or provider/id; `thinking` is its level. A turn after the first opens the session
  // with --session, which fails on an unknown id (--session-id would make a new one).
  pi: {
    settings: { model: "optional", thinking: "optional" },
    argv: ({ model, thinking }, session, promptFile) => [
      "pi", "-p", "--mode", "json", ...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : []),
      ...(session ? ["--session", session] : []), "--", readFileSync(promptFile, "utf8"),
    ],
    stdin: false,
    // {"type":"session","id":"…"} is its first event.
    sessionFromLine: (line) => field(line, "session", "id"),
    render: renderPi,
  },
};

export const PROVIDERS = Object.keys(ADAPTERS);

// `key` of the event `line` when it is one of type `type`, else null.
function field(line, type, key) {
  try {
    const e = JSON.parse(line);
    return e?.type === type && typeof e[key] === "string" ? e[key] : null;
  } catch { return null; }
}
const firstLine = (text, n = 200) => String(text ?? "").split("\n")[0].slice(0, n);

// Why a role's launch settings cannot start a turn, or null.
export function settingsProblem(role, l) {
  const a = ADAPTERS[l.provider];
  if (!a) return `${role}: provider "${l.provider}" is not one this run can start (${PROVIDERS.join(", ")})`;
  for (const [k, need] of Object.entries(a.settings)) if (need === "required" && !l[k]) return `${role}: ${l.provider} needs --${role === "reviewer" ? "review-" : ""}${k}`;
  const extra = ["model", "mode", "profile", "thinking"].filter((k) => l[k] && !a.settings[k]);
  if (extra.length) return `${role}: ${l.provider} takes no ${extra.join(", ")}${l.provider === "dsh" ? " (its model and effort come from the dsh profile; set --profile)" : ""}`;
  return null;
}

// dsh's events, for a person watching the tab: what it says and the tools it calls.
function renderDsh(line) {
  let e;
  try { e = JSON.parse(line); } catch { return `${line}\n`; }
  switch (e?.type) {
    case "session": return `── session ${e.sessionId}\n`;
    case "text": return `${e.text}\n`;
    case "tool_call": {
      const input = e.input || {};
      const what = input.description || input.command || input.path || input.file_path || JSON.stringify(input).slice(0, 160);
      return `▸ ${e.tool}: ${String(what).split("\n")[0].slice(0, 200)}\n`;
    }
    case "tool_result": return e.status && e.status !== "completed" ? `  ✗ ${e.status}\n` : "";
    case "final": return `── ${e.reason?.kind ?? "final"}: ${String(e.text ?? "").split("\n").slice(-3).join("\n")}\n`;
    case "error": return `!! ${e.message}\n`;
    default: return "";
  }
}

// Codex's events: what it says, the commands it runs and how they end.
function renderCodex(line) {
  let e;
  try { e = JSON.parse(line); } catch { return `${line}\n`; }
  const item = e?.item || {};
  if (e?.type === "thread.started") return `── session ${e.thread_id}\n`;
  if (e?.type === "item.completed" && item.type === "agent_message") return `${item.text}\n`;
  if (e?.type === "item.started" && item.type === "command_execution") return `▸ shell: ${firstLine(item.command)}\n`;
  if (e?.type === "item.completed" && item.type === "command_execution" && item.exit_code) return `  ✗ exit ${item.exit_code}\n`;
  if (e?.type === "turn.completed") return "── turn completed\n";
  if (e?.type === "turn.failed" || e?.type === "error") return `!! ${e.error?.message ?? e.message ?? line}\n`;
  return "";
}

// pi's events: the assistant's text when a message ends, and its tool calls.
function renderPi(line) {
  let e;
  try { e = JSON.parse(line); } catch { return `${line}\n`; }
  if (e?.type === "session") return `── session ${e.id}\n`;
  if (e?.type === "message_end" && e.message?.role === "assistant") {
    const text = (e.message.content || []).filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n");
    return text ? `${text}\n` : "";
  }
  if (e?.type === "tool_execution_start") {
    const a = e.args || {};
    return `▸ ${e.toolName}: ${firstLine(a.command || a.path || a.file_path || JSON.stringify(a))}\n`;
  }
  if (e?.type === "tool_execution_end" && e.isError) return `  ✗ ${e.toolName} failed\n`;
  if (e?.type === "agent_end") return "── done\n";
  return "";
}
