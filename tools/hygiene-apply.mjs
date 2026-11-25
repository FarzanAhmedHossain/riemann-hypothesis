#!/usr/bin/env node
// Deterministic edit and checks for pr120-hygiene.yml (no AI anywhere in that workflow).
//
//   node tools/hygiene-apply.mjs apply <tree> <target.json> <outdir>
//       Checks the target's line in <tree> (a clone at the tip), changes `instance` to `local instance` on it, commits,
//       and writes <outdir>/<id>.bundle + <outdir>/<id>.json (a publish-ready record) and <tree>/.pr120-hygiene/Check.lean.
//       Run it as the runner BEFORE the build sandbox gets the tree; the bundle and record live outside the tree.
//   node tools/hygiene-apply.mjs check-diff <repo> <record.json>
//       Refuses unless base..head changes exactly one line of the one recorded file, and only by inserting `local `
//       before that line's `instance` keyword.
//   node tools/hygiene-apply.mjs validate <target.json>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const INST = /^(\s*(?:@\[[^\]]*\]\s*)?(?:(?:noncomputable|protected|nonrec)\s+)*)instance\b/;
const MOD_RE = /^[\p{L}\p{N}_.']+$/u, FILE_RE = /^src\/[A-Za-z0-9_./-]+\.lean$/;
const expectedNew = old => { const m = old.match(INST); return m ? old.slice(0, m[1].length) + 'local ' + old.slice(m[1].length) : null; };
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const modOf = f => f.replace(/^src\//, '').replace(/\.lean$/, '').split('/').join('.');
const fail = m => { console.error(m); process.exit(1); };

function validate(t) {
  if (!t || typeof t !== 'object') return 'not an object';
  if (typeof t.module !== 'string' || !MOD_RE.test(t.module)) return 'bad module';
  if (typeof t.file !== 'string' || !FILE_RE.test(t.file) || t.file.includes('..') || modOf(t.file) !== t.module) return 'bad file';
  if (!Number.isInteger(t.line) || t.line < 1) return 'bad line';
  if (typeof t.old !== 'string' || typeof t.new !== 'string' || /[\r\n]/.test(t.old + t.new)) return 'bad line text';
  if (expectedNew(t.old) !== t.new) return 'the change is not exactly `instance` -> `local instance`';
  if (typeof t.check !== 'string' || t.check.length > 4000 || !t.check.startsWith(`import ${t.module}\n`)) return 'bad check file';
  // The check file may only import the module, set the two auto-implicit options, declare universes and state one example.
  const lines = t.check.split('\n').filter(l => l.trim());
  const okLine = l => l === `import ${t.module}` || /^set_option (autoImplicit|relaxedAutoImplicit) false$/.test(l) || /^universe [\p{L}\p{N}_' ]+$/u.test(l)
    || (/^example .* := inferInstance$/u.test(l) && !/\b(instance|attribute|local|scoped|haveI|letI|sorry|axiom|by|open|import|set_option|#)\b/.test(l.replace(/:= inferInstance$/, '')));
  if (!lines.every(okLine) || lines.filter(l => l.startsWith('example ')).length !== 1) return 'check file has something other than import, options, universes and one example';
  return '';
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'validate') {
  const e = validate(JSON.parse(fs.readFileSync(rest[0], 'utf8'))); if (e) fail(e); console.log('ok');
} else if (cmd === 'apply') {
  const [tree, tfile, outdir] = rest;
  const t = JSON.parse(fs.readFileSync(tfile, 'utf8'));
  const e = validate(t); if (e) fail(`invalid target: ${e}`);
  const fp = path.join(tree, t.file);
  const text = fs.readFileSync(fp, 'utf8');
  const lines = text.split('\n');
  if (lines[t.line - 1] !== t.old) fail(`line ${t.line} of ${t.file} is not the recorded line (the file changed at the tip)`);
  lines[t.line - 1] = t.new;
  fs.writeFileSync(fp, lines.join('\n'));
  const base = git(tree, 'rev-parse', 'HEAD');
  const name = process.env.GIT_NAME, email = process.env.GIT_EMAIL;
  if (!name || !email) fail('GIT_NAME and GIT_EMAIL must be set');
  const what = t.name ? `\`${t.name}\`` : `the \`${t.cls}\` instance`;
  git(tree, 'add', '--', t.file);
  git(tree, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m',
    `Make redundant global ${t.cls} instance ${t.name || ''} local in ${t.module.split('.').pop()}`.replace(/\s+/g, ' ') +
    `\n\n${what} is found without it from the same hypotheses (checked with inferInstance against the changed module),\nso the global copy only adds a try to every ${t.cls} search downstream.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
  const head = git(tree, 'rev-parse', 'HEAD');
  const slug = t.module.split('.').slice(-2).join('-').replace(/[^A-Za-z0-9_-]/g, '');
  const target = `fix/${slug}-inst${t.line}`;
  const run = process.env.GITHUB_RUN_ID || String(Date.now()), attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  const id = `${target.slice(4)}-r${run}-${attempt}`;
  fs.mkdirSync(outdir, { recursive: true });
  git(tree, 'update-ref', `refs/pr120/${id}`, head);
  try { git(tree, 'bundle', 'create', path.resolve(outdir, `${id}.bundle`), `refs/pr120/${id}`, `^${base}`); }
  finally { try { git(tree, 'update-ref', '-d', `refs/pr120/${id}`); } catch {} }
  const reach = Number.isInteger(t.reach) ? t.reach : 0;
  const canon = t.canonical && FILE_RE.test(t.canonical.file || '') && Number.isInteger(t.canonical.line)
    ? `\nAnother copy of the same instance is ${t.canonical.name ? `\`${t.canonical.name}\` ` : ''}in \`${t.canonical.file}:${t.canonical.line}\`, which \`${t.module}\` re-exports.\n` : '';
  const body = `${what} (\`${t.file}:${t.line}\`) is a global instance of the Prop-valued class \`${t.cls}\` whose arguments are all variables. Its discrimination-tree key is all wildcards, so every \`${t.cls}\` search in the ${reach.toLocaleString('en-US')} modules that see it tries it and backchains into its hypotheses.

The same instance is found without it. With this change, this file compiles against the changed module. It opens no namespace, so it sees no more instances than any module that saw the old global one:

\`\`\`lean
${t.check.trim()}
\`\`\`

So this PR changes \`instance\` to \`local instance\` on that one line. The name keeps working, the instance stays available in its own scope, and since \`${t.cls}\` is a Prop, whatever instance a search finds instead is definitionally equal. It is the same kind of change as #1423.
${canon}`;
  const title = `Make redundant global ${t.cls} instance ${t.name || ''} local (${t.module.split('.').slice(-2).join('.')})`.replace(/\s+/g, ' ');
  const rec = { id, target, title, files: [t.file], head, base, bundle: `${id}.bundle`, body, time: new Date().toISOString(), run, attempt, module: t.module, line: t.line };
  fs.writeFileSync(path.join(outdir, `${id}.json`), JSON.stringify(rec, null, 1));
  fs.mkdirSync(path.join(tree, '.pr120-hygiene'), { recursive: true });
  fs.writeFileSync(path.join(tree, '.pr120-hygiene', 'Check.lean'), t.check);
  console.log(id);
} else if (cmd === 'check-diff') {
  const [repo, recFile] = rest;
  const r = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(r.base || '') || !/^[0-9a-f]{40}$/.test(r.head || '') || !Array.isArray(r.files) || r.files.length !== 1) fail('bad record');
  const files = git(repo, 'diff', '--name-only', '--no-renames', r.base, r.head).split('\n').filter(Boolean);
  if (files.length !== 1 || files[0] !== r.files[0]) fail(`refusing: the change touches ${files.join(', ')}`);
  const hunks = git(repo, 'diff', '-U0', '--no-color', '--no-renames', r.base, r.head, '--', r.files[0]).split('\n');
  const minus = hunks.filter(l => l.startsWith('-') && !l.startsWith('---')), plus = hunks.filter(l => l.startsWith('+') && !l.startsWith('+++'));
  if (minus.length !== 1 || plus.length !== 1 || expectedNew(minus[0].slice(1)) !== plus[0].slice(1)) fail('refusing: not exactly one `instance` -> `local instance` line');
  console.log('hygiene diff ok');
} else fail('usage: hygiene-apply.mjs apply|check-diff|validate ...');
