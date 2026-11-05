// The CLIs an executor or reviewer runs as. An adapter says what differs about one:
// the settings it takes, its command line for a turn (a new conversation, or the
// same one again), how the prompt reaches it, and where the conversation's id
// shows up so a later turn can go on in it.
//
// A turn is one headless process: it gets its prompt, works, and exits. The run
// learns that a turn ended from the process exiting, and what it did from the
// report file its brief names.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  },
  // Devin's ACP stream includes tool events and can load its existing print sessions.
  devin: {
    settings: { mode: "required", model: "optional" },
    argv: ({ mode, model }, session, promptFile) => [
      process.execPath, fileURLToPath(new URL("./devin-acp.mjs", import.meta.url)), "--mode", mode,
      ...(model ? ["--model", model] : []), ...(session ? ["--session", session] : []), "--prompt-file", promptFile,
    ],
    stdin: false,
    sessionFromLine: (line) => field(line, "session", "id"),
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
// Why a role's launch settings cannot start a turn, or null.
export function settingsProblem(role, l) {
  const a = ADAPTERS[l.provider];
  if (!a) return `${role}: provider "${l.provider}" is not one this run can start (${PROVIDERS.join(", ")})`;
  for (const [k, need] of Object.entries(a.settings)) if (need === "required" && !l[k]) return `${role}: ${l.provider} needs --${role === "reviewer" ? "review-" : ""}${k}`;
  const extra = ["model", "mode", "profile", "thinking"].filter((k) => l[k] && !a.settings[k]);
  if (extra.length) return `${role}: ${l.provider} takes no ${extra.join(", ")}${l.provider === "dsh" ? " (its model and effort come from the dsh profile; set --profile)" : ""}`;
  return null;
}
