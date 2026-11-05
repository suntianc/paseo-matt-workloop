import terminal from "./vendor/terminal.cjs";
import { stripVTControlCharacters } from "node:util";

const { Markdown, diffLines, highlight, supportsLanguage, truncateToWidth, wrapTextWithAnsi } = terminal;
const color = process.stdout.isTTY && process.env.TERM !== "dumb" && !("NO_COLOR" in process.env);
const style = (code) => (text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;

// Provider text must not move the cursor or inject terminal control sequences.
export function safeText(value) {
  return stripVTControlCharacters(String(value ?? "")).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

const theme = {
  heading: style("1;36"), link: style("34;4"), linkUrl: style("2"),
  code: style("35"), codeBlock: style("37"), codeBlockBorder: style("2"),
  quote: style("2"), quoteBorder: style("36"), hr: style("2"), listBullet: style("36"),
  bold: style("1"), italic: style("3"), strikethrough: style("9"), underline: style("4"),
  highlightCode(code, language) {
    const lang = String(language || "").split(/\s+/)[0].toLowerCase();
    if (!color || !lang || !supportsLanguage(lang)) return code.split("\n");
    return highlight(code, { language: lang, ignoreIllegals: true }).split("\n");
  },
};

export function renderMarkdown(text, width = process.stdout.columns || 100) {
  const content = safeText(text).replace(/^\n+|\n+$/g, "");
  if (!content) return "";
  const columns = Math.max(20, Math.min(width, 120));
  return new Markdown(content, 0, 0, theme).render(columns).map((line) => line.replace(/ +$/, "")).join("\n");
}

export function renderCommand(command) {
  const text = safeText(command).split("\n")[0];
  return color ? highlight(text, { language: "bash", ignoreIllegals: true }) : text;
}

export function toolText(value) {
  if (value == null) return "";
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value)) return value.map(toolText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (value.type === "diff") {
      const changes = diffLines(safeText(value.oldText), safeText(value.newText));
      return [safeText(value.path), ...changes.flatMap((part) => part.value.replace(/\n$/, "").split("\n")
        .map((line) => `${part.added ? "+" : part.removed ? "-" : " "} ${line}`))].filter(Boolean).join("\n");
    }
    if (typeof value.text === "string") return safeText(value.text);
    if (value.content != null) return toolText(value.content);
    return safeText(JSON.stringify(value, null, 2));
  }
  return safeText(value);
}

export { truncateToWidth, wrapTextWithAnsi };
