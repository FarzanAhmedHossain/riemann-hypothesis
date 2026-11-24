#!/usr/bin/env node
// Helper for the PR #120 fixer agent. Everything here is read-only against GitHub
// (no pushes, no PRs, no comments). Run `node tools/rh.mjs help` for the commands.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_CLONE = path.join(HOME, 'riemann-hypothesis');
// RH_REPO points the helper at a separate worktree (see `worktree`), so several agents can each
// hold their own fix branch at once. Reads (show/resolve/closure/rows) work the same from any of them.
const REPO = process.env.RH_REPO ? path.resolve(process.env.RH_REPO) : MAIN_CLONE;
const UPSTREAM = 'rohanarun/riemann-hypothesis';
const BRANCH = 'opt/collapse-and-consolidate-4.36';
const BASE = `origin/${BRANCH}`;
const MAIN_REV = 'c7791603122c0328f79e49f6be5d7d4402effc53'; // "main" in the project docs
const BUGS_REPO = 'rohanarun/alpoge-rh-replay';
const ALI_REMOTE = 'https://github.com/aliromman/riemann-hypothesis.git';
const ALI_BRANCH = 'codex/pr120-integration-4.36';
const PROTECTED = [/^src\/Challenge\.lean$/, /^src\/Statements\.lean$/, /^comparator\.json$/, /^lakefile/, /^lean-toolchain$/, /^lake-manifest\.json$/];
const BANNED = [
  [/\bsorry\b/, 'sorry'], [/\badmit\b/, 'admit'], [/^\s*(?:private\s+|protected\s+)?axiom\b/, 'axiom'],
  [/\bunsafe\b/, 'unsafe'], [/\bnative_decide\b/, 'native_decide'], [/\bimplemented_by\b/, 'implemented_by'],
  [/@\[\s*extern\b/, 'extern'],
];
const DECL = /^\s*(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|public|noncomputable|partial|nonrec)\s+)*(theorem|lemma|def|abbrev|instance|structure|class|inductive|opaque|alias)\b/;
const BIG = 2 ** 31 - 1;

// A worktree's private git dir sits deep inside the main clone's .git, and git refuses absolute git-dir
// paths over ~220 characters ("'$GIT_DIR' too big"). Handing git the same directory as a relative path
// (resolved after -C) avoids that.
const GIT_ENV = (() => {
  try {
    const dotgit = path.join(REPO, '.git');
    if (fs.statSync(dotgit).isFile()) {
      const m = fs.readFileSync(dotgit, 'utf8').match(/gitdir:\s*(.+)/);
      if (m) return { ...process.env, GIT_DIR: path.relative(REPO, path.resolve(REPO, m[1].trim())) };
    }
  } catch { /* main clone, or not created yet */ }
  return process.env;
})();
const git = (args, opts = {}) =>
  execFileSync('git', ['-C', REPO, '-c', 'core.quotepath=false', '-c', 'core.longpaths=true', ...args],
    { encoding: 'utf8', maxBuffer: BIG, stdio: ['pipe', 'pipe', 'pipe'], env: GIT_ENV, ...opts });
const gitOk = (args) => { try { git(args); return true; } catch { return false; } };
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: BIG, stdio: ['pipe', 'pipe', 'pipe'] });

const modToPath = (m) => 'src/' + m.replace(/[«»]/g, '').split('.').join('/') + '.lean';
const pathToMod = (p) => p.replace(/^src\//, '').replace(/\.lean$/, '').split('/').join('.');
const asPath = (x) => (x.endsWith('.lean') ? x.replace(/\\/g, '/').replace(/^.*?(src\/)/, '$1') : modToPath(x));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Read many blobs in one git call. Returns text, or null where the path does not exist at that rev.
function catBatch(rev, paths) {
  if (!paths.length) return [];
  const out = execFileSync('git', ['-C', REPO, 'cat-file', '--batch'],
    { input: paths.map((p) => `${rev}:${p}`).join('\n') + '\n', maxBuffer: BIG, env: GIT_ENV });
  const res = []; let pos = 0;
  for (let i = 0; i < paths.length; i++) {
    const nl = out.indexOf(10, pos);
    const header = out.subarray(pos, nl).toString('utf8'); pos = nl + 1;
    const m = header.match(/ blob (\d+)$/);
    if (!m) { res.push(null); continue; }
    const size = Number(m[1]);
    res.push(out.subarray(pos, pos + size).toString('utf8')); pos += size + 1;
  }
  return res;
}
const readAt = (rev, p) => catBatch(rev, [p])[0];

// Header of a Lean file: is it a `module` file, and what does it import (public or not).
function parseHeader(text) {
  const imports = []; let isModule = false; let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (inBlock) { if (line.includes('-/')) inBlock = false; continue; }
    if (line.startsWith('/-')) { if (!line.includes('-/')) inBlock = true; continue; }
    if (line === '' || line.startsWith('--') || line === 'prelude') continue;
    if (line === 'module') { isModule = true; continue; }
    const m = line.match(/^((?:(?:public|private|meta)\s+)*)import\s+(?:all\s+)?(\S+)/);
    if (!m) break;
    imports.push({ mod: m[2].replace(/[«»]/g, ''), pub: /\bpublic\b/.test(m[1]) });
  }
  return { isModule, imports };
}

// Project modules whose declarations `root` can see at `rev`. In a `module` file only
// `public import`s are re-exported, so past the root we follow public edges only.
// Import headers via `git grep` on import/`module` lines only, 150 paths per call: the large bundle texts never
// enter node. (Reading the full texts, even chunked, ballooned to ~800 MB-1.3 GB per call and, with several
// fixers in parallel, exhausted this 8 GB machine; 2026-11-24.) Paths with no output (Mathlib, missing) get none.
function headerImports(rev, paths) {
  const res = new Map();
  for (let c = 0; c < paths.length; c += 150) {
    const chunk = paths.slice(c, c + 150); let out = '';
    try {
      out = execFileSync('git', ['-C', REPO, 'grep', '-n', '-E', '^((public|private|meta)[[:space:]]+)*import[[:space:]]|^module[[:space:]]*$', rev, '--', ...chunk],
        { maxBuffer: BIG, env: GIT_ENV }).toString('utf8');
    } catch (e) { out = e.stdout ? e.stdout.toString('utf8') : ''; } // exit 1 = no match in this chunk
    for (const line of out.split('\n')) {
      const m = line.match(/^[^:]+:(src\/[^:]+\.lean):\d+:(.*)$/); if (!m) continue;
      const e = res.get(m[1]) || { isModule: false, imports: [] }; res.set(m[1], e);
      const t = m[2].trim();
      if (t === 'module') { e.isModule = true; continue; }
      const h = t.match(/^((?:(?:public|private|meta)\s+)*)import\s+(?:all\s+)?(\S+)/);
      if (h) e.imports.push({ mod: h[2].replace(/[«»]/g, ''), pub: /\bpublic\b/.test(h[1]) });
    }
  }
  return res;
}
function closure(rev, root) {
  try { execFileSync('git', ['-C', REPO, 'cat-file', '-e', `${rev}:${modToPath(root)}`], { env: GIT_ENV, stdio: 'ignore' }); }
  catch { throw new Error(`${modToPath(root)} not found at ${rev}`); }
  const parent = new Map([[root, null]]);
  let frontier = [root];
  while (frontier.length) {
    const next = []; const heads = headerImports(rev, frontier.map(modToPath));
    for (const mod of frontier) {
      const h = heads.get(modToPath(mod)); if (!h) continue; // Mathlib etc., or no imports
      for (const imp of h.imports) {
        if (mod !== root && h.isModule && !imp.pub) continue;
        if (!parent.has(imp.mod)) { parent.set(imp.mod, mod); next.push(imp.mod); }
      }
    }
    frontier = next;
  }
  return parent;
}
function chain(parent, mod) { const out = []; for (let m = mod; m != null; m = parent.get(m)) out.push(m); return out.reverse(); }

// Namespace stack in force at a 1-based line of a file.
function namespaceAt(text, lineNo) {
  const stack = []; const lines = text.split('\n');
  for (let i = 0; i < Math.min(lineNo - 1, lines.length); i++) {
    const l = lines[i]; let m;
    if ((m = l.match(/^\s*namespace\s+(\S+)/))) stack.push({ k: 'ns', n: m[1] });
    else if ((m = l.match(/^\s*(?:(?:public|private|noncomputable)\s+)*section\b\s*(\S*)/))) stack.push({ k: 'sec', n: m[1] });
    else if (/^\s*mutual\s*$/.test(l)) stack.push({ k: 'mut' });
    else if (/^\s*end\b/.test(l)) stack.pop();
  }
  return stack.filter((s) => s.k === 'ns').map((s) => s.n).join('.');
}

// Every declaration whose last name component is `name`, at `rev`, with its full name.
function whoDefines(rev, name) {
  const pat = `(theorem|lemma|def|abbrev|instance|structure|class|inductive|opaque|alias)[[:space:]]+([^[:space:]]*\\.)?${reEsc(name)}([[:space:]:({\\[]|$)`;
  let out = '';
  try { out = git(['grep', '-n', '-E', pat, rev, '--', 'src']); } catch (e) { if (e.status !== 1) throw e; }
  const hits = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^[^:]+:(src\/.+?\.lean):(\d+):(.*)$/);
    if (m) hits.push({ path: m[1], line: Number(m[2]), text: m[3] });
  }
  const texts = catBatch(rev, [...new Set(hits.map((h) => h.path))]);
  const byPath = new Map([...new Set(hits.map((h) => h.path))].map((p, i) => [p, texts[i]]));
  return hits.map((h) => {
    const dm = h.text.match(new RegExp(`(?:theorem|lemma|def|abbrev|instance|structure|class|inductive|opaque|alias)\\s+(\\S*?${reEsc(name)})(?=[\\s:({\\[]|$)`));
    const declared = dm ? dm[1] : name;
    const ns = namespaceAt(byPath.get(h.path), h.line);
    const full = declared.startsWith('_root_.') ? declared.slice(7) : [ns, declared].filter(Boolean).join('.');
    return { ...h, module: pathToMod(h.path), full, private: /\bprivate\b/.test(h.text) };
  });
}

function parseRows(md) {
  const rows = [];
  // Since 2026-11-24 07:35 the list has three tables: "## Open (N)" (the rows to fix), "## Changed since this
  // error (likely fixed, rebuilding)" (don't claim) and "## Look-ahead: all known errors (preview)" (different
  // columns; see tools/lookahead.mjs). Only the Open table is rows here. Older lists have just the Open table.
  const open = md.split(/^## /m).find((s) => /^Open\b/.test(s)) ?? md;
  for (const line of open.split('\n')) {
    const m = line.match(/^\|\s*`([^`]+?\.lean):(\d+)`\s*\|(.*)\|\s*$/);
    if (!m) continue;
    const cells = m[3].split(' | ').map((c) => c.trim());
    const category = cells[0];
    const notes = cells.length > 2 ? cells[cells.length - 1] : '';
    const error = cells.slice(1, cells.length > 2 ? -1 : undefined).join(' | ');
    const file = 'src/' + m[1].replace(/^src\//, '');
    rows.push({ file, line: Number(m[2]), module: pathToMod(file), category, error, notes });
  }
  return rows;
}
const RANK = (r) => (/ambiguous/i.test(r.category) ? 1 : /wrong name/i.test(r.category) ? 2
  : !/instance/i.test(r.category) ? 5
    : /IsEmpty Empty|Empty →|IsLocalRing|IsDomain|LocallyCompactSpace|SecondCountableTopology|Normal|⧸/.test(r.error) ? 3 : 4);

function liveRows() {
  const md = gh(['api', `repos/${BUGS_REPO}/contents/PR120-BUGS.md`, '-H', 'Accept: application/vnd.github.raw']);
  const head = (md.match(/head `([0-9a-f]+)`\. Updated ([^\n.]+)/) || []).slice(1);
  const prs = JSON.parse(gh(['pr', 'list', '--repo', UPSTREAM, '--state', 'open', '--base', BRANCH, '--limit', '300',
    '--json', 'number,title,author,isDraft,files']));
  // Files changed on the branch after the list was generated: those rows may already be fixed.
  let since = new Set();
  try { git(['fetch', '--quiet', 'origin', BRANCH]); since = new Set(git(['diff', '--name-only', head[0], BASE]).split('\n')); } catch { /* list head unknown locally */ }
  const rows = parseRows(md).map((r) => {
    const tail = r.module.split('.').slice(-2).join('.'); const leaf = r.module.split('.').pop();
    const claims = [];
    if (since.has(r.file)) claims.push('changed on the branch since this list (probably fixed)');
    const noted = r.notes.match(/claimed:\s*(#\d+\s*@\S+)/);
    if (noted) claims.push(noted[1]);
    for (const pr of prs) {
      const touches = (pr.files || []).some((f) => f.path === r.file);
      const titled = pr.title.includes(r.module) || pr.title.includes(tail) || new RegExp(`\\b${reEsc(leaf)}\\b`).test(pr.title);
      if (touches || titled) claims.push(`#${pr.number} @${pr.author.login}${touches ? '' : ' (title only)'}`);
    }
    return { ...r, rank: RANK(r), aliFix: /aliromman/.test(r.notes), claimedBy: [...new Set(claims)] };
  });
  return { head, rows, prs };
}

const cmds = {
  help() {
    console.log(`PR #120 fixer helper (read-only against GitHub)
  sync                          fetch the work branch, the main reference commit and aliromman's branch
  rows [--all] [--json]         open root failures that nobody has claimed, easiest first
  claimed <file|Module>         open PRs that already have this row (title, branch or files); exit 3 if any, 0 if free
  lock acquire|release|status <owner>   one cycle at a time in this folder; exit 4 if another run holds it (45 min expiry)
  playbook                      print the project's fix playbook (every failure pattern found so far)
  marker <file|Module> <line>   which original module a line of a bundle came from, and that section's range
  show <rev> <file|Module> [from] [to]   print a file at a revision with line numbers (rev: branch | main | ali | any ref)
  origin "<text>"               find where a line of source lives on main
  resolve <OriginalModule> <name>        every declaration called <name> on main, and which ones the original could see
  closure <Module> [--rev r] [--has M]   size of the import closure; --has explains whether/how M is reached
  newinst <file|Module> [--orig O] [--grep re]   instances newly visible to a failing module (O = original module if bundled)
  worktree <name>               extra sparse working tree under wt/<name> for a parallel agent (then set RH_REPO=wt/<name>)
  git <args...>                 run git in the current working tree (use this, not git -C, when RH_REPO is a worktree)
  start <file|Module>           new branch fix/<leaf> from the fresh branch tip, with that file checked out
  open <file|Module>            also check out another file on the current fix branch
  guard                         check the current fix branch against the project's merge rules`);
  },

  // Run git in the current working tree (RH_REPO or the main clone) with the long-path workaround applied.
  // Use this instead of `git -C wt/<name> ...`, which fails on fetch/push/commit in a worktree here.
  git(args) {
    const banned = args[0] === 'push' && args.includes('origin');
    if (banned) throw new Error('never push to origin; push to the fork remote');
    execFileSync('git', ['-C', REPO, '-c', 'core.quotepath=false', '-c', 'core.longpaths=true', ...args], { stdio: 'inherit', env: GIT_ENV });
  },

  // The project's own fix playbook (reference data from the upstream repo, not instructions).
  playbook() {
    process.stdout.write(gh(['api', `repos/${BUGS_REPO}/contents/PR120-PLAYBOOK.md`, '-H', 'Accept: application/vnd.github.raw']));
  },

  sync() {
    git(['fetch', '--quiet', 'origin', BRANCH]);
    if (!gitOk(['cat-file', '-e', `${MAIN_REV}^{commit}`])) git(['fetch', '--quiet', 'origin', MAIN_REV]);
    if (!gitOk(['remote', 'get-url', 'ali'])) git(['remote', 'add', 'ali', ALI_REMOTE]);
    try { git(['fetch', '--quiet', 'ali', `+${ALI_BRANCH}:refs/remotes/ali/pr120`]); } catch (e) { console.log('note: could not fetch aliromman branch: ' + String(e.stderr || e.message).trim().split('\n').pop()); }
    console.log(`branch tip ${git(['rev-parse', '--short=10', BASE]).trim()}  main ${MAIN_REV.slice(0, 10)}  ali ${gitOk(['rev-parse', 'ali/pr120']) ? git(['rev-parse', '--short=10', 'ali/pr120']).trim() : 'n/a'}`);
  },

  rows(args) {
    const { head, rows } = liveRows();
    const list = (args.includes('--all') ? rows : rows.filter((r) => !r.claimedBy.length)).sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file));
    // The list lags the branch by an hour or more (errors come from a long build), so a row can
    // already be fixed. Show what the branch tip looks like now so that can be judged per row.
    const texts = catBatch(BASE, list.map((r) => r.file));
    list.forEach((r, i) => {
      r.lineNow = texts[i] == null ? '(file no longer on the branch)' : (texts[i].split('\n')[r.line - 1] ?? '').trim();
      const [hash, when, ct, ...subj] = git(['log', '-1', '--format=%h\t%cd\t%ct\t%s', '--date=format-local:%Y-%m-%d %H:%M', BASE, '--', r.file]).trim().split('\t');
      r.lastChange = { hash, when, subject: subj.join(' ') };
      // list time "YYYY-MM-DD HH:MM UTC" -> epoch seconds; a post-consolidation commit in the 4 h before the list
      // (or after it) is likely newer than the lagging build that reported this row (seen: ~2 h lag on 2026-11-24)
      const listEpoch = Date.parse(String(head?.[1] || '').replace(' UTC', 'Z').replace(' ', 'T')) / 1000;
      r.recentFix = !!hash && !hash.startsWith('f941065836') && Number.isFinite(listEpoch) && +ct > listEpoch - 4 * 3600;
      // Any commit after the consolidation (f941065836) on a failing file is a fix attempt, whatever its subject
      // ("Also qualify …", "Disambiguate …", "Supply …" were missed by a subject regex). The published list's
      // builds lag the branch by hours, so such a row's error may predate the fix: confirm before claiming.
      // So: touched if the last change is fix-style, or if the reported line itself was edited after the
      // consolidation (git log -L). A file touched elsewhere stays free: a new error in another section is real.
      let lineEdits = [];
      if (hash && !hash.startsWith('f941065836') && texts[i] != null && r.line > 0) {
        try {
          lineEdits = git(['log', '--no-patch', '--format=%h', `-L${r.line},${r.line}:${r.file}`, `f941065836..${BASE}`])
            .split('\n').map((s) => s.trim()).filter((s) => /^[0-9a-f]{7,}$/.test(s));
        } catch { lineEdits = []; }
      }
      r.lineEditedBy = lineEdits;
      r.touchedByFix = /^(Fix|Merge PR|Coordinator cycle|Restore|Qualify)/i.test(r.lastChange.subject) || lineEdits.length > 0 || r.recentFix;
    });
    if (args.includes('--json')) return console.log(JSON.stringify({ head, rows: list }, null, 1));
    console.log(`PR120-BUGS.md: branch head ${head[0]}, updated ${head[1]} — ${rows.length} open, ${rows.filter((r) => !r.claimedBy.length).length} unclaimed`);
    console.log('STALE? = a fix-style commit already touched the file; confirm the reported error still applies at the tip before working on it.\n');
    for (const r of list) {
      console.log(`[${r.rank}] ${r.file}:${r.line}\n    ${r.category}${r.aliFix ? '  (fix exists on aliromman branch)' : ''}${r.claimedBy.length ? '  CLAIMED ' + r.claimedBy.join(', ') : ''}\n    error: ${r.error.slice(0, 240)}\n    line now: ${r.lineNow.slice(0, 200)}\n    last change: ${r.lastChange.hash} ${r.lastChange.when} ${r.lastChange.subject.slice(0, 110)}${r.touchedByFix ? '  STALE?' : ''}\n`);
    }
  },

  marker([target, lineArg]) {
    const p = asPath(target); const line = Number(lineArg);
    const text = readAt(BASE, p); if (text == null) throw new Error(`${p} not on ${BASE}`);
    const lines = text.split('\n'); const marks = [];
    lines.forEach((l, i) => { const m = l.match(/^\s*--\s*bundled from\s+(\S+)/); if (m) marks.push({ at: i + 1, mod: m[1] }); });
    if (!marks.length) return console.log(`${p} is not a bundle; the original module is ${pathToMod(p)} (same path on main).`);
    const idx = marks.findLastIndex((m) => m.at <= line);
    if (idx < 0) return console.log(`line ${line} is before the first bundled section (bundle header). Sections: ${marks.length}`);
    const end = idx + 1 < marks.length ? marks[idx + 1].at - 1 : lines.length;
    console.log(`original: ${marks[idx].mod}\nsection:  lines ${marks[idx].at}-${end} of ${p}\nnamespace at line ${line}: ${namespaceAt(text, line) || '(root)'}\nexists on main: ${readAt(MAIN_REV, modToPath(marks[idx].mod)) != null}`);
  },

  show([rev, target, from, to]) {
    const r = { branch: BASE, main: MAIN_REV, ali: 'ali/pr120' }[rev] || rev;
    const p = asPath(target); const text = readAt(r, p);
    if (text == null) throw new Error(`${p} not found at ${r}`);
    const lines = text.split('\n'); const a = Math.max(1, Number(from) || 1); const b = Math.min(lines.length, Number(to) || lines.length);
    for (let i = a; i <= b; i++) console.log(`${String(i).padStart(5)}  ${lines[i - 1]}`);
  },

  origin([text]) {
    try { process.stdout.write(git(['grep', '-n', '-F', text, MAIN_REV, '--', 'src']).split('\n').slice(0, 40).map((l) => l.replace(/^[^:]+:/, '')).join('\n') + '\n'); }
    catch (e) { if (e.status === 1) console.log('no match on main'); else throw e; }
  },

  resolve([orig, name, ...rest]) {
    const rev = rest[rest.indexOf('--rev') + 1] && rest.includes('--rev') ? rest[rest.indexOf('--rev') + 1] : MAIN_REV;
    const vis = closure(rev, orig); const cands = whoDefines(rev, name);
    const head = parseHeader(readAt(rev, modToPath(orig)));
    console.log(`original ${orig} at ${rev.slice(0, 10)}: ${head.imports.length} direct imports, ${vis.size - 1} project modules visible`);
    const opens = readAt(rev, modToPath(orig)).split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /^\s*(open|namespace|end)\b/.test(l));
    console.log('scope lines in the original:'); for (const [n, l] of opens.slice(0, 60)) console.log(`  ${String(n).padStart(4)}  ${l.trim().slice(0, 200)}`);
    console.log(`\n${cands.length} declaration(s) named ${name}:`);
    for (const c of cands) {
      const seen = vis.has(c.module);
      console.log(`  ${seen ? 'VISIBLE ' : 'not seen'} ${c.full}${c.private ? '  [private]' : ''}\n           ${c.path}:${c.line}`);
      if (seen && c.module !== orig) console.log(`           via ${chain(vis, c.module).map((m) => m.split('.').pop()).join(' > ')}`);
    }
    const n = cands.filter((c) => vis.has(c.module) && !(c.private && c.module !== orig)).length;
    console.log(`\n=> ${n} visible candidate(s). ${n === 1 ? 'Unambiguous on main: qualify the use to that full name.' : 'Not decided by imports alone: check namespace nesting and the opens above.'}`);
  },

  closure([mod, ...rest]) {
    const rev = rest.includes('--rev') ? rest[rest.indexOf('--rev') + 1] : MAIN_REV;
    const vis = closure({ branch: BASE, main: MAIN_REV }[rev] || rev, mod);
    console.log(`${vis.size - 1} project modules visible from ${mod}`);
    if (rest.includes('--has')) {
      const want = rest[rest.indexOf('--has') + 1];
      console.log(vis.has(want) ? `reaches ${want} via:\n  ${chain(vis, want).join('\n  ')}` : `does NOT reach ${want}`);
    }
  },

  // A second (third, ...) sparse working tree on the same clone, for running agents in parallel.
  worktree([name]) {
    if (!/^[A-Za-z0-9_-]+$/.test(name || '')) throw new Error('usage: worktree <name>  (letters, digits, - and _)');
    const dir = path.join(HOME, 'wt', name);
    const at = (args) => execFileSync('git', ['-C', dir, '-c', 'core.longpaths=true', ...args], { encoding: 'utf8', maxBuffer: BIG, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!fs.existsSync(path.join(dir, '.git'))) {
      const main = (args) => execFileSync('git', ['-C', MAIN_CLONE, '-c', 'core.longpaths=true', ...args], { encoding: 'utf8', maxBuffer: BIG, stdio: ['pipe', 'pipe', 'pipe'] });
      main(['fetch', '--quiet', 'origin', BRANCH]);
      fs.mkdirSync(path.join(HOME, 'wt'), { recursive: true });
      main(['worktree', 'add', '--quiet', '--detach', '--no-checkout', dir, BASE]);
      at(['sparse-checkout', 'set', '--no-cone', '/README.md']);
      at(['read-tree', '-mu', 'HEAD']);
    }
    console.log(`worktree ready: ${dir}\nuse it by setting RH_REPO for every helper call, e.g.\n  RH_REPO=wt/${name} node tools/rh.mjs start <file>\nand run git there with: git -C wt/${name} ...`);
  },

  // Instances an original proof could not see on main but its bundled version can see now:
  // the usual suspects behind `failed to synthesize ... timeout at typeclass`.
  newinst([target, ...rest]) {
    const p = asPath(target); const branchMod = pathToMod(p);
    const orig = rest.includes('--orig') ? rest[rest.indexOf('--orig') + 1] : branchMod;
    const re = rest.includes('--grep') ? new RegExp(rest[rest.indexOf('--grep') + 1]) : null;
    const bVis = [...closure(BASE, branchMod).keys()].filter((m) => m !== branchMod);
    const mVis = closure(MAIN_REV, orig);
    // Map each visible branch module to the original modules it was bundled from.
    // Read in chunks: all visible bundles at once took ~1 GB per call, and parallel fixers running newinst
    // exhausted this 8 GB machine's commit charge and killed the session (2026-11-24).
    // Markers via `git grep` (150 paths per call), so bundle texts never enter node.
    const origins = new Set(); const marked = new Set();
    for (let c = 0; c < bVis.length; c += 150) {
      const chunk = bVis.slice(c, c + 150).map(modToPath); let out = '';
      try {
        out = execFileSync('git', ['-C', REPO, 'grep', '-h', '-o', '-E', '^[[:space:]]*--[[:space:]]*bundled from[[:space:]]+[^[:space:]]+', BASE, '--', ...chunk],
          { maxBuffer: BIG, env: GIT_ENV }).toString('utf8');
      } catch (e) { out = e.stdout ? e.stdout.toString('utf8') : ''; }
      for (const l of out.split('\n')) { const m = l.match(/bundled from\s+(\S+)/); if (m) origins.add(m[1]); }
      try {
        const files = execFileSync('git', ['-C', REPO, 'grep', '-l', '-E', '^[[:space:]]*--[[:space:]]*bundled from', BASE, '--', ...chunk],
          { maxBuffer: BIG, env: GIT_ENV }).toString('utf8');
        for (const l of files.split('\n')) { const m = l.match(/^[^:]+:(src\/.+\.lean)$/); if (m) marked.add(pathToMod(m[1])); }
      } catch {}
    }
    for (const m of bVis) if (!marked.has(m)) origins.add(m); // unbundled modules are their own original
    const fresh = [...origins].filter((o) => !mVis.has(o) && o !== orig);
    console.log(`${branchMod}: ${bVis.length} modules visible on the branch (${origins.size} originals); the original ${orig === branchMod ? '' : orig + ' '}saw ${mVis.size - 1} on main; ${fresh.length} originals are newly visible`);
    // Instance lines of every main module, from one cached `git grep -A2` (main is a fixed commit). Reading the
    // ~60k newly visible originals instead took 1.3 GB and made git run out of memory (2026-11-24).
    const instCache = path.join(HOME, 'runs', 'scan-cache', `main-instances-${MAIN_REV.slice(0, 10)}.txt`);
    if (!fs.existsSync(instCache)) {
      fs.mkdirSync(path.dirname(instCache), { recursive: true });
      const out = execFileSync('git', ['-C', REPO, 'grep', '-n', '-A2', '-E',
        '^\\s*(@\\[[^]]*\\]\\s*)*((scoped|local|private|protected|noncomputable|public)\\s+)*instance\\b', MAIN_REV, '--', 'src'],
        { maxBuffer: BIG, env: GIT_ENV });
      fs.writeFileSync(instCache, out);
    }
    const freshSet = new Set(fresh); let shown = 0; let total = 0; const nsWanted = [];
    const glines = fs.readFileSync(instCache, 'utf8').split('\n');
    for (let g = 0; g < glines.length; g++) {
      const m = glines[g].match(/^[^:]+:(src\/[^:]+\.lean):(\d+):(.*)$/); if (!m) continue;
      const o = pathToMod(m[1]); if (!freshSet.has(o)) continue;
      total++;
      const ctx = [1, 2].map((d) => { const c = (glines[g + d] || '').match(/^[^:]+:src\/[^:]+\.lean-\d+-(.*)$/); return c ? c[1] : ''; });
      const decl = [m[3], ...ctx].join(' ').replace(/\s+/g, ' ').trim();
      if (re && !re.test(decl)) continue;
      if (shown++ < 80) nsWanted.push({ o, line: +m[2], decl });
    }
    // Namespaces only for the (at most 80) shown declarations.
    const nsTexts = catBatch(MAIN_REV, [...new Set(nsWanted.map((x) => x.o))].map(modToPath));
    const nsText = new Map([...new Set(nsWanted.map((x) => x.o))].map((o, i) => [o, nsTexts[i]]));
    for (const x of nsWanted) console.log(`  ${x.o}:${x.line}  [ns ${(nsText.get(x.o) && namespaceAt(nsText.get(x.o), x.line)) || 'root'}]\n      ${x.decl.slice(0, 260)}`);
    console.log(`${total} instance declarations in newly visible originals${re ? `, ${shown} matching /${re.source}/` : ''}${shown > 80 ? ' (first 80 shown)' : ''}`);
  },

  // Who already has a PR for a row. Uses the full open-PR list, not GitHub search: the search index lags
  // behind new PRs (it missed #304 minutes after it opened), exactly when rows are being raced for.
  // Exit code: 0 free, 3 an open PR has it (ours included). Recently merged PRs touching the file are
  // printed as a hint (the row may already be fixed) but do not block.
  claimed([target]) {
    if (!target) throw new Error('usage: claimed <file|Module>');
    const p = asPath(target); const mod = pathToMod(p);
    const tail = mod.split('.').slice(-2).join('.'); const leaf = mod.split('.').pop();
    const branchName = 'fix/' + mod.split('.').slice(-2).join('-').replace(/[^A-Za-z0-9_-]/g, '');
    const hit = (pr) => {
      const why = [];
      if ((pr.files || []).some((f) => f.path === p)) why.push('touches the file');
      if (pr.title.includes(mod) || pr.title.includes(tail) || new RegExp(`(^|[^A-Za-z0-9_])${reEsc(leaf)}($|[^A-Za-z0-9_])`).test(pr.title)) why.push('title');
      if (pr.headRefName === branchName || pr.headRefName.endsWith('/' + leaf) || pr.headRefName.endsWith('-' + leaf)) why.push('branch ' + pr.headRefName);
      return why;
    };
    const list = (state, limit) => JSON.parse(gh(['pr', 'list', '--repo', UPSTREAM, '--state', state, '--base', BRANCH,
      '--limit', String(limit), '--json', 'number,title,author,isDraft,headRefName,files,url,createdAt,mergedAt']));
    const open = list('open', 300).map((pr) => ({ pr, why: hit(pr) })).filter((x) => x.why.length);
    const merged = list('merged', 100).map((pr) => ({ pr, why: hit(pr) })).filter((x) => x.why.length);
    for (const { pr, why } of open) console.log(`OPEN    #${pr.number} @${pr.author.login}${pr.isDraft ? ' (draft)' : ''} ${pr.createdAt}  [${why.join(', ')}]  ${pr.url}`);
    for (const { pr, why } of merged) console.log(`merged  #${pr.number} @${pr.author.login} ${pr.mergedAt}  [${why.join(', ')}]  (row may already be fixed)`);
    console.log(open.length ? `\nCLAIMED: ${mod}` : `\nFREE: ${mod}`);
    process.exitCode = open.length ? 3 : 0;
  },

  // One cycle at a time in this folder. The scheduled cycle, /fix-next and run-agent.ps1 all share the
  // worktrees and runs/ files, so whoever starts second must stop. A lock older than LOCK_TTL_MIN is
  // treated as left behind by a crashed run and taken over.
  lock([action = 'status', owner = '']) {
    const file = path.join(HOME, 'runs', 'cycle.lock'); const TTL = 45;
    const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
    const age = (l) => (Date.now() - Date.parse(l.at)) / 60000;
    const show = (l) => `${l.owner} since ${l.at} (${age(l).toFixed(0)} min)`;
    if (action === 'status') { const l = read(); console.log(l ? `held by ${show(l)}${age(l) > TTL ? ' — stale' : ''}` : 'free'); return; }
    if (!owner) throw new Error('usage: lock acquire|release|status <owner-name>');
    if (action === 'acquire') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const body = JSON.stringify({ owner, at: new Date().toISOString() });
      for (let attempt = 0; attempt < 2; attempt++) {
        try { fs.writeFileSync(file, body, { flag: 'wx' }); console.log(`acquired by ${owner}`); return; } catch (e) { if (e.code !== 'EEXIST') throw e; }
        const l = read();
        if (l && l.owner === owner) { console.log(`already held by ${owner}`); return; }
        if (l && age(l) <= TTL) { console.log(`BUSY: held by ${show(l)}`); process.exitCode = 4; return; }
        console.log(`taking over stale lock${l ? ' from ' + show(l) : ''}`); fs.rmSync(file, { force: true });
      }
      console.log('BUSY: lost the race for the lock'); process.exitCode = 4; return;
    }
    if (action === 'release') {
      const l = read();
      if (!l) { console.log('not held'); return; }
      if (l.owner !== owner) { console.log(`not released: held by ${show(l)}, not ${owner}`); process.exitCode = 4; return; }
      fs.rmSync(file, { force: true }); console.log(`released by ${owner}`); return;
    }
    throw new Error('usage: lock acquire|release|status <owner-name>');
  },

  start([target]) {
    const p = asPath(target);
    if (PROTECTED.some((re) => re.test(p))) throw new Error(`${p} is protected; never edit it`);
    if (git(['status', '--porcelain']).trim()) throw new Error('working tree has uncommitted changes; commit or stash them first');
    git(['fetch', '--quiet', 'origin', BRANCH]);
    if (readAt(BASE, p) == null) throw new Error(`${p} not on ${BASE}`);
    const name = 'fix/' + pathToMod(p).split('.').slice(-2).join('-').replace(/[^A-Za-z0-9_-]/g, '');
    if (gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) {
      // Never reset an existing fix branch: it may hold a prepared fix that was not published yet.
      const ahead = git(['rev-list', '--count', `${BASE}..${name}`]).trim();
      throw new Error(`branch ${name} already exists (${ahead} commit(s) not on the work branch). Continue it with: git -C riemann-hypothesis switch ${name}`);
    }
    git(['sparse-checkout', 'add', '/' + p]);
    git(['switch', '--quiet', '-c', name, BASE]);
    console.log(`on ${name} at ${git(['rev-parse', '--short=10', 'HEAD']).trim()}\nedit: ${path.join(REPO, p)}`);
  },

  open([target]) {
    const p = asPath(target);
    if (PROTECTED.some((re) => re.test(p))) throw new Error(`${p} is protected; never edit it`);
    git(['sparse-checkout', 'add', '/' + p]);
    console.log(`edit: ${path.join(REPO, p)}`);
  },

  guard() {
    const fail = []; const warn = []; const ok = [];
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (!branch.startsWith('fix/')) fail.push(`current branch is ${branch}, expected fix/<module>`);
    if (git(['status', '--porcelain']).trim()) fail.push('uncommitted changes in the working tree');
    git(['fetch', '--quiet', 'origin', BRANCH]);
    const behind = Number(git(['rev-list', '--count', `HEAD..${BASE}`]).trim());
    if (behind) warn.push(`branch tip moved ${behind} commit(s) ahead; rebase before pushing: git rebase ${BASE}`);
    const files = git(['diff', '--name-status', `${BASE}...HEAD`]).trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
    if (!files.length) fail.push('no changes against the branch');
    for (const [st, p] of files) {
      if (PROTECTED.some((re) => re.test(p))) fail.push(`protected file changed: ${p}`);
      else if (!/^src\/.+\.lean$/.test(p)) fail.push(`not a src/**/*.lean file: ${p}`);
      if (st !== 'M') warn.push(`${st} ${p}: adding/removing/renaming files needs a note in the PR for the coordinator`);
    }
    const diff = git(['diff', '-U0', `${BASE}...HEAD`]); let file = '';
    for (const l of diff.split('\n')) {
      if (l.startsWith('+++ ')) { file = l.slice(6); continue; }
      if (l.startsWith('+') && !l.startsWith('+++')) for (const [re, what] of BANNED) if (re.test(l.slice(1).replace(/--.*$/, ''))) fail.push(`${what} added in ${file}: ${l.slice(1).trim().slice(0, 120)}`);
      if (l.startsWith('-') && !l.startsWith('---') && DECL.test(l.slice(1))) warn.push(`declaration line changed in ${file} (statement and declared name must stay identical): ${l.slice(1).trim().slice(0, 120)}`);
    }
    let rows = [];
    try { rows = liveRows().rows; } catch { warn.push('could not load PR120-BUGS.md to compare'); }
    const failing = new Set(rows.map((r) => r.file));
    for (const [, p] of files) {
      const row = rows.find((r) => r.file === p);
      if (rows.length && !row) warn.push(`${p} is not (or no longer) a failing row — it may already be fixed; re-check before pushing`);
      if (row && row.claimedBy.length) warn.push(`${p} is claimed by ${row.claimedBy.join(', ')}`);
    }
    if (files.length && files.length <= 5 && files.every(([, p]) => failing.has(p))) ok.push('eligible for early draft merge (<=5 files, all currently failing rows)');
    ok.push(`${files.length} file(s) changed: ${files.map(([, p]) => p).join(', ')}`);
    for (const m of ok) console.log('ok    ' + m); for (const m of warn) console.log('WARN  ' + m); for (const m of fail) console.log('FAIL  ' + m);
    console.log(fail.length ? '\nGUARD FAILED' : '\nGUARD PASSED' + (warn.length ? ' with warnings' : ''));
    process.exitCode = fail.length ? 1 : 0;
  },
};

const [cmd = 'help', ...args] = process.argv.slice(2);
if (!cmds[cmd]) { console.error(`unknown command ${cmd}`); cmds.help(); process.exit(2); }
if (cmd !== 'help' && !fs.existsSync(path.join(REPO, '.git'))) { console.error(`clone missing at ${REPO} — see README.md`); process.exit(2); }
try { cmds[cmd](args); } catch (e) { console.error('error: ' + (e.stderr ? String(e.stderr).trim() : e.message)); process.exit(1); }
