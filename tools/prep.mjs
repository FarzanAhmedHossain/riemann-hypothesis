#!/usr/bin/env node
// One command from "the list was republished" to the args of tools/fast-fix.workflow.js.
//
//   node tools/prep.mjs [--max 8]      prints {home, listTime, rows:[...]} as JSON on stdout (progress on stderr)
//
// Steps: rh.mjs sync, rh.mjs rows --json, keep rows that are not touched since the consolidation (rows'
// touchedByFix: fix-style last commit, reported line edited, or a commit in the 4 h before the list), not in
// runs/processed.txt, and not touched by ANY open PR (claim.mjs file-level check). Assigns trees w1..wN and
// appends the picked files to runs/processed.txt so the scheduled cycle does not take them again.
// Read-only against GitHub.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const max = +(process.argv[process.argv.indexOf('--max') + 1] || 0) || 8;
const node = (...a) => execFileSync('node', a, { cwd: HOME, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const say = s => process.stderr.write(s + '\n');

say(node('tools/rh.mjs', 'sync').trim().split('\n').pop());
const { head, rows } = JSON.parse(node('tools/rh.mjs', 'rows', '--json'));
const proc = new Set(fs.readFileSync(path.join(HOME, 'runs', 'processed.txt'), 'utf8').split('\n').filter(Boolean));
let cand = rows.filter(r => !(r.claimedBy || []).some(c => /#\d+/.test(c)) && !r.touchedByFix && !proc.has(r.file + '|*'));
say(`list ${head?.[1]} head ${head?.[0]}: ${rows.length} rows, ${cand.length} untouched/unprocessed/unclaimed-by-title`);
// Drop rows whose file changed after the row was FIRST listed: the shard build does not re-run every cycle, so the
// list re-carries old errors (2026-11-24 23:30: all 9 such rows were already fixed; 72/72 had commits after first
// report). first-seen.mjs reads the list history; if it fails, keep the candidates.
if (cand.length) {
  try {
    const fsn = JSON.parse(node('tools/first-seen.mjs', '--hours', '40', '--json'));
    const fsr = Array.isArray(fsn) ? fsn : (fsn.rows || []);
    const changed = new Set(fsr.filter(r => r.changedSinceFirstSeen).map(r => `${r.file}:${r.line}`));
    const before = cand.length;
    cand = cand.filter(r => !changed.has(`${r.file}:${r.line}`) && !changed.has(`${r.file.replace(/^src\//, '')}:${r.line}`));
    say(`first-seen: ${before - cand.length} row(s) dropped (file changed after the row was first listed)`);
  } catch (e) { say('first-seen check failed, keeping candidates: ' + String(e.message || e).split('\n')[0]); }
}
if (cand.length) {
  let out = '';
  try { out = node('tools/claim.mjs', 'check', ...cand.map(r => r.file)); } catch (e) { out = String(e.stdout || ''); }
  const claimed = new Set(out.split('\n').filter(l => l.startsWith('CLAIMED')).map(l => l.split(/\s+/)[1]));
  for (const l of out.split('\n').filter(l => l.startsWith('CLAIMED'))) say('  ' + l.slice(0, 160));
  cand = cand.filter(r => !claimed.has(r.file));
}
cand.sort((a, b) => a.rank - b.rank).splice(max);
const existing = fs.existsSync(path.join(HOME, 'wt')) ? fs.readdirSync(path.join(HOME, 'wt')) : [];
const picked = cand.map((r, i) => {
  const tree = `w${i + 1}`;
  return { tree, createTree: !existing.includes(tree), file: r.file, line: r.line, category: r.category, error: r.error, lineNow: r.lineNow };
});
for (const r of picked) fs.appendFileSync(path.join(HOME, 'runs', 'processed.txt'), r.file + '|*\n');
say(`picked ${picked.length}: ${picked.map(r => r.file.split('/').slice(-2).join('/')).join(', ') || 'none'}`);
process.stdout.write(JSON.stringify({ home: HOME.replace(/\\/g, '/'), listTime: head?.[1] || '', rows: picked }));
