// Turn a candidates file (from a shadow-scan shard) into fast-fix workflow args.
//   node tools/scan-args.cjs runs/scanN-candidates.json <firstTreeNumber> <label> > runs/scanN-args.json
// candidates: [{file, orig:[...], toks:[...], lines:[...]}]
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const HOME = path.resolve(__dirname, '..');
const [, , inFile, firstTree, label] = process.argv;
const c = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const BASE = execFileSync('git', ['-C', path.join(HOME, 'riemann-hypothesis'), 'rev-parse', '--short', 'origin/opt/collapse-and-consolidate-4.36']).toString().trim();
const HINT = [
  'Verify before editing:',
  '(1) the use is a real reference to a global name, not a binder, local, field or named argument;',
  '(2) `node tools/rh.mjs resolve` on the ORIGINAL module shows which declaration the name meant on main;',
  '(3) `node tools/rh.mjs closure <module> --rev branch --has <module declaring the capturing name>` shows the capture is visible on the branch, and the same check on main shows it was not.',
  'If all three hold, qualify EVERY affected use in this file to the original declaration.',
  'Use `_root_.<full name>` where an enclosing namespace would capture a partial qualification, as in the merged TmLev PRs #757/#759/#787 for CMType/cech/twist.',
  'Inside `namespace A`, a declaration written `def A.x` is named `A.A.x`, so a doubled name like `GlobalTheory.CompanionTheory.Ar.GlobalTheory.CompanionTheory.Ar.dualMap` can really exist; check with git grep.',
  'Also check git log on the file and the PR120-BUGS.md history so you are not redoing a fix that already landed.',
  'If it is not a real capture, report no-defensible-fix.',
  'One file = one PR. Never add sorry, never change a statement.',
].join(' ');
const rows = c.map((o, i) => ({
  tree: `w${+firstTree + i}`, createTree: !fs.existsSync(path.join(HOME, 'wt', `w${+firstTree + i}`)),
  file: o.file, line: o.lines[0], category: 'scanner',
  error: `Static scanner finding at branch tip ${BASE}. This is not a PR120-BUGS.md row: the module is blocked behind other failures, so no build has reached it yet. Enclosing-namespace capture (playbook Pattern 1) at line(s) ${o.lines.join(', ')}: ${o.toks.join('; ')}. On main, the original module (${o.orig.join(', ')}) saw no declaration with that name in its enclosing namespaces, so there the name resolved through an open or the root.`,
  lineNow: '', hint: HINT,
}));
process.stdout.write(JSON.stringify({ home: HOME.replace(/\\/g, '/'), listTime: `${label} at ${BASE}`, rows }));
