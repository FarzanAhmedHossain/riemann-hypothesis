#!/usr/bin/env node
// Preventive audit for pr120-hygiene.yml: global instances that every typeclass search for their class must try.
//
//   node tools/instance-audit.mjs [--k 4] [--min-reach 500] [--maxc 6000] [--json] [--rev <rev>] [--all]
//
// A candidate is a global, non-private, default-priority `instance` of a Prop-valued class (Module.Finite,
// T2Space, IsScalarTower, ...) whose explicit arguments are all variables. Its discrimination-tree key is then all
// wildcards: every search for that class, in every module that sees it, tries it and backchains into its
// hypotheses (the cost behind `typeclass` heartbeat timeouts). If the same instance can be found WITHOUT it (Mathlib
// or another project instance provides it from the same hypotheses), `instance` -> `local instance` only removes
// that cost. The name keeps working and it stays an instance in its own scope. Because the class is Prop-valued,
// whatever instance is found instead is definitionally equal (proof irrelevance).
// Precedent: #1423 (josephch405, merged 2026-11-25) for three Module.Finite / FiniteDimensional instances.
//
// This script decides nothing by itself. For each candidate it emits the one-line change and a check file:
//     import <Module>
//     example <the instance's hypotheses, exactly as Lean includes them> : <its type> := inferInstance
// pr120-hygiene.yml builds the module with the change and then compiles the check file against it. The check file
// imports the declaring module and opens no namespace, so it sees no more instances than any module that saw the
// old instance (they all import the declaring module's public part). If it compiles, no search that found the old
// instance can fail now. If anything is off in the reconstruction (a name that needs an `open`, a missed
// hypothesis), the check fails and nothing is published.
// Lean's rule for section variables (v4.10+): a variable is included when the header mentions it (or a variable
// it depends on is included), and an instance-implicit variable when all the variables it mentions are included.
// Files with `include`/`omit` are skipped. Duplicate copies of the same instance are reported as a hint.
// JSON output: [{module, file, line, name, cls, old, new, check, reach, closure, canonical?}]
import { BASE, importGraph, pathToMod, say, git, catStream } from './scanlib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const REV = opt('--rev', BASE), MIN_REACH = +opt('--min-reach', 500), K = +opt('--k', 0) || Infinity;

// Prop-valued classes from Mathlib (full names). Project classes declared `: Prop` are added below.
const PROP_CLASSES = new Set(`Module.Finite FiniteDimensional Module.Free Module.Flat Module.Projective Module.IsTorsionFree
NoZeroSMulDivisors IsScalarTower SMulCommClass IsCentralScalar IsDomain Nontrivial CharZero CharP ExpChar IsNoetherian
IsNoetherianRing IsArtinianRing Algebra.IsSeparable Algebra.IsIntegral Algebra.IsAlgebraic IsGalois Normal
Algebra.IsQuadraticExtension NumberField FunctionField IsIntegrallyClosed IsDedekindDomain IsDiscreteValuationRing
IsPrincipalIdealRing IsLocalRing IsFractionRing IsLocalization IsIntegralClosure Algebra.FiniteType Algebra.FinitePresentation
Algebra.EssFiniteType Algebra.Etale Algebra.Smooth Algebra.Unramified FaithfulSMul
T0Space T1Space T2Space T3Space RegularSpace NormalSpace CompactSpace LocallyCompactSpace SecondCountableTopology
FirstCountableTopology SeparableSpace ProperSpace CompleteSpace DiscreteTopology TotallyDisconnectedSpace
IsTopologicalRing IsTopologicalGroup IsTopologicalAddGroup ContinuousMul ContinuousAdd ContinuousSMul ContinuousConstSMul
MeasurableSingletonClass BorelSpace OpensMeasurableSpace SFinite IsFiniteMeasure IsProbabilityMeasure SigmaFinite
MeasureTheory.SFinite MeasureTheory.IsFiniteMeasure MeasureTheory.IsProbabilityMeasure MeasureTheory.SigmaFinite
MeasureTheory.Measure.IsHaarMeasure MeasureTheory.Measure.IsAddHaarMeasure MeasureTheory.Measure.Regular
Finite Countable Infinite Subsingleton Fact IsEmpty Nonempty Ideal.IsPrime Ideal.IsMaximal Ideal.IsRadical
Subgroup.Normal Subgroup.FiniteIndex AddSubgroup.Normal IsCyclic IsSimpleGroup IsSimpleOrder IsSemisimpleModule
IsSimpleModule IsReduced IsField IsAlgClosed PerfectField IsSepClosed`.split(/\s+/).filter(Boolean));

const g = importGraph(REV);
// Modules re-exported by m: m itself plus everything reachable through `public import`s.
const pubCache = new Map();
const pubClosure = m => {
  if (pubCache.has(m)) return pubCache.get(m);
  const seen = new Set([m]); const st = [m];
  while (st.length) { const x = st.pop(); for (const i of g[x]?.imports || []) if (i.pub && g[i.mod] && !seen.has(i.mod)) { seen.add(i.mod); st.push(i.mod); } }
  pubCache.set(m, seen); return seen;
};
// Modules that see m's declarations: R = m and every module re-exporting m; then R plus every direct importer of R.
const pubRev = new Map(), allRev = new Map();
for (const [m, v] of Object.entries(g)) for (const i of v.imports || []) if (g[i.mod]) {
  (allRev.get(i.mod) || allRev.set(i.mod, []).get(i.mod)).push(m);
  if (i.pub) (pubRev.get(i.mod) || pubRev.set(i.mod, []).get(i.mod)).push(m);
}
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
// A binder group "(a b : T)" -> [{kind, names, type}], "[C x]" -> [{kind:'[', names:[], type:'C x'}]
function parseBinder(grp) {
  const kind = grp[0], inner = grp.slice(1, -1).trim();
  const c = topIndex(inner, ':');
  if (kind === '[') {
    if (c >= 0 && IDENT.test(inner.slice(0, c).trim())) return { kind, names: [inner.slice(0, c).trim()], type: inner.slice(c + 1).trim() };
    return { kind, names: [], type: inner };
  }
  if (c < 0) return { kind, names: inner.split(/\s+/).filter(x => IDENT.test(x)), type: '' };
  return { kind, names: inner.slice(0, c).trim().split(/\s+/).filter(x => IDENT.test(x)), type: inner.slice(c + 1).trim() };
}
const tokensOf = s => new Set((s.match(/[\p{L}_][\p{L}\p{N}_'₀-₉!?]*/gu) || []));
const MAXC = +opt('--maxc', 6000);

// ---- pass 1: project Prop classes ----
try {
  for (const l of git('grep', '-h', '-E', '^\\s*class\\s+[^ ]+.*:\\s*Prop\\b', REV, '--', 'src').split('\n')) {
    const m = l.match(/class\s+(?:inductive\s+)?([^\s(\[{:]+)/); if (m) PROP_CLASSES.add(m[1]);
  }
} catch {}
const BY_SHORT = new Map();
for (const c of PROP_CLASSES) { const s = c.split('.').pop(); (BY_SHORT.get(s) || BY_SHORT.set(s, []).get(s)).push(c); }

// ---- pass 2: global instances ----
const files = git('grep', '-l', '-E', '^\\s*(@\\[[^]]*\\]\\s*)?((noncomputable|protected|nonrec)\\s+)*instance\\b', REV, '--', 'src')
  .split('\n').filter(Boolean).map(l => l.replace(/^[^:]+:/, '')).filter(f => f.endsWith('.lean'));
// Modifiers then the `instance` keyword. `private` is not matched (not exported), nor `local`/`scoped`.
const INST = /^(\s*(?:@\[[^\]]*\]\s*)?(?:(?:noncomputable|protected|nonrec)\s+)*)instance\b/;
const SCOPE_OPEN = /^\s*(@\[[^\]]*\]\s*)?((public|private|noncomputable)\s+)*section\b|^\s*namespace\b/;
const insts = [];
await catStream(REV, files, (file, text) => {
  if (!text) return;
  const lines = text.split('\n');
  if (lines.some(l => /^\s*(include|omit)\b/.test(l))) return;
  const universes = lines.filter(l => /^\s*universe\s/.test(l)).map(l => l.trim());
  const frames = [{ vars: [] }];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (SCOPE_OPEN.test(L)) { frames.push({ vars: [] }); continue; }
    if (/^\s*end\b/.test(L) && frames.length > 1) { frames.pop(); continue; }
    if (/^\s*variable\b/.test(L)) {
      let s = L.replace(/^\s*variable\b/, ''); let j = i + 1;
      for (; j < lines.length && /^\s+[([{⦃]/.test(lines[j]); j++) s += ' ' + lines[j];
      if (/\bin\s*$/.test(s)) continue; // `variable ... in`: applies to the next command only; leaving it out only makes the check stricter
      for (const grp of topLevel(s)) if (/^[([{⦃]/.test(grp)) {
        const b = parseBinder(grp);
        if (b.kind !== '[' && !b.type) continue; // binder-kind update of an existing variable: no new hypothesis
        frames[frames.length - 1].vars.push({ ...b, raw: grp });
      }
      continue;
    }
    const m = L.match(INST);
    if (!m) continue;
    let sig = L.slice(m[0].length);
    for (let j = i + 1; j < Math.min(lines.length, i + 25) && topIndex(sig, ':=') < 0 && !/\swhere\b/.test(sig) && !/^\s*\|/.test(lines[j]); j++) sig += ' ' + lines[j].trim();
    let end = topIndex(sig, ':='); const w = sig.search(/\swhere\b/); if (w >= 0 && (end < 0 || w < end)) end = w;
    if (end < 0) continue;
    sig = sig.slice(0, end);
    if (/^\s*\(priority\s*:=/.test(sig)) continue;
    const parts = topLevel(sig);
    let name = '';
    if (parts.length && !/^[([{⦃:]/.test(parts[0])) name = parts.shift();
    const own = [];
    while (parts.length && /^[([{⦃]/.test(parts[0])) { const grp = parts.shift(); own.push({ ...parseBinder(grp), raw: grp }); }
    if (!parts.length || !parts[0].startsWith(':')) continue;
    const type = parts.join(' ').replace(/^:\s*/, '').trim();
    const tp = topLevel(type);
    if (tp.length < 2) continue;
    const head = tp[0], args = tp.slice(1);
    let cls = PROP_CLASSES.has(head) ? head : '';
    if (!cls && !head.includes('.')) for (const full of BY_SHORT.get(head) || []) if (full === head) cls = full;
    if (!cls) continue; // a short name that only an `open` would resolve: skip rather than guess
    const varB = frames.flatMap(f => f.vars);
    const bound = new Set([...varB, ...own].flatMap(b => b.names));
    if (!args.every(a => bound.has(a))) continue;
    // Lean's inclusion rule for section variables.
    const incl = new Set([...tokensOf(type), ...own.flatMap(b => [...tokensOf(b.type), ...b.names])].filter(x => bound.has(x)));
    for (let grew = true; grew;) {
      grew = false;
      for (const b of varB) if (b.kind !== '[' && b.names.some(n => incl.has(n)))
        for (const x of tokensOf(b.type)) if (bound.has(x) && !incl.has(x)) { incl.add(x); grew = true; }
    }
    const used = [];
    for (const b of varB) {
      if (b.kind === '[') { const vs = [...tokensOf(b.type)].filter(x => bound.has(x)); if (vs.length && vs.every(x => incl.has(x))) used.push(b); }
      else if (b.names.some(n => incl.has(n))) { const names = b.names.filter(n => incl.has(n)); used.push({ ...b, names, raw: `${b.kind}${names.join(' ')} : ${b.type}${{ '(': ')', '{': '}', '⦃': '⦄' }[b.kind]}` }); }
    }
    const hypsAll = [...used, ...own].filter(b => b.kind === '[');
    // A hypothesis of the class itself would make the check trivial: skip.
    if (hypsAll.some(b => topLevel(b.type)[0] === head || topLevel(b.type)[0] === cls)) continue;
    const check = [
      'set_option autoImplicit false',
      'set_option relaxedAutoImplicit false',
      ...universes,
      `import ${pathToMod(file)}`,
    ];
    // `import` must come first in a Lean file; options and universes go after it.
    const checkText = [check[check.length - 1], '', ...check.slice(0, -1), '',
      `example ${[...used, ...own].map(b => b.raw.replace(/\s+/g, ' ')).join(' ')} : ${type.replace(/\s+/g, ' ')} := inferInstance`, ''].join('\n');
    // Signature key for the duplicate hint.
    const ren = new Map(); const rn = x => { if (!ren.has(x)) ren.set(x, `v${ren.size}`); return ren.get(x); };
    for (const a of args) rn(a);
    const norm = s => s.replace(/[\p{L}_][\p{L}\p{N}_'₀-₉!?]*/gu, x => (incl.has(x) ? rn(x) : x)).replace(/\s+/g, ' ').trim();
    const sigKey = `${cls} ${args.map(rn).join(' ')} | ${hypsAll.map(b => norm(b.type)).sort().join(' ; ')}`;
    insts.push({ module: pathToMod(file), file, line: i + 1, name, cls, sig: sigKey, old: L, new: L.slice(0, m[1].length) + 'local ' + L.slice(m[1].length), check: checkText });
  }
});
say(`${insts.length} global, default-priority instances of Prop classes with all-variable arguments`);

// ---- duplicate hint ----
const bySig = new Map();
for (const x of insts) (bySig.get(x.sig) || bySig.set(x.sig, []).get(x.sig)).push(x);
for (const [, grp] of bySig) if (grp.length > 1) for (const b of grp) {
  const pc = pubClosure(b.module);
  const c = grp.find(a => a !== b && a.module !== b.module && pc.has(a.module));
  if (c) b.canonical = { module: c.module, file: c.file, line: c.line, name: c.name };
}

// ---- filters: reach, build cone, earlier verdicts, open PRs ----
let res = insts;
for (const c of res) c.reach = seersOf(c.module);
res = res.filter(c => argv.includes('--all') || c.reach >= MIN_REACH);
for (const c of res) c.closure = buildCone(c.module);
res = res.filter(c => argv.includes('--all') || c.closure <= MAXC);
// runs/hygiene-done.txt: "<module>:<line> <tip>" for candidates already tried; skipped while their file is unchanged.
const { execFileSync } = await import('node:child_process');
const fs = await import('node:fs');
const path = await import('node:path');
const { HOME, REPO } = await import('./scanlib.mjs');
const doneFile = path.join(HOME, 'runs', 'hygiene-done.txt');
const done = new Map();
for (const l of (fs.existsSync(doneFile) ? fs.readFileSync(doneFile, 'utf8') : '').split('\n')) {
  const [k, t] = l.trim().split(/\s+/); if (k && /^[0-9a-f]{40}$/.test(t || '')) (done.get(k) || done.set(k, []).get(k)).push(t);
}
const unchangedSince = (t, file) => { try { execFileSync('git', ['-C', REPO, 'diff', '--quiet', t, REV, '--', file], { stdio: 'ignore' }); return true; } catch { return false; } };
const before = res.length;
res = res.filter(c => !(done.get(`${c.module}:${c.line}`) || []).some(t => unchangedSince(t, c.file)));
if (before !== res.length) say(`skipped ${before - res.length} candidate(s) already tried at an unchanged file`);
if (res.length && !argv.includes('--no-claims')) {
  let o = '';
  try { o = execFileSync('node', ['tools/claim.mjs', 'check', ...new Set(res.map(c => c.file))], { cwd: HOME, encoding: 'utf8', maxBuffer: 1 << 26 }); }
  catch (e) { o = String(e.stdout || ''); if (!o) throw new Error('claim check failed'); }
  const claimed = new Set(o.split('\n').filter(l => l.startsWith('CLAIMED')).map(l => l.split(/\s+/)[1]));
  const b2 = res.length; res = res.filter(c => !claimed.has(c.file));
  if (b2 !== res.length) say(`dropped ${b2 - res.length} candidate(s) in files an open PR touches`);
}
// One candidate per file per run (each becomes its own PR; two edits to one file would conflict).
const seenF = new Set();
res = res.sort((a, b) => b.reach - a.reach).filter(c => !seenF.has(c.file) && seenF.add(c.file));
say(`${res.length} candidate(s) (reach >= ${MIN_REACH}, build cone <= ${MAXC}); picked ${Math.min(K, res.length)}`);
if (argv.includes('--json')) process.stdout.write(JSON.stringify(res.slice(0, K)));
else for (const c of res.slice(0, K)) console.log(`${String(c.reach).padStart(6)} see ${String(c.closure).padStart(6)} cone  ${c.cls}  ${c.file}:${c.line} ${c.name}${c.canonical ? `  (copy of ${c.canonical.file}:${c.canonical.line})` : ''}\n${c.check.replace(/^/gm, '        | ')}`);
