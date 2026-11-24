#!/usr/bin/env node
// Free Open rows (tools/prep.mjs) + untouched look-ahead files (tools/lookahead.mjs --untouched-only), merged into
// one args object for tools/fast-fix.workflow.js, with non-overlapping worktrees.
//
//   node tools/combined-prep.mjs [--max 8] > runs/fast-args.json     (one-line summary on stderr)
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const max = +(process.argv[process.argv.indexOf('--max') + 1] || 0) || 8;
const run = (...a) => {
  try { return JSON.parse(execFileSync('node', a, { cwd: HOME, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { return { rows: [] }; }
};
const open = run('tools/prep.mjs', '--max', String(max));
const left = Math.max(0, max - open.rows.length);
const look = left ? run('tools/lookahead.mjs', '--max', String(left), '--untouched-only', '--tree-offset', String(open.rows.length)) : { rows: [] };
const rows = [...open.rows, ...look.rows];
process.stderr.write(`open ${open.rows.length} + look-ahead ${look.rows.length}: ${rows.map(r => r.file.split('/').pop()).join(', ') || 'none'}\n`);
process.stdout.write(JSON.stringify({ home: HOME.replace(/\\/g, '/'), listTime: open.listTime || look.listTime || '', rows }));
