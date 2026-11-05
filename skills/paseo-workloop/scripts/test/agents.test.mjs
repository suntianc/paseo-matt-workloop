// The CLI adapters: the command line of a first and a later turn, the conversation
// id each CLI prints, and the settings each takes. Guards against: a later turn that
// starts a new conversation instead of going on in its own, a setting silently
// dropped, a prompt that never reaches the CLI.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ADAPTERS, PROVIDERS, settingsProblem } from "../agents.mjs";
import { RENDERERS } from "../presenters.mjs";

const prompt = join(mkdtempSync(join(tmpdir(), "agents-")), "p.md");
const devinAcp = fileURLToPath(new URL("../devin-acp.mjs", import.meta.url));
writeFileSync(prompt, "do the thing\n");

test("every provider has an adapter, and each later turn names its conversation", () => {
  assert.deepEqual(PROVIDERS, ["dsh", "devin", "codex", "pi"]);
  const expected = {
    dsh: [["dsh", "--profile", "headless", "--json", "--permission-mode", "danger-full-access", "--approval-policy", "never", "-"],
      ["dsh", "--profile", "headless", "--json", "--permission-mode", "danger-full-access", "--approval-policy", "never", "--session-id", "S1", "-"]],
    devin: [[process.execPath, devinAcp, "--mode", "dangerous", "--prompt-file", prompt],
      [process.execPath, devinAcp, "--mode", "dangerous", "--session", "S1", "--prompt-file", prompt]],
    codex: [["codex", "exec", "--json", "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"', "-"],
      ["codex", "exec", "resume", "--json", "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"', "S1", "-"]],
    pi: [["pi", "-p", "--mode", "json", "--", "do the thing\n"],
      ["pi", "-p", "--mode", "json", "--session", "S1", "--", "do the thing\n"]],
  };
  for (const p of PROVIDERS) {
    const settings = p === "pi" ? {} : { mode: p === "devin" ? "dangerous" : "danger-full-access" };
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
  assert.equal(ADAPTERS.devin.sessionFromLine('{"type":"session","id":"devin-1"}'), "devin-1");
  assert.equal(ADAPTERS.codex.sessionFromLine('{"type":"thread.started","thread_id":"t-1"}'), "t-1");
  assert.equal(ADAPTERS.pi.sessionFromLine('{"type":"session","version":3,"id":"p-1","cwd":"/x"}'), "p-1");
  for (const p of ["dsh", "devin", "codex", "pi"]) {
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
  assert.match(RENDERERS.codex('{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}'), /● Done\./);
  assert.match(RENDERERS.codex('{"type":"item.started","item":{"type":"command_execution","command":"git status\\nmore"}}'), /Running git status/);
  assert.match(RENDERERS.codex('{"type":"item.completed","item":{"type":"command_execution","exit_code":2}}'), /✗.*exit 2/);
  assert.match(RENDERERS.pi('{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","text":"x"},{"type":"text","text":"DONE"}]}}'), /● DONE/);
  assert.match(RENDERERS.pi('{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"先检查"}]}}'), /Thinking[\s\S]*先检查/);
  assert.match(RENDERERS.pi('{"type":"tool_execution_start","toolName":"bash","args":{"command":"ls"}}'), /Running ls/);
  assert.equal(RENDERERS.pi('{"type":"message_update"}'), "");
});

test("plain Devin output keeps split UTF-8 intact and separates pauses at message boundaries", async () => {
  const { createPlainDisplay } = await import("../display.mjs");
  let output = "", now = 0;
  const display = createPlainDisplay((text) => { output += text; }, () => now);
  const text = Buffer.from("先检查。", "utf8");
  display.write(text.subarray(0, 2));
  display.write(text.subarray(2));
  now = 1200;
  display.write(Buffer.from("然后运行命令。"));
  display.end();
  assert.match(output, /先检查。\n\n.*然后运行命令。/s);
  assert.doesNotMatch(output, /�/);
});

test("plain text is not split inside a code fence", async () => {
  const { createPlainDisplay } = await import("../display.mjs");
  let output = "", now = 0;
  const display = createPlainDisplay((text) => { output += text; }, () => now);
  display.write(Buffer.from("Example:\n```js\nconsole.log('ok.'));"));
  now = 1000;
  display.write(Buffer.from("next();\n```"));
  display.end();
  assert.match(output, /console\.log\('ok\.'\)\);next\(\);/);
  assert.equal((output.match(/● /g) || []).length, 1);
});

test("structured providers show agent messages and tool outcomes", () => {
  const dsh = RENDERERS.dsh;
  assert.match(dsh('{"type":"tool_call","tool":"read","input":{"file_path":"a.txt"}}'), /Read.*a\.txt/);
  assert.match(dsh('{"type":"tool_result","status":"completed"}'), /✓/);
  assert.match(dsh('{"type":"tool_result","status":"completed","result":"line one\\nline two"}'), /line one[\s\S]*line two/);
  const dshPreview = dsh('{"type":"tool_result","status":"completed","result":"line one\\nline two\\nline three\\nline four"}');
  assert.match(dshPreview, /line one[\s\S]*line two/);
  assert.doesNotMatch(dshPreview, /line three|line four|\+2 lines/);
  assert.match(dsh('{"type":"thinking","text":"Checking the failure."}'), /Checking the failure/);
  assert.match(dsh('{"type":"final","reason":{"kind":"completed"},"text":"first\nsecond\nthird\nfourth"}'.replaceAll('\n', '\\n')), /first[\s\S]*fourth/);
  assert.match(RENDERERS.codex('{"type":"item.completed","item":{"type":"command_execution","exit_code":0}}'), /✓/);
  assert.match(RENDERERS.codex('{"type":"item.completed","item":{"type":"command_execution","exit_code":0,"aggregated_output":"tests passed"}}'), /tests passed/);
  assert.match(RENDERERS.pi('{"type":"tool_execution_end","toolName":"bash","isError":false}'), /✓.*bash/);
  assert.match(RENDERERS.pi('{"type":"tool_execution_end","toolName":"bash","isError":false,"result":{"content":[{"type":"text","text":"hello"}]}}'), /hello/);
});

test("agent runner renders a real child stream while preserving the raw log and session metadata", { skip: process.platform === "win32" && "uses a Unix executable fixture" }, () => {
  const root = mkdtempSync(join(tmpdir(), "agent-run-display-"));
  const bin = join(root, "dsh");
  const events = [
    '{"type":"session","sessionId":"session-example"}',
    '{"type":"text","text":"正在检查。"}',
    '{"type":"tool_call","tool":"read","input":{"path":"a.txt"}}',
    '{"type":"tool_result","status":"completed"}',
    '{"type":"final","reason":{"kind":"completed"},"text":"完成"}',
  ].join("\n"); // Last line intentionally has no newline.
  writeFileSync(bin, `#!${process.execPath}\nconst b=Buffer.from(${JSON.stringify(events)}); const i=b.indexOf(Buffer.from('正在'))+1; process.stdout.write(b.subarray(0,i)); setTimeout(()=>{ process.stdout.write(b.subarray(i)); process.exitCode=3; },10);\n`, { mode: 0o755 });
  const log = join(root, "turn.log"), meta = join(root, "turn.json"), promptFile = join(root, "prompt.md"), spec = join(root, "spec.json");
  writeFileSync(promptFile, "test\n");
  writeFileSync(spec, JSON.stringify({ provider: "dsh", settings: { mode: "danger-full-access" }, cwd: root, prompt: promptFile, log, meta, title: "#01 exec" }));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("../agent-run.mjs", import.meta.url)), spec], { encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stdout, /正在检查。/);
  assert.match(run.stdout, /Running Read a\.txt/);
  assert.match(run.stdout, /✓/);
  assert.match(run.stdout, /完成[\s\S]*Stopped · exit 3/);
  assert.equal(readFileSync(log, "utf8"), events);
  const result = JSON.parse(readFileSync(meta, "utf8"));
  assert.equal(result.session, "session-example");
  assert.equal(result.exitCode, 3);
});

test("provider icons animate only in a Rex terminal and stop after the turn", async () => {
  const { createProviderAnimation } = await import("../provider-animation.mjs");
  for (const provider of PROVIDERS) {
    let output = "";
    const stream = { isTTY: true, write: (s) => { output += s; } };
    const icon = createProviderAnimation(provider, { stream, env: { TERM_PROGRAM: "rex" }, id: 73 });
    assert.equal(icon.start(), true, provider);
    assert.match(output, /\x1b_Ga=T,.*i=73/);
    assert.match(output, /\x1b_Ga=f,.*i=73/);
    assert.equal((output.match(/\x1b_Ga=f,f=100,i=73,z=80,X=1,q=2,m=/g) || []).length, 23);
    assert.match(output, /\x1b_Ga=a,i=73,s=3/);
    const running = output;
    icon.stop();
    assert.match(output.slice(running.length), /\x1b_Ga=a,i=73,s=1/);
    const stopped = output;
    icon.stop();
    assert.equal(output, stopped);
  }
  let output = "";
  const redirected = createProviderAnimation("devin", { stream: { isTTY: false, write: (s) => { output += s; } }, env: { TERM_PROGRAM: "rex" } });
  assert.equal(redirected.start(), false);
  assert.equal(output, "");
  const otherTerminal = createProviderAnimation("devin", { stream: { isTTY: true, write: (s) => { output += s; } }, env: { TERM_PROGRAM: "other" } });
  assert.equal(otherTerminal.start(), false);
  assert.equal(output, "");
});
