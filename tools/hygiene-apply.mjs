#!/usr/bin/env node
// Deterministic edit and checks for pr120-hygiene.yml (no AI anywhere in that workflow).
//
//   node tools/hygiene-apply.mjs validate <target.json>
//   node tools/hygiene-apply.mjs apply <tree> <target.json> <outdir>
//       Checks the target's line in <tree> (a clone at the tip), changes `instance` to `local instance` on it, commits,
//       and writes <outdir>/<id>.bundle, <outdir>/<id>.json (a publish-ready record) and <outdir>/Check.lean.
//       Run it as the runner BEFORE anything is built; the build sandbox gets a copy of the tree without .git.
//   node tools/hygiene-apply.mjs check-diff <repo> <record.json> <tip>
//       Refuses unless the record's base is <tip> and base..head is one commit changing exactly one line of the one
//       recorded file from `instance` to `local instance` (tools/gate-rules.mjs checkOneInstanceLine).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FILE_RE, toLocalInstance, checkOneInstanceLine, hygieneCheckText, LEAN_NAME } from './gate-rules.mjs';

const MOD_RE = /^[\p{L}\p{N}_.']+$/u;
const gitIn = dir => (...a) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...a], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const modOf = f => f.replace(/^src\//, '').replace(/\.lean$/, '').split('/').join('.');
const fail = m => { console.error(m); process.exit(1); };

function validate(t) {
  if (!t || typeof t !== 'object') return 'not an object';
  if (typeof t.module !== 'string' || !MOD_RE.test(t.module)) return 'bad module';
  if (typeof t.file !== 'string' || !FILE_RE.test(t.file) || t.file.includes('..') || modOf(t.file) !== t.module) return 'bad file';
  if (!Number.isInteger(t.line) || t.line < 1) return 'bad line';
  if (typeof t.full !== 'string' || !LEAN_NAME.test(t.full) || typeof t.cls !== 'string' || !LEAN_NAME.test(t.cls)) return 'bad name or class';
  if (typeof t.old !== 'string' || typeof t.new !== 'string' || /[\r\n]/.test(t.old + t.new)) return 'bad line text';
  if (toLocalInstance(t.old) !== t.new) return 'the change is not exactly `instance` -> `local instance`';
  if (t.check !== hygieneCheckText(t.module, t.full)) return 'the check file is not the standard one for this instance';
  return '';
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'validate') {
  const e = validate(JSON.parse(fs.readFileSync(rest[0], 'utf8'))); if (e) fail(e); console.log('ok');
} else if (cmd === 'apply') {
  const [tree, tfile, outdir] = rest;
  const t = JSON.parse(fs.readFileSync(tfile, 'utf8'));
  const e = validate(t); if (e) fail(`invalid target: ${e}`);
  const g = gitIn(tree);
  const fp = path.join(tree, t.file);
  const lines = fs.readFileSync(fp, 'utf8').split('\n');
  if (lines[t.line - 1] !== t.old) fail(`line ${t.line} of ${t.file} is not the recorded line (the file changed at the tip)`);
  lines[t.line - 1] = t.new;
  fs.writeFileSync(fp, lines.join('\n'));
  const base = g('rev-parse', 'HEAD');
  const name = process.env.GIT_NAME, email = process.env.GIT_EMAIL;
  if (!name || !email) fail('GIT_NAME and GIT_EMAIL must be set');
  g('add', '--', t.file);
  g('-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m',
    `Make redundant global ${t.cls} instance ${t.full.split('.').pop()} local\n\nThe instance is found without it from the same hypotheses (checked with inferInstance against the\nchanged module), so the global copy only adds a try to every ${t.cls} search downstream.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
  const head = g('rev-parse', 'HEAD');
  const err = checkOneInstanceLine(g, base, head); if (err) fail(err);
  const slug = t.module.split('.').slice(-2).join('-').replace(/[^A-Za-z0-9_-]/g, '');
  const target = `fix/${slug}-inst${t.line}`;
  const run = process.env.GITHUB_RUN_ID || String(Date.now()), attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  const id = `${target.slice(4)}-r${run}-${attempt}`;
  fs.mkdirSync(outdir, { recursive: true });
  g('update-ref', `refs/pr120/${id}`, head);
  try { g('bundle', 'create', path.resolve(outdir, `${id}.bundle`), `refs/pr120/${id}`, `^${base}`); }
  finally { try { g('update-ref', '-d', `refs/pr120/${id}`); } catch {} }
  const reach = Number.isInteger(t.reach) ? t.reach : 0;
  const body = `\`${t.full}\` (\`${t.file}:${t.line}\`) is a global instance of the Prop-valued class \`${t.cls}\` whose arguments are all variables. Its discrimination-tree key is all wildcards, so every \`${t.cls}\` search in the ${reach.toLocaleString('en-US')} modules that see it tries it and backchains into its hypotheses.

The same instance is found without it. With this change, this file compiles against the changed module (Lean supplies the instance's exact type, and the file opens nothing, so it sees no more instances than any module that saw the old global one):

\`\`\`lean
${t.check.trim()}
\`\`\`

So this PR changes \`instance\` to \`local instance\` on that one line. The name keeps working and it stays an instance in its own scope; since \`${t.cls}\` is a Prop, whatever instance a search finds instead is definitionally equal. No \`attribute [-instance]\` line in \`src/\` names it. Same kind of change as #1423.

Not built: the modules downstream. They now reach \`${t.cls}\` through the route the check found, which may be a longer search.
`;
  const title = `Make redundant global ${t.cls} instance ${t.full.split('.').pop()} local (${t.module.split('.').slice(-2).join('.')})`;
  const rec = { id, target, title, files: [t.file], head, base, bundle: `${id}.bundle`, body, time: new Date().toISOString(), run, attempt, module: t.module, line: t.line };
  fs.writeFileSync(path.join(outdir, `${id}.json`), JSON.stringify(rec, null, 1));
  fs.writeFileSync(path.join(outdir, 'Check.lean'), t.check);
  console.log(id);
} else if (cmd === 'check-diff') {
  const [repo, recFile, tip] = rest;
  const r = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(r.base || '') || !/^[0-9a-f]{40}$/.test(r.head || '') || !Array.isArray(r.files) || r.files.length !== 1) fail('bad record');
  if (!/^[0-9a-f]{40}$/.test(tip || '') || r.base !== tip) fail('refusing: the record is not based on the selected tip');
  const g = gitIn(repo);
  const err = checkOneInstanceLine(g, r.base, r.head); if (err) fail(err);
  if (g('diff', '--name-only', r.base, r.head) !== r.files[0]) fail('refusing: the change is not in the recorded file');
  console.log('hygiene diff ok');
} else fail('usage: hygiene-apply.mjs validate|apply|check-diff ...');
