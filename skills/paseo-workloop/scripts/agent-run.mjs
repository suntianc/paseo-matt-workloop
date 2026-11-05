#!/usr/bin/env node
// One turn of an executor or reviewer, run in its own Rex tab: start the CLI with
// its prompt, show what it does in the tab, keep everything it printed in the log,
// and write the turn's meta file (the conversation id, then how the turn ended).
// The tab's exit status is the CLI's, so `rex wait` on the tab reports the turn.
//
//   node agent-run.mjs <spec.json>
//   spec: { provider, settings, session, prompt, log, meta, cwd, title }
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { ADAPTERS } from "./agents.mjs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const adapter = ADAPTERS[spec.provider];
const meta = { provider: spec.provider, session: spec.session ?? null, startedAt: new Date().toISOString(), pid: process.pid };
function saveMeta() {
  const tmp = `${spec.meta}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(tmp, spec.meta);
}
function end(code) {
  meta.exitCode = code;
  meta.endedAt = new Date().toISOString();
  saveMeta();
  process.exit(code);
}

if (!adapter) {
  appendFileSync(spec.log, `agent-run: unknown provider ${spec.provider}\n`);
  end(2);
}
const argv = adapter.argv(spec.settings || {}, spec.session, spec.prompt);
meta.argv = argv;
saveMeta();
process.stdout.write(`── ${spec.title || spec.provider} · ${argv[0]} · ${spec.cwd}\n`);

const child = spawn(argv[0], argv.slice(1), { cwd: spec.cwd, stdio: [adapter.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
if (adapter.stdin) child.stdin.end(readFileSync(spec.prompt));

let pending = "";
child.stdout.on("data", (chunk) => {
  appendFileSync(spec.log, chunk);
  if (!adapter.render && !adapter.sessionFromLine) return void process.stdout.write(chunk);
  pending += chunk;
  const lines = pending.split("\n");
  pending = lines.pop();
  for (const line of lines) {
    const session = adapter.sessionFromLine?.(line);
    if (session && session !== meta.session) { meta.session = session; saveMeta(); }
    process.stdout.write(adapter.render ? adapter.render(line) : `${line}\n`);
  }
});
child.stderr.on("data", (chunk) => {
  appendFileSync(spec.log, chunk);
  process.stderr.write(chunk);
});
child.on("error", (e) => {
  appendFileSync(spec.log, `agent-run: cannot start ${argv[0]}: ${e.message}\n`);
  end(127);
});
// Ctrl-C in the tab reaches the CLI as well (same foreground group); a signal sent
// to this process alone is passed on, so the CLI never outlives its turn.
for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("close", (code, signal) => {
  if (pending && adapter.render) process.stdout.write(adapter.render(pending));
  if (!meta.session && adapter.sessionAfter) meta.session = adapter.sessionAfter(spec.cwd);
  if (signal) meta.signal = signal;
  end(code ?? 128 + (constants.signals[signal] || 0));
});
