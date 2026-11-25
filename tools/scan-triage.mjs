#!/usr/bin/env node
// Turn shadow-scan "replaced" findings into fixer candidates, applying the triage that used to be done by hand.
//
//   node tools/scan-triage.mjs [findings.json] [--max 8] [--hours 3] [--ignore-verdicts] > runs/scan-candidates.json
//   node tools/scan-args.cjs runs/scan-candidates.json <firstTree> "scan" > runs/scan-args.json
//
// Drops, in order (counts go to stderr):
//   1. tokens that are usually bound variables (tools/scan-verdicts.json fpTokens / fpTokenPattern);
//   2. findings a fixer already judged (scan-verdicts.json verdicts: equivalent copy or false positive);
//   3. files any open PR touches (claim.mjs check, file level);
//   4. files with a commit on the branch in the last --hours hours (someone is working there).
// Prints [{file, orig, toks, lines}] (the scan-args.cjs input), most findings first, at most --max files.
// Read-only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const inFile = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--ignore-verdicts')) || 'runs/shadow-findings-blocked.json';
const MAX = +opt('--max', 8);
const HOURS = +opt('--hours', 3);
const say = s => process.stderr.write(s + '\n');
const REPO = path.join(HOME, 'riemann-hypothesis');
const BRANCH = 'origin/opt/collapse-and-consolidate-4.36';

const findings = JSON.parse(fs.readFileSync(path.resolve(HOME, inFile), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'tools', 'scan-verdicts.json'), 'utf8'));
const fpTok = new Set(cfg.fpTokens || []);
const fpRe = cfg.fpTokenPattern ? new RegExp(cfg.fpTokenPattern, 'u') : null;
const verdicts = argv.includes('--ignore-verdicts') ? [] : (cfg.verdicts || []);
say(`${findings.length} findings in ${new Set(findings.map(f => f.file)).size} files (${inFile})`);

let fs1 = findings.filter(f => !(fpTok.has(f.tok) || (fpRe && fpRe.test(f.tok))));
say(`  binder-name tokens: -${findings.length - fs1.length}`);
const judged = f => verdicts.find(v => f.file.endsWith('/' + v.file) && v.tok === f.tok && (!v.branch || v.branch === f.branch));
const fs2 = fs1.filter(f => !judged(f));
say(`  already judged (scan-verdicts.json): -${fs1.length - fs2.length}`);

const byFile = new Map();
for (const f of fs2) { if (!byFile.has(f.file)) byFile.set(f.file, []); byFile.get(f.file).push(f); }
let files = [...byFile.keys()];
if (files.length) {
  let out = '';
  try { out = execFileSync('node', ['tools/claim.mjs', 'check', ...files], { cwd: HOME, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { out = String(e.stdout || ''); }
  const claimed = new Set(out.split('\n').filter(l => l.startsWith('CLAIMED')).map(l => l.split(/\s+/)[1]));
  say(`  claimed by an open PR: -${files.filter(f => claimed.has(f)).length} files`);
  files = files.filter(f => !claimed.has(f));
}
const recent = files.filter(f => {
  try { return execFileSync('git', ['-C', REPO, 'log', '-1', '--format=%h', `--since=${HOURS}.hours`, BRANCH, '--', f], { encoding: 'utf8' }).trim() !== ''; }
  catch { return false; }
});
say(`  changed in the last ${HOURS} h: -${recent.length} files`);
files = files.filter(f => !recent.includes(f));

const cands = files.map(file => {
  const xs = byFile.get(file);
  return {
    file,
    orig: [...new Set(xs.map(x => x.orig))],
    toks: [...new Set(xs.map(x => `${x.tok} -> captured by ${x.branch} (from ${(x.branchFrom || []).join(',')})`))],
    lines: [...new Set(xs.map(x => x.line))].sort((a, b) => a - b),
    n: xs.length,
  };
}).sort((a, b) => b.n - a.n);
if (cands.length > MAX) say(`  over --max ${MAX}: ${cands.length - MAX} more files not printed: ${cands.slice(MAX).map(c => c.file.split('/').slice(-2).join('/')).join(', ')}`);
const picked = cands.slice(0, MAX).map(({ n, ...c }) => c);
say(`candidates: ${picked.length}${picked.length ? ' — ' + picked.map(c => c.file.split('/').slice(-2).join('/') + ' [' + c.toks.map(t => t.split(' ')[0]).join(',') + ']').join('; ') : ''}`);
process.stdout.write(JSON.stringify(picked, null, 1));
