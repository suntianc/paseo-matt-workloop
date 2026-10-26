import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { install, MANIFEST } from '../lib/install.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'paseo-matt-skills-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'package');
  const target = join(root, 'installed');
  const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  write(join(source, 'package.json'), JSON.stringify({ name: 'paseo-matt-skills', version: '1.0.0' }));
  for (const name of ['LICENSE', 'THIRD_PARTY_LICENSES', 'NOTICE.md']) write(join(source, name), name);
  write(join(source, 'skills/paseo-workloop/SKILL.md'), '[Sibling](../tdd/SKILL.md)');
  write(join(source, 'skills/paseo-workloop/scripts/test.mjs'), 'console.log("fixture")');
  write(join(source, 'skills/tdd/SKILL.md'), 'original');
  return { root, source, target, write };
}

test('installation persists all sibling resources and licenses outside the npx source', (t) => {
  const f = fixture(t);
  f.write(join(f.target, 'unrelated/SKILL.md'), 'keep');
  assert.equal(install(f).skills.length, 2);
  rmSync(f.source, { recursive: true });
  assert.equal(readFileSync(join(f.target, 'paseo-workloop/scripts/test.mjs'), 'utf8'), 'console.log("fixture")');
  assert.equal(readFileSync(join(f.target, 'tdd/SKILL.md'), 'utf8'), 'original');
  assert.equal(readFileSync(join(f.target, '.paseo-matt-skills-licenses/THIRD_PARTY_LICENSES'), 'utf8'), 'THIRD_PARTY_LICENSES');
  assert.equal(readFileSync(join(f.target, 'unrelated/SKILL.md'), 'utf8'), 'keep');
});

test('update replaces managed content, adds and removes skills, and preserves unrelated files', (t) => {
  const f = fixture(t);
  install(f);
  f.write(join(f.target, 'unrelated.txt'), 'keep');
  f.write(join(f.source, 'skills/paseo-workloop/SKILL.md'), 'new workloop');
  rmSync(join(f.source, 'skills/tdd'), { recursive: true });
  f.write(join(f.source, 'skills/code-review/SKILL.md'), 'new sibling');
  install({ ...f, update: true, revision: 'commit-two' });
  assert.equal(readFileSync(join(f.target, 'paseo-workloop/SKILL.md'), 'utf8'), 'new workloop');
  assert.equal(existsSync(join(f.target, 'tdd')), false);
  assert.equal(readFileSync(join(f.target, 'code-review/SKILL.md'), 'utf8'), 'new sibling');
  assert.equal(readFileSync(join(f.target, 'unrelated.txt'), 'utf8'), 'keep');
  assert.equal(JSON.parse(readFileSync(join(f.target, MANIFEST))).revision, 'commit-two');
  assert.equal(existsSync(join(f.target, '.paseo-matt-skills.lock')), false);
});

test('reinstall is supported, while update requires a managed installation', (t) => {
  const f = fixture(t);
  assert.throws(() => install({ ...f, update: true }), /run install first/);
  install(f);
  install(f);
  assert.equal(readFileSync(join(f.target, 'tdd/SKILL.md'), 'utf8'), 'original');
});

for (const mutation of ['edit', 'extra file', 'delete']) {
  test(`update refuses a local ${mutation} before changing any installed content`, (t) => {
    const f = fixture(t);
    install(f);
    const manifest = readFileSync(join(f.target, MANIFEST), 'utf8');
    if (mutation === 'edit') f.write(join(f.target, 'tdd/SKILL.md'), 'local');
    if (mutation === 'extra file') f.write(join(f.target, 'tdd/custom.md'), 'local');
    if (mutation === 'delete') rmSync(join(f.target, 'tdd/SKILL.md'));
    f.write(join(f.source, 'skills/paseo-workloop/SKILL.md'), 'updated');
    assert.throws(() => install({ ...f, update: true }), /Local changes detected/);
    assert.equal(readFileSync(join(f.target, 'paseo-workloop/SKILL.md'), 'utf8'), '[Sibling](../tdd/SKILL.md)');
    assert.equal(readFileSync(join(f.target, MANIFEST), 'utf8'), manifest);
  });
}

test('install refuses an existing unmanaged skill without touching any target files', (t) => {
  const f = fixture(t);
  f.write(join(f.target, 'tdd/SKILL.md'), 'mine');
  assert.throws(() => install(f), /Existing unmanaged entry/);
  assert.equal(readFileSync(join(f.target, 'tdd/SKILL.md'), 'utf8'), 'mine');
  assert.equal(existsSync(join(f.target, 'paseo-workloop')), false);
});

test('dry run leaves a missing target missing and a managed target unchanged', (t) => {
  const f = fixture(t);
  assert.equal(install({ ...f, dryRun: true }).dryRun, true);
  assert.equal(existsSync(f.target), false);
  install(f);
  const manifest = readFileSync(join(f.target, MANIFEST), 'utf8');
  install({ ...f, update: true, dryRun: true });
  assert.equal(readFileSync(join(f.target, MANIFEST), 'utf8'), manifest);
});

test('symlinks and malicious manifest entries cannot redirect managed writes', (t) => {
  const f = fixture(t);
  mkdirSync(f.target);
  symlinkSync(f.source, join(f.target, 'tdd'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => install(f), /unmanaged/);
  rmSync(join(f.target, 'tdd'));
  install(f);
  rmSync(join(f.target, 'tdd'), { recursive: true });
  symlinkSync(f.source, join(f.target, 'tdd'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => install({ ...f, update: true }), /symbolic link/);
  f.write(join(f.target, MANIFEST), JSON.stringify({ owner: 'paseo-matt-skills', schema: 1, entries: { '../outside': 'a'.repeat(64) } }));
  assert.throws(() => install({ ...f, update: true }), /Invalid installation entry/);
});

test('a concurrent install lock prevents replacement and remains owned by that process', (t) => {
  const f = fixture(t);
  install(f);
  f.write(join(f.target, '.paseo-matt-skills.lock'), 'other process');
  assert.throws(() => install(f), /EEXIST/);
  assert.equal(readFileSync(join(f.target, '.paseo-matt-skills.lock'), 'utf8'), 'other process');
});

test('CLI rejects unknown arguments and can install into a path containing spaces', (t) => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('../bin/paseo-matt-skills.mjs', import.meta.url));
  const bad = spawnSync(process.execPath, [cli, 'install', '--typo'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  const target = join(f.root, 'path with spaces');
  const good = spawnSync(process.execPath, [cli, 'install', '--target', target], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /17 skills/);
  assert.equal(existsSync(join(target, 'paseo-workloop/scripts/workloop.mjs')), true);
});
