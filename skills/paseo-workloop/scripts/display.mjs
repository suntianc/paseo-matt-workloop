import { StringDecoder } from "node:string_decoder";
import { renderMarkdown, toolText, truncateToWidth } from "./markdown.mjs";

const color = process.stdout.isTTY && process.env.TERM !== "dumb" && !("NO_COLOR" in process.env);
export function mark(text, code = "36") {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function toolMark(status) {
  if (status === "running") return mark("◌", "33");
  if (status !== "completed" && status !== "failed") return mark("?", "2");
  const symbol = color ? "●" : status === "completed" ? "✓" : "✗";
  return mark(symbol, status === "completed" ? "32" : "31");
}

// A message starts with one muted dot; continuation lines align under its text.
export function messageBlock(text, { label = "Agent", first = true } = {}) {
  const rendered = renderMarkdown(text, Math.max(20, (process.stdout.columns || 100) - 2));
  if (!rendered) return "";
  if (label !== "Agent") {
    return `${first ? `${mark(`● ${label}`, label === "Thinking" ? "2" : "36")}\n` : ""}${rendered}`;
  }
  return `${first ? `${mark("●", "2")} ` : "  "}${rendered.replace(/\n/g, "\n  ")}`;
}

export function message(text, label = "Agent") {
  const block = messageBlock(text, { label });
  return block ? `\n${block}\n\n` : "";
}

// Keep a short preview in the terminal; the original provider event stays in the log.
export function preview(value, { lines: limit = 3, more = true } = {}) {
  const text = toolText(value);
  if (!text) return "";
  const lines = text.replace(/\n+$/, "").split("\n");
  const width = Math.max(16, Math.min(process.stdout.columns || 100, 120) - 6);
  const visible = lines.slice(0, limit).map((line) => `    ${mark("│", "2")} ${truncateToWidth(line, width)}`).join("\n");
  const hidden = Math.max(0, lines.length - limit);
  return `${visible}\n${more && hidden ? `    ${mark(`└ +${hidden} lines`, "2")}\n` : ""}`;
}

// Devin's print mode is plain text, not an event stream. Break at a quiet
// sentence boundary when it is safe to do so, while leaving the raw log intact.
export function createPlainDisplay(write, clock = Date.now) {
  const decoder = new StringDecoder("utf8");
  let started = false, lastAt = 0, tail = "", inFence = false, ticks = 0;
  function emit(text) {
    if (!text) return;
    const now = clock();
    if (!started) { write(`${mark("●", "2")} `); started = true; }
    else if (!inFence && now - lastAt >= 600 && /[.!?。！？…][”’"'`]*$/.test(tail) && !/^\s/.test(text)) {
      write(`\n\n${mark("●", "2")} `);
    }
    write(text);
    for (const char of text) {
      if (char === "`") { if (++ticks === 3) { inFence = !inFence; ticks = 0; } }
      else ticks = 0;
    }
    tail = (tail + text).slice(-32);
    lastAt = now;
  }
  return {
    write(chunk) { emit(decoder.write(chunk)); },
    end() { emit(decoder.end()); if (started && !tail.endsWith("\n")) write("\n"); },
  };
}
