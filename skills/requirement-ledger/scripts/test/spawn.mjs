// spawnSync with a ceiling. A child that never exits would otherwise hold the whole
// test file, and CI, until the runner gives up; this fails the test instead and names
// the command that hung, with whatever it printed.
import { spawnSync } from "node:child_process";

const HANG_MS = 120_000;

export function spawnBounded(command, args, options = {}) {
  const result = spawnSync(command, args, { timeout: HANG_MS, ...options });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`hung for ${HANG_MS / 1000}s and was killed: ${command} ${args.join(" ")}\n`
      + `stdout: ${result.stdout ?? ""}\nstderr: ${result.stderr ?? ""}`);
  }
  return result;
}
