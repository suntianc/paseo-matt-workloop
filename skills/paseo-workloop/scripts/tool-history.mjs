import { appendFileSync, closeSync, mkdtempSync, openSync, readSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { toolMark } from "./display.mjs";
import { safeText, toolText, truncateToWidth, wrapTextWithAnsi } from "./markdown.mjs";

// The normal transcript remains in Rex's scrollback. The temporary alternate
// screen is used only while the user inspects a tool result.
export function createToolHistory({ provider, detailsPath, input = process.stdin, output = process.stdout, errorOutput = process.stderr, interrupt = () => {} } = {}) {
  const records = [], byId = new Map();
  let directory, fd, offset = 0, active = false, selected = 0, scroll = 0, queued = [], queuedBytes = 0;
  let attached = false, originalRaw = false, hasDetails = false;
  const interactive = provider !== "dsh" && input.isTTY && output.isTTY && typeof input.setRawMode === "function";

  function save(text) {
    if (!text || provider === "dsh") return null;
    if (fd == null) {
      directory = mkdtempSync(join(tmpdir(), "workloop-tools-"));
      fd = openSync(join(directory, "results"), "w+");
    }
    const bytes = Buffer.from(text, "utf8"), at = offset;
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, at + written);
    offset += bytes.length;
    return { at, length: bytes.length };
  }

  function content(record) {
    if (!record?.saved) return "";
    const bytes = Buffer.alloc(record.saved.length);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, record.saved.at + read);
      if (!n) break;
      read += n;
    }
    return bytes.subarray(0, read).toString("utf8");
  }

  function start(id, title) {
    const key = id || `anonymous-${records.length}`;
    if (byId.has(key)) return byId.get(key);
    const record = { id: key, title: safeText(title), status: "running", saved: null };
    records.push(record);
    byId.set(key, record);
    if (active) draw();
    return record;
  }

  function update(id, { title, status, result } = {}) {
    const record = byId.get(id) || start(id, title || "Tool");
    if (title) record.title = safeText(title);
    if (status) record.status = status;
    if (result != null) record.saved = save(toolText(result));
    if (detailsPath && provider !== "dsh" && !record.persisted && (status === "completed" || status === "failed")) {
      const text = content(record);
      if (text) {
        appendFileSync(detailsPath, `\n── ${record.title} · ${status}\n${text}\n`, { mode: 0o600 });
        record.persisted = true;
        hasDetails = true;
      }
    }
    if (active) draw();
    return record;
  }

  function draw() {
    if (!active) return;
    const width = Math.max(20, output.columns || 80), height = Math.max(10, output.rows || 24);
    const listHeight = Math.max(2, Math.min(6, Math.floor((height - 5) / 3)));
    const listStart = Math.max(0, Math.min(selected - listHeight + 1, records.length - listHeight));
    const rows = ["Tool calls  ↑↓ select · PgUp/PgDn scroll · Esc return", "─".repeat(width)];
    if (!records.length) rows.push("  No tool calls yet.");
    for (let i = listStart; i < Math.min(records.length, listStart + listHeight); i++) {
      const record = records[i];
      const symbol = toolMark(record.status);
      rows.push(truncateToWidth(`${i === selected ? "›" : " "} ${symbol} ${record.title}`, width));
    }
    rows.push("─".repeat(width));
    const record = records[selected];
    const detail = record ? content(record) || (record.status === "running" ? "Running…" : "No text output.") : "";
    const lines = detail.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
    const available = Math.max(1, height - rows.length - 1);
    scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - available)));
    rows.push(...lines.slice(scroll, scroll + available));
    rows.push(`${record ? selected + 1 : 0}/${records.length}  ·  ${scroll + 1}/${Math.max(1, lines.length)}`);
    output.write(`\x1b[H\x1b[2J${rows.slice(0, height).map((line) => truncateToWidth(line, width)).join("\r\n")}`);
  }

  function closeOverlay() {
    if (!active) return;
    active = false;
    output.write("\x1b[?1049l\x1b[?25h");
    for (const item of queued) item.destination.write(item.text);
    queued = [];
    queuedBytes = 0;
  }

  function write(text, destination = output) {
    if (!active) return destination.write(text);
    queued.push({ text, destination });
    queuedBytes += Buffer.byteLength(text);
    // Keep a forgotten overlay from retaining unbounded live output.
    if (queuedBytes > 1024 * 1024) closeOverlay();
    return true;
  }

  function keypress(_text, key = {}) {
    if (key.ctrl && key.name === "c") return interrupt();
    if (key.ctrl && key.name === "o") {
      if (active) closeOverlay();
      else {
        selected = Math.max(0, records.length - 1);
        scroll = 0;
        active = true;
        output.write("\x1b[?1049h\x1b[?25l");
        draw();
      }
      return;
    }
    if (!active) return;
    if (key.name === "escape" || key.name === "q") return closeOverlay();
    if (key.name === "up" || key.name === "k") { selected = Math.max(0, selected - 1); scroll = 0; }
    if (key.name === "down" || key.name === "j") { selected = Math.max(0, Math.min(records.length - 1, selected + 1)); scroll = 0; }
    if (key.name === "pageup") scroll -= Math.max(1, (output.rows || 24) - 10);
    if (key.name === "pagedown") scroll += Math.max(1, (output.rows || 24) - 10);
    if (key.name === "home") scroll = 0;
    if (key.name === "end") scroll = Number.MAX_SAFE_INTEGER;
    draw();
  }

  function attach() {
    if (!interactive || attached) return false;
    attached = true;
    originalRaw = !!input.isRaw;
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on("keypress", keypress);
    input.resume();
    output.on("resize", draw);
    return true;
  }

  function close() {
    closeOverlay();
    if (attached) {
      input.removeListener("keypress", keypress);
      output.removeListener("resize", draw);
      input.setRawMode(originalRaw);
      input.pause();
      attached = false;
    }
    if (fd != null) {
      closeSync(fd);
      unlinkSync(join(directory, "results"));
      rmdirSync(directory);
      fd = undefined;
    }
  }

  return {
    attach, close, get: (id) => byId.get(id), hasDetails: () => hasDetails,
    result: (id) => content(byId.get(id)), start, update, write,
    writeError: (text) => write(text, errorOutput),
  };
}
