// The frontmatter dialect: the slice of YAML a requirement record uses — nested
// mappings, lists of scalars, lists of mappings, inline `[a, b]` / `{k: v}` flow
// collections, and single-line scalars. A person hand-edits these files, so the
// parser is lenient about quoting and trailing comments and strict about
// structure: when it cannot read a document it says so, and `doctor` reports the
// file instead of guessing at half a record.
//
// Anything outside the dialect (anchors, tags, block scalars, multi-line flow,
// multi-document files) is an error rather than a silent misreading.

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message);
    this.name = "YamlError";
    this.line = line;
  }
}

const KEY = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/;

export function parseYaml(text) {
  const rows = String(text).replace(/\r\n/g, "\n").split("\n");
  const lines = [];
  rows.forEach((row, index) => {
    if (/^[\t ]*\t/.test(row)) throw new YamlError("tab indentation is not supported", index + 1);
    const body = row.trim();
    if (!body || body.startsWith("#")) return;
    lines.push({ indent: row.length - row.trimStart().length, text: body, line: index + 1 });
  });
  if (!lines.length) return {};
  if (lines[0].indent !== 0) throw new YamlError("the first key must start at the left margin", lines[0].line);
  const [value, next] = parseMapping(lines, 0, 0);
  if (next !== lines.length) throw new YamlError("unexpected indentation", lines[next].line);
  return value;
}

function parseMapping(lines, start, indent) {
  const out = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (line.text.startsWith("-")) throw new YamlError("a list item where a key was expected", line.line);
    const match = KEY.exec(line.text);
    if (!match) throw new YamlError(`expected "key: value", found ${JSON.stringify(line.text)}`, line.line);
    const [, key, rest = ""] = match;
    if (Object.hasOwn(out, key)) throw new YamlError(`duplicate key "${key}"`, line.line);
    if (rest.trim() === "") {
      const nextLine = lines[i + 1];
      if (nextLine && nextLine.indent > indent && nextLine.text.startsWith("-")) {
        [out[key], i] = parseList(lines, i + 1, nextLine.indent);
      } else if (nextLine && nextLine.indent > indent) {
        [out[key], i] = parseMapping(lines, i + 1, nextLine.indent);
      } else {
        out[key] = null;
        i += 1;
      }
    } else {
      out[key] = parseValue(rest, line.line);
      i += 1;
    }
  }
  if (i < lines.length && lines[i].indent > indent) throw new YamlError("unexpected indentation", lines[i].line);
  return [out, i];
}

function parseList(lines, start, indent) {
  const out = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("-")) {
    const line = lines[i];
    const rest = line.text === "-" ? "" : line.text.slice(1).trimStart();
    if (rest === "") {
      const nextLine = lines[i + 1];
      if (!nextLine || nextLine.indent <= indent) {
        out.push(null);
        i += 1;
      } else if (nextLine.text.startsWith("-")) {
        const [value, next] = parseList(lines, i + 1, nextLine.indent);
        out.push(value);
        i = next;
      } else {
        const [value, next] = parseMapping(lines, i + 1, nextLine.indent);
        out.push(value);
        i = next;
      }
      continue;
    }
    const entry = KEY.exec(rest);
    if (entry) {
      // "- project: myapp" opens a mapping item; its following keys line up under
      // the first one, so the item's indent is where its content starts.
      const contentIndent = indent + (line.text.length - rest.length);
      const [key, valueText = ""] = [entry[1], entry[2] ?? ""];
      const item = {};
      if (valueText.trim() === "") {
        const nextLine = lines[i + 1];
        if (nextLine && nextLine.indent > contentIndent) {
          const [nested, next] = nextLine.text.startsWith("-")
            ? parseList(lines, i + 1, nextLine.indent)
            : parseMapping(lines, i + 1, nextLine.indent);
          item[key] = nested;
          i = next;
        } else {
          item[key] = null;
          i += 1;
        }
      } else {
        item[key] = parseValue(valueText, line.line);
        i += 1;
      }
      const [more, next] = parseMapping(lines, i, contentIndent);
      Object.assign(item, more);
      out.push(item);
      i = next;
      continue;
    }
    out.push(parseValue(rest, line.line));
    i += 1;
  }
  if (i < lines.length && lines[i].indent > indent) throw new YamlError("unexpected indentation", lines[i].line);
  return [out, i];
}

function parseValue(text, line) {
  const body = stripComment(text).trim();
  if (body === "") return null;
  if (body.startsWith("[") || body.startsWith("{")) return parseFlow(body, line);
  return parseScalar(body, line);
}

// Cut a trailing " # comment" that sits outside quotes and outside flow brackets.
function stripComment(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === "#" && depth === 0 && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

function parseFlow(text, line) {
  let i = 0;
  const space = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  const expect = (ch) => {
    if (text[i] !== ch) throw new YamlError(`expected "${ch}"`, line);
    i += 1;
  };
  const value = () => {
    space();
    if (text[i] === "[") {
      i += 1;
      const list = [];
      space();
      if (text[i] === "]") { i += 1; return list; }
      for (;;) {
        list.push(value());
        space();
        if (text[i] === ",") { i += 1; space(); if (text[i] === "]") { i += 1; return list; } continue; }
        expect("]");
        return list;
      }
    }
    if (text[i] === "{") {
      i += 1;
      const map = {};
      space();
      if (text[i] === "}") { i += 1; return map; }
      for (;;) {
        space();
        const key = bare();
        space();
        expect(":");
        map[key] = value();
        space();
        if (text[i] === ",") { i += 1; continue; }
        expect("}");
        return map;
      }
    }
    return parseScalar(bare(), line);
  };
  const bare = () => {
    const start = i;
    let quote = null;
    while (i < text.length) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\" && quote === '"') i += 2;
        else { if (ch === quote) quote = null; i += 1; }
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; i += 1; continue; }
      if (ch === "," || ch === "]" || ch === "}" || ch === ":") break;
      i += 1;
    }
    const raw = text.slice(start, i).trim();
    if (raw === "") throw new YamlError("expected a value", line);
    return raw;
  };
  const out = value();
  space();
  if (i !== text.length) throw new YamlError("unexpected text after a flow collection", line);
  return out;
}

function parseScalar(text, line) {
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new YamlError("an unterminated quoted string", line);
    try { return JSON.parse(text); } catch { throw new YamlError("a quoted string with invalid escapes", line); }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new YamlError("an unterminated quoted string", line);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

// ---------------------------------------------------------------- emitting

export function stringifyYaml(value) {
  if (!isMapping(value)) throw new TypeError("frontmatter must be a mapping");
  const out = [];
  emitMapping(value, 0, out);
  return out.length ? `${out.join("\n")}\n` : "";
}

function emitMapping(object, indent, out) {
  const pad = " ".repeat(indent);
  for (const [key, raw] of Object.entries(object)) {
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      if (!raw.length) out.push(`${pad}${key}: []`);
      else if (raw.every(isScalar) && flowWidth(raw) <= 72) out.push(`${pad}${key}: [${raw.map(emitScalar).join(", ")}]`);
      else {
        out.push(`${pad}${key}:`);
        emitList(raw, indent + 2, out);
      }
    } else if (isMapping(raw)) {
      if (!Object.keys(raw).length) out.push(`${pad}${key}: {}`);
      else {
        out.push(`${pad}${key}:`);
        emitMapping(raw, indent + 2, out);
      }
    } else {
      out.push(`${pad}${key}: ${emitScalar(raw)}`);
    }
  }
}

function emitList(list, indent, out) {
  const pad = " ".repeat(indent);
  for (const item of list) {
    if (isMapping(item)) {
      const nested = [];
      emitMapping(item, indent + 2, nested);
      if (!nested.length) { out.push(`${pad}- {}`); continue; }
      out.push(`${pad}- ${nested[0].slice(indent + 2)}`);
      out.push(...nested.slice(1));
    } else if (Array.isArray(item)) {
      const nested = [];
      emitList(item, indent + 2, nested);
      if (!nested.length) { out.push(`${pad}- []`); continue; }
      out.push(`${pad}- ${nested[0].slice(indent + 2)}`);
      out.push(...nested.slice(1));
    } else {
      out.push(`${pad}- ${emitScalar(item)}`);
    }
  }
}

const FLOW_UNSAFE = /[#,[\]{}&*!|>'"%@`]/;

function emitScalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  const text = String(value);
  const unsafe =
    text === "" ||
    text !== text.trim() ||
    /[\n\r\t]/.test(text) ||
    text.startsWith("- ") ||
    text.startsWith("-") ||
    /^(null|~|true|false|-?\d+(\.\d+)?)$/.test(text) ||
    FLOW_UNSAFE.test(text) ||
    /:(\s|$)/.test(text) ||
    text.startsWith("? ");
  return unsafe ? JSON.stringify(text) : text;
}

const isScalar = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);
const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const flowWidth = (list) => list.reduce((n, item) => n + emitScalar(item).length + 2, 0);
