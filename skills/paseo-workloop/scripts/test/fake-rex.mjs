#!/usr/bin/env node
// A fake rex CLI for the tests: the commands rex.mjs uses, against a JSON file
// (FAKE_REX_DB). A tab it opens runs nothing; a test ends a turn by setting the
// block's exit in the file (and writing the turn's meta file, as agent-run would).
//   FAKE_REX_FAIL=<command>  that command fails, as when Rex is not running
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_REX_DB;
const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { n: 0, sessions: [], blocks: [], calls: [] });
const save = (db) => { writeFileSync(`${file}.tmp`, JSON.stringify(db, null, 2)); renameSync(`${file}.tmp`, file); };
const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const die = (msg, code = 1) => { process.stderr.write(`Error: ${msg}\n`); process.exit(code); };
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const argv = process.argv.slice(2);
const [cmd, sub] = argv;
const what = cmd === "window" || cmd === "block" ? `${cmd} ${sub}` : cmd;
if (process.env.FAKE_REX_FAIL && process.env.FAKE_REX_FAIL.split(",").includes(what)) die(`fake failure of ${what}`);
const db = load();
db.calls.push(argv);

if (cmd === "ls") {
  save(db);
  out({ sessions: db.sessions.filter((s) => !s.killed).map((s) => ({ session_id: s.id, label: s.label })) });
} else if (cmd === "new") {
  const id = `session:fake-${++db.n}`;
  const block = `block:fake-${++db.n}`;
  const separator = argv.indexOf("--");
  const command = separator < 0 ? [] : argv.slice(separator + 1);
  db.sessions.push({ id, label: argv[1], cwd: flag(argv, "-c") });
  db.blocks.push({ id: block, session: id, label: flag(argv, "--window") || "shell", cwd: flag(argv, "-c"), argv: command, exit: null, closed: false, shell: !command.length, keepOpen: argv.includes("--keep-open") });
  save(db);
  out({ session_id: id, initial_windows: [{ window_id: `window:fake-${db.n}`, block_ids: [block] }] });
} else if (what === "window new") {
  const session = flag(argv, "-s");
  if (!db.sessions.some((s) => s.id === session && !s.killed)) die(`session ${session} not found`);
  const rest = argv.slice(argv.indexOf("--") + 1);
  const label = argv[argv.indexOf("-s") + 2];
  const id = `block:fake-${++db.n}`;
  db.blocks.push({ id, session, label, cwd: flag(argv, "-c"), argv: rest, exit: null, closed: false, keepOpen: argv.includes("--keep-open") });
  save(db);
  out({ window_id: `window:fake-${db.n}`, block_ids: [id] });
} else if (what === "block call") {
  const b = db.blocks.find((x) => x.id === flag(argv, "-b"));
  save(db);
  if (!b || b.closed) die(`block target "${flag(argv, "-b")}" not found`);
  out(b.exit == null ? { last_exit: null, child: { pid: 1, name: "node" } } : { last_exit: { exit_code: b.exit, ...(b.exit ? { error: `exit status ${b.exit}` } : {}) } });
} else if (what === "block close") {
  const b = db.blocks.find((x) => x.id === argv.at(-1));
  if (b) b.closed = true;
  save(db);
} else if (cmd === "kill") {
  const s = db.sessions.find((x) => x.id === argv[1]);
  if (s) s.killed = true;
  for (const b of db.blocks) if (b.session === argv[1]) b.closed = true;
  save(db);
} else if (cmd === "wait") {
  save(db);
  const id = argv[argv.indexOf("-s") + 2];
  const tick = () => {
    const b = load().blocks.find((x) => x.id === id);
    if (!b) die(`block target "${id}" not found`);
    if (b.exit != null) {
      out({ exit_code: b.exit, ...(b.exit ? { error: `exit status ${b.exit}` } : {}) });
      process.exit(b.exit ? 1 : 0);
    }
    if (b.closed) { out({ block_id: id }); process.exit(1); }
    setTimeout(tick, 50);
  };
  tick();
} else die(`fake rex does not know: ${argv.join(" ")}`, 2);
