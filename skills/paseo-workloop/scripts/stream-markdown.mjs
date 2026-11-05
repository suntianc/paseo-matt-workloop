import { messageBlock } from "./display.mjs";

// Append complete Markdown blocks to scrollback, without rewriting past output.
export function createMarkdownStream(write) {
  let buffer = "", scan = 0, label = null, messageId = null, opened = false, timer;

  function emit(text) {
    if (!text.trim()) return;
    const block = messageBlock(text, { label: label || "Agent", first: !opened });
    if (!block) return;
    write(`${opened ? "" : "\n"}${block}\n\n`);
    opened = true;
  }

  function closedFence(text) {
    let fence = null;
    for (const line of text.split("\n")) {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (!match) continue;
      if (!fence) fence = { char: match[1][0], length: match[1].length };
      else if (match[1][0] === fence.char && match[1].length >= fence.length && /^\s*$/.test(match[2])) fence = null;
    }
    return !fence;
  }

  function completeBlocks() {
    let end = 0, from = scan;
    while (true) {
      const at = buffer.indexOf("\n\n", from);
      if (at < 0) break;
      if (closedFence(buffer.slice(0, at))) end = at + 2;
      from = at + 2;
    }
    const searched = Math.max(from, buffer.length - 1);
    if (end) {
      emit(buffer.slice(0, end));
      buffer = buffer.slice(end);
    }
    scan = Math.max(0, searched - end);
  }

  function idleFlush() {
    timer = undefined;
    const text = buffer.trimEnd();
    if (!text || !/[.!?。！？…]$/.test(text) || !closedFence(text)) return;
    if ((text.match(/\*\*/g) || []).length % 2 || (text.match(/(?<!`)`(?!`)/g) || []).length % 2) return;
    if (text.split("\n").at(-1).includes("|")) return;
    emit(buffer);
    buffer = "";
    scan = 0;
  }

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    emit(buffer);
    buffer = "";
    scan = 0;
    label = null;
    messageId = null;
    opened = false;
  }

  function push(text, nextLabel = "Agent", nextId = null) {
    if (!text) return;
    if (label && (nextLabel !== label || (messageId && nextId && messageId !== nextId))) flush();
    label = nextLabel;
    messageId = nextId || messageId;
    buffer += text;
    completeBlocks();
    clearTimeout(timer);
    timer = setTimeout(idleFlush, 700);
    timer.unref();
  }

  return { push, flush };
}
