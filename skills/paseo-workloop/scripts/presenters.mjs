import { mark, message, preview, toolMark } from "./display.mjs";
import { renderCommand, safeText } from "./markdown.mjs";

const firstLine = (text, n = 200) => String(text ?? "").split("\n")[0].slice(0, n);

function toolTitle(name, input = {}, provided = "") {
  const value = typeof input === "string" ? input
    : input && typeof input === "object"
      ? input.command || input.path || input.file_path || input.description || (Object.keys(input).length ? JSON.stringify(input) : "")
      : input == null ? "" : String(input);
  const tool = String(name || "").toLowerCase();
  const verb = /^(bash|shell|exec|execute|terminal)$/.test(tool) ? "Ran"
    : /^(read|read_file)$/.test(tool) ? "Read"
      : /^(edit|write|write_file|edit_file)$/.test(tool) ? "Edited" : name || "Tool";
  return safeText(value ? `${verb} ${value}` : provided || verb);
}

function showTool(title) {
  const line = firstLine(title);
  if (line.startsWith("Ran ")) return `${mark("Ran", "1")} ${renderCommand(line.slice(4))}`;
  return line;
}

function showRunning(title) {
  const line = firstLine(title);
  return line.startsWith("Ran ") ? renderCommand(line.slice(4)) : line;
}

// dsh's events, for a person watching the tab: what it says and the tools it calls.
function renderDsh(line, context) {
  const e = JSON.parse(line);
  switch (e?.type) {
    case "session": return `${mark("◆")} session ${e.sessionId}\n`;
    case "text": return message(e.text);
    case "thinking": return message(e.text, "Thinking");
    case "tool_call": {
      const input = e.input || {};
      const title = toolTitle(e.tool, input);
      context?.tools.start(e.callId, title);
      return `${mark("◌", "33")} Running ${showRunning(title)}\n`;
    }
    case "tool_result": {
      const status = e.status === "completed" ? "completed" : e.status ? "failed" : "unknown";
      const title = context?.tools.get(e.callId)?.title || e.status || "Tool";
      context?.tools.update(e.callId, { title, status });
      return `${toolMark(status)} ${showTool(title)}\n`
        + preview(e.result ?? e.error?.reason ?? e.error?.message, { lines: 2, more: false });
    }
    case "final": return message(e.text, e.reason?.kind === "completed" ? "Result" : (e.reason?.kind ?? "Result"));
    case "error": return `${mark("✗", "31")} ${e.message}\n`;
    default: return "";
  }
}

// Codex's events: what it says, the commands it runs and how they end.
function renderCodex(line, context) {
  const e = JSON.parse(line);
  const item = e?.item || {};
  if (e?.type === "thread.started") return `${mark("◆")} session ${e.thread_id}\n`;
  if (e?.type === "item.completed" && item.type === "agent_message") return message(item.text);
  if (e?.type === "item.completed" && item.type === "reasoning" && item.text) return message(item.text, "Thinking");
  if (e?.type === "item.started" && item.type === "command_execution") {
    const title = toolTitle("bash", { command: item.command });
    context?.tools.start(item.id, title);
    return `${mark("◌", "33")} Running ${renderCommand(firstLine(item.command))}\n`;
  }
  if (e?.type === "item.updated" && item.type === "command_execution") {
    context?.tools.update(item.id, { result: item.aggregated_output });
    return "";
  }
  if (e?.type === "item.completed" && item.type === "command_execution") {
    const title = item.command ? toolTitle("bash", { command: item.command }) : context?.tools.get(item.id)?.title || "Command";
    const status = item.exit_code === 0 && !["failed", "declined"].includes(item.status) ? "completed"
      : typeof item.exit_code === "number" || ["failed", "declined"].includes(item.status) ? "failed" : "unknown";
    context?.tools.update(item.id, { title, status, result: item.aggregated_output });
    return `${toolMark(status)} ${showTool(title)} · exit ${item.exit_code ?? "unknown"}\n` + preview(item.aggregated_output);
  }
  if (e?.type === "item.completed" && item.type === "file_change") {
    const changes = (item.changes || []).map((c) => `${c.kind} ${c.path}`).join(", ");
    const status = item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : "unknown";
    context?.tools.update(item.id, { title: `Files ${changes}`, status, result: changes });
    return `${toolMark(status)} Files ${safeText(changes)}\n`;
  }
  if (e?.type === "item.started" && item.type === "mcp_tool_call") {
    const title = `${item.server}.${item.tool}`;
    context?.tools.start(item.id, title);
    return `${mark("◌", "33")} ${safeText(title)}\n`;
  }
  if (e?.type === "item.completed" && item.type === "mcp_tool_call") {
    const title = `${item.server}.${item.tool}`, ok = !item.error && item.status !== "failed";
    const result = item.error?.message || item.result?.content || item.result?.structured_content;
    context?.tools.update(item.id, { title, status: ok ? "completed" : "failed", result });
    return `${toolMark(ok ? "completed" : "failed")} ${safeText(title)}\n` + preview(result);
  }
  if (["item.started", "item.completed"].includes(e?.type) && item.type === "web_search") {
    const title = `Search ${safeText(item.query || "")}`;
    if (e.type === "item.started") {
      context?.tools.start(item.id, title);
      return `${mark("◌", "33")} ${title}\n`;
    }
    context?.tools.update(item.id, { title, status: "completed", result: item.results });
    return `${toolMark("completed")} ${title}\n` + preview(item.results);
  }
  if (["item.started", "item.completed"].includes(e?.type) && item.type === "collab_tool_call") {
    const title = `Agent ${safeText(item.tool || "task")}`;
    if (e.type === "item.started") {
      context?.tools.start(item.id, title);
      return `${mark("◌", "33")} ${title}\n`;
    }
    const status = item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : "unknown";
    context?.tools.update(item.id, { title, status, result: item.agents_states });
    return `${toolMark(status)} ${title}\n`;
  }
  if (e?.type === "turn.completed") return `${mark("✓", "32")} turn completed\n`;
  if (e?.type === "turn.failed" || e?.type === "error") return `${mark("✗", "31")} ${e.error?.message ?? e.message ?? line}\n`;
  return "";
}

// pi's events: the assistant's text when a message ends, and its tool calls.
function renderPi(line, context) {
  const e = JSON.parse(line);
  if (e?.type === "session") return `${mark("◆")} session ${e.id}\n`;
  if (e?.type === "message_end" && e.message?.role === "assistant") {
    return (e.message.content || []).map((part) => {
      if (part.type === "thinking" && (part.thinking || part.text)) return message(part.thinking || part.text, "Thinking");
      return part.type === "text" && part.text ? message(part.text) : "";
    }).join("");
  }
  if (e?.type === "tool_execution_start") {
    const a = e.args || {};
    const title = toolTitle(e.toolName, a);
    context?.tools.start(e.toolCallId, title);
    return `${mark("◌", "33")} Running ${showRunning(title)}\n`;
  }
  if (e?.type === "tool_execution_update") {
    context?.tools.update(e.toolCallId, { result: e.partialResult });
    return "";
  }
  if (e?.type === "tool_execution_end") {
    const title = context?.tools.get(e.toolCallId)?.title || e.toolName || "Tool";
    context?.tools.update(e.toolCallId, { title, status: e.isError ? "failed" : "completed", result: e.result });
    return `${toolMark(e.isError ? "failed" : "completed")} ${showTool(title)}\n` + preview(e.result);
  }
  if (e?.type === "agent_end") return `${mark("✓", "32")} turn completed\n`;
  return "";
}

function renderDevin(line, context) {
  const e = JSON.parse(line);
  if (e?.type === "session") return `${mark("◆")} session ${e.id}\n`;
  if (e?.type === "turn.completed") { context?.stream.flush(); return `${mark("✓", "32")} turn completed\n`; }
  if (e?.type === "error") { context?.stream.flush(); return `${mark("✗", "31")} ${safeText(e.message)}\n`; }
  if (e?.type !== "acp_update") return "";
  const update = e.update || {};
  if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
    const label = update.sessionUpdate === "agent_thought_chunk" ? "Thinking" : "Agent";
    const text = update.content?.type === "text" ? update.content.text : "";
    if (context?.stream) { context.stream.push(text, label, update.messageId); return ""; }
    return text ? message(text, label) : "";
  }
  if (update.sessionUpdate === "tool_call") {
    context?.stream.flush();
    const title = toolTitle(update.kind, update.rawInput, update.title);
    context?.tools.start(update.toolCallId, title);
    if (update.content) context?.tools.update(update.toolCallId, { result: update.content });
    return `${mark("◌", "33")} Running ${showRunning(title)}\n`;
  }
  if (update.sessionUpdate === "tool_call_update") {
    const id = update.toolCallId, previous = context?.tools.get(id);
    const title = update.rawInput ? toolTitle(update.kind, update.rawInput, update.title) : update.title || previous?.title || "Tool";
    const complete = update.status === "completed", failed = update.status === "failed" || update.status === "cancelled";
    const result = update.rawOutput ?? update.content;
    context?.tools.update(id, { title, status: complete ? "completed" : failed ? "failed" : undefined, result });
    if (!complete && !failed) return "";
    return `${toolMark(complete ? "completed" : "failed")} ${showTool(title)}\n` + preview(result ?? context?.tools.result(id));
  }
  return "";
}

export const RENDERERS = { dsh: renderDsh, devin: renderDevin, codex: renderCodex, pi: renderPi };
