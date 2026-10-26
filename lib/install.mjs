import {
  closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MANIFEST = '.paseo-matt-skills.json';
const OWNER = 'paseo-matt-skills';
const present = (path) => { try { lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const validName = (name) => typeof name === 'string' && name.length > 0
  && name !== '.' && name !== '..' && !/[\\/]/.test(name)
  && !name.startsWith('.paseo-matt-skills') && !isAbsolute(name);

// Include directories, empty directories, and file modes; never follow links.
export function fingerprint(path) {
  const hash = createHash('sha256');
  function walk(p, name) {
    const stat = lstatSync(p);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${p}`);
    if (stat.isDirectory()) {
      hash.update(JSON.stringify(['directory', name]));
      for (const child of readdirSync(p).sort()) walk(join(p, child), `${name}/${child}`);
    } else if (stat.isFile()) {
      hash.update(JSON.stringify(['file', name, stat.mode & 0o111, stat.size]));
      hash.update(readFileSync(p));
    } else throw new Error(`Unsupported file type: ${p}`);
  }
  walk(path, '');
  return hash.digest('hex');
}

function readManifest(target) {
  const path = join(target, MANIFEST);
  if (!present(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.owner !== OWNER || value.schema !== 1 || !value.entries
    || Array.isArray(value.entries) || typeof value.entries !== 'object') {
    throw new Error(`Invalid installation manifest: ${path}`);
  }
  for (const [name, hash] of Object.entries(value.entries)) {
    if (!(validName(name) || name === '.paseo-matt-skills-licenses')
      || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`Invalid installation entry in ${path}`);
    }
  }
  return value;
}

export function install({ source, target, update = false, dryRun = false, revision = null }) {
  source = resolve(source);
  target = resolve(target);
  const skills = join(source, 'skills');
  const rel = relative(target, source);
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    || target.startsWith(`${source}${sep}`)) {
    throw new Error('The installation target must be outside the package source.');
  }
  if (present(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory())) {
    throw new Error(`Target must be a regular directory: ${target}`);
  }
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (pkg.name !== OWNER) throw new Error('Unexpected source package.');
  const names = readdirSync(skills).sort();
  if (!names.every(validName)) throw new Error('Unexpected entry in the skills bundle.');
  const skillNames = names.filter((name) => existsSync(join(skills, name, 'SKILL.md')));
  if (!skillNames.includes('paseo-workloop')) throw new Error('The workloop skill is missing.');
  const next = Object.fromEntries(names.map((name) => [name, fingerprint(join(skills, name))]));
  const licensesName = '.paseo-matt-skills-licenses';
  // All validation and conflict checks finish before replacing any installed files.
  const old = readManifest(target);
  if (update && !old) throw new Error(`No managed installation at ${target}; run install first.`);
  function check() {
    for (const [name, hash] of Object.entries(old?.entries ?? {})) {
      const path = join(target, name);
      if (!present(path) || fingerprint(path) !== hash) {
        throw new Error(`Local changes detected: ${path}. Back up your changes and restore the managed copy before updating.`);
      }
    }
    for (const name of [...names, licensesName]) {
      if (!Object.hasOwn(old?.entries ?? {}, name) && present(join(target, name))) {
        throw new Error(`Existing unmanaged entry: ${join(target, name)}. Back it up or choose another --target.`);
      }
    }
  }
  check();
  if (dryRun) return { target, version: pkg.version, revision, skills: skillNames, dryRun: true };

  mkdirSync(target, { recursive: true });
  const lock = join(target, '.paseo-matt-skills.lock');
  const lockFd = openSync(lock, 'wx');
  let staging;
  const moved = [];
  const installed = [];
  try {
    // A second process may have finished between preflight and taking the lock.
    if (JSON.stringify(readManifest(target)) !== JSON.stringify(old)) throw new Error('Installation changed; retry.');
    check();
    staging = mkdtempSync(join(target, '.paseo-matt-skills-stage-'));
    const fresh = join(staging, 'new');
    const backup = join(staging, 'old');
    mkdirSync(fresh);
    mkdirSync(backup);
    for (const name of names) cpSync(join(skills, name), join(fresh, name), { recursive: true });
    mkdirSync(join(fresh, licensesName));
    for (const name of ['LICENSE', 'THIRD_PARTY_LICENSES', 'NOTICE.md']) {
      cpSync(join(source, name), join(fresh, licensesName, name));
    }
    next[licensesName] = fingerprint(join(fresh, licensesName));
    const manifest = {
      owner: OWNER, schema: 1, version: pkg.version, revision,
      installedAt: new Date().toISOString(), entries: next,
    };
    writeFileSync(join(fresh, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    const replace = new Set([...Object.keys(old?.entries ?? {}), ...Object.keys(next), MANIFEST]);
    try {
      for (const name of replace) {
        if (present(join(target, name))) {
          renameSync(join(target, name), join(backup, name));
          moved.push(name);
        }
        if (present(join(fresh, name))) {
          renameSync(join(fresh, name), join(target, name));
          installed.push(name);
        }
      }
    } catch (error) {
      try {
        for (const name of installed.reverse()) rmSync(join(target, name), { recursive: true, force: true });
        for (const name of moved.reverse()) renameSync(join(backup, name), join(target, name));
      } catch (rollbackError) {
        const recovery = staging;
        staging = null; // Preserve the previous files for manual recovery.
        throw new Error(`Rollback failed; recovery files remain in ${recovery}: ${rollbackError.message}`, { cause: error });
      }
      throw error;
    }
    return { target, version: pkg.version, revision, skills: skillNames, dryRun: false };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    closeSync(lockFd);
    rmSync(lock, { force: true });
  }
}
