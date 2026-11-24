#!/usr/bin/env node
// Write a progress page (Markdown) for the PR #120 fixing work and, with --push, commit it to the fork's
// `automation` branch so it can be watched in a browser:
//   node tools/status.mjs [--push] [--repo owner/name]     (default repo: the `fork` remote's owner/name)
// Content: our PRs (state, merge time), scanner shard progress, the last log lines, links. It holds no local
// paths or personal data (the log lines are filtered for paths before publishing).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });
const forkUrl = (() => { try { return sh('git', ['-C', path.join(HOME, 'riemann-hypothesis'), 'remote', 'get-url', 'fork']).trim(); } catch { return ''; } })();
const REPO = argv.includes('--repo') ? argv[argv.indexOf('--repo') + 1] : (forkUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/) || [])[1];
if (!REPO) throw new Error('no fork repo: pass --repo owner/name');
const OWNER = REPO.split('/')[0];
const UPSTREAM = 'rohanarun/riemann-hypothesis';

const prs = JSON.parse(sh('gh', ['pr', 'list', '-R', UPSTREAM, '--author', OWNER, '--state', 'all', '--limit', '40',
  '--json', 'number,title,state,isDraft,createdAt,mergedAt,url']));
const merged = prs.filter(p => p.state === 'MERGED'), open = prs.filter(p => p.state === 'OPEN'), closed = prs.filter(p => p.state === 'CLOSED');
const t = s => (s || '').replace('T', ' ').slice(0, 16);

const shards = [];
for (let i = 0; i < 8; i++) {
  const out = path.join(HOME, 'runs', `shadow-findings-blocked-${i}of8.json`);
  const log = path.join(HOME, 'runs', `scan-blocked-${i}of8.log`);
  let st = 'pending';
  if (fs.existsSync(out)) { try { const n = JSON.parse(fs.readFileSync(out, 'utf8')).length; st = `done (${n} findings)`; } catch { st = 'done'; } }
  else if (fs.existsSync(log)) { const last = fs.readFileSync(log, 'utf8').trim().split('\n').filter(l => l.startsWith('[')).pop() || ''; st = `running: ${last.replace(/^\[\d+s\]\s*/, '').slice(0, 60)}`; }
  shards.push(`| ${i} | ${st} |`);
}

const clean = l => !/[A-Za-z]:[\\/]|\/c\/Users|AppData|@gmail|monir/i.test(l);
const logLines = fs.existsSync(path.join(HOME, 'runs', 'cycles.log'))
  ? fs.readFileSync(path.join(HOME, 'runs', 'cycles.log'), 'utf8').trim().split('\n').filter(clean).slice(-12).reverse()
  : [];

const md = [
  `# PR #120 fixing: progress`,
  ``,
  `Updated ${t(new Date().toISOString())} UTC by the workstation run. Fixes are published as \`Fix <Module>\` PRs from [${REPO}](https://github.com/${REPO}) to [${UPSTREAM}](https://github.com/${UPSTREAM}/tree/opt/collapse-and-consolidate-4.36).`,
  ``,
  `**Links:** [all our PRs](https://github.com/${UPSTREAM}/pulls?q=is%3Apr+author%3A${OWNER}) · [cloud workflow runs](https://github.com/${REPO}/actions/workflows/pr120-cloud.yml) · [failure list](https://github.com/rohanarun/alpoge-rh-replay/blob/main/PR120-BUGS.md)`,
  ``,
  `## Summary`,
  `${merged.length} merged, ${open.length} open, ${closed.length} closed (of the last ${prs.length}).`,
  ``,
  `## Open PRs`,
  open.length ? open.map(p => `- [#${p.number}](${p.url}) ${p.title}${p.isDraft ? ' (draft)' : ''}, opened ${t(p.createdAt)}`).join('\n') : '_none_',
  ``,
  `## Merged (most recent first)`,
  merged.map(p => `- [#${p.number}](${p.url}) ${p.title}, merged ${t(p.mergedAt)}`).join('\n') || '_none_',
  ``,
  `## Name-capture scanner (blocked modules, 8 shards)`,
  `| shard | status |`, `|---|---|`, ...shards,
  ``,
  `## Recent log`,
  '```', ...logLines.map(l => l.slice(0, 400)), '```',
  ``,
].join('\n');

const outFile = path.join(HOME, 'automation-branch', 'STATUS.md');
const prev = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
const strip = s => s.replace(/^Updated .*$/m, '');
if (strip(prev) === strip(md) && !argv.includes('--force')) { console.log('STATUS unchanged'); process.exit(0); }
fs.writeFileSync(outFile, md);
console.log(`STATUS written (${merged.length} merged, ${open.length} open)`);
if (argv.includes('--push')) {
  const g = (...a) => sh('git', ['-C', path.join(HOME, 'automation-branch'), ...a]);
  g('add', 'STATUS.md');
  g('commit', '-q', '-m', 'Update STATUS.md\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
  g('push', '-q', `https://github.com/${REPO}.git`, 'automation:refs/heads/automation');
  console.log(`pushed: https://github.com/${REPO}/blob/automation/STATUS.md`);
}
