#!/usr/bin/env node
// Audit the "main=True over-disable" sweeps: commits that deleted `attribute [-instance] …` names because the
// instance was already in the original module's closure on main. That reasoning is wrong when the ORIGINAL'S
// OWN SOURCE on main disabled the same instance: then the deletion makes the section elaborate differently from
// the original (2026-11-25: ReBaseZeta, broken by 8851789ca7 / PR #1345, repaired by the coordinator in 947729fc72).
//
//   node tools/overdisable-audit.mjs [--grep main=True] [--json runs/overdisable.json]
//
// For every non-merge commit on the branch since the consolidation whose message matches --grep, and every hunk
// that removes instance names from an `attribute [-instance]` line, this reports the names that
//   (a) the section's original module disables in its own source on main, and
//   (b) the current tip still does not disable anywhere in that section.
// Read-only (local git objects only).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, REPO, BASE, MAIN, pathToMod, modToPath, say } from './scanlib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const GREP = opt('--grep', 'main=True');
const JSON_OUT = opt('--json', '');
const CONSOL = 'f941065836';

const g = (...a) => execFileSync('git', ['-C', REPO, '-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 1 << 30 });
const blobCache = new Map();
const blob = (rev, p) => {
  const k = rev + ':' + p;
  if (!blobCache.has(k)) { let t = null; try { t = g('show', k); } catch { t = null; } if (blobCache.size > 4000) blobCache.clear(); blobCache.set(k, t); }
  return blobCache.get(k);
};
const attrNames = line => {
  const m = line.match(/attribute\s*\[-instance\]\s*(.*)$/); if (!m) return [];
  return m[1].replace(/--.*$/, '').replace(/\s+in\s*$/, '').trim().split(/\s+/).filter(Boolean);
};
const last = n => n.split('.').pop();
const same = (a, b) => a === b || a.endsWith('.' + b) || b.endsWith('.' + a); // full name, or one written relative to an open namespace
// Section of `text` that belongs to original module `orig` (bundle marker `-- bundled from orig` up to the next
// marker); the whole file when it has no markers.
const sectionOf = (text, orig) => {
  const lines = text.split('\n');
  const marks = []; lines.forEach((l, i) => { const m = l.match(/^-- bundled from (\S+)\s*$/); if (m) marks.push({ i, mod: m[1] }); });
  if (!marks.length) return { lines, from: 0 };
  const k = marks.findIndex(x => x.mod === orig);
  if (k < 0) return null;
  const end = k + 1 < marks.length ? marks[k + 1].i : lines.length;
  return { lines: lines.slice(marks[k].i, end), from: marks[k].i };
};
const origAtLine = (text, lineNo, file) => {
  const lines = text.split('\n'); let o = null, sawMarker = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^-- bundled from (\S+)\s*$/);
    if (m) { sawMarker = true; if (i < lineNo) o = m[1]; }
  }
  if (!sawMarker) return { orig: pathToMod(file), level: 'module' };
  return o ? { orig: o, level: 'section' } : { orig: null, level: 'file-header' };
};

const commits = g('log', '--no-merges', '--format=%h|%an|%s', '-i', `--grep=${GREP}`, `${CONSOL}..${BASE}`).trim().split('\n').filter(Boolean)
  .map(l => { const [h, an, ...s] = l.split('|'); return { h, an, s: s.join('|') }; });
say(`${commits.length} commits match --grep ${GREP}`);

const out = []; let hunksSeen = 0, removedSeen = 0, inMainHunks = 0, restoredHunks = 0; const restoredList = [];
for (const c of commits) {
  const diff = g('show', '-U0', '--format=', c.h, '--', 'src');
  let file = null, hunk = null; const hunks = [];
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) { file = l.split(' b/').pop(); continue; }
    const hm = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hm) { hunk = { file, old: +hm[1], neu: +hm[2], minus: [], plus: [] }; hunks.push(hunk); continue; }
    if (!hunk || l.startsWith('---') || l.startsWith('+++')) continue;
    if (l.startsWith('-')) hunk.minus.push(l.slice(1)); else if (l.startsWith('+')) hunk.plus.push(l.slice(1));
  }
  for (const h of hunks) {
    const before = h.minus.flatMap(attrNames), after = new Set(h.plus.flatMap(attrNames));
    const removed = before.filter(n => !after.has(n));
    if (!removed.length) continue;
    hunksSeen++; removedSeen += removed.length;
    const parentText = blob(c.h + '^', h.file); if (!parentText) continue;
    const { orig, level } = origAtLine(parentText, h.old, h.file);
    if (!orig) { out.push({ commit: c.h, author: c.an, file: h.file, line: h.old, level, orig: null, names: removed, mainLines: [], note: 'file-header line (applies to every section); check by hand' }); continue; }
    const mainText = blob(MAIN, modToPath(orig));
    if (!mainText) continue; // original not on main
    const mainAttr = mainText.split('\n').map((l, i) => ({ l, i: i + 1 })).filter(x => /attribute\s*\[-instance\]/.test(x.l));
    const inMain = removed.filter(n => mainAttr.some(x => attrNames(x.l).some(m => same(m, n))));
    if (!inMain.length) continue; // the sweep removed fixer-added disables: fine
    inMainHunks++;
    const tipText = blob(BASE, h.file);
    if (!tipText) continue; // file gone at the tip
    const sec = sectionOf(tipText, orig);
    if (!sec) continue;
    const secAttr = sec.lines.filter(l => /attribute\s*\[-instance\]/.test(l));
    const stillMissing = inMain.filter(n => !secAttr.some(l => attrNames(l).some(m => same(m, n))));
    if (!stillMissing.length) { restoredHunks++; restoredList.push(h.file.split('/').pop() + ' ' + c.h + ' ' + inMain.join(',')); continue; } // restored since
    out.push({
      commit: c.h, author: c.an, subject: c.s.slice(0, 120), file: h.file, line: h.old, level, orig, names: stillMissing,
      mainLines: mainAttr.filter(x => attrNames(x.l).some(m => stillMissing.some(n => same(m, n)))).map(x => `${x.i}: ${x.l.trim()}`),
    });
  }
}
say(`${hunksSeen} hunks removed ${removedSeen} instance names; ${inMainHunks} removed a disable the original had on main (${restoredHunks} restored since: ${restoredList.slice(0, 20).join('; ')}); ${out.length} hunks remove a disable that the original itself had on main and that is still missing at the tip`);
const byFile = new Map(); for (const o of out) { if (!byFile.has(o.file)) byFile.set(o.file, []); byFile.get(o.file).push(o); }
for (const [f, xs] of byFile) {
  console.log(f);
  for (const x of xs) console.log(`  ${x.commit} (${x.author}) L${x.line} [${x.level}] orig ${x.orig || '-'}: ${x.names.join(' ')}${x.mainLines.length ? '\n      main: ' + x.mainLines.join('\n      main: ') : ''}${x.note ? '\n      ' + x.note : ''}`);
}
if (JSON_OUT) fs.writeFileSync(path.resolve(HOME, JSON_OUT), JSON.stringify(out, null, 1));
