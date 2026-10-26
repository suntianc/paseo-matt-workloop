// Heartbeats are hidden from `paseo schedule ls/inspect` in Paseo 0.12.
// Keep a durable ledger around every daemon mutation; never infer absence from
// those commands. All deletion still goes through the ownership-checking CLI.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export class HeartbeatError extends Error {}
const fail = (message) => { throw new HeartbeatError(message); };
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);

function localHeartbeats(name, owner) {
  if (process.env.PASEO_HOST) return [];
  const home = (process.env.PASEO_HOME || join(homedir(), ".paseo")).replace(/^~(?=$|[\\/])/, homedir());
  const dir = join(home, "schedules");
  if (!existsSync(dir)) return [];
  const result = [];
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    let h;
    try { h = JSON.parse(readFileSync(join(dir, file.name), "utf8")); }
    catch (e) { if (e instanceof SyntaxError || e.code === "ENOENT") continue; throw e; }
    if (h.target?.type === "agent" && h.target.agentId === owner
      && (h.name === name || h.name?.startsWith(`${name}:`))) {
      if (!validId(h.id) || file.name !== `${h.id}.json`) fail(`invalid owned heartbeat record in ${dir}`);
      result.push(h);
    }
  }
  return result;
}

function confirmedMissing(error, id) {
  return error.paseoCode === "HEARTBEAT_DELETE_FAILED" && [
    `Failed to delete heartbeat: Schedule not found: ${id}`,
    `Failed to delete heartbeat: Heartbeat not found: ${id}`,
  ].includes(error.paseoMessage);
}

export function maintainHeartbeat({ dir, state: s, owner, wanted, due, prompt, call, persist,
  receiptIds = [], clearPending = false, reason }) {
  const name = `workloop:${s.runKey}:${owner}`;
  const migrating = !s.heartbeatLedger;
  const ledger = s.heartbeatLedger ||= { version: 1, ids: [], pendingCreate: null };
  if (ledger.version !== 1 || !Array.isArray(ledger.ids)) fail("unsupported heartbeat ledger; preserve it and reconcile before continuing");
  function track(h) {
    if (!validId(h.id) || h.owner !== owner) fail("heartbeat ledger has an invalid ID or a different owner; not deleting it");
    if (!ledger.ids.some((x) => x.id === h.id)) ledger.ids.push({ ...h });
  }
  for (const h of ledger.ids) if (!validId(h.id) || h.owner !== owner) fail("heartbeat ledger ownership mismatch");
  if (s.heartbeat) track(s.heartbeat);

  // Upgrade old runs using their receipts, including older IDs no longer in
  // state. Re-deleting an acknowledged-gone ID is safe and explicitly checked.
  if (migrating) {
    const log = join(dir, "events.jsonl");
    if (existsSync(log)) for (const line of readFileSync(log, "utf8").split("\n")) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.kind === "watch" && event.heartbeat?.owner === owner) track(event.heartbeat);
    }
  }
  const discovered = migrating || ledger.pendingCreate ? localHeartbeats(name, owner) : [];
  for (const h of discovered) track({ id: h.id, owner, name: h.name });

  let recovered = false;
  if (ledger.pendingCreate) {
    if (ledger.pendingCreate.owner !== owner) fail("pending heartbeat creation belongs to a different owner");
    const matches = discovered.filter((h) => h.name === ledger.pendingCreate.name);
    if (matches.length) {
      const active = matches.find((h) => h.status === "active" && Date.parse(ledger.pendingCreate.due) > Date.now());
      s.heartbeat = active ? { id: active.id, owner, name: active.name, due: ledger.pendingCreate.due } : null;
      ledger.pendingCreate = null;
      recovered = Boolean(active);
    }
  }
  // Explicit receipt IDs are for recovery when the daemon is remote or its
  // store is unavailable. They are persisted and ownership-checked on delete.
  for (const id of receiptIds) track({ id, owner });
  if (receiptIds.length && ledger.pendingCreate) {
    ledger.pendingCreate = null;
    s.heartbeat = null;
  }
  if (clearPending) {
    if (!reason) fail("--clear-heartbeat-create needs --reason explaining how creation was confirmed not to occur");
    ledger.pendingCreate = null;
  }
  persist("heartbeat-reconcile", { ids: ledger.ids.map((h) => h.id), pendingCreate: ledger.pendingCreate, ...(clearPending ? { reason } : {}) });
  if (ledger.pendingCreate) fail(`pending heartbeat creation ${ledger.pendingCreate.name} has no confirmed receipt. Do not create another. Recover its ID with watch --heartbeat-id <id>; if creation definitely never occurred, use --clear-heartbeat-create --reason <evidence>`);

  function removeExcept(keep) {
    for (const h of [...ledger.ids]) {
      if (h.id === keep) continue;
      let absent = false;
      try {
        const result = call(["heartbeat", "delete", h.id, "--json"]);
        if (result?.id !== h.id || result?.status !== "deleted") fail(`heartbeat ${h.id} deletion returned no matching acknowledgement; its ID is retained`);
      } catch (e) {
        if (!confirmedMissing(e, h.id)) throw e;
        absent = true;
      }
      ledger.ids = ledger.ids.filter((x) => x.id !== h.id);
      if (s.heartbeat?.id === h.id) s.heartbeat = null;
      persist("heartbeat-deleted", { id: h.id, owner, confirmedAbsent: absent });
    }
  }

  // Failed previous cleanups must finish before another create can happen.
  removeExcept(wanted ? s.heartbeat?.id : null);
  if (!wanted || recovered) return;

  const intent = { name: `${name}:${randomUUID()}`, owner, due: due.toISOString() };
  ledger.pendingCreate = intent;
  persist("heartbeat-create-intent", { ...intent });
  const result = call(["heartbeat", "create", prompt, "--cron", `${due.getUTCMinutes()} ${due.getUTCHours()} ${due.getUTCDate()} ${due.getUTCMonth() + 1} *`,
    "--timezone", "UTC", "--max-runs", "1", "--expires-in", "2h", "--name", intent.name, "--json"]);
  if (!validId(result?.id)) fail("heartbeat creation returned no valid ID; pending creation retained for reconciliation");
  const created = { id: result.id, ...intent };
  track(created);
  s.heartbeat = created;
  ledger.pendingCreate = null;
  // Persist the new ID together with every old ID BEFORE trying to delete any.
  persist("heartbeat-created", { ...created });
  removeExcept(created.id);
}
