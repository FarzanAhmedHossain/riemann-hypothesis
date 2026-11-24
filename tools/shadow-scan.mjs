#!/usr/bin/env node
// Batch scan for deterministic enclosing-namespace shadowing introduced by bundling (playbook Pattern 1).
//
//   node --max-old-space-size=4096 tools/shadow-scan.mjs [--set blocked|compiled|both] [--sample N] [--out runs/x.json]
//
// Lean resolves an identifier `x` (or a dotted `Q.x`) used inside `namespace A.B.C` by trying A.B.C.x, A.B.x, A.x
// (longest first) BEFORE any opened namespace or the root. For each identifier in each target module we compute
// that prefix resolution twice: on the branch (the bundle's import closure, branch declarations) and for the
// section's ORIGINAL module on main (its import closure there, main declarations). If the branch picks a prefix
// declaration the original did not pick, the meaning changed: almost always a compile error. That is a finding.
//
// --set blocked   modules that cannot compile yet (import a listed failing file)  [default]
// --set compiled  modules that compile: every finding there is a FALSE POSITIVE (precision check; use --sample)
// Read-only. Declarations come from a line scanner (not Lean): structure fields and constructors are indexed;
// binders, named arguments, projections, field assignments and declared names are skipped heuristically.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, BASE, MAIN, pathToMod, say, catStream, importGraph, closureOf, blockedBy, failingFromList } from './scanlib.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const SET = opt('--set', 'blocked');
const SAMPLE = +opt('--sample', 0);
// --shard i/n: scan only every n-th target (offset i) so 16k blocked modules fit in ~2 GB per run (a single
// 3 GB run ran out of heap in pass 3a on 2026-11-24). Default output then gets an -iofn suffix.
const SHARD = opt('--shard', '').split('/').map(Number);
const OUT = path.join(HOME, opt('--out', `runs/shadow-findings-${SET}${SHARD.length === 2 ? `-${SHARD[0]}of${SHARD[1]}` : ''}.json`));
const REV = opt('--rev', BASE); // branch revision to scan (recall tests: the parent of a known fix)
const FILES = opt('--files', ''); // file with one src/...lean path per line: scan exactly these

// ---------- lexical helpers ----------
const IDC = "[\\p{L}_][\\p{L}\\p{N}_'!?\\u2080-\\u209C\\u1D62-\\u1D6A]*";
const ID = new RegExp(`${IDC}(?:\\.${IDC})*`, 'gu');
const KEYWORDS = new Set(('fun λ let have show from by at with if then else match do return theorem lemma def abbrev instance structure class ' +
  'inductive where extends deriving namespace section end open variable universe import public private protected noncomputable partial ' +
  'unsafe mutual in calc this Type Sort Prop exact rw rwa simp simp_all dsimp intro intros rintro apply refine refine\' obtain rcases use ' +
  'constructor cases induction omega ring ring_nf linarith nlinarith norm_num field_simp conv ext funext congr gcongr positivity aesop decide rfl ' +
  'unfold delta change trivial assumption contradiction exfalso by_contra by_cases push_neg specialize subst split left right exists existsi ' +
  'filter_upwards haveI letI set generalize revert clear on_goal all_goals any_goals first try repeat case next fin_cases interval_cases ' +
  'infer_instance inferInstance show_term simpa erw nth_rewrite nth_rw rewrite abel module_ring tauto norm_cast push_cast ' +
  'exact_mod_cast lift choose classical continuity measurability fun_prop bound wlog suffices replace termination_by decreasing_by ' +
  'attribute local scoped notation macro syntax elab export set_option omit include true false sorry admit with_reducible ' +
  'Iff And Or Not True False Exists Subtype Sigma').split(/\s+/));
const COMMENT_OR_STRING = /\/-[\s\S]*?-\/|--[^\n]*|"(?:[^"\\\n]|\\.)*"/g;
const blank = m => m.replace(/[^\n]/g, ' ');
const stripComments = text => text.replace(COMMENT_OR_STRING, blank);
const DECL = /^\s*(?:@\[[^\]]*\]\s*)*((?:(?:private|protected|noncomputable|partial|unsafe|public|nonrec|scoped)\s+)*)(theorem|lemma|def|abbrev|instance|structure|class(?:\s+inductive)?|inductive|opaque|axiom|alias|irreducible_def)\b\s*(?:\([^)]*\)\s*)?([^\s:({\[⦃]+)?/;

// Walk a (comment-stripped) file; per line: namespace in force, declarations on the line, structure context.
function walk(text, onLine) {
  const stack = []; let inStruct = null, structIndent = -1;
  // dns: a dotted declaration name (`theorem A.B.foo`) makes A.B an enclosing namespace for that declaration's
  // own signature and body, exactly like `namespace A.B` (Lean elaborates it inside that namespace).
  let dns = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const ns = stack.filter(s => s.k === 'ns').map(s => s.n).join('.');
    const decls = []; let declName = null, fieldName = null; let m;
    if ((m = raw.match(/^\s*namespace\s+(\S+)/))) { stack.push({ k: 'ns', n: m[1] }); dns = null; }
    else if (/^\s*(?:@\[[^\]]*\]\s*)*(?:(?:public|private|noncomputable)\s+)*section\b/.test(raw)) { stack.push({ k: 'sec' }); dns = null; }
    else if (/^\s*mutual\s*$/.test(raw)) stack.push({ k: 'mut' });
    else if (/^\s*end\b/.test(raw)) { stack.pop(); dns = null; }
    else if ((m = raw.match(DECL))) {
      const mods = m[1] || '', kind = m[2], name = m[3];
      inStruct = null; dns = null;
      if (name && !/^\d/.test(name) && name !== 'where' && name !== ':') {
        const full = name.startsWith('_root_.') ? name.slice(7) : (ns ? ns + '.' + name : name);
        // `def A.B.x` opens A.B for its own signature and body; `def _root_.A.B.x` does NOT (verified by two
        // fixers on 2026-11-24: IsArithVar in Bundle0255 and CMType in Bundle0198 were false positives).
        if (!name.startsWith('_root_.') && name.includes('.')) dns = full.split('.').slice(0, -1).join('.');
        declName = name.replace(/^_root_\./, '');
        decls.push({ full, priv: /private/.test(mods), prot: /protected/.test(mods), kind });
        if (/structure|class|inductive/.test(kind)) { inStruct = full; structIndent = raw.search(/\S/); }
        if (/structure|class/.test(kind) && !/inductive/.test(kind)) decls.push({ full: full + '.mk', priv: false, prot: true, kind: 'ctor' });
      }
    } else if (inStruct && raw.trim()) {
      const ind = raw.search(/\S/);
      if (ind <= structIndent && !/^\s*\|/.test(raw)) inStruct = null;
      else if ((m = raw.match(new RegExp(`^\\s*\\|\\s*(${IDC})`, 'u')))) { fieldName = m[1]; decls.push({ full: inStruct + '.' + m[1], priv: false, prot: true, kind: 'ctor' }); }
      else if ((m = raw.match(new RegExp(`^\\s*(${IDC})\\s*(?::|\\(|\\{|\\[|⦃)`, 'u'))) && !KEYWORDS.has(m[1])) { fieldName = m[1]; decls.push({ full: inStruct + '.' + m[1], priv: false, prot: false, kind: 'field' }); }
    }
    onLine(i + 1, raw, ns, decls, declName, fieldName, inStruct, dns || ns);
  }
}
const markersOf = text => { const out = []; text.split('\n').forEach((l, i) => { const m = l.match(/^\s*--\s*bundled from\s+(\S+)/); if (m) out.push({ at: i + 1, mod: m[1] }); }); return out; };
const origAtOf = (markers, mod) => line => { let o = mod; for (const mk of markers) { if (mk.at <= line) o = mk.mod; else break; } return o; };
const tails = full => { const p = full.split('.'); const out = []; for (let k = 0; k < p.length; k++) out.push(p.slice(k).join('.')); return out; };

// ---------- main ----------
const T = Date.now(); const el = () => ((Date.now() - T) / 1000).toFixed(0) + 's';
const gB = importGraph(REV), gM = importGraph(MAIN);
say(`[${el()}] graphs: branch ${Object.keys(gB).length}, main ${Object.keys(gM).length}`);
const allMods = Object.keys(gB);
const blocked = FILES ? new Set() : blockedBy(gB, failingFromList().files.map(pathToMod).filter(m => gB[m]));
let targets = FILES ? fs.readFileSync(path.resolve(FILES), 'utf8').split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).map(pathToMod).filter(m => gB[m]) : SET === 'compiled' ? allMods.filter(m => !blocked.has(m)) : SET === 'both' ? allMods : [...blocked];
if (SHARD.length === 2) targets = targets.sort().filter((_, k) => k % SHARD[1] === SHARD[0]);
if (SAMPLE && targets.length > SAMPLE) targets = targets.sort().filter((_, i) => i % Math.ceil(targets.length / SAMPLE) === 0).slice(0, SAMPLE);
say(`[${el()}] targets (${SET}): ${targets.length} modules (blocked set ${blocked.size})`);

// Pass 1: targets -> wanted identifier tails (texts are re-streamed in pass 3a so 16k targets fit in memory).
const tPaths = targets.map(m => 'src/' + m.split('.').join('/') + '.lean'); const want = new Set(); let nT = 0;
await catStream(REV, tPaths, (p, text) => {
  if (text == null) return;
  nT++;
  for (const t of stripComments(text).match(ID) || []) for (const x of tails(t)) want.add(x);
});
say(`[${el()}] pass 1: ${nT} files, ${want.size} identifier tails`);

// Pass 2a: branch declarations (any tail wanted).
const modIdx = new Map(); const mods = []; const idx = m => { if (!modIdx.has(m)) { modIdx.set(m, mods.length); mods.push(m); } return modIdx.get(m); };
const byFullB = new Map(); let nB = 0;
const wanted = full => tails(full).some(x => want.has(x));
await catStream(REV, allMods.map(m => 'src/' + m.split('.').join('/') + '.lean'), (p, text) => {
  if (text == null) return;
  const mod = pathToMod(p); const origAt = origAtOf(markersOf(text), mod);
  walk(stripComments(text), (line, raw, ns, decls) => {
    for (const d of decls) if (wanted(d.full)) {
      (byFullB.get(d.full) || byFullB.set(d.full, []).get(d.full)).push({ m: idx(mod), o: idx(origAt(line)), l: line, p: d.priv, r: d.prot });
      nB++;
    }
  });
});
say(`[${el()}] pass 2a: ${nB} branch declarations (${byFullB.size} names)`);

// Pass 3a: branch resolution of each identifier use; keep only uses that resolve to a prefix declaration.
const closB = new Map(), closM = new Map();
const visB = m => { if (!closB.has(m)) { if (closB.size > 50) closB.clear(); closB.set(m, closureOf(gB, m)); } return closB.get(m); };
const visM = o => { if (!closM.has(o)) { if (closM.size > 500) closM.clear(); closM.set(o, gM[o] ? closureOf(gM, o) : null); } return closM.get(o); };
const BINDER_RE = new RegExp(`(?:\\bfun\\b|λ|∀|∃!?|∑'?|∏|⨆|⨅|⋃|⋂|∫⁻?|∮|\\bintro\\b|\\bintros\\b|\\brintro\\b|\\bobtain\\b|\\blet\\b|\\bhave\\b|\\bset\\b|\\bgeneralize\\b|\\bchoose\\b|\\blift\\b|\\bcase\\b|\\bnext\\b|\\bby_cases\\b|\\bby_contra\\b|\\bwith\\b|\\bforall\\b|\\bexists\\b)\\s+([^,:=↦⊢∈∉⊆⊂⊇⊃<>≤≥≠]*)`, 'gu');
const findings = []; const pending = []; const needMain = new Set(); let checked = 0;
await catStream(REV, tPaths, (p, text) => {
  if (text == null) return;
  const mod = pathToMod(p); const s = stripComments(text); const markers = markersOf(text);
  const B = visB(mod); const me = modIdx.get(mod); const origAt = origAtOf(markers, mod);
  let declBinders = new Set(), secVars = new Set(), structFields = new Set(), lastOrig = null;
  walk(s, (line, raw, nsDecl, decls, declName, fieldName, inStruct, ns) => {
    const o = origAt(line);
    if (o !== lastOrig) { secVars = new Set(); lastOrig = o; }
    if (declName) { declBinders = new Set(); structFields = new Set(); }
    if (fieldName) structFields.add(fieldName);
    const isVar = /^\s*variable\b/.test(raw);
    for (const m of raw.matchAll(new RegExp(`[(\\[{⦃]\\s*((?:${IDC}\\s+)*${IDC})\\s*:(?!=)`, 'gu'))) for (const b of m[1].split(/\s+/)) (isVar ? secVars : declBinders).add(b);
    for (const m of raw.matchAll(BINDER_RE)) for (const b of m[1].match(ID) || []) declBinders.add(b);
    for (const m of raw.matchAll(/⟨([^⟩]*)⟩/gu)) for (const b of m[1].match(ID) || []) declBinders.add(b);
    for (const m of raw.matchAll(/\|\s*([^|=]*?)\s*=>/gu)) for (const b of (m[1].match(ID) || []).slice(1)) declBinders.add(b);
    // Untyped implicit binders `{a b c}` / `⦃a b⦄` (shard 0 false positive: `chi` in `{Lb U chi y lat st}`).
    for (const m of raw.matchAll(new RegExp(`[{⦃]\\s*((?:${IDC}\\s+)*${IDC})\\s*[}⦄]`, 'gu'))) for (const b of m[1].split(/\s+/)) declBinders.add(b);
    // Untyped names after ∀/∃/fun up to the first `,` `=>` `↦` `→` at bracket depth 0 (shard 0: `del` in `∀ (lam : _) (c0 : _) pair nab del`).
    for (const q of raw.matchAll(/(?:∀|∃!?|\bfun\b|λ)\s+/gu)) {
      let depth = 0, k = q.index + q[0].length, word = '';
      const flush = () => { if (depth === 0 && word && new RegExp(`^${IDC}$`, 'u').test(word)) declBinders.add(word); word = ''; };
      for (; k < raw.length; k++) {
        const ch = raw[k];
        if ('([{⦃⟨'.includes(ch)) { flush(); depth++; continue; }
        if (')]}⦄⟩'.includes(ch)) { depth = Math.max(0, depth - 1); continue; }
        if (depth === 0 && (ch === ',' || raw.startsWith('=>', k) || ch === '↦' || ch === '→' || ch === ':')) { flush(); break; }
        if (/\s/u.test(ch)) { flush(); continue; }
        if (depth === 0) word += ch;
      }
      flush();
    }
    // `field args := value` inside structure instances / `where` blocks (shard 0: `jM μ hμ j h1 h2 := ...`).
    const fa = raw.match(new RegExp(`^\\s*(${IDC})((?:\\s+${IDC})*)\\s*:=`, 'u'));
    if (fa && !/^\s*(?:let|have|show|set|obtain|def|theorem|lemma|instance|abbrev)\b/.test(raw)) {
      declBinders.add(fa[1]); for (const b of (fa[2].match(ID) || [])) declBinders.add(b);
    }
    if (/^\s*(namespace|open|end|section|variable|universe|attribute|set_option|import|export|@\[|deriving|notation|macro|syntax|initialize)/.test(raw)) return;
    const M = visM(o); if (M === null) return; // original not on main: skip
    const nsParts = ns ? ns.split('.') : []; if (!nsParts.length) return;
    const prefixes = []; for (let k = nsParts.length; k >= 1; k--) prefixes.push(nsParts.slice(0, k).join('.'));
    for (const mt of raw.matchAll(ID)) {
      const tok = mt[0]; const col = mt.index; const before = raw[col - 1] || ' '; const after = raw.slice(col + tok.length);
      if (before === '.' || before === '`' || before === '\'') continue;
      if (tok === declName || tok === fieldName) continue;
      const head = tok.split('.')[0];
      if (KEYWORDS.has(tok) || KEYWORDS.has(head)) continue;
      if (/^\s*:=/.test(after) && (/[({,]\s*$/.test(raw.slice(0, col)) || /^\s*$/.test(raw.slice(0, col)))) continue;
      if (declBinders.has(head) || secVars.has(head) || structFields.has(head)) continue;
      if (inStruct && tok === inStruct.split('.').pop()) continue;
      checked++;
      // Every enclosing-namespace prefix with a visible declaration (Lean offers them all as overloads; opens are
      // consulted only when none exists). bRes = the longest one.
      const bAll = []; let bRes = null;
      for (let k = 0; k < prefixes.length; k++) {
        const P = prefixes[k];
        const es = (byFullB.get(P + '.' + tok) || []).filter(e => (e.m === me ? e.l < line : B.has(mods[e.m])) && !(e.p && e.m !== me) && !(e.r && !tok.includes('.')));
        if (es.length) { bAll.push(k); if (!bRes) bRes = { P, full: P + '.' + tok, es }; }
      }
      if (!bRes) continue;
      // same original: declared earlier in the section (the section is a copy of the original)
      const same = prefixes.map(P => (byFullB.get(P + '.' + tok) || []).some(e => mods[e.o] === o && e.m === me && e.l < line && !(e.r && !tok.includes('.'))));
      const own = same[prefixes.indexOf(bRes.P)] && !same.slice(0, prefixes.indexOf(bRes.P)).some(Boolean); // longest is the section's own decl
      if (own && bAll.length < 2) continue;
      pending.push({ mod, line, col, tok, ns, o, prefixes, same, own, bAll, bFull: bRes.full, bFrom: [...new Set(bRes.es.map(e => mods[e.o]))].slice(0, 3), text: raw.trim().slice(0, 200) });
      for (const P of prefixes) needMain.add(P + '.' + tok);
    }
  });
});
say(`[${el()}] pass 3a: ${checked} uses checked, ${pending.length} resolve to a prefix declaration on the branch; ${needMain.size} names to look up on main`);

// Pass 2b: main declarations, only for the names pass 3a needs: full -> modules defining it on main.
const byFullM = new Map(); let nM = 0;
// Names (as written) that exist on main under ANY namespace. A finding whose name exists nowhere on main is a
// lemma newly added on the branch, not a capture (2026-11-24: Mert's MvPoly.l1Norm_sq_le_choose_mul_fockNormSq).
const pendTok = new Set(pending.map(u => u.tok)); const onMain = new Set();
const needMods = new Set(); for (const o of new Set(pending.map(u => u.o))) for (const m of visM(o) || []) needMods.add(m);
await catStream(MAIN, [...needMods].map(m => 'src/' + m.split('.').join('/') + '.lean'), (p, text) => {
  if (text == null) return;
  const mod = pathToMod(p);
  walk(stripComments(text), (line, raw, ns, decls) => {
    for (const d of decls) for (const t of tails(d.full)) if (pendTok.has(t)) onMain.add(t);
    for (const d of decls) if (needMain.has(d.full)) {
      (byFullM.get(d.full) || byFullM.set(d.full, []).get(d.full)).push({ m: mod, p: d.priv, r: d.prot });
      nM++;
    }
  });
});
say(`[${el()}] pass 2b: ${nM} main declarations (${byFullM.size} names)`);

// Pass 3b: main resolution for the original; a finding when it differs from the branch's.
// replaced: the longest-prefix declaration differs from the original's (deterministic error or meaning change).
// added: same longest one, but bundling made extra enclosing-prefix declarations visible: Lean elaborates all of them
// as overloads; an error only when more than one (or none) elaborates. Reported separately (OUT-added.json).
const added = [];
for (const u of pending) {
  const M = visM(u.o);
  const mAll = [];
  for (let k = 0; k < u.prefixes.length; k++) {
    const full = u.prefixes[k] + '.' + u.tok;
    const other = (byFullM.get(full) || []).some(e => e.m !== u.o && M.has(e.m) && !e.p && !(e.r && !u.tok.includes('.')));
    if (u.same[k] || other) mAll.push(k);
  }
  const mFull = mAll.length ? u.prefixes[mAll[0]] + '.' + u.tok : null;
  const rec = { file: 'src/' + u.mod.split('.').join('/') + '.lean', line: u.line, col: u.col, tok: u.tok, ns: u.ns, orig: u.o,
    branch: u.bFull, branchFrom: u.bFrom, mainPrefix: mFull, text: u.text };
  if (!mFull && !onMain.has(u.tok)) continue; // new on the branch: nothing on main for it to have meant
  if (!u.own && mFull !== u.bFull) { findings.push(rec); continue; }
  const extra = u.bAll.filter(k => !mAll.includes(k)).map(k => u.prefixes[k] + '.' + u.tok);
  if (mFull && extra.length) added.push({ ...rec, extra, mainAll: mAll.map(k => u.prefixes[k] + '.' + u.tok) });
}
say(`[${el()}] pass 3b: ${findings.length} replaced findings in ${new Set(findings.map(f => f.file)).size} files; ${added.length} added-overload findings in ${new Set(added.map(f => f.file)).size} files`);
fs.writeFileSync(OUT, JSON.stringify(findings));
fs.writeFileSync(OUT.replace(/\.json$/, '-added.json'), JSON.stringify(added));
say(`wrote ${OUT}`);
