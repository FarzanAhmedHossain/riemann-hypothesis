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
import { PROTECTED, BANNED } from './gate-rules.mjs';

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

// strict: throw when any open PR's file list cannot be fetched (publish must fail closed, not treat that PR as
// touching nothing).
async function openPRsWithFiles(strict = false) {
  const LIMIT = 1000;
  const prs = JSON.parse(gh('pr', 'list', '-R', UP, '--state', 'open', '--limit', String(LIMIT),
    '--json', 'number,title,headRefName,headRefOid,author,isDraft,createdAt,changedFiles'));
  if (strict && prs.length >= LIMIT) throw new Error(`cannot verify claims: ${prs.length} open PRs (the listing may be truncated); not publishing`);
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const need = prs.filter(p => !cache[p.number] || cache[p.number].oid !== p.headRefOid);
  if (process.env.CLAIM_DEBUG) console.error(`${prs.length} open PRs listed in ${((Date.now() - T0) / 1000).toFixed(1)}s; fetching files for ${need.length}`);
  const failed = [];
  for (let i = 0; i < need.length; i += 8) {
    await Promise.all(need.slice(i, i + 8).map(async p => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { stdout } = await pexec('gh', ['api', '--paginate', `repos/${UP}/pulls/${p.number}/files?per_page=100`, '--jq', '.[].filename'],
            { maxBuffer: 1 << 26 });
          cache[p.number] = { oid: p.headRefOid, files: stdout.split('\n').filter(Boolean) };
          return;
        } catch {}
      }
      delete cache[p.number]; failed.push(p.number);
    }));
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  if (strict && failed.length) throw new Error(`cannot verify claims: file lists of open PRs ${failed.map(n => '#' + n).join(', ')} could not be fetched; not publishing`);
  // The files endpoint caps at 3000 entries: a PR with more changed files than we could list touches "everything".
  return prs.map(p => {
    const files = cache[p.number]?.files || [];
    return { ...p, files, partial: typeof p.changedFiles === 'number' && files.length < p.changedFiles };
  });
}
const IN_CLOUD = () => process.env.GITHUB_ACTIONS === 'true' || process.env.PR120_NO_PR === '1';
// PROTECTED and BANNED (forbidden added text) are shared with tools/diff-gate.mjs; see tools/gate-rules.mjs.

function claimsFor(file, prs) {
  const f = normFile(file), mod = modOf(f), leaf = mod.split('.').pop(), tail = mod.split('.').slice(-2).join('.');
  const out = [];
  for (const p of prs) {
    const why = [];
    if (p.files.includes(f)) why.push('files');
    else if (p.partial) why.push('files?'); // file list truncated: assume it may touch this file
    if (p.title.includes(mod) || p.title.includes(tail) ||
        (!/^Bundle\d+$/.test(leaf) && new RegExp(`(^|[^A-Za-z0-9_])${reEsc(leaf)}($|[^A-Za-z0-9_])`).test(p.title))) why.push('title');
    if (p.headRefName === branchOf(f) || p.headRefName.endsWith('-' + leaf) || p.headRefName.endsWith('/' + leaf)) why.push('branch');
    if (why.length) out.push({ n: p.number, who: p.author?.login, draft: p.isDraft, why: why.join('+'), title: p.title, head: p.headRefName });
  }
  return out;
}

// In Actions the job token cannot call /user; the fork owner is the repository owner there.
const me = () => (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY_OWNER) || gh('api', 'user', '--jq', '.login');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (['open', 'finish', 'release'].includes(cmd) && IN_CLOUD()) {
    throw new Error(`refusing '${cmd}' in the cloud: only the workstation opens, edits or closes PRs`);
  }
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
    // With --no-pr (or in the cloud's AI job: GITHUB_ACTIONS=true / PR120_NO_PR=1) nothing is pushed and no PR is
    // opened. Instead, after the same checks, the commit is written as a git bundle plus a record in runs/ready/
    // (uploaded as the `ready-branches` artifact). The publish job, or the workstation, opens the PR with
    // tools/publish-ready.mjs. The AI job therefore needs no write access to any repository.
    // Flags: --no-pr; --target fix/<leaf> (branch to publish as, needed when HEAD is detached, as in
    // publish-ready's tree); --body-file <path> (PR text; default runs/<Parent-Leaf>/PR.md); --block-own (our
    // own open PRs on other branches that touch the same files block too); --expect-files a,b (refuse unless
    // the published files are exactly these).
    const [treeArg, ...flags] = rest;
    const flag = k => { const i = flags.indexOf(k); return i >= 0 ? flags[i + 1] : ''; };
    const noPr = flags.includes('--no-pr') || IN_CLOUD();
    const env = { ...process.env, RH_REPO: treeArg || 'riemann-hypothesis' };
    const run = (...a) => execFileSync('node', [path.join(HOME, 'tools', 'rh.mjs'), 'git', ...a], { cwd: HOME, encoding: 'utf8', env }).trim();
    run('fetch', '-q', 'origin', `+refs/heads/${BASE}:refs/remotes/origin/${BASE}`);
    const headName = run('rev-parse', '--abbrev-ref', 'HEAD');
    const branch = flag('--target') || headName;
    if (!/^fix\/[A-Za-z0-9_-]+$/.test(branch)) throw new Error(`tree is on ${headName}, expected fix/<leaf> (or pass --target fix/<leaf>)`);
    // Rebase FIRST: if the same change already landed upstream, git drops our commit and the diff below is
    // empty, so we never open a duplicate or empty PR.
    try { run('rebase', '-q', `origin/${BASE}`); } catch (e) { try { run('rebase', '--abort'); } catch {} throw new Error('rebase onto the fresh tip failed (conflict: someone changed the same lines); fix by hand'); }
    const sha = run('rev-parse', 'HEAD'); // everything below checks and pushes exactly this commit
    // What changed, with modes: only regular files (100644), only modified or added src/**/*.lean, never protected.
    const raw = run('diff', '--raw', '--no-renames', '--no-abbrev', `origin/${BASE}`, sha).split('\n').filter(Boolean).map(l => {
      const m = l.match(/^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*\t(.+)$/);
      return m ? { oldMode: m[1], mode: m[2], s: m[3], f: m[4] } : { s: '?', f: l };
    });
    const files = raw.map(x => x.f);
    if (!files.length) throw new Error('nothing to publish: no diff against the work branch');
    const bad = raw.filter(x => !['M', 'A'].includes(x.s) || x.mode !== '100644' || !/^src\/[A-Za-z0-9_./-]+\.lean$/.test(x.f) || x.f.includes('..') || PROTECTED.test(x.f));
    if (bad.length) throw new Error(`refusing: diff ${bad.map(x => `${x.s} ${x.mode || ''} ${x.f}`).join(', ')} (only modified or added regular src/**/*.lean files outside the protected ones)`);
    if (flag('--expect-files')) {
      const want = flag('--expect-files').split(',').filter(Boolean).sort().join(',');
      if (want !== files.slice().sort().join(',')) throw new Error(`refusing: the commit changes ${files.join(', ')}, not the recorded files`);
    }
    // Added text, parsed hunk by hunk: inside a hunk every '+' line is added text (even one starting with '++').
    const added = []; let inHunk = false;
    for (const l of run('diff', '--text', '-U0', '--no-renames', '--no-color', `origin/${BASE}`, sha).split('\n')) {
      if (l.startsWith('diff --git ')) { inHunk = false; continue; }
      if (l.startsWith('@@')) { inHunk = true; continue; }
      if (inHunk && l.startsWith('+')) added.push(l.slice(1));
      if (!inHunk && /^Binary files /.test(l)) throw new Error('refusing: binary change');
    }
    const hit = added.join('\n').match(BANNED);
    if (hit) throw new Error(`refusing: added text contains a forbidden keyword (${hit[0].slice(0, 40)})`);
    const prs = await openPRsWithFiles(true);
    // Other people's claims always block. Our own open PRs block too, except a PR on this very branch (updated in
    // place by the push below), unless --block-own; in the no-PR (cloud) mode every open PR blocks.
    const login = noPr ? '' : me();
    const blockOwn = flags.includes('--block-own');
    const clash = files.flatMap(f => claimsFor(f, prs).filter(c => noPr || c.who !== login || c.head !== branch || blockOwn && c.head !== branch).map(c => `${f}: #${c.n} @${c.who} (${c.why})`));
    if (clash.length) { console.log(`CLAIMED, not publishing:\n  ${clash.join('\n  ')}`); process.exitCode = 3; return; }
    const mod = modOf(files[0]);
    const leaf = modOf(files[0]).split('.').pop();
    const bodyFile = flag('--body-file') ? path.resolve(flag('--body-file'))
      : [path.join(HOME, 'runs', leafDir(files[0]), 'PR.md'), path.join(HOME, 'runs', leaf, 'PR.md')].find(p => fs.existsSync(p));
    if (!bodyFile || !fs.existsSync(bodyFile)) throw new Error(`missing PR text runs/${leafDir(files[0])}/PR.md (or runs/${leaf}/PR.md, or --body-file)`);
    const title = files.length === 1 ? `Fix ${mod}` : `Fix ${mod} and ${files.length - 1} more`;
    if (noPr) {
      // No push: hand the checked commit over as a git bundle next to its record (both go into the artifact).
      const runId = process.env.GITHUB_RUN_ID || String(Date.now());
      const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
      const id = `${branch.slice(4)}-r${runId}-${attempt}`;
      const base = run('rev-parse', `origin/${BASE}`);
      const dir = path.join(HOME, 'runs', 'ready'); fs.mkdirSync(dir, { recursive: true });
      const bundle = path.join(dir, `${id}.bundle`);
      run('update-ref', `refs/pr120/${id}`, sha);
      try { run('bundle', 'create', bundle.replace(/\\/g, '/'), `refs/pr120/${id}`, `^${base}`); }
      finally { try { run('update-ref', '-d', `refs/pr120/${id}`); } catch {} }
      const rec = { id, target: branch, title, files, head: sha, base, bundle: `${id}.bundle`,
        body: fs.readFileSync(bodyFile, 'utf8'), time: new Date().toISOString(), run: runId, attempt };
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec, null, 1));
      console.log(`READY ${id} -> ${branch} (${files.length} file(s), head ${sha.slice(0, 10)}): bundled for the publish job; nothing pushed, no PR opened`);
      return;
    }
    run('push', '-q', '--force', 'fork', `${sha}:refs/heads/${branch}`);
    gh('pr', 'create', '--repo', UP, '--base', BASE, '--head', `${login}:${branch}`, '--title', title, '--body-file', bodyFile);
    const n = JSON.parse(gh('pr', 'list', '-R', UP, '--state', 'open', '--head', branch, '--json', 'number,url'))[0];
    console.log(`PUBLISHED #${n.number} ${n.url} (ready) ${files.length} file(s), head ${sha.slice(0, 10)}`);
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
