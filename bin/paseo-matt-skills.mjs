#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { install } from '../lib/install.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'https://github.com/suntianc/paseo-matt-skills.git';
const help = `Usage: paseo-matt-skills [install|update|list] [options]

  install          Install the complete bundled collection (default command)
  update           Fetch current GitHub main and update a managed installation
  list             List the bundled skills

  --target <dir>   Skills directory (default: ~/.agents/skills)
  --dry-run        Validate and report without changing installed files
  --help           Show this help
  --version        Show the installer version

Examples:
  npx --yes github:suntianc/paseo-matt-skills#main install
  npx --yes github:suntianc/paseo-matt-skills#main update
  npx --yes github:suntianc/paseo-matt-skills#main install --target ~/.claude/skills

Install/update refuse unmanaged entries, symlinks, and locally modified files.
Update requires Git and network access; it fetches main even if npx cached the CLI.
`;

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`git: ${result.error?.message || result.stderr.trim()}`);
  return result.stdout.trim();
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { target: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' } },
  });
  if (values.help) { console.log(help); process.exit(0); }
  if (values.version) { console.log(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version); process.exit(0); }
  const command = positionals[0] ?? 'install';
  if (positionals.length > 1 || !['install', 'update', 'list'].includes(command)) throw new Error('Expected install, update, or list. See --help.');
  if (command === 'list') {
    for (const name of readdirSync(join(root, 'skills')).sort()) {
      if (existsSync(join(root, 'skills', name, 'SKILL.md'))) console.log(name);
    }
  } else {
    const target = values.target ?? join(homedir(), '.agents', 'skills');
    let checkout;
    try {
      let source = root;
      let revision = null;
      if (command === 'update') {
        checkout = mkdtempSync(join(tmpdir(), 'paseo-matt-skills-update-'));
        source = join(checkout, 'repo');
        git(['clone', '--depth', '1', '--single-branch', '--branch', 'main', repo, source]);
        revision = git(['-C', source, 'rev-parse', 'HEAD']);
      }
      const result = install({ source, target, update: command === 'update', dryRun: values['dry-run'], revision });
      console.log(`${result.dryRun ? 'Dry run OK' : command === 'update' ? 'Updated' : 'Installed'}: ${result.skills.length} skills, v${result.version}`);
      console.log(`Target: ${result.target}`);
      if (result.revision) console.log(`Source: ${repo} @ ${result.revision}`);
      console.log('Restart or reload your agent to discover the installed skills.');
    } finally {
      if (checkout) rmSync(checkout, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error(`paseo-matt-skills: ${error.message}`);
  process.exitCode = 1;
}
