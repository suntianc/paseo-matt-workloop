#!/usr/bin/env node
// A fake codex CLI for `wait --wake codex`: appends each call's argv to FAKE_CODEX_LOG
// (one JSON line), and exits with FAKE_CODEX_EXIT (default 0).
import { appendFileSync } from "node:fs";

appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
const code = Number(process.env.FAKE_CODEX_EXIT || 0);
if (code) process.stderr.write("Error: fake queue failure\n");
process.exit(code);
