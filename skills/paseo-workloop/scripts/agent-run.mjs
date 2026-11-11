#!/usr/bin/env node
// One turn of an executor or reviewer, run in its own Rex tab: start the CLI with
// its prompt, show what it does in the tab, keep everything it printed in the log,
// and write the turn's meta file (the conversation id, then how the turn ended).
// The tab's exit status is the CLI's, so `rex wait` on the tab reports the turn.
//
//   node agent-run.mjs <spec.json>
//   spec: { provider, settings, session, prompt, log, meta, cwd, title }
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { ADAPTERS } from "./agents.mjs";
import { RENDERERS } from "./presenters.mjs";
import { createPlainDisplay, mark } from "./display.mjs";
import { createProviderAnimation } from "./provider-animation.mjs";
import { createMarkdownStream } from "./stream-markdown.mjs";
import { createToolHistory } from "./tool-history.mjs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const adapter = ADAPTERS[spec.provider];
const renderer = RENDERERS[spec.provider];
const icon = createProviderAnimation(spec.provider);
const startedAt = Date.now();
let tools, stream;
const meta = { provider: spec.provider, session: spec.session ?? null, startedAt: new Date().toISOString(), pid: process.pid };
function saveMeta() {
  const tmp = `${spec.meta}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(tmp, spec.meta);
}
function end(code) {
  stream?.flush();
  if (tools?.hasDetails()) tools.write(`\n${mark("Tool details", "2")}: ${spec.log}.tools.txt\n`);
  tools?.close();
  icon.stop();
  meta.exitCode = code;
  meta.endedAt = new Date().toISOString();
  saveMeta();
  process.stdout.write(`\n${code === 0 ? mark("✓", "32") : mark("✗", "31")} ${code === 0 ? "Finished" : "Stopped"} · exit ${code} · ${Math.round((Date.now() - startedAt) / 1000)}s\n`);
  process.exit(code);
}

if (!adapter) {
  appendFileSync(spec.log, `agent-run: unknown provider ${spec.provider}\n`);
  end(2);
}
if (spec.workspace) {
  const git = spawnSync("git", ["-C", spec.cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  const [root, branch] = (git.stdout || "").trim().split("\n");
  if (git.status !== 0 || realpathSync(root) !== realpathSync(spec.workspace.root) || realpathSync(spec.cwd) !== realpathSync(root) || branch !== spec.workspace.branch) {
    appendFileSync(spec.log, `agent-run: workspace mismatch: expected ${JSON.stringify(spec.workspace)}, cwd=${spec.cwd}, git=${git.stdout || git.stderr}\n`);
    end(2);
  }
  meta.workspace = { root: realpathSync(root), branch };
  appendFileSync(spec.log, `agent-run: workspace: ${meta.workspace.root} branch=${branch}\n`);
}
const argv = adapter.argv(spec.settings || {}, spec.session, spec.prompt);
meta.argv = argv;
saveMeta();
const indent = icon.start() ? "     " : "";
process.stdout.write(`${indent}${mark("╭─")} ${spec.title || spec.provider}  ${mark(`(${spec.provider})`, "2")}\n${indent}${mark("│")} ${spec.cwd}\n${indent}${mark("╰─")} log: ${spec.log}\n\n`);

const child = spawn(argv[0], argv.slice(1), { cwd: spec.cwd, stdio: [adapter.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
if (adapter.stdin) child.stdin.end(readFileSync(spec.prompt));
tools = createToolHistory({ provider: spec.provider, detailsPath: `${spec.log}.tools.txt`, interrupt: () => child.kill("SIGINT") });
stream = createMarkdownStream((text) => tools.write(text));
const context = { tools, stream };
if (tools.attach()) tools.write(`${mark("Ctrl+O", "2")} tools\n\n`);

let pending = "";
const decoder = new StringDecoder("utf8");
const plain = !renderer && !adapter.sessionFromLine ? createPlainDisplay((text) => tools.write(text)) : null;
function renderLine(line) {
  const session = adapter.sessionFromLine?.(line);
  if (session && session !== meta.session) { meta.session = session; saveMeta(); }
  try {
    tools.write(renderer ? renderer(line, context) : `${line}\n`);
  } catch (error) {
    const diagnostic = `agent-run: cannot render ${spec.provider} event: ${error.message}\n`;
    appendFileSync(spec.log, diagnostic);
    tools.writeError(diagnostic);
    end(1);
  }
}
child.stdout.on("data", (chunk) => {
  appendFileSync(spec.log, chunk);
  if (plain) return void plain.write(chunk);
  pending += decoder.write(chunk);
  const lines = pending.split("\n");
  pending = lines.pop();
  for (const line of lines) renderLine(line);
});
child.stderr.on("data", (chunk) => {
  appendFileSync(spec.log, chunk);
  tools.writeError(chunk);
});
child.on("error", (e) => {
  appendFileSync(spec.log, `agent-run: cannot start ${argv[0]}: ${e.message}\n`);
  end(127);
});
// Ctrl-C in the tab reaches the CLI as well (same foreground group); a signal sent
// to this process alone is passed on, so the CLI never outlives its turn.
for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("exit", () => {
  if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
  tools?.close();
  icon.stop();
});
child.on("close", (code, signal) => {
  if (plain) plain.end();
  else { pending += decoder.end(); if (pending) renderLine(pending); }
  if (!meta.session && adapter.sessionAfter) meta.session = adapter.sessionAfter(spec.cwd);
  if (signal) meta.signal = signal;
  end(code ?? 128 + (constants.signals[signal] || 0));
});
