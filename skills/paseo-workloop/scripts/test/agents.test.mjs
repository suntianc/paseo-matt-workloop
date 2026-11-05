// The CLI adapters: the command line of a first and a later turn, the conversation
// id each CLI prints, and the settings each takes. Guards against: a later turn that
// starts a new conversation instead of going on in its own, a setting silently
// dropped, a prompt that never reaches the CLI.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ADAPTERS, PROVIDERS, settingsProblem } from "../agents.mjs";

const prompt = join(mkdtempSync(join(tmpdir(), "agents-")), "p.md");
writeFileSync(prompt, "do the thing\n");

test("every provider has an adapter, and each later turn names its conversation", () => {
  assert.deepEqual(PROVIDERS, ["dsh", "devin", "codex", "pi"]);
  const expected = {
    dsh: [["dsh", "--profile", "headless", "--json", "--permission-mode", "danger-full-access", "--approval-policy", "never", "-"],
      ["dsh", "--profile", "headless", "--json", "--permission-mode", "danger-full-access", "--approval-policy", "never", "--session-id", "S1", "-"]],
    devin: [["devin", "--permission-mode", "danger-full-access", "--respect-workspace-trust=false", "--prompt-file", prompt, "-p"],
      ["devin", "--permission-mode", "danger-full-access", "--respect-workspace-trust=false", "-r", "S1", "--prompt-file", prompt, "-p"]],
    codex: [["codex", "exec", "--json", "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"', "-"],
      ["codex", "exec", "resume", "--json", "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"', "S1", "-"]],
    pi: [["pi", "-p", "--mode", "json", "--", "do the thing\n"],
      ["pi", "-p", "--mode", "json", "--session", "S1", "--", "do the thing\n"]],
  };
  for (const p of PROVIDERS) {
    const settings = p === "pi" ? {} : { mode: "danger-full-access" };
    assert.deepEqual(ADAPTERS[p].argv(settings, null, prompt), expected[p][0], `${p} first turn`);
    assert.deepEqual(ADAPTERS[p].argv(settings, "S1", prompt), expected[p][1], `${p} later turn`);
  }
});

test("codex and pi pass their model and thinking; the prompt goes on stdin or as the message", () => {
  assert.deepEqual(ADAPTERS.codex.argv({ mode: "read-only", model: "m1", thinking: "high" }, null),
    ["codex", "exec", "--json", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "-m", "m1", "-c", 'model_reasoning_effort="high"', "-"]);
  assert.deepEqual(ADAPTERS.pi.argv({ model: "magpie/x", thinking: "low" }, null, prompt), ["pi", "-p", "--mode", "json", "--model", "magpie/x", "--thinking", "low", "--", "do the thing\n"]);
  assert.equal(ADAPTERS.codex.stdin, true);
  assert.equal(ADAPTERS.dsh.stdin, true);
  assert.equal(ADAPTERS.pi.stdin, false);
  assert.equal(ADAPTERS.devin.stdin, false);
});

test("the conversation id is read from each CLI's own first event", () => {
  assert.equal(ADAPTERS.dsh.sessionFromLine('{"type":"session","sessionId":"session-1","cwd":"/x"}'), "session-1");
  assert.equal(ADAPTERS.codex.sessionFromLine('{"type":"thread.started","thread_id":"t-1"}'), "t-1");
  assert.equal(ADAPTERS.pi.sessionFromLine('{"type":"session","version":3,"id":"p-1","cwd":"/x"}'), "p-1");
  for (const p of ["dsh", "codex", "pi"]) {
    assert.equal(ADAPTERS[p].sessionFromLine('{"type":"turn.started"}'), null);
    assert.equal(ADAPTERS[p].sessionFromLine("not json"), null);
  }
});

test("each provider's settings: a missing mode and a setting it does not take are refused", () => {
  assert.equal(settingsProblem("executor", { provider: "codex", mode: "danger-full-access", model: "m", thinking: "high" }), null);
  assert.equal(settingsProblem("executor", { provider: "pi", model: "m", thinking: "low" }), null);
  assert.match(settingsProblem("reviewer", { provider: "codex" }), /codex needs --review-mode/);
  assert.match(settingsProblem("executor", { provider: "pi", mode: "full" }), /pi takes no mode/);
  assert.match(settingsProblem("executor", { provider: "codex", mode: "read-only", profile: "p" }), /codex takes no profile/);
  assert.match(settingsProblem("executor", { provider: "devin", mode: "auto", thinking: "max" }), /devin takes no thinking/);
  assert.match(settingsProblem("executor", { provider: "claude", mode: "x" }), /provider "claude" is not one this run can start \(dsh, devin, codex, pi\)/);
});

test("codex and pi output reads as text and tool lines in the tab", () => {
  assert.equal(ADAPTERS.codex.render('{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}'), "Done.\n");
  assert.equal(ADAPTERS.codex.render('{"type":"item.started","item":{"type":"command_execution","command":"git status\\nmore"}}'), "▸ shell: git status\n");
  assert.equal(ADAPTERS.codex.render('{"type":"item.completed","item":{"type":"command_execution","exit_code":2}}'), "  ✗ exit 2\n");
  assert.equal(ADAPTERS.pi.render('{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","text":"x"},{"type":"text","text":"DONE"}]}}'), "DONE\n");
  assert.equal(ADAPTERS.pi.render('{"type":"tool_execution_start","toolName":"bash","args":{"command":"ls"}}'), "▸ bash: ls\n");
  assert.equal(ADAPTERS.pi.render('{"type":"message_update"}'), "");
});
