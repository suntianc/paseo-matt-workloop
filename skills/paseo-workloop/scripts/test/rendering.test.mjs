import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { message } from "../display.mjs";
import { renderMarkdown, toolText } from "../markdown.mjs";
import { createMarkdownStream } from "../stream-markdown.mjs";
import { createToolHistory } from "../tool-history.mjs";

test("Markdown renders Chinese, tables, fenced code, and strips terminal controls", () => {
  const fence = "`".repeat(3);
  const source = ["# 报告", "", "- **通过**", "", "| 检查 | 结果 |", "| --- | --- |", "| 中文 | 正常 |",
    "", `${fence}js`, "const count = 42;", fence, "", "\x1b[2Junsafe"].join("\n");
  const rendered = renderMarkdown(source, 60);
  assert.match(rendered, /报告[\s\S]*- 通过/);
  assert.match(rendered, /│ 检查 │ 结果 │[\s\S]*│ 中文 │ 正常 │/);
  assert.match(rendered, /const count = 42/);
  assert.doesNotMatch(rendered, /\*\*|^\| ---/m);
  assert.doesNotMatch(rendered, /\x1b/);
  assert.match(toolText({ type: "diff", path: "file.txt", oldText: "same\nold\n", newText: "same\nnew\n" }),
    /file\.txt[\s\S]*  same[\s\S]*- old[\s\S]*\+ new/);
});

test("streamed Markdown keeps split code fences and tables together", () => {
  let text = "";
  const stream = createMarkdownStream((chunk) => { text += chunk; });
  const fence = "`".repeat(3);
  stream.push("第一段 **完成**。\n\n");
  stream.push(`${fence}js\nconst n = `);
  stream.push("42;\n");
  assert.doesNotMatch(text, /const n/);
  stream.push(`${fence}\n\n| 项目 | 值 |\n| --- | --- |\n`);
  stream.push("| 中文 | 正常 |\n\n");
  stream.flush();
  assert.match(text, /第一段 完成。[\s\S]*const n = 42;[\s\S]*│ 中文 │ 正常 │/);
  assert.equal((text.match(/● /g) || []).length, 1);
  assert.match(text, /● 第一段 完成。[\s\S]*\n  ```js[\s\S]*\n  │ 中文 │ 正常 │/);
});

test("message content follows a single dot and continuation lines stay aligned", () => {
  const rendered = message("第一行\n第二行\n\n- **通过**");
  assert.match(rendered, /● 第一行[\s\S]*第二行[\s\S]*\n  - 通过/);
  assert.doesNotMatch(rendered, /● Agent/);
  assert.match(message("先检查", "Thinking"), /● Thinking\n先检查/);
});

test("all providers color messages and tool outcomes consistently", () => {
  const presenters = new URL("../presenters.mjs", import.meta.url).href;
  const script = `
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    const { RENDERERS } = await import(${JSON.stringify(presenters)});
    const line = (provider, event) => RENDERERS[provider](JSON.stringify(event));
    const events = {
      dsh: [{ type: "text", text: "正文" }, { type: "tool_result", status: "completed" }, { type: "tool_result", status: "failed" }],
      codex: [{ type: "item.completed", item: { type: "agent_message", text: "正文" } },
        { type: "item.completed", item: { type: "command_execution", exit_code: 0 } },
        { type: "item.completed", item: { type: "command_execution", exit_code: 1 } }],
      pi: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "正文" }] } },
        { type: "tool_execution_end", toolName: "bash", isError: false }, { type: "tool_execution_end", toolName: "bash", isError: true }],
      devin: [{ type: "acp_update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正文" } } },
        { type: "acp_update", update: { sessionUpdate: "tool_call_update", status: "completed" } },
        { type: "acp_update", update: { sessionUpdate: "tool_call_update", status: "failed" } }],
    };
    process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(events).map(([provider, items]) =>
      [provider, items.map((item) => line(provider, item))]))));
  `;
  const env = { ...process.env, TERM: "xterm-256color" };
  delete env.NO_COLOR;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  for (const [provider, [text, success, failure]] of Object.entries(JSON.parse(run.stdout))) {
    assert.match(text, /\x1b\[2m●\x1b\[0m 正文/, provider);
    assert.doesNotMatch(text, /● Agent/, provider);
    assert.match(success, /\x1b\[32m●\x1b\[0m/, provider);
    assert.match(failure, /\x1b\[31m●\x1b\[0m/, provider);
  }
});

test("a shorter nested fence does not end a streamed code block", () => {
  let text = "";
  const stream = createMarkdownStream((chunk) => { text += chunk; });
  const outer = "`".repeat(4), inner = "`".repeat(3);
  stream.push(`${outer}markdown\nbefore\n${inner}js\n\ninside\n`);
  assert.equal(text, "");
  stream.push(`${inner}\nafter\n${outer}\n\n`);
  stream.flush();
  assert.match(text, /before[\s\S]*inside[\s\S]*after/);
});

test("tool history opens a temporary view and preserves live terminal output", () => {
  class Input extends EventEmitter {
    isTTY = true;
    isRaw = false;
    setRawMode(value) { this.isRaw = value; }
    resume() {}
    pause() {}
  }
  class Output extends EventEmitter {
    isTTY = true;
    columns = 70;
    rows = 18;
    text = "";
    write(value) { this.text += value; return true; }
  }
  const root = mkdtempSync(join(tmpdir(), "tool-history-"));
  const details = join(root, "details.txt"), input = new Input(), output = new Output();
  const history = createToolHistory({ provider: "codex", detailsPath: details, input, output });
  assert.equal(history.attach(), true);
  history.start("one", "Ran npm test");
  history.update("one", { status: "completed", result: "one\ntwo\nthree\nfour" });
  history.write("before overlay\n");
  input.emit("keypress", "", { ctrl: true, name: "o" });
  assert.match(output.text, /\x1b\[\?1049h/);
  assert.match(output.text, /Ran npm test[\s\S]*one[\s\S]*four/);
  history.write("during overlay\n");
  assert.doesNotMatch(output.text, /during overlay/);
  input.emit("keypress", "", { name: "escape" });
  assert.match(output.text, /\x1b\[\?1049l[\s\S]*during overlay/);
  assert.match(readFileSync(details, "utf8"), /one[\s\S]*four/);
  history.close();
  assert.equal(input.isRaw, false);

  const dshDetails = join(root, "dsh.txt");
  const dsh = createToolHistory({ provider: "dsh", detailsPath: dshDetails, input, output });
  dsh.start("dsh", "Read file");
  dsh.update("dsh", { status: "completed", result: "one\ntwo\nthree" });
  dsh.close();
  assert.equal(existsSync(dshDetails), false);
});

test("a malformed provider event fails the turn and reports the rendering error", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "bad-provider-event-"));
  const executable = join(root, "dsh"), prompt = join(root, "prompt"), log = join(root, "turn.log");
  const meta = join(root, "turn.json"), spec = join(root, "turn.spec");
  writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write("not-json\\n"); setTimeout(() => {}, 30000);\n`, { mode: 0o755 });
  writeFileSync(prompt, "test");
  writeFileSync(spec, JSON.stringify({ provider: "dsh", settings: { mode: "danger-full-access" }, cwd: root, prompt, log, meta }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../agent-run.mjs", import.meta.url)), spec], {
    encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cannot render dsh event/);
  assert.match(readFileSync(log, "utf8"), /not-json[\s\S]*cannot render dsh event/);
  assert.equal(JSON.parse(readFileSync(meta, "utf8")).exitCode, 1);
});

test("Devin runner preserves tool results, resumes its session, and applies permission settings", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "devin-acp-fixture-"));
  const executable = join(root, "devin"), calls = join(root, "calls.jsonl");
  const fake = String.raw`#!${process.execPath}
const {createInterface} = require("node:readline");
const {appendFileSync} = require("node:fs");
const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const reply = (id, result) => send({jsonrpc:"2.0", id, result});
let promptId;
createInterface({input:process.stdin}).on("line", (line) => {
  const event=JSON.parse(line);
  appendFileSync(process.env.ACP_FIXTURE_CALLS,JSON.stringify(event)+"\n");
  if(event.method==="initialize") reply(event.id,{protocolVersion:1,agentCapabilities:{loadSession:true}});
  if(event.method==="session/new") reply(event.id,{sessionId:"D1",configOptions:[]});
  if(event.method==="session/load") {
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"D1",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"OLD HISTORY"}}}});
    reply(event.id,{configOptions:[{id:"model",options:[{value:"swe-2-high",name:"SWE-2"}]}]});
  }
  if(event.method==="session/set_config_option") reply(event.id,{});
  if(event.method==="session/prompt") {
    promptId=event.id;
    send({jsonrpc:"2.0",id:900,method:"session/request_permission",params:{options:[{kind:"allow_once",optionId:"allow"},{kind:"reject_once",optionId:"reject"}]}});
  }
  if(event.id===900 && event.result) {
    const update=(value)=>send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"D1",update:value}});
    update({sessionUpdate:"tool_call",toolCallId:"call-1",kind:"execute",rawInput:{command:"printf test"}});
    update({sessionUpdate:"tool_call_update",toolCallId:"call-1",status:"in_progress",content:[{type:"content",content:{type:"text",text:"one\ntwo\nthree\nfour"}}]});
    update({sessionUpdate:"tool_call_update",toolCallId:"call-1",status:"completed"});
    update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"**完成**"}});
    reply(promptId,{stopReason:"end_turn"});
  }
});
`;
  writeFileSync(executable, fake, { mode: 0o755 });
  const runner = fileURLToPath(new URL("../agent-run.mjs", import.meta.url));
  const promptFile = join(root, "prompt.md");
  writeFileSync(promptFile, "test");
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, ACP_FIXTURE_CALLS: calls };
  const run = (n, settings, session) => {
    const log = join(root, `turn-${n}.log`), meta = join(root, `turn-${n}.json`), spec = join(root, `turn-${n}.spec`);
    writeFileSync(spec, JSON.stringify({ provider: "devin", settings, session, cwd: root, prompt: promptFile, log, meta }));
    const result = spawnSync(process.execPath, [runner, spec], { encoding: "utf8", env, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return { ...result, log, meta };
  };
  const first = run(1, { mode: "dangerous" }, null);
  assert.match(first.stdout, /✓ Ran printf test[\s\S]*one[\s\S]*three[\s\S]*\+1 lines/);
  assert.doesNotMatch(first.stdout, /four/);
  assert.match(readFileSync(`${first.log}.tools.txt`, "utf8"), /one[\s\S]*four/);
  assert.match(readFileSync(first.log, "utf8"), /"sessionUpdate":"tool_call_update"/);
  assert.equal(JSON.parse(readFileSync(first.meta, "utf8")).session, "D1");
  const second = run(2, { mode: "auto", model: "SWE-2" }, "D1");
  assert.doesNotMatch(second.stdout, /OLD HISTORY/);
  assert.match(second.stdout, /完成/);
  const requests = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(requests.some((event) => event.method === "session/set_config_option" && event.params.value === "bypass"));
  assert.ok(requests.some((event) => event.method === "session/set_config_option" && event.params.value === "ask"));
  assert.ok(requests.some((event) => event.method === "session/set_config_option" && event.params.value === "swe-2-high"));
  assert.ok(requests.some((event) => event.id === 900 && event.result?.outcome?.optionId === "allow"));
  assert.ok(requests.some((event) => event.id === 900 && event.result?.outcome?.optionId === "reject"));
});
