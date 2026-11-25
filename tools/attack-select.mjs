#!/usr/bin/env node
// Picks Open and look-ahead rows of PR120-BUGS.md for the attack pipeline (pr120-attack.yml).
// Those are rows whose module's project import closure is small enough to build on a runner, that no open PR
// touches, and that were not found OK at this tip already.
//
//   node tools/attack-select.mjs [--k 2] [--maxc 6000] [--modules A.B,C.D] [--md saved-list.md]   prints a JSON array on stdout
//
// Each entry: {module, file, line, error, closure}. Smallest closures first (cheapest to build; closures overlap,
// so a shared build cache makes later ones cheaper). runs/attack-ok.txt lists "<module> <tip>" pairs already
// built OK; a module is skipped while no file of its import closure (and no build setting) changed since that tip.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, REPO, BASE, importGraph, failingFromList, pathToMod, modToPath, say, git } from './scanlib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const K = +opt('--k', 2), MAXC = +opt('--maxc', 6000);
const given = opt('--modules', '').split(',').map(s => s.trim()).filter(Boolean);
const tip = git('rev-parse', BASE).trim();
const g = importGraph(BASE);
// Full import closure (what `lake build` compiles), counted in project modules.
const closureSet = root => { const seen = new Set([root]); const st = [root]; while (st.length) { const m = st.pop(); for (const i of (g[m]?.imports || [])) if (g[i.mod] && !seen.has(i.mod)) { seen.add(i.mod); st.push(i.mod); } } return seen; };
const closure = root => closureSet(root).size;

let rows;
if (given.length) {
  rows = given.map(m => {
    if (!/^[\p{L}\p{N}_.']+$/u.test(m) || !g[m]) throw new Error(`unknown module ${m}`);
    return { module: m, file: modToPath(m), line: 0, error: '(requested by hand)' };
  });
} else {
  // --md <file>: a saved PR120-BUGS.md instead of the live one (for tests)
  const mdFile = opt('--md', '');
  const { md } = mdFile ? { md: fs.readFileSync(mdFile, 'utf8') } : failingFromList();
  const open = md.split(/^## /m).find(s => /^Open\b/.test(s)) || '';
  rows = [];
  for (const l of open.split('\n')) {
    const m = l.match(/^\|\s*`([^`]+?\.lean):(\d+)`\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/);
    if (!m) continue;
    const file = 'src/' + m[1].replace(/^src\//, '');
    if (m[5].trim()) continue; // a note such as "fix exists on aliromman's branch": someone has it
    rows.push({ module: pathToMod(file), file, line: +m[2], error: m[4].trim().slice(0, 400) });
  }
  // Look-ahead rows too (errors the scratch build found behind stubbed declarations). The cheap fix mode judges
  // these by reading the source; a real build settles them. (2026-11-25: ReBaseZeta.lean:40 was judged "already
  // fixed by 947729fc72" without a build, marked processed for good, then fixed differently by another PR.)
  const la = md.split(/^## /m).find(s => /^Look-ahead\b/.test(s)) || '';
  const seen = new Set(rows.map(r => r.file));
  for (const l of la.split('\n')) {
    const m = l.match(/^\|\s*`([^`]+?\.lean):(\d+)`\s*\|\s*(\d+)\s*\|\s*([^|]*)\|\s*(.*?)\s*\|\s*$/);
    if (!m) continue;
    const file = 'src/' + m[1].replace(/^src\//, '');
    if (seen.has(file)) continue;
    seen.add(file);
    rows.push({ module: pathToMod(file), file, line: +m[2], error: `look-ahead round ${m[3]}: ${m[5].trim().slice(0, 370)}` });
  }
}
const okFile = path.join(HOME, 'runs', 'attack-ok.txt');
// module -> the tips it built OK at
const okAt = new Map();
for (const l of (fs.existsSync(okFile) ? fs.readFileSync(okFile, 'utf8') : '').split('\n')) {
  const [m, t] = l.trim().split(/\s+/);
  if (m && /^[0-9a-f]{40}$/.test(t || '')) okAt.set(m, [...(okAt.get(m) || []), t]);
}
// Files changed between an OK tip and this tip; null when that tip is not in this clone or a build setting changed.
const changedSince = new Map();
const changed = t => {
  if (!changedSince.has(t)) {
    let v = null;
    try {
      execFileSync('git', ['-C', REPO, 'cat-file', '-e', `${t}^{commit}`], { stdio: 'ignore' });
      const files = git('diff', '--name-only', '--no-renames', t, tip).split('\n').filter(Boolean);
      v = files.some(p => /^(lakefile|lake-manifest\.json|lean-toolchain)/.test(p)) ? null : new Set(files);
    } catch { v = null; }
    changedSince.set(t, v);
  }
  return changedSince.get(t);
};
const stillOk = m => (okAt.get(m) || []).some(t => {
  if (t === tip) return true;
  const ch = changed(t);
  if (!ch) return false;
  for (const x of closureSet(m)) if (ch.has(modToPath(x))) return false;
  return true;
});
let cand = rows.filter(r => g[r.module]).map(r => ({ ...r, closure: closure(r.module) }))
  .filter(r => given.length || r.closure <= MAXC);
const skipped = given.length ? [] : cand.filter(r => stillOk(r.module));
if (skipped.length) say(`skipped ${skipped.length} module(s) built OK at an earlier tip, closure unchanged since: ${skipped.map(r => r.module.split('.').pop()).join(', ')}`);
cand = cand.filter(r => !skipped.includes(r));
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
