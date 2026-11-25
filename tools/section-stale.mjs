#!/usr/bin/env node
// Section-level staleness for Open rows. first-seen.mjs marks a row "changed" when ANY commit touched its file
// after the row was first listed, but broad sweeps (bundling-leak / main=True attribute sweeps over 50-120 files)
// touch almost every file, so that drops live rows too. This looks only at the row's own bundled section (or the
// whole file when it is not a bundle) and classifies the commits that touched it since --lead hours before the row
// was first listed:
//   targeted: a commit whose subject names this module or file, or that touched at most --small files
//   sweep:    any other commit (broad mechanical sweep)
// Rows whose section saw no targeted commit are printed as candidates (possibly still failing at the tip).
//
//   node tools/section-stale.mjs [--fs runs/fs-now.json] [--lead 8] [--small 6] [--json runs/section-stale.json]
// Read-only (local git).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, REPO, BASE, pathToMod, say } from './scanlib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FS = opt('--fs', 'runs/fs-now.json');
const LEAD = +opt('--lead', 8);
const SMALL = +opt('--small', 6);
const JSON_OUT = opt('--json', '');
const g = (...a) => execFileSync('git', ['-C', REPO, '-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });

const fsData = JSON.parse(fs.readFileSync(path.resolve(HOME, FS), 'utf8'));
const rows = Array.isArray(fsData) ? fsData : fsData.rows;
const nFiles = new Map();
const filesIn = h => { if (!nFiles.has(h)) nFiles.set(h, g('show', '--format=', '--name-only', h).split('\n').filter(Boolean).length); return nFiles.get(h); };

const out = [];
for (const r of rows) {
  const text = g('show', `${BASE}:${r.file}`).split('\n');
  // section at the tip around the row's line
  let start = 1, end = text.length, orig = pathToMod(r.file);
  const marks = []; text.forEach((l, i) => { const m = l.match(/^-- bundled from (\S+)\s*$/); if (m) marks.push({ i: i + 1, mod: m[1] }); });
  if (marks.length) {
    const k = marks.filter(m => m.i <= r.line).pop();
    if (k) { start = k.i; orig = k.mod; const nx = marks.find(m => m.i > k.i); end = nx ? nx.i - 1 : text.length; }
    else { start = 1; end = marks[0].i - 1; orig = '(file header)'; }
  }
  const since = new Date(Date.parse(r.firstSeen) - LEAD * 3600e3).toISOString();
  let log = '';
  try { log = g('log', '--format=%h|%an|%s', '-s', `--since=${since}`, `-L${start},${end}:${r.file}`, BASE); } catch (e) { log = String(e.stdout || ''); }
  const commits = log.split('\n').filter(l => /^[0-9a-f]{7,}\|/.test(l)).map(l => { const [h, an, ...s] = l.split('|'); return { h, an, s: s.join('|') }; });
  const leaf = orig.split('.').pop(), fleaf = path.basename(r.file, '.lean');
  const cls = commits.map(c => ({ ...c, kind: (c.s.includes(leaf) || c.s.includes(fleaf) || filesIn(c.h) <= SMALL) ? 'targeted' : 'sweep' }));
  const targeted = cls.filter(c => c.kind === 'targeted');
  out.push({ file: r.file, line: r.line, error: r.error, firstSeen: r.firstSeen, orig, section: [start, end], targeted, sweeps: cls.filter(c => c.kind === 'sweep') });
}
const cand = out.filter(o => !o.targeted.length);
say(`${rows.length} Open rows; ${cand.length} with no targeted commit in their section since ${LEAD} h before first listed`);
for (const o of cand) {
  console.log(`${o.file.replace(/^src\//, '')}:${o.line}  [${o.orig.split('.').slice(-1)}] first ${o.firstSeen.slice(5, 16)}  sweeps ${o.sweeps.length}`);
  console.log(`    ${o.error.slice(0, 170)}`);
  for (const s of o.sweeps.slice(0, 4)) console.log(`      sweep ${s.h} ${s.an}: ${s.s.slice(0, 110)}`);
}
if (JSON_OUT) fs.writeFileSync(path.resolve(HOME, JSON_OUT), JSON.stringify(out, null, 1));
