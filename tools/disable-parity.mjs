#!/usr/bin/env node
// Instance-disable parity between main's original modules and their sections at the branch tip.
//
//   node tools/disable-parity.mjs [--json runs/disable-parity.json] [--all] [--rev <commit>]
//
// For every module on main whose own source has `attribute [-instance] N …` (file-level or `… in`), find where that
// module lives at the tip (its `-- bundled from M` section, or the same path when not bundled) and report the names N
// that are disabled NOWHERE in that section or in the tip file's header (lines before the first bundle marker).
// A missing disable means the section can elaborate differently from the original (2026-11-25 ReBaseZeta: a sweep
// removed the original's own `attribute [-instance] DoubleCosetMeasures.instMeasGL …`, and the look-ahead build
// then failed on the statement). Without --all, only modules that are not compiled yet (blocked behind a listed
// failure or failing themselves) are reported, since a module that compiles needs no change.
// Read-only: two git greps plus the blocked set.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, REPO, BASE, MAIN, pathToMod, modToPath, say } from './scanlib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const JSON_OUT = opt('--json', '');
// --kind: which attribute lines to compare. disable = [-instance] (default), local = [local instance], instance = [instance], simp = [-simp]
const KINDS = { disable: '-instance', local: 'local instance', instance: 'instance', simp: '-simp' };
const KIND = KINDS[opt('--kind', 'disable')]; if (!KIND) throw new Error('--kind must be one of ' + Object.keys(KINDS).join(', '));
const KIND_RE = KIND.replace(/ /g, ' *');                                   // for git grep (basic regex; `-` is literal)
const KIND_JS = new RegExp('attribute\\s*\\[' + KIND.replace(/-/g, '\\-').replace(/ /g, '\\s*') + '\\]\\s*(.*)$');
const REV = opt('--rev', BASE); // tip revision to check (recall test: --rev 94ff1f0fd0 must report ReBaseZeta)
const g = (...a) => execFileSync('git', ['-C', REPO, '-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 1 << 30 });
const attrNames = line => {
  const m = line.match(KIND_JS); if (!m) return [];
  return m[1].replace(/--.*$/, '').replace(/\s+in\s*$/, '').trim().split(/\s+/).filter(Boolean);
};
const last = n => n.split('.').pop();
const same = (a, b) => a === b || a.endsWith('.' + b) || b.endsWith('.' + a); // full name, or one written relative to an open namespace
const grepLines = (rev, args) => {
  let out = '';
  try { out = g('grep', '-n', ...args, rev, '--', 'src'); } catch (e) { out = String(e.stdout || ''); }
  return out.split('\n').filter(Boolean).map(l => {
    const rest = l.slice(rev.length + 1); const m = rest.match(/^([^:]+):(\d+):(.*)$/);
    return m ? { file: m[1], line: +m[2], text: m[3] } : null;
  }).filter(Boolean);
};

// 1. main: module -> [{line, names, text}]
const mainHits = grepLines(MAIN, ['-e', 'attribute *\\[' + KIND_RE + '\\]']);
const mainBy = new Map();
for (const h of mainHits) {
  const names = attrNames(h.text); if (!names.length) continue;
  const mod = pathToMod(h.file);
  if (!mainBy.has(mod)) mainBy.set(mod, []);
  mainBy.get(mod).push({ line: h.line, names, text: h.text.trim() });
}
say(`main: ${mainHits.length} instance-disable lines in ${mainBy.size} modules`);

// 2. tip: per file, markers and disable lines in order
const tipHits = grepLines(REV, ['-e', '^-- bundled from ', '-e', 'attribute *\\[' + KIND_RE + '\\]']);
const tipFiles = new Map();
for (const h of tipHits) { if (!tipFiles.has(h.file)) tipFiles.set(h.file, []); tipFiles.get(h.file).push(h); }
const where = new Map(); // orig module -> {file, line, names:Set}
for (const [file, hs] of tipFiles) {
  hs.sort((a, b) => a.line - b.line);
  const header = new Set(); let cur = null;
  for (const h of hs) {
    const m = h.text.match(/^-- bundled from (\S+)\s*$/);
    if (m) { cur = { file, line: h.line, names: new Set(), header }; where.set(m[1], cur); continue; }
    for (const n of attrNames(h.text)) (cur ? cur.names : header).add(n);
  }
  if (!hs.some(h => /^-- bundled from /.test(h.text))) {
    const mod = pathToMod(file);
    where.set(mod, { file, line: 1, names: header, header: new Set() });
  }
}
say(`tip: ${tipHits.length} marker/disable lines in ${tipFiles.size} files`);

// Modules at the tip with no marker/disable lines at all are not in tipFiles; find them by path when needed.
let tipPaths = null;
const tipHasPath = p => { if (!tipPaths) tipPaths = new Set(g('ls-tree', '-r', '--name-only', REV, '--', 'src').split('\n')); return tipPaths.has(p); };

// 3. blocked/failing set (modules not compiled yet)
let notCompiled = null;
if (!argv.includes('--all')) {
  try {
    const lib = await import('./scanlib.mjs');
    const { files } = lib.failingFromList();
    notCompiled = lib.blockedBy(lib.importGraph(BASE), files.map(pathToMod));
    say(`not compiled yet: ${notCompiled.size} modules (${files.length} listed failing files and everything importing them)`);
  } catch (e) { say('blocked set unavailable, reporting all: ' + String(e.message || e).split('\n')[0]); notCompiled = null; }
}

// 4. compare
const out = []; let checked = 0, gone = 0;
for (const [mod, lines] of mainBy) {
  let w = where.get(mod);
  if (!w) {
    const p = modToPath(mod);
    if (tipHasPath(p)) w = { file: p, line: 1, names: new Set(), header: new Set() };
    else { gone++; continue; } // bundled without a marker line we saw, or deleted
  }
  checked++;
  const have = [...w.names, ...w.header];
  const missing = [];
  for (const l of lines) for (const n of l.names) {
    if (have.some(m => same(m, n))) continue;
    missing.push({ name: n, mainLine: `${l.line}: ${l.text}` });
  }
  if (!missing.length) continue;
  const inScope = !notCompiled || notCompiled.has(mod) || notCompiled.has(pathToMod(w.file));
  out.push({ orig: mod, file: w.file, sectionLine: w.line, inScope, missing });
}
say(`checked ${checked} originals (${gone} not located at the tip); ${out.length} have a main disable missing at the tip, ${out.filter(o => o.inScope).length} of them not compiled yet`);
for (const o of out.filter(o => o.inScope || argv.includes('--all'))) {
  console.log(`${o.file}:${o.sectionLine}  (orig ${o.orig})${o.inScope ? '' : '  [compiled]'}`);
  for (const m of o.missing) console.log(`    missing ${m.name}    main ${m.mainLine.slice(0, 200)}`);
}
if (JSON_OUT) fs.writeFileSync(path.resolve(HOME, JSON_OUT), JSON.stringify(out, null, 1));
