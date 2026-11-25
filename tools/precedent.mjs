#!/usr/bin/env node
// Find earlier fixes for an error like the one in a new PR120-BUGS.md row.
//
//   node tools/precedent.mjs "<error text>" [--max N] [--refresh]
//
// Searches every PR against the work branch (bodies paste the original error and explain the fix) and the
// branch's own fix commits since the consolidation commit, ranks them by how much of the error they share
// (the class / name the error is about counts most), and prints for each: the PR or commit, its explanation,
// and the +/- lines of the change that landed. Reads GitHub (one `gh pr list` call when the cache is older
// than 10 minutes or --refresh is given) and the local clone; never writes anywhere but runs/all-prs.json.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(HOME, 'riemann-hypothesis');
const CACHE = path.join(HOME, 'runs', 'all-prs.json');
const BRANCH = 'origin/opt/collapse-and-consolidate-4.36';
const BASE = 'f941065836'; // "Collapse thin wrappers and consolidate leaf modules"

const args = process.argv.slice(2);
let max = 6, refresh = false; const words = [];
let fromFile = '', fromStdin = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max') max = +args[++i];
  else if (args[i] === '--refresh') refresh = true;
  else if (args[i] === '--file') fromFile = args[++i];   // error text from a file: keeps upstream text off the shell command line
  else if (args[i] === '--stdin') fromStdin = true;
  else words.push(args[i]);
}
const err = (fromFile ? fs.readFileSync(fromFile, 'utf8') : fromStdin ? fs.readFileSync(0, 'utf8') : words.join(' ')).replace(/\s+/g, ' ').trim();
if (!err) { console.error('usage: node tools/precedent.mjs ("<error text>" | --file <path> | --stdin) [--max N] [--refresh]'); process.exit(2); }

const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });

// ---- corpus -------------------------------------------------------------------------------------------
let prs = [];
const stale = !fs.existsSync(CACHE) || Date.now() - fs.statSync(CACHE).mtimeMs > 10 * 60 * 1000;
if (refresh || stale) {
  try {
    const out = execFileSync('gh', ['pr', 'list', '-R', 'rohanarun/riemann-hypothesis', '--state', 'all', '--limit', '1000',
      '--json', 'number,title,state,author,body,mergedAt,headRefName'], { encoding: 'utf8', maxBuffer: 1 << 28 });
    fs.writeFileSync(CACHE, out);
  } catch (e) { console.error('(could not refresh PR cache; using the old one)'); }
}
if (fs.existsSync(CACHE)) prs = JSON.parse(fs.readFileSync(CACHE, 'utf8'));

// merge commits on the branch: "Merge PR #N: ..." (coordinator) or "Merge pull request #N ..." (GitHub)
const mergeOf = new Map();
for (const line of git('log', '--merges', '--format=%h %s', `${BASE}..${BRANCH}`).split('\n')) {
  const m = line.match(/^(\w+) Merge (?:PR|pull request) #(\d+)/);
  if (m && !mergeOf.has(+m[2])) mergeOf.set(+m[2], m[1]);
}
// direct fix commits (not merges) with their full messages
const commits = [];
for (const rec of git('log', '--no-merges', '--format=%h%x1f%s%x1f%b%x1e', `${BASE}..${BRANCH}`).split('\x1e')) {
  const [h, s, b] = rec.trim().split('\x1f');
  if (h && s && !/^Coordinator cycle/.test(s)) commits.push({ h, s, b: b || '' });
}

// ---- scoring ------------------------------------------------------------------------------------------
const STOP = new Set(('failed to synthesize instance of type class deterministic timeout at typeclass maximum number of ' +
  'heartbeats has been reached the but this term has type is expected to Application mismatch argument Function ' +
  'expected Possible interpretations use fully qualified name possible ambiguous Ambiguous Invalid Tactic failed ' +
  'Did not find an occurrence pattern in target expression case Type Prop fun').split(/\s+/).map(s => s.toLowerCase()));
const ident = s => (s.match(/[A-Za-z_][\w'.₀-₉ᵢ-ᵪ]*/gu) || []);
const tokens = [...new Set(ident(err).filter(t => t.length >= 3 && !STOP.has(t.toLowerCase())))];
// The thing the error is about: the class after "synthesize", or the name after "term"/"at"
const focus = [];
let m;
if ((m = err.match(/synthesize(?: instance of type class)?\s+([\w.₂]+)/))) focus.push(m[1]);
if ((m = err.match(/(?:Ambiguous term|Function expected at|Unknown identifier|Unknown constant)\s+`?([\w.'₂]+)/))) focus.push(m[1]);
if ((m = err.match(/timeout at `([^`]+)`/))) focus.push(m[1]);
if ((m = err.match(/(Invalid simp theorem|Invalid rewrite argument|rewrite` failed|stuck)/))) focus.push(m[1]);
const lastSeg = t => t.split('.').pop();

function score(text) {
  if (!text) return 0;
  let s = 0;
  for (const f of focus) {
    if (text.includes(f)) s += 10; else if (f.includes('.') && text.includes(lastSeg(f))) s += 5;
  }
  for (const t of tokens) if (text.includes(t)) s += 1;
  return s;
}

const hits = [];
for (const p of prs) {
  const sc = score(p.body);
  if (sc > 0) hits.push({ kind: 'pr', sc, p });
}
for (const c of commits) {
  const sc = score(c.s + '\n' + c.b) + (focus.some(f => c.s.includes(lastSeg(f))) ? 3 : 0);
  if (sc > 0) hits.push({ kind: 'commit', sc, c });
}
// favour what actually landed
for (const h of hits) if (h.kind === 'pr' && h.p.state === 'MERGED') h.sc += 2;
hits.sort((a, b) => b.sc - a.sc);

function diffLines(rev, isMerge) {
  try {
    const d = isMerge ? git('diff', `${rev}^1`, rev, '--', 'src') : git('show', '--format=', rev, '--', 'src');
    const lines = d.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
    const files = [...new Set(d.split('\n').filter(l => l.startsWith('+++ b/')).map(l => l.slice(6)))];
    return { files, lines };
  } catch { return { files: [], lines: [] }; }
}
const explain = body => {
  const b = (body || '').replace(/```[\s\S]*?```/g, ' ').replace(/🤖 Generated[^\n]*/g, '').replace(/\n{2,}/g, '\n').trim();
  return b.split('\n').filter(l => l.trim()).slice(0, 8).map(l => '      ' + l.slice(0, 220)).join('\n');
};

console.log(`focus: ${focus.join(', ') || '(none)'}; ${prs.length} PRs, ${commits.length} fix commits searched`);
let shown = 0;
for (const h of hits) {
  if (shown >= max) break;
  if (h.kind === 'pr') {
    const p = h.p, mc = mergeOf.get(p.number);
    console.log(`\n[score ${h.sc}] PR #${p.number} ${p.state} @${p.author?.login}: ${p.title}`);
    console.log(explain(p.body));
    if (mc) {
      const { files, lines } = diffLines(mc, true);
      console.log(`    landed as ${mc} in ${files.join(', ')}`);
      for (const l of lines.slice(0, 14)) console.log('    ' + l.slice(0, 200));
    }
  } else {
    const c = h.c; const { files, lines } = diffLines(c.h, false);
    console.log(`\n[score ${h.sc}] commit ${c.h}: ${c.s}`);
    if (c.b.trim()) console.log(c.b.trim().split('\n').slice(0, 5).map(l => '      ' + l.slice(0, 220)).join('\n'));
    console.log(`    in ${files.join(', ')}`);
    for (const l of lines.slice(0, 14)) console.log('    ' + l.slice(0, 200));
  }
  shown++;
}
if (!shown) console.log('no precedent found');
