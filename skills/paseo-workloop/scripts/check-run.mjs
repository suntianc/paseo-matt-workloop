#!/usr/bin/env node
// Runs one workloop check: `node check-run.mjs <token> <command>`.
//
// workloop.mjs starts every check through this wrapper. The token in its
// command line lets a later recovery confirm that a recorded pid is still this
// check before signalling it. The command does no work until workloop.mjs has
// recorded {pid, token} and writes "go" on stdin; if stdin closes first (the
// workloop process died), the wrapper exits without running anything.
import { spawn } from "node:child_process";

const [, , , cmd] = process.argv;
let line = "";
let started = false;

function start() {
  started = true;
  const child = spawn(cmd, { shell: true, stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (e) => { console.error(e.message); process.exit(1); });
  child.on("exit", (code) => process.exit(code ?? 1));
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  if (started) return;
  line += d;
  if (!line.includes("\n")) return;
  if (line.split("\n")[0].trim() === "go") start();
  else process.exit(1);
});
process.stdin.on("end", () => { if (!started) process.exit(1); });
process.stdin.on("error", () => { if (!started) process.exit(1); });
