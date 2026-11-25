#!/usr/bin/env node
// Preventive audit for pr120-hygiene.yml: global instances that every typeclass search for their class must try.
//
//   node tools/instance-audit.mjs [--k 4] [--min-reach 500] [--maxc 6000] [--json] [--rev <rev>] [--no-claims]
//
// A candidate is a named, global, non-private, default-priority `instance` of a Prop-valued class (Module.Finite,
// T2Space, IsScalarTower, ...) whose explicit arguments are all variables. Its discrimination-tree key is then all
// wildcards: every search for that class, in every module that sees it, tries it and backchains into its
// hypotheses (the cost behind `typeclass` heartbeat timeouts). If the same instance is found WITHOUT it (Mathlib or
// another project instance provides it from the same hypotheses), `instance` -> `local instance` only removes that
// cost: the name keeps working, it stays an instance in its own scope, and because the class is Prop-valued
// whatever instance is found instead is definitionally equal (proof irrelevance). Precedent: #1423 (merged).
//
// This script decides nothing. For each candidate it emits the one-line change and a check file
// (tools/gate-rules.mjs hygieneCheckText):  import <Module>;  example : type_of% @<Name> := by intros; infer_instance
// Lean supplies the instance's exact type. pr120-hygiene.yml builds the module with the change and compiles the
// check. The check imports the declaring module and opens nothing, so it sees no more instances than any module
// that saw the old instance (they all import the declaring module's public part); if it compiles, no search that
// found the old instance loses one. A wrong full name only makes the check fail.
// Also skipped: instances any `attribute [-instance]` line may name (it would fail once the name is no longer an
// instance), and candidates that interact: if one picked candidate's module sees another's (or one of our open
// hygiene PRs), their checks are not independent.
// JSON output: [{module, file, line, name, full, cls, old, new, check, reach, closure}]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, REPO, BASE, importGraph, closureOf, pathToMod, say, git, catStream } from './scanlib.mjs';
import { INST_DECL, toLocalInstance, hygieneCheckText, LEAN_NAME } from './gate-rules.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const REV = opt('--rev', BASE), MIN_REACH = +opt('--min-reach', 500), K = +opt('--k', 0) || Infinity, MAXC = +opt('--maxc', 6000);
const UPSTREAM = 'rohanarun/riemann-hypothesis';

// Prop-valued classes from Mathlib (full names). Project classes declared `... : Prop` (header on one line) are added.
const PROP_CLASSES = new Set(`Module.Finite FiniteDimensional Module.Free Module.Flat Module.Projective Module.IsTorsionFree
NoZeroSMulDivisors IsScalarTower SMulCommClass IsCentralScalar IsDomain Nontrivial CharZero CharP ExpChar IsNoetherian
IsNoetherianRing IsArtinianRing Algebra.IsSeparable Algebra.IsIntegral Algebra.IsAlgebraic IsGalois Normal
Algebra.IsQuadraticExtension NumberField FunctionField IsIntegrallyClosed IsDedekindDomain IsDiscreteValuationRing
IsPrincipalIdealRing IsLocalRing IsFractionRing IsLocalization IsIntegralClosure Algebra.FiniteType Algebra.FinitePresentation
Algebra.EssFiniteType Algebra.Etale Algebra.Smooth Algebra.Unramified FaithfulSMul
T0Space T1Space T2Space T3Space RegularSpace NormalSpace CompactSpace LocallyCompactSpace SecondCountableTopology
FirstCountableTopology SeparableSpace ProperSpace CompleteSpace DiscreteTopology TotallyDisconnectedSpace
IsTopologicalRing IsTopologicalGroup IsTopologicalAddGroup ContinuousMul ContinuousAdd ContinuousSMul ContinuousConstSMul
MeasurableSingletonClass BorelSpace OpensMeasurableSpace
MeasureTheory.SFinite MeasureTheory.IsFiniteMeasure MeasureTheory.IsProbabilityMeasure MeasureTheory.SigmaFinite
MeasureTheory.Measure.IsHaarMeasure MeasureTheory.Measure.IsAddHaarMeasure MeasureTheory.Measure.Regular
Finite Countable Infinite Subsingleton Fact IsEmpty Nonempty Ideal.IsPrime Ideal.IsMaximal Ideal.IsRadical
Subgroup.Normal Subgroup.FiniteIndex AddSubgroup.Normal IsCyclic IsSimpleGroup IsSimpleOrder IsSemisimpleModule
IsSimpleModule IsReduced IsField IsAlgClosed PerfectField IsSepClosed`.split(/\s+/).filter(Boolean));
try {
  for (const l of git('grep', '-h', '-E', '^\\s*class\\s+.*:\\s*Prop\\s*(where)?\\s*$', REV, '--', 'src').split('\n')) {
    const m = l.match(/^\s*class\s+(?:inductive\s+)?([^\s(\[{:]+)/); if (m) PROP_CLASSES.add(m[1]);
  }
} catch {}

const g = importGraph(REV);
const pubRev = new Map(), allRev = new Map();
for (const [m, v] of Object.entries(g)) for (const i of v.imports || []) if (g[i.mod]) {
  (allRev.get(i.mod) || allRev.set(i.mod, []).get(i.mod)).push(m);
  if (i.pub) (pubRev.get(i.mod) || pubRev.set(i.mod, []).get(i.mod)).push(m);
}
// Modules that see m's declarations: m and every module re-exporting it, plus every direct importer of those.
const seersOf = m => {
  const R = new Set([m]); const st = [m];
  while (st.length) { const x = st.pop(); for (const y of pubRev.get(x) || []) if (!R.has(y)) { R.add(y); st.push(y); } }
  const S = new Set(R); for (const x of R) for (const y of allRev.get(x) || []) S.add(y);
  return S.size - 1;
};
const buildCone = m => { const seen = new Set([m]); const st = [m]; while (st.length) { const x = st.pop(); for (const i of g[x]?.imports || []) if (g[i.mod] && !seen.has(i.mod)) { seen.add(i.mod); st.push(i.mod); } } return seen.size; };

// ---- parsing helpers ----
const OPEN = '([{⦃⟨', CLOSE = ')]}⦄⟩';
function topLevel(s) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (OPEN.includes(ch)) { if (depth === 0 && cur.trim()) { parts.push(cur.trim()); cur = ''; } depth++; cur += ch; continue; }
    if (CLOSE.includes(ch)) { depth--; cur += ch; if (depth === 0) { parts.push(cur.trim()); cur = ''; } continue; }
    if (depth === 0 && /\s/.test(ch)) { if (cur.trim()) parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
function topIndex(s, tok) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (OPEN.includes(ch)) depth++; else if (CLOSE.includes(ch)) depth--;
    else if (depth === 0 && s.startsWith(tok, i)) return i;
  }
  return -1;
}
const IDENT = /^[\p{L}_][\p{L}\p{N}_'₀-₉!?]*$/u;
const binderNames = grp => { const inner = grp.slice(1, -1); const c = topIndex(inner, ':'); return c < 0 ? (grp[0] === '[' ? [] : inner.trim().split(/\s+/).filter(x => IDENT.test(x))) : inner.slice(0, c).trim().split(/\s+/).filter(x => IDENT.test(x)); };
// Blank out comments (nested block comments, line comments, doc comments) and string literals, keeping line breaks.
function stripComments(text) {
  let out = '', depth = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (depth === 0 && !inStr && c === '"') { inStr = true; out += ' '; continue; }
    if (inStr) { if (c === '\\') { out += ' '; if (n !== undefined) { out += n === '\n' ? '\n' : ' '; i++; } continue; } if (c === '"') inStr = false; out += c === '\n' ? '\n' : ' '; continue; }
    if (c === '/' && n === '-') { depth++; out += '  '; i++; continue; }
    if (depth > 0 && c === '-' && n === '/') { depth--; out += '  '; i++; continue; }
    if (depth > 0) { out += c === '\n' ? '\n' : ' '; continue; }
    if (c === '-' && n === '-') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } if (i < text.length) out += '\n'; continue; }
    out += c;
  }
  return out;
}

// ---- names that some `attribute [-instance]` line erases (anywhere in src) ----
const erased = new Set();
try {
  for (const l of git('grep', '-h', '-E', 'attribute\\s*\\[[^]]*-\\s*instance', REV, '--', 'src').split('\n')) {
    const after = l.slice(l.lastIndexOf(']') + 1).replace(/\bin\s*$/, '');
    for (const t of after.split(/\s+/)) if (t) erased.add(t.replace(/^_root_\./, ''));
  }
} catch {}
const isErased = (full, name) => erased.has(full) || erased.has(name) || [...erased].some(t => full.endsWith('.' + t) || t.endsWith('.' + name));

// ---- pass: global instances ----
const files = git('grep', '-l', '-E', '^\\s*(@\\[[^]]*\\]\\s*)?((noncomputable|protected|nonrec)\\s+)*instance\\b', REV, '--', 'src')
  .split('\n').filter(Boolean).map(l => l.replace(/^[^:]+:/, '')).filter(f => f.endsWith('.lean'));
const SECTION = /^\s*(@\[[^\]]*\]\s*)?((public|private|noncomputable)\s+)*section\b/;
const insts = [];
let skippedErased = 0;
await catStream(REV, files, (file, raw) => {
  if (!raw) return;
  const rawLines = raw.split('\n');
  const lines = stripComments(raw).split('\n');
  if (lines.length !== rawLines.length) return; // the comment stripper lost track: skip the file
  const frames = [{ ns: [], vars: [] }];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const nm = L.match(/^\s*namespace\s+(\S+)/);
    if (nm) { frames.push({ ns: nm[1].split('.'), vars: [] }); continue; }
    if (SECTION.test(L)) { frames.push({ ns: [], vars: [] }); continue; }
    if (/^\s*end\b/.test(L)) { if (frames.length > 1) frames.pop(); continue; }
    if (/^\s*variable\b/.test(L)) {
      let s = L.replace(/^\s*variable\b/, '');
      for (let j = i + 1; j < lines.length && /^\s+[([{⦃]/.test(lines[j]); j++) s += ' ' + lines[j];
      if (!/\bin\s*$/.test(s)) for (const grp of topLevel(s)) if (/^[([{⦃]/.test(grp)) frames[frames.length - 1].vars.push(...binderNames(grp));
      continue;
    }
    const m = L.match(INST_DECL);
    if (!m || rawLines[i] !== L) continue; // the declaration line itself must carry no comment or string
    let sig = L.slice(m[0].length);
    for (let j = i + 1; j < Math.min(lines.length, i + 25) && topIndex(sig, ':=') < 0 && !/\swhere\b/.test(sig) && !/^\s*\|/.test(lines[j]); j++) sig += ' ' + lines[j].trim();
    let end = topIndex(sig, ':='); const w = sig.search(/\swhere\b/); if (w >= 0 && (end < 0 || w < end)) end = w;
    if (end < 0) continue;
    sig = sig.slice(0, end);
    if (/^\s*\(priority\s*:=/.test(sig)) continue;
    const parts = topLevel(sig);
    if (!parts.length || /^[([{⦃:]/.test(parts[0])) continue; // unnamed: the check needs the name
    const name = parts.shift();
    const own = [];
    while (parts.length && /^[([{⦃]/.test(parts[0])) own.push(parts.shift());
    if (!parts.length || !parts[0].startsWith(':')) continue;
    const type = parts.join(' ').replace(/^:\s*/, '').trim();
    const tp = topLevel(type);
    if (tp.length < 2 || !PROP_CLASSES.has(tp[0])) continue; // full class names only; one that needs an `open` is skipped
    const bound = new Set([...frames.flatMap(f => f.vars), ...own.flatMap(binderNames)]);
    if (!tp.slice(1).every(a => bound.has(a))) continue;
    const full = name.startsWith('_root_.') ? name.slice(7) : [...frames.flatMap(f => f.ns), name].join('.');
    if (!LEAN_NAME.test(full)) continue;
    if (isErased(full, name.split('.').pop())) { skippedErased++; continue; }
    const mod = pathToMod(file);
    insts.push({ module: mod, file, line: i + 1, name, full, cls: tp[0], old: rawLines[i], new: toLocalInstance(rawLines[i]), check: hygieneCheckText(mod, full) });
  }
});
say(`${insts.length} named global default-priority instances of Prop classes with all-variable arguments (${skippedErased} more skipped: an \`attribute [-instance]\` line may name them)`);

// ---- filters: reach, build cone, earlier verdicts, open PRs ----
let res = insts;
for (const c of res) c.reach = seersOf(c.module);
res = res.filter(c => c.reach >= MIN_REACH);
for (const c of res) c.closure = buildCone(c.module);
res = res.filter(c => c.closure <= MAXC);
// runs/hygiene-done.txt: "<module>:<line> <tip>" per candidate already tried; skipped while its file is unchanged.
const doneFile = path.join(HOME, 'runs', 'hygiene-done.txt');
const done = new Map();
for (const l of (fs.existsSync(doneFile) ? fs.readFileSync(doneFile, 'utf8') : '').split('\n')) {
  const [k, t] = l.trim().split(/\s+/); if (k && /^[0-9a-f]{40}$/.test(t || '')) (done.get(k) || done.set(k, []).get(k)).push(t);
}
const unchangedSince = (t, file) => { try { execFileSync('git', ['-C', REPO, 'diff', '--quiet', t, REV, '--', file], { stdio: 'ignore' }); return true; } catch { return false; } };
const before = res.length;
res = res.filter(c => !(done.get(`${c.module}:${c.line}`) || []).some(t => unchangedSince(t, c.file)));
if (before !== res.length) say(`skipped ${before - res.length} candidate(s) already tried at an unchanged file`);
// Our open hygiene PRs: their instances are still global upstream, so candidates that see them are not independent.
const pending = new Set();
if (!argv.includes('--no-claims')) {
  let o = '';
  try { o = execFileSync('node', ['tools/claim.mjs', 'check', ...new Set(res.map(c => c.file))], { cwd: HOME, encoding: 'utf8', maxBuffer: 1 << 26 }); }
  catch (e) { o = String(e.stdout || ''); if (!o && res.length) throw new Error('claim check failed'); }
  const claimed = new Set(o.split('\n').filter(l => l.startsWith('CLAIMED')).map(l => l.split(/\s+/)[1]));
  const b2 = res.length; res = res.filter(c => !claimed.has(c.file));
  if (b2 !== res.length) say(`dropped ${b2 - res.length} candidate(s) in files an open PR touches`);
  const owner = process.env.GITHUB_REPOSITORY_OWNER || execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).trim();
  const prs = JSON.parse(execFileSync('gh', ['pr', 'list', '-R', UPSTREAM, '--state', 'open', '--author', owner, '--limit', '200', '--json', 'title,files'], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  for (const p of prs) if (/^Make redundant global /.test(p.title)) for (const f of p.files || []) pending.add(pathToMod(f.path));
  if (pending.size) say(`${pending.size} module(s) with our open hygiene PRs`);
}
// Independence: keep a candidate only if no kept candidate's module (or a pending one) is visible from it, or it from them.
const vis = new Map(); const visOf = m => { if (!vis.has(m)) vis.set(m, closureOf(g, m)); return vis.get(m); };
const kept = [];
let deferred = 0;
for (const c of res.sort((a, b) => b.reach - a.reach)) {
  if (kept.length >= K) break;
  const others = [...kept.map(k => k.module), ...pending];
  if (kept.some(k => k.file === c.file) || others.some(o => visOf(c.module).has(o) || visOf(o).has(c.module))) { deferred++; continue; }
  kept.push(c);
}
say(`${res.length} candidate(s) (reach >= ${MIN_REACH}, build cone <= ${MAXC}); picked ${kept.length} independent one(s)${deferred ? `, ${deferred} deferred (same file, or they see each other)` : ''}`);
if (argv.includes('--json')) process.stdout.write(JSON.stringify(kept));
else for (const c of kept) console.log(`${String(c.reach).padStart(6)} see ${String(c.closure).padStart(6)} cone  ${c.cls}  ${c.file}:${c.line} ${c.full}`);
