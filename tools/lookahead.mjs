#!/usr/bin/env node
// Turn PR120-BUGS.md's "Look-ahead: all known errors (preview)" table into fast-fix workflow args.
//
//   node tools/lookahead.mjs [--max 6] [--include-changed] > runs/lookahead-args.json   (progress on stderr)
//
// The look-ahead table comes from a scratch build that stubs failing declarations with `sorry` so later
// errors show up (rounds 1..n). The project says fix PRs for any of its rows are welcome. Error texts there
// are first lines only ("Ambiguous term", "Function expected at"), so each agent finds the offending name at
// the line itself. One agent per FILE, covering all of that file's locations.
// Filters: files any open PR touches (claim.mjs check), files in runs/processed.txt, and (unless
// --include-changed) files changed on the branch since the scratch session's head (probably being fixed).
// Ranking: lowest round first (round 1 = the next layer to block the build), name-resolution kinds first.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(HOME, 'riemann-hypothesis');
const BASE = 'origin/opt/collapse-and-consolidate-4.36';
const argv = process.argv.slice(2);
const max = +(argv[argv.indexOf('--max') + 1] || 0) || 6;
const includeChanged = argv.includes('--include-changed');
const say = s => process.stderr.write(s + '\n');
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const node = (...a) => { try { return execFileSync('node', a, { cwd: HOME, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stdout || ''); } };

// --md <file>: read a saved PR120-BUGS.md (e.g. an earlier commit's version when the latest one dropped the table).
const mdFile = argv.includes('--md') ? argv[argv.indexOf('--md') + 1] : '';
const md = mdFile ? fs.readFileSync(path.resolve(mdFile), 'utf8')
  : execFileSync('gh', ['api', 'repos/rohanarun/alpoge-rh-replay/contents/PR120-BUGS.md', '-H', 'Accept: application/vnd.github.raw'], { encoding: 'utf8', maxBuffer: 1 << 26 });
const listTime = (md.match(/Updated ([0-9: -]+UTC)/) || [])[1] || '';
const sec = md.split(/^## /m).find(s => s.startsWith('Look-ahead'));
if (!sec) { say('no Look-ahead section in PR120-BUGS.md'); process.stdout.write(JSON.stringify({ home: HOME.replace(/\\/g, '/'), listTime, rows: [] })); process.exit(0); }
// The table can merge several scratch sessions (different shards, different branch heads) and rows do not say
// which one they came from, so a row's line number may be at any of those heads: check every head.
const sessions = [...new Set([...sec.matchAll(/branch head ([0-9a-f]{7,})/g)].map(m => m[1]))];
const session = sessions[0] || '';
try { git('fetch', '-q', 'origin', '+refs/heads/opt/collapse-and-consolidate-4.36:refs/remotes/origin/opt/collapse-and-consolidate-4.36'); } catch {}
const oldest = sessions.map(h => { try { return { h, t: +git('log', '-1', '--format=%ct', h) }; } catch { return { h, t: Infinity }; } })
  .sort((a, b) => a.t - b.t)[0]?.h || session;
const locs = [];
for (const line of sec.split('\n')) {
  const m = line.match(/^\|\s*`([^`]+):(\d+)`\s*\|\s*(\d+)\s*\|\s*([^|]*)\|\s*(.*?)\s*\|\s*$/);
  if (m) locs.push({ file: 'src/' + m[1], line: +m[2], round: +m[3], kind: m[4].trim(), error: m[5].trim() });
}
const byFile = new Map();
for (const l of locs) { if (!byFile.has(l.file)) byFile.set(l.file, []); byFile.get(l.file).push(l); }
say(`look-ahead (session heads ${sessions.join(' ')}): ${locs.length} locations in ${byFile.size} files; list ${listTime}`);

try { git('fetch', '-q', 'origin', '+refs/heads/opt/collapse-and-consolidate-4.36:refs/remotes/origin/opt/collapse-and-consolidate-4.36'); } catch {}
const proc = new Set(fs.readFileSync(path.join(HOME, 'runs', 'processed.txt'), 'utf8').split('\n').filter(Boolean));
const NAMEY = /Ambiguous|Function expected|Unknown identifier|Unknown constant|Application type mismatch|Invalid argument name|Invalid field|overloaded/;
let files = [...byFile.entries()].map(([file, ls]) => {
  ls.sort((a, b) => a.line - b.line);
  let changed = [];
  // "Changed" is measured from the OLDEST session head: a row may come from any session, and on 2026-11-24 most
  // picks "untouched since the newest head" were rows from older shard sessions fixed before that head.
  if (oldest) { try { changed = git('log', '--format=%h %s', `${oldest}..${BASE}`, '--', file).split('\n').filter(Boolean); } catch {} }
  let exists = true; try { git('cat-file', '-e', `${BASE}:${file}`); } catch { exists = false; }
  // Heads at which this file differs from the first one (identical file => line numbers agree there).
  const heads = sessions.filter((h, i) => { if (i === 0) return true; try { git('diff', '--quiet', sessions[0], h, '--', file); return false; } catch { return true; } });
  // Per location: was that line edited since the scratch session? Look-ahead line numbers are at the SESSION
  // head, so follow each line forward with `git blame --reverse session..tip`: it names the last commit in which
  // the line still existed unchanged. If that is the tip, the line survived untouched (error probably still
  // there); otherwise it was edited or deleted (probably fixed). (`git log -L` reads line numbers at the END of
  // the range, i.e. the tip, which picked the wrong lines after fixes shifted them: all 8 picks on 2026-11-24
  // 07:35 were stale for that reason.)
  if (exists && changed.length && session) {
    const tip = git('rev-parse', BASE);
    for (const l of ls) {
      // Open only if the line survived untouched to the tip from EVERY candidate head. ("Any head" was tried on
      // 2026-11-24 12:05: 9 of 11 picks were rows from the oldest session whose line had since been fixed.)
      l.editedSince = false; l.texts = [];
      for (const h of heads) {
        try {
          const out = git('blame', '--reverse', '--porcelain', `-L${l.line},${l.line}`, `${h}..${BASE}`, '--', file);
          const last = out.split(/\s/)[0];
          const untouched = tip.startsWith(last) || last.startsWith(tip);
          const text = (out.split('\n').find(s => s.startsWith('\t')) || '').slice(1);
          l.texts.push(`at ${h}${untouched ? ' (line unchanged since)' : ' (line edited since)'}: ${text.trim().slice(0, 140)}`);
          if (!untouched) l.editedSince = true;
          if (l.sessionText == null || untouched) l.sessionText = text;
        } catch {}
      }
    }
  }
  if (session) for (const l of ls) if (l.sessionText == null) { try { l.sessionText = git('show', `${session}:${file}`).split('\n')[l.line - 1] || ''; } catch { l.sessionText = ''; } }
  const open = ls.filter(l => !l.editedSince);
  return { file, ls: open, lsAll: ls, all: ls.length, round: Math.min(...(open.length ? open : ls).map(l => l.round)),
    namey: open.filter(l => NAMEY.test(l.error)).length, changed, exists };
}).filter(f => f.exists && (argv.includes('--ignore-processed') || !proc.has(f.file + '|*')));
const nChanged = files.filter(f => f.changed.length).length;
if (!includeChanged) files = files.filter(f => f.ls.length > 0);
// --untouched-only: keep only files with NO commit since the scratch session. Files that changed are where other
// contributors and the maintainer are working (e.g. 88fa0b1ab6 rewrote opens in ten files right after the session),
// so their rows are unreliable; untouched files are the cleanest open targets.
if (argv.includes('--untouched-only')) files = files.filter(f => !f.changed.length);
// Later-round rows whose file imports a LOWER-round table file that changed since the oldest session head: the
// later error is usually an artifact of that dependency being stubbed with sorry (2026-11-25 09:23: SatDict:67
// and LocUnr:212 "introN failed" because the SatDict/LocUnr defs in HodgeTateFromSandwich (round 3) were
// stubbed; #1411 had already fixed HodgeTateFromSandwich). Drop them unless --include-dependent.
if (!argv.includes('--include-dependent') && files.length) {
  try {
    const { importGraph, closureOf, pathToMod } = await import('./scanlib.mjs');
    const gB = importGraph(BASE);
    const changedLow = [...byFile.entries()].map(([file, ls]) => ({ mod: pathToMod(file), round: Math.min(...ls.map(l => l.round)), file }))
      .filter(x => { try { return git('log', '-1', '--format=%h', `${oldest}..${BASE}`, '--', x.file) !== ''; } catch { return false; } });
    const before = files.length;
    files = files.filter(f => {
      const clos = closureOf(gB, pathToMod(f.file));
      const dep = changedLow.find(x => x.file !== f.file && x.round < f.round && clos.has(x.mod));
      if (dep) say(`  ${f.file.split('/').pop()} (round ${f.round}) depends on ${dep.file.split('/').slice(-2).join('/')} (round ${dep.round}, changed since ${oldest}): skipped`);
      return !dep;
    });
    if (before !== files.length) say(`dropped ${before - files.length} later-round file(s) behind a changed lower-round dependency`);
  } catch (e) { say('dependency check failed, keeping files: ' + String(e.message || e).split('\n')[0]); }
}
say(`${files.length} files with locations whose line was not edited since the session (${nChanged} files changed since it; ${files.filter(f => f.changed.length).length} of those still have untouched locations)`);
if (files.length) {
  const out = node('tools/claim.mjs', 'check', ...files.map(f => f.file));
  const claimed = new Set(out.split('\n').filter(l => l.startsWith('CLAIMED')).map(l => l.split(/\s+/)[1]));
  if (claimed.size) say(`dropped ${claimed.size} file(s) touched or titled by open PRs`);
  files = files.filter(f => !claimed.has(f.file));
}
files.sort((a, b) => a.round - b.round || (b.namey / b.ls.length) - (a.namey / a.ls.length) || a.ls.length - b.ls.length);
files = files.slice(0, max);
const existing = fs.existsSync(path.join(HOME, 'wt')) ? fs.readdirSync(path.join(HOME, 'wt')) : [];
const rows = files.map((f, i) => {
  if (!f.ls.length) f.ls = f.lsAll; // --include-changed: every location edited since; let the agent check them
  const tree = `w${i + 1 + (+(argv[argv.indexOf("--tree-offset") + 1] || 0) || 0)}`;
  const text = (() => { try { return git('show', `${BASE}:${f.file}`).split('\n'); } catch { return []; } })();
  const list = f.ls.map(l => `session L${l.line} (round ${l.round}, ${l.kind}): ${l.error}   [${l.texts && l.texts.length > 1 ? 'that line ' + l.texts.join(' | ') : `that line at the session head ${session}: ${(l.sessionText || '').trim().slice(0, 160)}`}]`).join('\n  ');
  return {
    tree, createTree: !existing.includes(tree), file: f.file, line: f.ls[0].line, category: 'look-ahead',
    error: `Look-ahead scratch build (session ${session}, earlier failures stubbed with sorry in a scratch copy) reports ${f.ls.length} error(s) in this file:\n  ${list}`,
    lineNow: (text[f.ls[0].line - 1] || '').trim(),
    hint: `These are look-ahead rows, not Open rows: the error texts are FIRST LINES only (e.g. "Ambiguous term" without the name), so find the offending identifier/instance at each listed line yourself (marker, show branch, resolve on the section's original). Fix ALL listed locations in this file in one commit (one file = one PR). Round ${f.round} = ${f.round === 1 ? 'the next layer the real build will hit' : 'hidden behind earlier failures'}. The table merges scratch sessions at heads ${sessions.join(', ')} and rows do not say which, so a line number may be at any of them (per-head texts are given where the file differs). If the file changed since, a listed error may already be fixed: check each against the tip. Never add sorry. The project says fix PRs for any look-ahead row are welcome.`,
  };
});
if (!argv.includes('--dry')) for (const r of rows) fs.appendFileSync(path.join(HOME, 'runs', 'processed.txt'), r.file + '|*\n');
say(`picked ${rows.length}: ${rows.map(r => `${r.file.split('/').slice(-2).join('/')} (${byFile.get(r.file).length} loc)`).join(', ') || 'none'}`);
process.stdout.write(JSON.stringify({ home: HOME.replace(/\\/g, '/'), listTime, rows }));
