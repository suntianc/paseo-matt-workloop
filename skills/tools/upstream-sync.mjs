#!/usr/bin/env node
// Keeps the upstream skills in this collection identical to mattpocock/skills.
// Usage: node tools/upstream-sync.mjs <upstream-clone> [--check]
//   copy (default): replace each skill listed in upstream.json with the clone's
//                   copy and record the clone's commit in upstream.json.
//   --check:        compare instead; exit 1 on any difference. Line endings are
//                   ignored, so a CRLF checkout on Windows still passes.
// The clone is only read: nothing in it is executed.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CONFIG = join(HERE, "upstream.json");
const args = process.argv.slice(2);
const check = args.includes("--check");
const clone = args.find((a) => !a.startsWith("--"));
if (!clone) {
  console.error("usage: node tools/upstream-sync.mjs <upstream-clone> [--check]");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));

function files(dir) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) throw new Error(`symlink in ${p}; refusing to copy it`);
      if (e.isDirectory()) walk(p);
      else if (e.name !== ".DS_Store") out.push(relative(dir, p).split("\\").join("/"));
    }
  })(dir);
  return out.sort();
}

function cloneCommit() {
  // fsmonitor off and no hooks: reading HEAD must not run anything from the clone.
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function findMoved(name) {
  const base = join(clone, "skills");
  return readdirSync(base).find((c) => existsSync(join(base, c, name, "SKILL.md")));
}

const commit = cloneCommit();
if (!commit) console.error(`warning: ${clone} is not a git checkout; cannot tell which commit it is`);
else if (check && commit !== cfg.commit) console.error(`warning: clone is at ${commit.slice(0, 7)} but upstream.json records ${cfg.commit.slice(0, 7)}; differences may be upstream changes`);

let problems = 0;
for (const [name, entry] of Object.entries(cfg.skills)) {
  const category = typeof entry === "string" ? entry : entry.category;
  const src = join(clone, "skills", category, name);
  const dst = join(ROOT, name);
  if (!existsSync(join(src, "SKILL.md"))) {
    const moved = findMoved(name);
    console.error(`${name}: not in upstream skills/${category}/${moved ? `; it is now in skills/${moved}/, update upstream.json` : "; removed upstream?"}`);
    problems++;
    continue;
  }
  // A local wrapper may keep the upstream SKILL.md as plain reference text,
  // avoiding a second discoverable skill with the same name.
  if (entry.reference) {
    const target = join(ROOT, entry.reference);
    const sourceText = readFileSync(join(src, "SKILL.md"), "utf8");
    if (check) {
      if (!existsSync(target) || readFileSync(target, "utf8").replace(/\r\n/g, "\n") !== sourceText.replace(/\r\n/g, "\n")) {
        console.error(`${name}: reference differs at ${entry.reference}`);
        problems++;
      }
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, sourceText);
      console.log(`${name}: copied as reference ${entry.reference}`);
    }
    continue;
  }
  if (!check) {
    files(src); // refuses symlinks before anything is deleted
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true, filter: (p) => !p.endsWith(".DS_Store") });
    console.log(`${name}: copied from skills/${category}/`);
    continue;
  }
  if (!existsSync(dst)) {
    console.error(`${name}: missing locally`);
    problems++;
    continue;
  }
  const a = files(src);
  const b = files(dst);
  const diffs = [
    ...a.filter((f) => !b.includes(f)).map((f) => `missing ${f}`),
    ...b.filter((f) => !a.includes(f)).map((f) => `extra ${f}`),
    ...a.filter((f) => b.includes(f)).filter((f) => {
      const norm = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
      return norm(join(src, f)) !== norm(join(dst, f));
    }).map((f) => `changed ${f}`),
  ];
  if (diffs.length) {
    console.error(`${name}: ${diffs.join(", ")}`);
    problems++;
  }
}

if (check) {
  const known = new Set([...Object.keys(cfg.skills), ...cfg.local]);
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith(".") && !known.has(e.name) && existsSync(join(ROOT, e.name, "SKILL.md"))) {
      console.error(`${e.name}: not listed in upstream.json (add it to "skills" or "local")`);
      problems++;
    }
  }
  if (!problems) console.log(`OK ${Object.keys(cfg.skills).length} upstream skills match ${cfg.repo}@${cfg.commit.slice(0, 7)}`);
} else if (commit && commit !== cfg.commit) {
  cfg.commit = commit;
  writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`upstream.json now records ${commit.slice(0, 7)}`);
}
process.exitCode = problems ? 1 : 0;
