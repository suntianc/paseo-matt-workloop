#!/usr/bin/env node
// Checks that every relative markdown link and skill:// reference in the
// collection points at a real file.
// Usage: node tools/link-check.mjs [skills-root]   (default: the repo root)
// Links resolve relative to the file they're in, so links to sibling skills
// (../grill-me/SKILL.md) are checked too. skill://<name>[/<path>] resolves to
// <root>/<name>/SKILL.md or <root>/<name>/<path>.
// Skips external URLs, anchors, absolute paths, <placeholder> targets and
// anything inside fenced code blocks.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
let failures = 0;
const fail = (file, line, msg) => { console.error(`FAIL ${relative(root, file)}:${line}: ${msg}`); failures++; };

const mdFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) mdFiles.push(p);
  }
})(root);

const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|skill:\/\/([A-Za-z0-9_-]+(?:\/[\w./-]+)?)/g;

for (const file of mdFiles) {
  const lines = String(readFileSync(file, "utf8")).split("\n");
  let inFence = false;
  lines.forEach((text, i) => {
    if (/^\s*```/.test(text)) { inFence = !inFence; return; }
    if (inFence) return;
    for (const m of text.matchAll(LINK)) {
      const [, mdTarget, skillRef] = m;
      if (skillRef) {
        const [name, ...rest] = skillRef.split("/");
        const p = rest.length ? join(root, name, ...rest) : join(root, name, "SKILL.md");
        if (!existsSync(p)) fail(file, i + 1, `skill://${skillRef} -> ${relative(root, p)} missing`);
        continue;
      }
      const t = mdTarget;
      if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(t) || t.startsWith("mailto:")) continue; // external
      if (t.startsWith("#")) continue;                                                // anchor
      if (/[<>]/.test(t)) continue;                                                   // placeholder
      if (/^([A-Za-z]:[\\/]|\/)/.test(t)) continue;                                   // absolute
      const target = resolve(dirname(file), t.split("#")[0]);
      if (!existsSync(target)) fail(file, i + 1, `link target "${t}" missing`);
    }
  });
}

if (!failures) console.log(`OK ${mdFiles.length} markdown files — all relative links and skill:// refs resolve`);
process.exitCode = failures ? 1 : 0;
