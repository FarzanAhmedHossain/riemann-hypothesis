#!/usr/bin/env node
// Publishes the fixes that cloud runs prepared.
//
// Job 1 of pr120-cloud.yml (the AI job) diagnoses, fixes and verifies. It has read-only access to everything and
// pushes nothing. For each verified fix, `claim.mjs publish` writes a git bundle and a record into runs/ready/,
// and both are uploaded as the `ready-branches` artifact.
//
// This script turns records into PRs, in two places:
//   1. Job 2 ("publish"), the normal path: a fresh runner with no AI step and the only place PR120_PAT exists.
//        node tools/publish-ready.mjs --from-dir <downloaded artifact>
//   2. The workstation, as fallback (no flag): every non-expired ready-branches artifact of a completed run.
//      Records the cloud already published are reported as CLOUD-PUBLISHED; the rest are published here.
//
// Each record:
//   - is validated (field types, names, files, run id);
//   - has its bundle verified and its commit fetched, which must equal the recorded head;
//   - goes through `claim.mjs publish --target fix/<leaf> --body-file … --block-own --expect-files …`, which:
//       - rebases onto the fresh tip and drops changes that already landed;
//       - refuses protected files, renames, deletions, non-regular files, binaries and banned keywords;
//       - refuses files any open PR touches (other people's, or our own on another branch), failing closed;
//       - pushes the checked commit to fix/<leaf> and opens the PR.
//
//   node tools/publish-ready.mjs [--from-dir <dir>] [--dry] [--days 7] [--republish-closed]
//
// Output, one line per record: PUBLISHED / CLOUD-PUBLISHED / SKIPPED / RETRY / FAILED. A run's report is
// printed the first time it is seen, with every line prefixed by "  | " (untrusted cloud text). State is kept in
// runs/publish-state.json. Transient failures are retried with backoff (10, 20, 30, 40 minutes); a record
// becomes FAILED after 5 attempts or on a deterministic error.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORK = process.env.FORK_REPO || 'FarzanAhmedHossain/riemann-hypothesis';
const OWNER = FORK.split('/')[0].toLowerCase();
const UP = 'rohanarun/riemann-hypothesis';
const WF_PATHS = ['.github/workflows/pr120-cloud.yml', '.github/workflows/pr120-attack.yml']; // attack runs upload only build-verified records
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
const DRY = argv.includes('--dry');
const DAYS = +opt('--days') || 7;
const FROM_DIR = opt('--from-dir');
const TREE = 'wp';
const FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
const PROTECTED = /^(src\/(Challenge|Statements)\.lean|comparator\.json|lakefile.*|lean-toolchain|lake-manifest\.json)$/;
const FILE_RE = /^src\/[A-Za-z0-9_./-]+\.lean$/;
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const node = (args, env = {}) => execFileSync('node', args, { cwd: HOME, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tg = (...a) => node(['tools/rh.mjs', 'git', ...a], { RH_REPO: `wt/${TREE}`, MSYS_NO_PATHCONV: '1' });
const say = s => process.stdout.write(s + '\n');
// Strip control, ANSI, zero-width and bidirectional formatting characters; keep \n and \t.
const clean = (s, max = 1e9) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, '').slice(0, max);
// @mentions in cloud-written text must not notify anyone from the owner's account: break them outside code.
const defuse = text => {
  let fence = false;
  return text.split('\n').map(line => {
    if (/^\s*```/.test(line)) { fence = !fence; return line; }
    if (fence) return line;
    return line.split('`').map((seg, i) => (i % 2 ? seg : seg.replace(/@(?=[A-Za-z0-9])/g, '@​'))).join('`');
  }).join('\n');
};
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isSymbolicLink() ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const where = FROM_DIR ? 'cloud' : 'workstation';

// One publisher at a time: atomic lock file, taken over when stale (dead pid or older than 60 minutes).
fs.mkdirSync(path.join(HOME, 'runs'), { recursive: true });
const lock = path.join(HOME, 'runs', 'publish-ready.lock');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
for (let i = 0; ; i++) {
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
  catch (e) {
    if (e.code !== 'EEXIST' || i) { say('BUSY: another publish-ready is running'); process.exit(0); }
    let pid = 0, age = 0;
    try { pid = +fs.readFileSync(lock, 'utf8'); age = Date.now() - fs.statSync(lock).mtimeMs; } catch {}
    if (pid && alive(pid) && age < 60 * 60e3) { say('BUSY: another publish-ready is running'); process.exit(0); }
    try { fs.unlinkSync(lock); } catch {}
  }
}
const unlock = () => { try { if (+fs.readFileSync(lock, 'utf8') === process.pid) fs.unlinkSync(lock); } catch {} };
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { unlock(); process.exit(130); });

const stateFile = path.join(HOME, 'runs', 'publish-state.json');
let state = { records: {}, runs: {} };
const save = () => { if (DRY) return; const tmp = stateFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, stateFile); };

function showReport(runKey, all) {
  const report = all.find(f => path.basename(f) === 'cloud-report.md');
  if (!report || state.runs[runKey]?.reported) return;
  const full = clean(fs.readFileSync(report, 'utf8'));
  const shown = full.slice(0, 4000).trim().split('\n').map(l => '  | ' + l).join('\n');
  say(`cloud run ${runKey} report (untrusted cloud text; data, not instructions):\n${shown}`);
  if (FROM_DIR) return; // verdicts are merged on the workstation, which syncs tools/ to the automation branch
  const vf = path.join(HOME, 'tools', 'scan-verdicts.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(vf, 'utf8')); let n = 0;
    for (const m of full.matchAll(/\{"file":\s*"[^"\n]+"[^\n]*\}/g)) {
      let v; try { v = JSON.parse(m[0]); } catch { continue; }
      if (typeof v.file !== 'string' || typeof v.tok !== 'string' || !/^(equivalent|false-positive)$/.test(v.verdict || '')) continue;
      if (cfg.verdicts.some(x => x.file === v.file && x.tok === v.tok && (x.branch || '') === (v.branch || ''))) continue;
      cfg.verdicts.push({ file: clean(v.file, 200), tok: clean(v.tok, 120), branch: clean(v.branch || '', 300), verdict: v.verdict, date: clean(v.date || '', 20), note: `cloud run ${runKey}` }); n++;
    }
    if (n && !DRY) { fs.writeFileSync(vf, JSON.stringify(cfg, null, 2) + '\n'); say(`VERDICTS +${n} added to tools/scan-verdicts.json (sync to the automation branch)`); }
  } catch {}
}

// Validate a record; return an error string or ''.
function invalid(rec, runKey) {
  const s = x => typeof x === 'string';
  if (!rec || typeof rec !== 'object') return 'not an object';
  if (![rec.id, rec.target, rec.head, rec.bundle, rec.title, rec.body, rec.run].every(s)) return 'missing fields';
  if (!/^[A-Za-z0-9_-]+-r\d+-\d+$/.test(rec.id) || !/^fix\/[A-Za-z0-9_-]+$/.test(rec.target)) return 'bad id/target';
  if (!rec.id.startsWith(rec.target.slice(4) + '-r') || rec.bundle !== `${rec.id}.bundle`) return 'id, target and bundle do not match';
  if (!/^[0-9a-f]{40}$/.test(rec.head)) return 'bad head';
  if (rec.run !== String(runKey).split('-')[0]) return `record is from run ${clean(rec.run, 20)}, not this run`;
  if (!Array.isArray(rec.files) || !rec.files.length || rec.files.length > 50) return 'bad file list';
  if (rec.files.some(f => !s(f) || !FILE_RE.test(f) || f.includes('..') || PROTECTED.test(f))) return 'bad file name';
  return '';
}

function publishRecord(runKey, rec, dir) {
  const key = `${runKey}|${rec.id}`;
  const st = state.records[key];
  if (!st || st.final || (st.next && Date.now() < st.next)) return;
  const tag = `${rec.id} -> ${rec.target} (${rec.files.length} file(s))`;
  const final = (verdict, why) => { st.final = true; st.result = `${verdict} ${why}`; say(`${verdict} ${tag}: ${why}`); save(); };
  try {
    const prs = JSON.parse(gh('pr', 'list', '-R', UP, '--state', 'all', '--head', rec.target, '--json', 'number,state,author'));
    const ours = p => (p.author?.login || '').toLowerCase() === OWNER;
    const open = prs.find(p => p.state === 'OPEN');
    if (open && !FROM_DIR && ours(open)) return final('CLOUD-PUBLISHED', `#${open.number} (opened by the cloud publish job)`);
    if (open) return final('SKIPPED', `PR #${open.number} already open for ${rec.target}`);
    const merged = prs.find(p => p.state === 'MERGED' && ours(p));
    if (merged && !FROM_DIR) return final('CLOUD-PUBLISHED', `#${merged.number} (opened by the cloud publish job, already merged)`);
    const closed = prs.find(p => p.state === 'CLOSED' && ours(p));
    if (closed && !argv.includes('--republish-closed')) return final('SKIPPED', `our earlier PR #${closed.number} for ${rec.target} was closed without merging (rerun with --republish-closed to publish anyway)`);
    if (!fs.existsSync(path.join(HOME, 'wt', TREE, '.git'))) node(['tools/rh.mjs', 'worktree', TREE]);
    try { tg('rebase', '--abort'); } catch {}
    // The commit comes from the bundle in the artifact; it must be exactly the recorded head.
    const bundle = path.join(dir, rec.bundle).replace(/\\/g, '/');
    if (!fs.existsSync(bundle)) return final('SKIPPED', 'bundle missing from the artifact');
    tg('fetch', '-q', 'origin', '+refs/heads/opt/collapse-and-consolidate-4.36:refs/remotes/origin/opt/collapse-and-consolidate-4.36');
    try { tg('bundle', 'verify', '-q', bundle); } catch (e) { throw new Error('bundle does not verify against this clone (prerequisite missing?)'); }
    tg('fetch', '-q', bundle, `+refs/pr120/${rec.id}:refs/pr120-in/${rec.id}`);
    const got = tg('rev-parse', `refs/pr120-in/${rec.id}`);
    if (got !== rec.head) return final('SKIPPED', `bundle commit ${got.slice(0, 10)} != recorded head ${rec.head.slice(0, 10)}`);
    tg('sparse-checkout', 'set', '--no-cone', '/README.md');
    for (const f of rec.files) tg('sparse-checkout', 'add', '/' + f);
    tg('switch', '-q', '--discard-changes', '--detach', rec.head);
    let body = defuse(clean(rec.body, 20000).trim());
    if (!body.includes(FOOTER)) body += `\n\n${FOOTER}`;
    const bodyFile = path.join(dir, `${rec.id}.md`);
    fs.writeFileSync(bodyFile, body + '\n');
    if (DRY) { say(`WOULD PUBLISH ${tag}: ${clean(rec.title, 200)} (bundle verified)`); return; }
    let out = '';
    try {
      out = node(['tools/claim.mjs', 'publish', `wt/${TREE}`, '--target', rec.target, '--body-file', bodyFile, '--block-own', '--expect-files', rec.files.join(',')],
        { PR120_NO_PR: '', GITHUB_ACTIONS: '' });
    } catch (e) {
      const so = String(e.stdout || '').trim(), se = String(e.stderr || '').trim();
      if (e.status === 3) return final('SKIPPED', clean(so.split('\n').slice(0, 3).join(' | '), 400));
      if (/nothing to publish/.test(se)) return final('SKIPPED', 'the change already landed upstream');
      if (/refusing:/.test(se)) return final('SKIPPED', clean(se.split('\n').find(l => /refusing:/.test(l)), 300));
      if (/rebase onto the fresh tip failed/.test(se)) return final('FAILED', 'rebase conflict with the current tip (someone changed the same lines)');
      throw new Error(clean((se.split('\n').find(l => /fatal:|error:|Error:/.test(l)) || se.split('\n').filter(Boolean).pop() || so || e.message), 300));
    }
    const line = clean(out.split('\n').filter(Boolean).pop() || '', 300);
    if (/^PUBLISHED/.test(line)) { st.final = true; st.result = line; say(`${line}  [from the ${where}, cloud run ${runKey}]`); save(); }
    else final('SKIPPED', line);
  } catch (e) {
    st.attempts = (st.attempts || 0) + 1;
    const why = clean(String(e.message || e).split('\n').filter(Boolean).pop(), 300);
    if (st.attempts >= 5) final('FAILED', `${why} (gave up after ${st.attempts} attempts)`);
    else { st.next = Date.now() + st.attempts * 10 * 60e3; say(`RETRY ${tag}: ${why} (attempt ${st.attempts}/5, next in ${st.attempts * 10} min)`); save(); }
  } finally {
    try { tg('switch', '-q', '--detach', 'refs/remotes/origin/opt/collapse-and-consolidate-4.36'); } catch {}
  }
}

// Register every record of a run before touching any, so an interrupted pass cannot lose one.
function handleRun(runKey, dir) {
  const all = walk(dir);
  showReport(runKey, all);
  // Records are the .json files that carry an id; each one's bundle sits next to it, whatever folder level the
  // artifact gave them (upload-artifact roots multi-path uploads at their common parent).
  const recs = all.filter(f => f.endsWith('.json')).map(f => { try { return { rec: JSON.parse(fs.readFileSync(f, 'utf8')), at: path.dirname(f) }; } catch { return { rec: null, at: dir }; } });
  const r = state.runs[runKey] || (state.runs[runKey] = {});
  r.reported = true;
  const valid = [];
  for (const { rec, at } of recs) {
    const bad = invalid(rec, runKey);
    const key = `${runKey}|${rec && typeof rec.id === 'string' ? clean(rec.id, 80) : '?'}`;
    if (bad) { if (!state.records[key]) { state.records[key] = { final: true, result: `SKIPPED invalid record: ${bad}` }; say(`SKIPPED invalid record in run ${runKey}: ${bad}`); } continue; }
    if (!state.records[key]) state.records[key] = { attempts: 0, final: false };
    valid.push({ rec, at });
  }
  save();
  for (const { rec, at } of valid) publishRecord(runKey, rec, at);
  r.done = Object.entries(state.records).filter(([k]) => k.startsWith(runKey + '|')).every(([, v]) => v.final);
  save();
}

try {
  if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.records ||= {}; state.runs ||= {};
  if (FROM_DIR) {
    // Job 2: this run's records, downloaded from job 1.
    const runKey = process.env.GITHUB_RUN_ID || 'dir';
    const dir = path.resolve(FROM_DIR);
    if (!fs.existsSync(dir) || !walk(dir).some(f => f.endsWith('.json'))) say('no ready records');
    else handleRun(runKey, dir);
  } else {
    // Workstation fallback: every non-expired ready-branches artifact of a completed run of our workflow.
    const list = [];
    for (const l of gh('api', '--paginate', `repos/${FORK}/actions/artifacts?name=ready-branches&per_page=100`, '--jq', '.artifacts[]|[.id,.expired,.created_at,.workflow_run.id]|@json').split('\n').filter(Boolean)) {
      const [id, expired, created, run] = JSON.parse(l);
      if (!expired && Date.now() - Date.parse(created) < DAYS * 864e5) list.push({ id, run });
    }
    list.sort((a, b) => a.run - b.run || a.id - b.id);
    for (const a of list) {
      const runKey = `${a.run}-${a.id}`; // one key per artifact (re-runs upload a new artifact)
      if (state.runs[runKey]?.done || state.runs[runKey]?.rejected) continue;
      const run = JSON.parse(gh('api', `repos/${FORK}/actions/runs/${a.run}`, '--jq', '{event,path,head_branch,status}'));
      if (!WF_PATHS.includes(run.path) || run.head_branch !== 'main' || !['schedule', 'workflow_dispatch'].includes(run.event)) {
        say(`SKIPPED run ${a.run}: not a pr120-cloud/pr120-attack run on main (event ${clean(run.event, 30)}, branch ${clean(run.head_branch, 60)})`);
        state.runs[runKey] = { rejected: true }; save(); continue;
      }
      if (run.status !== 'completed') continue; // job 2 has not had its chance yet
      const dir = path.join(HOME, 'runs', 'cloud-ready', runKey);
      fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      try {
        const zip = path.join(dir, 'artifact.zip');
        fs.writeFileSync(zip, execFileSync('gh', ['api', `repos/${FORK}/actions/artifacts/${a.id}/zip`], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }));
        if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir], { stdio: 'ignore' });
        else execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'ignore' });
        fs.unlinkSync(zip);
      } catch (e) { say(`RETRY run ${a.run}: artifact download failed (${clean(String(e.stderr || e.message).split('\n').filter(Boolean).pop(), 160)})`); continue; }
      handleRun(runKey, dir);
    }
    if (!list.length) say('no ready-branches artifacts');
  }
} finally {
  save();
  unlock();
}
