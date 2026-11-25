#!/usr/bin/env node
// Write a progress page (Markdown) for the PR #120 fixing work and, with --push, commit it to the fork's
// `automation` branch so it can be watched in a browser:
//   node tools/status.mjs [--push] [--repo owner/name]     (default repo: the `fork` remote's owner/name)
// Content: our PRs (state, merge time), cloud attack runs, the last log lines, links. It holds no local
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

// Cloud attack runs (pr120-attack.yml): each job's state; build jobs are named after their module.
const attack = [];
try {
  const runs = JSON.parse(sh('gh', ['run', 'list', '-R', REPO, '-w', 'pr120-attack.yml', '-L', '5', '--json', 'databaseId,status,conclusion,createdAt,url']));
  for (const r of runs) {
    let jobs = [];
    try { jobs = JSON.parse(sh('gh', ['run', 'view', String(r.databaseId), '-R', REPO, '--json', 'jobs'])).jobs || []; } catch {}
    const js = jobs.map(j => {
      const m = j.name.match(/^([\w-]+) \(([^,)]+)/);
      const name = m ? `${m[1]} ${m[2].split('.').pop()}` : j.name;
      return `${name}: ${j.status === 'completed' ? j.conclusion : j.status.replace('_', ' ')}`;
    });
    attack.push(`- [run ${r.databaseId}](${r.url}), started ${t(r.createdAt)} UTC, ${r.status === 'completed' ? r.conclusion : r.status.replace('_', ' ')}${js.length ? `: ${js.join('; ')}` : ''}`);
  }
} catch { attack.push('_could not list the runs_'); }

const clean = l => !/[A-Za-z]:[\\/]|\/c\/Users|AppData|@gmail|monir/i.test(l);
const logLines = fs.existsSync(path.join(HOME, 'runs', 'cycles.log'))
  ? fs.readFileSync(path.join(HOME, 'runs', 'cycles.log'), 'utf8').trim().split('\n').filter(clean).slice(-12).reverse()
  : [];

const md = [
  `# PR #120 fixing: progress`,
  ``,
  `Updated ${t(new Date().toISOString())} UTC by the workstation run. Fixes are published as \`Fix <Module>\` PRs from [${REPO}](https://github.com/${REPO}) to [${UPSTREAM}](https://github.com/${UPSTREAM}/tree/opt/collapse-and-consolidate-4.36).`,
  ``,
  `**Links:** [all our PRs](https://github.com/${UPSTREAM}/pulls?q=is%3Apr+author%3A${OWNER}) · [cloud workflow runs](https://github.com/${REPO}/actions/workflows/pr120-cloud.yml) · [attack runs](https://github.com/${REPO}/actions/workflows/pr120-attack.yml) · [failure list](https://github.com/rohanarun/alpoge-rh-replay/blob/main/PR120-BUGS.md)`,
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
  `## Cloud attack runs (build at the tip, fix, rebuild, publish)`,
  attack.length ? attack.join('\n') : '_none yet_',
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
