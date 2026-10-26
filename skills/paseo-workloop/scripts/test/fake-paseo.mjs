#!/usr/bin/env node
// Stand-in for the paseo CLI, used by workloop.test.mjs through PASEO_CLI.
// Implements only the subcommands and flags workloop.mjs calls, with the JSON
// shapes recorded in ../../reference/paseo-compat.md. State: $FAKE_PASEO_DB.
// $FAKE_PASEO_FAIL="agent run" makes that subcommand fail once (then unsets itself).
// Providers: "fake" works, "down" is unavailable, "crashy" starts agents in status "error".
// Profiles are not served here: workloop.mjs reads them from $PASEO_HOME/config.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dbPath = process.env.FAKE_PASEO_DB;
const db = existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, "utf8")) : { n: 0, agents: [], workspaces: [], calls: [], failOnce: process.env.FAKE_PASEO_FAIL || null };
const save = () => writeFileSync(dbPath, JSON.stringify(db, null, 2));
const out = (x) => { save(); process.stdout.write(`${JSON.stringify(x, null, 2)}\n`); };
const err = (code, message) => { save(); process.stdout.write(`${JSON.stringify({ error: { code, message } })}\n`); process.exit(1); };

const argv = process.argv.slice(2);
const sub = argv.slice(0, 2).join(" ");
if (process.env.FAKE_PASEO_DELAY_COMMAND === sub) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_PASEO_DELAY_MS));
db.calls.push(argv);
if (db.failOnce === sub) { db.failOnce = null; err("INJECTED", `injected failure for ${sub}`); }

const flags = { label: [] };
const pos = [];
const BOOL = new Set(["--json", "-d", "--background", "-g", "-a", "--no-wait", "--force"]);
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (BOOL.has(a)) flags[a.replace(/^-+/, "")] = true;
  else if (a.startsWith("--")) {
    const k = a.slice(2);
    if (k === "label") flags.label.push(argv[++i]);
    else flags[k] = argv[++i];
  } else pos.push(a);
}
const git = (...a) => {
  const r = spawnSync("git", a, { encoding: "utf8" });
  if (r.status !== 0) err("GIT", r.stderr);
  return r.stdout.trim();
};
const agent = (id) => db.agents.find((a) => a.id === id || a.id.startsWith(id)) || err("NOT_FOUND", `agent ${id}`);

switch (sub) {
  case "workspace create":
  case "worktree create": {
    if (flags.mode !== "branch-off") err("UNSUPPORTED", "mode");
    const branch = flags["new-branch"].replace(/\//g, "-"); // paseo 0.11.2 flattens slashes
    const path = join(process.env.FAKE_PASEO_HOME, "worktrees", branch);
    const repo = flags.path || flags.cwd;
    git("-C", repo, "worktree", "add", "-b", branch, path, flags.base ?? "main");
    const workspaceId = `wks_${++db.n}`;
    db.workspaces.push({ workspaceId, project: "repo", name: branch, isolation: "worktree", cwd: path, repo, archived: false });
    out(sub === "workspace create" ? { workspaceId, name: branch, cwd: path, isolation: "worktree" } : { name: branch, branchName: branch, worktreePath: path });
    break;
  }
  case "provider ls":
    out([
      { provider: "fake", label: "Fake", status: "available", enabled: "Enabled", defaultMode: "full", modes: "Full Access" },
      { provider: "crashy", label: "Crashy", status: "available", enabled: "Enabled", defaultMode: "full", modes: "Full Access" },
      { provider: "down", label: "Down", status: "unavailable", enabled: "Disabled", defaultMode: "default", modes: "" },
    ]);
    break;
  case "agent run": {
    const id = `${String(++db.n).padStart(8, "0")}-fake-agent`;
    const labels = Object.fromEntries(flags.label.map((l) => l.split("=")));
    const status = flags.provider === "crashy" ? "error" : "running";
    db.agents.push({ id, title: flags.title, cwd: flags.cwd, labels, status, archived: false, prompts: [pos.at(-1)], args: argv, updatedAt: new Date().toISOString() });
    out({ agentId: id, status, cwd: flags.cwd });
    break;
  }
  case "agent ls": {
    const want = flags.label.map((l) => l.split("="));
    out(db.agents.filter((a) => (flags.a || !a.archived) && want.every(([k, v]) => a.labels[k] === v))
      .map((a) => ({ id: a.id, shortId: a.id.slice(0, 7), name: a.title, provider: "fake", status: a.status, cwd: a.cwd })));
    break;
  }
  case "agent inspect": {
    const a = agent(pos[0]);
    out({ Id: a.id, Name: a.title, Status: a.status, Archived: a.archived, Cwd: a.cwd, UpdatedAt: a.updatedAt, PendingPermissions: a.pending || [], ParentAgentId: a.parentAgentId || null });
    break;
  }
  case "agent send": {
    const a = agent(pos[0]);
    if (a.archived) err("SEND_FAILED", "Working directory does not exist");
    a.prompts.push(readFileSync(flags["prompt-file"], "utf8"));
    a.status = "running";
    out({ agentId: a.id, status: "running" });
    break;
  }
  case "agent archive": {
    const a = agent(pos[0]);
    Object.assign(a, { archived: true, status: "closed" });
    out({ agentId: a.id, archived: true });
    break;
  }
  case "schedule ls":
    // Paseo 0.12 lists new-agent schedules here, not agent-target heartbeats.
    out(db.schedules || []);
    break;
  case "heartbeat create": {
    const id = `hb_${++db.n}`;
    db.heartbeats ||= [];
    const h = { id, name: flags.name, status: "active", target: { type: "agent", agentId: process.env.PASEO_AGENT_ID }, prompt: pos[0], cron: flags.cron };
    db.heartbeats.push(h);
    const store = join(process.env.PASEO_HOME, "schedules");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, `${id}.json`), JSON.stringify(h));
    if (db.loseCreateReplyOnce) { db.loseCreateReplyOnce = false; err("INJECTED", "created heartbeat but lost the receipt"); }
    out({ id });
    break;
  }
  case "heartbeat delete": {
    const h = (db.heartbeats || []).find((h) => h.id === pos[0]);
    if (!h) err("HEARTBEAT_DELETE_FAILED", `Failed to delete heartbeat: Schedule not found: ${pos[0]}`);
    if (h.target.agentId !== process.env.PASEO_AGENT_ID) err("HEARTBEAT_DELETE_FAILED", `Heartbeat ${pos[0]} does not belong to agent`);
    db.heartbeats = (db.heartbeats || []).filter((h) => h.id !== pos[0]);
    const file = join(process.env.PASEO_HOME, "schedules", `${pos[0]}.json`);
    if (existsSync(file)) unlinkSync(file);
    if (db.loseDeleteReplyOnce) { db.loseDeleteReplyOnce = false; err("INJECTED", "deleted heartbeat but lost the receipt"); }
    out({ id: pos[0], status: "deleted" });
    break;
  }
  case "workspace ls":
    out(db.workspaces.filter((w) => !w.archived).map(({ archived, repo, ...w }) => w));
    break;
  case "workspace archive": {
    const w = db.workspaces.find((x) => x.workspaceId === pos[0]) || err("NOT_FOUND", pos[0]);
    git("-C", w.repo, "worktree", "remove", "--force", w.cwd); // like paseo 0.11.2: the branch survives
    w.archived = true;
    for (const a of db.agents) if (a.cwd === w.cwd) Object.assign(a, { archived: true, status: "closed" });
    out({ workspaceId: w.workspaceId, archived: true });
    break;
  }
  default:
    err("UNSUPPORTED", `fake paseo does not implement "${sub}"`);
}
