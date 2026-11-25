#!/usr/bin/env node
// `open` parity between main's original modules and their sections at the branch tip.
//
//   node tools/open-parity.mjs [--rev <commit>] [--all] [--json runs/open-parity.json]
//
// For every original module on main, collect the namespaces its own source opens (`open A B`, `open A in`,
// `open scoped A`, `open A (x y)`, `open A hiding x`, `open A renaming x → y`), then check that each namespace is
// opened somewhere in the module's section at the tip (bundle section plus file header, or the whole file when it
// is not bundled), or that it no longer exists (a namespace nobody declares cannot change resolution).
// A namespace the original opened but the section does not is reported: names in that section can then resolve
// differently from main (same failure family as the instance-disable regressions found 2026-11-25).
// Without --all only modules that are not compiled yet are printed. Read-only: git greps plus the blocked set.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, REPO, BASE, MAIN, pathToMod, modToPath, say } from './scanlib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const REV = opt('--rev', BASE);
const JSON_OUT = opt('--json', '');
const g = (...a) => execFileSync('git', ['-C', REPO, '-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 1 << 30 });
const grepLines = (rev, args) => {
  let out = '';
  try { out = g('grep', '-n', ...args, rev, '--', 'src'); } catch (e) { out = String(e.stdout || ''); }
  return out.split('\n').filter(Boolean).map(l => {
    const rest = l.slice(rev.length + 1); const m = rest.match(/^([^:]+):(\d+):(.*)$/);
    return m ? { file: m[1], line: +m[2], text: m[3] } : null;
  }).filter(Boolean);
};
// Namespaces named by one `open` line (single-line opens only; multi-line opens are rare and skipped).
const opened = text => {
  const m = text.match(/^\s*open\s+(.*)$/); if (!m) return [];
  let s = m[1].replace(/--.*$/, '').replace(/\s+in\s*$/, '').trim();
  s = s.replace(/^scoped\s+/, '');
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\bhiding\b.*$/, '').replace(/\brenaming\b.*$/, '');
  return s.split(/\s+/).filter(x => /^[A-Za-z_«][\w.'₀-₉«»]*$/u.test(x));
};

const mainHits = grepLines(MAIN, ['-E', '-e', '^\\s*open\\s']);
const mainBy = new Map();
for (const h of mainHits) { const ns = opened(h.text); if (!ns.length) continue; const mod = pathToMod(h.file); if (!mainBy.has(mod)) mainBy.set(mod, new Map()); for (const n of ns) if (!mainBy.get(mod).has(n)) mainBy.get(mod).set(n, `${h.line}: ${h.text.trim()}`); }
say(`main: ${mainHits.length} open lines in ${mainBy.size} modules`);

const tipHits = grepLines(REV, ['-E', '-e', '^-- bundled from ', '-e', '^\\s*open\\s']);
const tipFiles = new Map();
for (const h of tipHits) { if (!tipFiles.has(h.file)) tipFiles.set(h.file, []); tipFiles.get(h.file).push(h); }
const where = new Map();
for (const [file, hs] of tipFiles) {
  hs.sort((a, b) => a.line - b.line);
  const header = new Set(); let cur = null;
  for (const h of hs) {
    const m = h.text.match(/^-- bundled from (\S+)\s*$/);
    if (m) { cur = { file, line: h.line, names: new Set(), header }; where.set(m[1], cur); continue; }
    for (const n of opened(h.text)) (cur ? cur.names : header).add(n);
  }
  if (!hs.some(h => /^-- bundled from /.test(h.text))) where.set(pathToMod(file), { file, line: 1, names: header, header: new Set() });
}
say(`tip: ${tipHits.length} marker/open lines in ${tipFiles.size} files`);

// Namespaces that exist at the tip: any `namespace X` line, or a dotted declaration prefix. Approximated by the
// set of `namespace` lines (and their prefixes) plus Mathlib/Lean namespaces, which we cannot list: a name not
// declared as a project namespace is kept (could be Mathlib's).
const nsLines = grepLines(REV, ['-E', '-e', '^\\s*namespace\\s']);
const projNs = new Set();
for (const h of nsLines) { const m = h.text.match(/^\s*namespace\s+(\S+)/); if (m) { const parts = m[1].split('.'); for (let k = 1; k <= parts.length; k++) projNs.add(parts.slice(0, k).join('.')); } }

let notCompiled = null;
if (!argv.includes('--all')) {
  try {
    const lib = await import('./scanlib.mjs');
    const { files } = lib.failingFromList();
    notCompiled = lib.blockedBy(lib.importGraph(BASE), files.map(pathToMod));
  } catch (e) { say('blocked set unavailable: ' + String(e.message || e).split('\n')[0]); }
}
let tipPaths = null;
const tipHasPath = p => { if (!tipPaths) tipPaths = new Set(g('ls-tree', '-r', '--name-only', REV, '--', 'src').split('\n')); return tipPaths.has(p); };

const out = []; let checked = 0, gone = 0;
for (const [mod, nsMap] of mainBy) {
  let w = where.get(mod);
  if (!w) { const p = modToPath(mod); if (tipHasPath(p)) w = { file: p, line: 1, names: new Set(), header: new Set() }; else { gone++; continue; } }
  checked++;
  const have = new Set([...w.names, ...w.header]);
  const missing = [...nsMap.entries()].filter(([n]) => !have.has(n) && ![...have].some(h => h.endsWith('.' + n) || n.endsWith('.' + h)));
  if (!missing.length) continue;
  const inScope = !notCompiled || notCompiled.has(mod) || notCompiled.has(pathToMod(w.file));
  out.push({ orig: mod, file: w.file, sectionLine: w.line, inScope, missing: missing.map(([n, l]) => ({ ns: n, project: projNs.has(n), mainLine: l })) });
}
const scoped = out.filter(o => o.inScope || argv.includes('--all'));
say(`checked ${checked} originals (${gone} not at the tip); ${out.length} miss an opened namespace (${out.filter(o => o.inScope).length} not compiled yet); ${scoped.reduce((s, o) => s + o.missing.filter(m => m.project).length, 0)} missing PROJECT namespaces in scope`);
for (const o of scoped) {
  const pm = o.missing.filter(m => m.project); if (!pm.length) continue;
  console.log(`${o.file}:${o.sectionLine}  (orig ${o.orig.split('.').slice(-2).join('.')})`);
  for (const m of pm) console.log(`    missing open ${m.ns}    main ${m.mainLine.slice(0, 150)}`);
}
if (JSON_OUT) fs.writeFileSync(path.resolve(HOME, JSON_OUT), JSON.stringify(out, null, 1));
