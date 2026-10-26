#!/usr/bin/env node
// Optional Claude Code Stop hook. Only renew this agent's workloop watches.
// No global configuration edits, no model calls, and no blocking Stop decision.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const owner = process.env.PASEO_AGENT_ID;
const root = resolve((process.env.WORKLOOP_ROOT || join(homedir(), ".workloop")).replace(/^~(?=$|[\\/])/, homedir()));
if (owner && existsSync(root)) {
  const deadline = Date.now() + 45000;
  for (const project of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const feature of readdirSync(join(root, project.name), { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const dir = join(root, project.name, feature.name);
      const path = join(dir, "state.json");
      if (!existsSync(path)) continue;
      try {
        const s = JSON.parse(readFileSync(path, "utf8"));
        const heartbeatPending = s.heartbeat || s.heartbeatLedger?.ids?.length || s.heartbeatLedger?.pendingCreate;
        if (s.orchestratorId !== owner || (!heartbeatPending && (s.finishedAt || !Object.values(s.tasks).some((t) => ["running", "in_review"].includes(t.status))))) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Stop hook time budget exhausted; run workloop watch manually");
        const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "workloop.mjs"), "--run", dir, "watch"], {
          encoding: "utf8", timeout: Math.min(15000, remaining), killSignal: "SIGKILL",
          env: { ...process.env, PASEO_TIMEOUT_MS: "5000" },
        });
        if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr.trim());
        if (r.stdout.includes("异常")) console.error(r.stdout.trim());
      } catch (e) { console.error(`workloop Stop hook: ${e.message}`); }
    }
  }
}
