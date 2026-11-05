// Build the self-contained renderer copied by the skill installer.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const vendor = join(repo, "skills/paseo-workloop/scripts/vendor");
const result = await build({
  entryPoints: [join(vendor, "terminal-source.mjs")],
  outfile: join(vendor, "terminal.cjs"),
  nodePaths: [join(here, "node_modules")],
  bundle: true, platform: "node", format: "cjs", target: "node20",
  minify: true, legalComments: "none", metafile: true,
});
const packages = new Set();
for (const name of Object.keys(result.metafile.inputs)) {
  const match = name.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) packages.add(match[1]);
}
let notice = "Licenses of the dependencies bundled into terminal.cjs\n\n";
for (const name of [...packages].sort()) {
  const directory = join(here, "node_modules", name);
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const licenseFile = name === "@earendil-works/pi-tui" ? join(here, "pi-LICENSE")
    : join(directory, readdirSync(directory).find((file) => /^(license|licence|copying)(\.|$)/i.test(file)));
  notice += `--- ${name} ${pkg.version} (${pkg.license}) ---\n\n${readFileSync(licenseFile, "utf8").replace(/\r\n?/g, "\n").trim()}\n\n`;
}
writeFileSync(join(vendor, "THIRD_PARTY_LICENSES.txt"), `${notice.trimEnd()}\n`);
