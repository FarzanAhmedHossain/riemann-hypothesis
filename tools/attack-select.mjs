#!/usr/bin/env node
// Picks Open rows of PR120-BUGS.md for the attack pipeline (pr120-attack.yml).
// Those are rows whose module's project import closure is small enough to build on a runner, that no open PR
// touches, and that were not found OK at this tip already.
//
//   node tools/attack-select.mjs [--k 2] [--maxc 6000] [--modules A.B,C.D]   prints a JSON array on stdout
//
// Each entry: {module, file, line, error, closure}. Smallest closures first (cheapest to build; closures overlap,
// so a shared build cache makes later ones cheaper). runs/attack-ok.txt lists "<module> <tip>" pairs already
// built OK; those are skipped until the tip changes the module's closure (simple rule: skip while the same tip).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, BASE, importGraph, failingFromList, pathToMod, modToPath, say, git } from './scanlib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const K = +opt('--k', 2), MAXC = +opt('--maxc', 6000);
const given = opt('--modules', '').split(',').map(s => s.trim()).filter(Boolean);
const tip = git('rev-parse', BASE).trim();
const g = importGraph(BASE);
// Full import closure (what `lake build` compiles), counted in project modules.
const closure = root => { const seen = new Set([root]); const st = [root]; while (st.length) { const m = st.pop(); for (const i of (g[m]?.imports || [])) if (g[i.mod] && !seen.has(i.mod)) { seen.add(i.mod); st.push(i.mod); } } return seen.size; };

let rows;
if (given.length) {
  rows = given.map(m => {
    if (!/^[\p{L}\p{N}_.']+$/u.test(m) || !g[m]) throw new Error(`unknown module ${m}`);
    return { module: m, file: modToPath(m), line: 0, error: '(requested by hand)' };
  });
} else {
  const { md } = failingFromList();
  const open = md.split(/^## /m).find(s => /^Open\b/.test(s)) || '';
  rows = [];
  for (const l of open.split('\n')) {
    const m = l.match(/^\|\s*`([^`]+?\.lean):(\d+)`\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/);
    if (!m) continue;
    const file = 'src/' + m[1].replace(/^src\//, '');
    if (m[5].trim()) continue; // a note such as "fix exists on aliromman's branch": someone has it
    rows.push({ module: pathToMod(file), file, line: +m[2], error: m[4].trim().slice(0, 400) });
  }
}
const okFile = path.join(HOME, 'runs', 'attack-ok.txt');
const ok = new Set(fs.existsSync(okFile) ? fs.readFileSync(okFile, 'utf8').split('\n').filter(Boolean) : []);
let cand = rows.filter(r => g[r.module]).map(r => ({ ...r, closure: closure(r.module) }))
  .filter(r => given.length || (r.closure <= MAXC && !ok.has(`${r.module} ${tip}`)));
if (cand.length) {
  let out = '';
  try { out = execFileSync('node', ['tools/claim.mjs', 'check', ...cand.map(r => r.file)], { cwd: HOME, encoding: 'utf8', maxBuffer: 1 << 26 }); }
  catch (e) { out = String(e.stdout || ''); }
  const claimed = new Set(out.split('\n').filter(l => l.startsWith('CLAIMED')).map(l => l.split(/\s+/)[1]));
  const before = cand.length;
  cand = cand.filter(r => !claimed.has(r.file));
  if (before !== cand.length) say(`dropped ${before - cand.length} row(s) an open PR touches`);
}
cand.sort((a, b) => a.closure - b.closure);
say(`tip ${tip.slice(0, 10)}: ${rows.length} rows, ${cand.length} candidates (closure <= ${MAXC}); picked ${Math.min(K, cand.length)}: ${cand.slice(0, K).map(r => `${r.module.split('.').slice(-2).join('.')} (${r.closure})`).join(', ') || 'none'}`);
process.stdout.write(JSON.stringify(cand.slice(0, K)));
