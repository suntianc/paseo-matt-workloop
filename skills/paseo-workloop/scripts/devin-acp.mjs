#!/usr/bin/env node
// Drive one Devin turn through ACP so the display can see tool lifecycle events.
// The session is persisted by Devin and can also be resumed by its print mode.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
}
const mode = option("--mode");
const model = option("--model");
const previousSession = option("--session");
const promptFile = option("--prompt-file");
const modes = { auto: "ask", "accept-edits": "accept-edits", smart: "smart", dangerous: "bypass" };
if (!Object.hasOwn(modes, mode) || !promptFile) {
  process.stderr.write("devin-acp: expected a supported --mode and --prompt-file\n");
  process.exit(2);
}

const command = ["acp", ...(model && !previousSession ? ["--model", model] : [])];
const child = spawn("devin", command, {
  cwd: process.cwd(),
  env: { ...process.env, RUST_LOG: process.env.RUST_LOG || "error" },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.pipe(process.stderr);
let nextId = 0, sessionId = null, streaming = false, stopping = false, fatalError;
const pending = new Map();
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

function request(method, params) {
  return new Promise((resolve, reject) => {
    if (fatalError) return reject(fatalError);
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function rejectPending(error) {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

function respondToAgent(event) {
  if (event.method === "session/request_permission") {
    const preferred = mode === "dangerous" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
    const choice = preferred.map((kind) => event.params?.options?.find((item) => item.kind === kind)).find(Boolean);
    send({
      jsonrpc: "2.0", id: event.id,
      result: { outcome: choice ? { outcome: "selected", optionId: choice.optionId } : { outcome: "cancelled" } },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: event.id, error: { code: -32601, message: "Method not supported" } });
}

createInterface({ input: child.stdout }).on("line", (line) => {
  let event;
  try { event = JSON.parse(line); } catch (error) {
    fatalError = new Error(`Invalid Devin ACP message: ${error.message}`);
    rejectPending(fatalError);
    child.kill("SIGTERM");
    return;
  }
  if (event.method && event.id != null) return respondToAgent(event);
  if (event.method === "session/update") {
    // session/load replays history. The tab shows only this turn's new events.
    if (streaming && event.params?.sessionId === sessionId) emit({ type: "acp_update", update: event.params.update });
    return;
  }
  const waiter = pending.get(event.id);
  if (!waiter) return;
  pending.delete(event.id);
  if (event.error) waiter.reject(new Error(event.error.message || "Devin ACP request failed"));
  else waiter.resolve(event.result);
});
child.on("error", (error) => rejectPending(error));
child.on("close", (code, signal) => rejectPending(new Error(`Devin ACP exited (${signal || code})`)));
child.stdin.on("error", (error) => { fatalError = error; rejectPending(error); });

function modelValue(options, requested) {
  const normalized = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const flatten = (items) => items.flatMap((item) => item.options ? flatten(item.options) : [item]);
  const choices = flatten(options.find((item) => item.id === "model")?.options || []);
  const wanted = normalized(requested);
  const exact = choices.find((item) => normalized(item.value) === wanted || normalized(item.name) === wanted);
  if (exact) return exact.value;
  const matches = choices.filter((item) => normalized(item.value).includes(wanted) || normalized(item.name).includes(wanted));
  if (matches.length === 1) return matches[0].value;
  throw new Error(`Cannot resolve Devin model "${requested}" for the resumed session; use its exact model ID`);
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (sessionId && streaming) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  const timer = setTimeout(() => child.kill(signal), 1500);
  timer.unref();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(signal));

try {
  const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "workloop", version: "1" } });
  if (previousSession && !init.agentCapabilities?.loadSession) throw new Error("Devin ACP cannot resume sessions");
  const session = previousSession
    ? await request("session/load", { sessionId: previousSession, cwd: process.cwd(), mcpServers: [] })
    : await request("session/new", { cwd: process.cwd(), mcpServers: [] });
  sessionId = previousSession || session.sessionId;
  if (!sessionId) throw new Error("Devin ACP did not return a session ID");
  emit({ type: "session", id: sessionId });
  await request("session/set_config_option", { sessionId, configId: "mode", value: modes[mode] });
  if (previousSession && model) {
    const value = modelValue(session.configOptions || [], model);
    await request("session/set_config_option", { sessionId, configId: "model", value });
  }
  streaming = true;
  const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: readFileSync(promptFile, "utf8") }] });
  streaming = false;
  if (result?.stopReason !== "end_turn") throw new Error(`Devin stopped: ${result?.stopReason || "unknown reason"}`);
  emit({ type: "turn.completed" });
} catch (error) {
  emit({ type: "error", message: error.message });
  process.exitCode = stopping ? 130 : 1;
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
}
