// Time as the ledger writes it: a local timestamp with its UTC offset, matching
// the record examples (`2026-11-01T10:00:00+08:00`).
export function nowIso(date = new Date()) {
  const pad = (n, width = 2) => String(Math.abs(n)).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? "-" : "+"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
}

// A synchronous pause: the CLI is one short-lived process, so a sleep loop is the
// whole concurrency story here.
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
