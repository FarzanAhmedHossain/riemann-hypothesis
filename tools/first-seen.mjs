#!/usr/bin/env node
// For each Open row of the live PR120-BUGS.md: when was this error FIRST listed (same file and same error
// prefix), and has the file changed on the branch since then? Unchanged since first report => the error is
// real at the tip. Changed since => probably fixed or in flux.
//
//   node tools/first-seen.mjs [--hours 30] [--json]
//
// Why: the main 4-shard build does not re-run every cycle (the "Compiled" count stayed 41,883 from 07:35 to
// 10:21 UTC on 2026-11-24) while the list is republished, so the Open table carries errors that later commits
// fixed. Reads GitHub (list history) and the local clone; writes nothing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(HOME, 'riemann-hypothesis');
const BASE = 'origin/opt/collapse-and-consolidate-4.36';
const argv = process.argv.slice(2);
const hours = +(argv[argv.indexOf('--hours') + 1] || 0) || 30;
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 27 });
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

const parseOpen = md => {
  const sec = md.split(/^## /m).find(s => /^Open\b/.test(s)) ?? md;
  const out = [];
  for (const line of sec.split('\n')) {
    const m = line.match(/^\|\s*`([^`]+?\.lean):(\d+)`\s*\|\s*([^|]*)\|\s*([^|]*)\|/);
    if (m) out.push({ file: 'src/' + m[1].replace(/^src\//, ''), line: +m[2], category: m[3].trim(), error: m[4].trim() });
  }
  return out;
};
const key = r => r.file + '|' + r.error.slice(0, 50);

const since = new Date(Date.now() - hours * 3600e3).toISOString();
const commits = JSON.parse(gh('api', `repos/rohanarun/alpoge-rh-replay/commits?path=PR120-BUGS.md&since=${since}&per_page=100`,
  '--jq', '[.[] | {sha: .sha, date: .commit.committer.date}]')).reverse(); // oldest first
const firstSeen = new Map();
for (const c of commits) {
  let md = '';
  // List versions never change: cache them by commit sha (saves ~100 API calls per run; the Actions job token
  // allows 1,000 requests an hour).
  const cacheDir = path.join(path.dirname(REPO), 'runs', 'listhist'); fs.mkdirSync(cacheDir, { recursive: true });
  const cf = path.join(cacheDir, `${String(c.sha).replace(/[^0-9a-f]/g, '').slice(0, 40)}.md`);
  if (fs.existsSync(cf)) md = fs.readFileSync(cf, 'utf8');
  else {
    try { md = gh('api', `repos/rohanarun/alpoge-rh-replay/contents/PR120-BUGS.md?ref=${c.sha}`, '-H', 'Accept: application/vnd.github.raw'); } catch { continue; }
    try { fs.writeFileSync(cf, md); } catch {}
  }
  for (const r of parseOpen(md)) if (!firstSeen.has(key(r))) firstSeen.set(key(r), c.date);
}
const live = parseOpen(gh('api', 'repos/rohanarun/alpoge-rh-replay/contents/PR120-BUGS.md', '-H', 'Accept: application/vnd.github.raw'));
try { git('fetch', '-q', 'origin', '+refs/heads/opt/collapse-and-consolidate-4.36:refs/remotes/origin/opt/collapse-and-consolidate-4.36'); } catch {}
const rows = live.map(r => {
  const t0 = firstSeen.get(key(r)) || commits[0]?.date || since;
  let after = [];
  try { after = git('log', `--since=${t0}`, '--format=%h %cI %s', BASE, '--', r.file).split('\n').filter(Boolean); } catch {}
  return { ...r, firstSeen: t0, changedSinceFirstSeen: after.length, commitsAfter: after.slice(0, 3) };
});
if (argv.includes('--json')) { process.stdout.write(JSON.stringify(rows)); process.exit(0); }
const real = rows.filter(r => !r.changedSinceFirstSeen), moved = rows.filter(r => r.changedSinceFirstSeen);
console.log(`${commits.length} list versions in ${hours} h; ${live.length} Open rows: ${real.length} unchanged since first listed (real), ${moved.length} changed since (probably fixed)`);
for (const r of real) console.log(`REAL  ${r.file}:${r.line}  first ${r.firstSeen.slice(11, 16)}  ${r.error.slice(0, 90)}`);
for (const r of moved) console.log(`moved ${r.file}:${r.line}  first ${r.firstSeen.slice(11, 16)}  ${r.commitsAfter[0] || ''}`.slice(0, 220));
