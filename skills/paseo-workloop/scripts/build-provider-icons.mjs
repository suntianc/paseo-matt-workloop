// Development-only: RESVG_MODULE points to a locally installed @resvg/resvg-js.
// Runtime reads the generated PNGs and does not require a renderer or network.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { Resvg } = require(process.env.RESVG_MODULE || "@resvg/resvg-js");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "provider-icons");
const colors = { devin: "#83afff", codex: "#a3e8d0", dsh: "#66b2ff", pi: "#f1be58" };
const frames = 24;
const selected = process.argv.slice(2);
for (const provider of selected) if (!(provider in colors)) throw new Error(`Unknown provider: ${provider}`);
for (const [provider, color] of Object.entries(colors)) {
  if (selected.length && !selected.includes(provider)) continue;
  const input = readFileSync(join(root, "svg", `${provider}.svg`), "utf8").replace(/<\?xml[^>]*\?>/g, "");
  const logo = input.replace(/<svg\b([^>]*)>/, (_, attrs) => `<svg${attrs.replace(/\s(?:width|height)="[^"]*"/g, "")} x="8" y="8" width="48" height="48">`);
  const dest = join(root, "frames", provider);
  mkdirSync(dest, { recursive: true });
  for (let i = 0; i < frames; i++) {
    const angle = i * Math.PI * 2 / frames;
    const scale = 0.96 + 0.04 * Math.cos(angle);
    const dotX = 32 + 29 * Math.cos(angle - Math.PI / 2);
    const dotY = 32 + 29 * Math.sin(angle - Math.PI / 2);
    const tailX = 32 + 29 * Math.cos(angle - Math.PI / 2 - 1.05);
    const tailY = 32 + 29 * Math.sin(angle - Math.PI / 2 - 1.05);
    const foreground = provider === "codex" ? ' color="#e2f7ee"' : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><defs><linearGradient id="trail" gradientUnits="userSpaceOnUse" x1="${tailX}" y1="${tailY}" x2="${dotX}" y2="${dotY}"><stop offset="0" stop-color="${color}" stop-opacity="0"/><stop offset="0.65" stop-color="${color}" stop-opacity="0.35"/><stop offset="1" stop-color="${color}" stop-opacity="0.9"/></linearGradient></defs><circle cx="32" cy="32" r="29" fill="none" stroke="${color}" stroke-opacity="0.16" stroke-width="1.5"/><g${foreground} transform="translate(32 32) scale(${scale}) translate(-32 -32)">${logo}</g><path d="M ${tailX} ${tailY} A 29 29 0 0 1 ${dotX} ${dotY}" fill="none" stroke="url(#trail)" stroke-width="2.5" stroke-linecap="round"/><circle cx="${dotX}" cy="${dotY}" r="5" fill="${color}" fill-opacity="0.15"/><circle cx="${dotX}" cy="${dotY}" r="2.5" fill="${color}"/><circle cx="${dotX}" cy="${dotY}" r="1" fill="#fff" fill-opacity="0.85"/></svg>`;
    writeFileSync(join(dest, `${String(i).padStart(2, "0")}.png`), new Resvg(svg).render().asPng());
  }
}
