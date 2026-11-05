// The CLIs an executor or reviewer runs as. An adapter says what differs about one:
// the settings it takes, its command line for a turn (a new conversation, or the
// same one again), how the prompt reaches it, and where the conversation's id
// shows up so a later turn can go on in it.
//
// A turn is one headless process: it gets its prompt, works, and exits. The run
// learns that a turn ended from the process exiting, and what it did from the
// report file its brief names.
import { spawnSync } from "node:child_process";

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
};

export const PROVIDERS = Object.keys(ADAPTERS);

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
