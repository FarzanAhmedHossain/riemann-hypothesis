#!/usr/bin/env node
// Claim rows of PR120-BUGS.md fast, the way the project asks ("open a draft PR early; that's your claim").
//
//   node tools/claim.mjs check <file>...        which open PRs touch each file (title, branch or changed files)
//   node tools/claim.mjs open <file> [note]     empty-commit draft "Fix <Module>" from the fork; prints the PR number
//   node tools/claim.mjs finish <n> <wt/wN|riemann-hypothesis>
//                                               force-push that tree's HEAD to the claim branch, set the body from
//                                               runs/<leaf>/PR.md, mark ready
//   node tools/claim.mjs release <n> <reason>   close one of OUR OWN claim PRs whose diff is still empty
//
// An empty-diff draft is never merged by the coordinator ("empty diff"), so a claim cannot land anything by
// itself. File-level check: per-PR changed-file lists are cached in runs/pr-files-cache.json by head commit,
// so only new or updated PRs are fetched (8 in parallel) and a check takes seconds, not minutes.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const T0 = Date.now();
const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(HOME, 'riemann-hypothesis');
const CACHE = path.join(HOME, 'runs', 'pr-files-cache.json');
const UP = 'rohanarun/riemann-hypothesis';
const BASE = 'opt/collapse-and-consolidate-4.36';
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

const normFile = f => {
  f = f.replace(/\\/g, '/');
  if (!f.endsWith('.lean')) f = f.replace(/\./g, '/') + '.lean';
  return f.startsWith('src/') ? f : 'src/' + f;
};
const modOf = f => normFile(f).replace(/^src\//, '').replace(/\.lean$/, '').replace(/\//g, '.');
const branchOf = f => 'fix/' + modOf(f).split('.').slice(-2).join('-').replace(/[^A-Za-z0-9_-]/g, '');
const leafDir = f => modOf(f).split('.').slice(-2).join('-').replace(/[^A-Za-z0-9_-]/g, '');
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function openPRsWithFiles() {
  const prs = JSON.parse(gh('pr', 'list', '-R', UP, '--state', 'open', '--limit', '300',
    '--json', 'number,title,headRefName,headRefOid,author,isDraft,createdAt'));
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const need = prs.filter(p => !cache[p.number] || cache[p.number].oid !== p.headRefOid);
  if (process.env.CLAIM_DEBUG) console.error(`${prs.length} open PRs listed in ${((Date.now() - T0) / 1000).toFixed(1)}s; fetching files for ${need.length}`);
  for (let i = 0; i < need.length; i += 8) {
    await Promise.all(need.slice(i, i + 8).map(async p => {
      try {
        const { stdout } = await pexec('gh', ['api', '--paginate', `repos/${UP}/pulls/${p.number}/files?per_page=100`, '--jq', '.[].filename'],
          { maxBuffer: 1 << 26 });
        cache[p.number] = { oid: p.headRefOid, files: stdout.split('\n').filter(Boolean) };
      } catch { cache[p.number] = { oid: '?', files: [] }; }
    }));
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return prs.map(p => ({ ...p, files: cache[p.number]?.files || [] }));
}

function claimsFor(file, prs) {
  const f = normFile(file), mod = modOf(f), leaf = mod.split('.').pop(), tail = mod.split('.').slice(-2).join('.');
  const out = [];
  for (const p of prs) {
    const why = [];
    if (p.files.includes(f)) why.push('files');
    if (p.title.includes(mod) || p.title.includes(tail) ||
        (!/^Bundle\d+$/.test(leaf) && new RegExp(`(^|[^A-Za-z0-9_])${reEsc(leaf)}($|[^A-Za-z0-9_])`).test(p.title))) why.push('title');
    if (p.headRefName === branchOf(f) || p.headRefName.endsWith('-' + leaf) || p.headRefName.endsWith('/' + leaf)) why.push('branch');
    if (why.length) out.push({ n: p.number, who: p.author?.login, draft: p.isDraft, why: why.join('+'), title: p.title });
  }
  return out;
}

const me = () => gh('api', 'user', '--jq', '.login');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'check') {
    const prs = await openPRsWithFiles();
    let any = false;
    for (const f of rest) {
      const c = claimsFor(f, prs);
      if (c.length) any = true;
      console.log(`${c.length ? 'CLAIMED' : 'free   '} ${normFile(f)}${c.map(x => `  #${x.n} @${x.who} (${x.why})`).join('')}`);
    }
    process.exitCode = any ? 3 : 0;
    return;
  }
  if (cmd === 'open') {
    const [file, ...noteWords] = rest; const f = normFile(file); const mod = modOf(f); const br = branchOf(f);
    const prs = await openPRsWithFiles();
    const c = claimsFor(f, prs);
    if (c.length) { console.log(`CLAIMED ${f}: ${c.map(x => `#${x.n} @${x.who} (${x.why})`).join(', ')}`); process.exitCode = 3; return; }
    git('fetch', '-q', 'origin', `+refs/heads/${BASE}:refs/remotes/origin/${BASE}`);
    const tip = git('rev-parse', `origin/${BASE}`);
    const tree = git('rev-parse', `${tip}^{tree}`);
    const email = git('config', 'user.email'), name = git('config', 'user.name');
    const sha = execFileSync('git', ['-C', REPO, 'commit-tree', tree, '-p', tip, '-m', `Claim ${mod} (fix in progress)`],
      { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } }).trim();
    git('push', '-q', '--force', 'fork', `${sha}:refs/heads/${br}`);
    const login = me();
    const note = noteWords.join(' ');
    const body = `Claiming this row of PR120-BUGS.md; the fix follows on this branch shortly. Until then the diff is empty, so there is nothing to merge.${note ? '\n\n' + note : ''}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
    gh('pr', 'create', '--repo', UP, '--base', BASE, '--head', `${login}:${br}`, '--draft', '--title', `Fix ${mod}`, '--body', body);
    const n = JSON.parse(gh('pr', 'list', '-R', UP, '--state', 'open', '--head', br, '--json', 'number,url'))[0];
    console.log(`CLAIMED-BY-US #${n.number} ${n.url} branch ${br}`);
    return;
  }
  if (cmd === 'finish') {
    const [n, treeArg] = rest;
    const pr = JSON.parse(gh('pr', 'view', n, '-R', UP, '--json', 'headRefName,author,title,isDraft'));
    if (pr.author.login !== me()) throw new Error(`#${n} is not ours`);
    const env = { ...process.env, RH_REPO: treeArg || 'riemann-hypothesis' };
    const run = (...a) => execFileSync('node', [path.join(HOME, 'tools', 'rh.mjs'), 'git', ...a], { cwd: HOME, encoding: 'utf8', env }).trim();
    run('push', '--force', 'fork', `HEAD:refs/heads/${pr.headRefName}`);
    const mod = pr.title.replace(/^Fix /, '');
    const bodyFile = path.join(HOME, 'runs', mod.split('.').slice(-2).join('-').replace(/[^A-Za-z0-9_-]/g, ''), 'PR.md');
    if (fs.existsSync(bodyFile)) gh('pr', 'edit', n, '-R', UP, '--body-file', bodyFile);
    else console.log(`(no ${bodyFile}; body left as is)`);
    if (pr.isDraft) gh('pr', 'ready', n, '-R', UP);
    console.log(`FINISHED #${n}: pushed ${run('rev-parse', '--short', 'HEAD')} to ${pr.headRefName}, body ${fs.existsSync(bodyFile) ? 'updated' : 'unchanged'}, ready`);
    return;
  }
  if (cmd === 'publish') {
    // Open a READY "Fix <Module>" PR straight from a fix tree (no empty claim: the coordinator closes those).
    const [treeArg] = rest;
    const env = { ...process.env, RH_REPO: treeArg || 'riemann-hypothesis' };
    const run = (...a) => execFileSync('node', [path.join(HOME, 'tools', 'rh.mjs'), 'git', ...a], { cwd: HOME, encoding: 'utf8', env }).trim();
    run('fetch', '-q', 'origin', `+refs/heads/${BASE}:refs/remotes/origin/${BASE}`);
    const branch = run('rev-parse', '--abbrev-ref', 'HEAD');
    if (!branch.startsWith('fix/')) throw new Error(`tree is on ${branch}, expected fix/<leaf>`);
    // Rebase FIRST: if the same change already landed upstream, git drops our commit and the diff below is
    // empty, so we never open a duplicate or empty PR.
    try { run('rebase', '-q', `origin/${BASE}`); } catch (e) { try { run('rebase', '--abort'); } catch {} throw new Error('rebase onto the fresh tip failed (conflict: someone changed the same lines); fix by hand'); }
    const files = run('diff', '--name-only', `origin/${BASE}`, 'HEAD').split('\n').filter(Boolean);
    if (!files.length) throw new Error('nothing to publish: no diff against the work branch');
    if (files.some(f => !/^src\/.*\.lean$/.test(f) || /^src\/(Challenge|Statements)\.lean$/.test(f))) throw new Error(`refusing: diff touches ${files.join(', ')}`);
    const added = run('diff', `origin/${BASE}`, 'HEAD').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    if (added.some(l => /\b(sorry|admit|axiom|unsafe|native_decide|implemented_by)\b|@\[extern/.test(l))) throw new Error('refusing: added lines contain a forbidden keyword');
    const prs = await openPRsWithFiles();
    const clash = files.flatMap(f => claimsFor(f, prs).filter(c => c.who !== me()).map(c => `${f}: #${c.n} @${c.who} (${c.why})`));
    if (clash.length) { console.log(`CLAIMED by others, not publishing:\n  ${clash.join('\n  ')}`); process.exitCode = 3; return; }
    run('push', '-q', '--force', 'fork', `HEAD:refs/heads/${branch}`);
    const mod = modOf(files[0]);
    const leaf = modOf(files[0]).split('.').pop();
    const bodyFile = [path.join(HOME, 'runs', leafDir(files[0]), 'PR.md'), path.join(HOME, 'runs', leaf, 'PR.md')].find(p => fs.existsSync(p));
    if (!bodyFile) throw new Error(`missing PR text runs/${leafDir(files[0])}/PR.md (or runs/${leaf}/PR.md)`);
    const title = files.length === 1 ? `Fix ${mod}` : `Fix ${mod} and ${files.length - 1} more`;
    gh('pr', 'create', '--repo', UP, '--base', BASE, '--head', `${me()}:${branch}`, '--title', title, '--body-file', bodyFile);
    const n = JSON.parse(gh('pr', 'list', '-R', UP, '--state', 'open', '--head', branch, '--json', 'number,url'))[0];
    console.log(`PUBLISHED #${n.number} ${n.url} (ready) ${files.length} file(s), head ${run('rev-parse', '--short', 'HEAD')}`);
    return;
  }
  if (cmd === 'release') {
    const [n, ...why] = rest;
    const pr = JSON.parse(gh('pr', 'view', n, '-R', UP, '--json', 'author,files,state,title'));
    if (pr.author.login !== me()) throw new Error(`#${n} is not ours; never close other people's PRs`);
    if ((pr.files || []).length) throw new Error(`#${n} has a non-empty diff; release only touches empty claims`);
    if (pr.state !== 'OPEN') { console.log(`#${n} is already ${pr.state}`); return; }
    gh('pr', 'close', n, '-R', UP, '--comment', `Releasing this claim: ${why.join(' ') || 'no defensible fix found without a build'}. The row is free for anyone.`);
    console.log(`RELEASED #${n}`);
    return;
  }
  console.log('usage: node tools/claim.mjs check <file>... | publish <tree> | open <file> [note] | finish <n> <tree> | release <n> <reason>');
  process.exitCode = 2;
}
main().catch(e => { console.error(String(e.message || e)); process.exitCode = 1; });
