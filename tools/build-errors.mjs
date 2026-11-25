#!/usr/bin/env node
// Turns a `lake build <Module>` log into a JSON verdict for one target module.
//
//   node tools/build-errors.mjs <build.log> <Module> <exit code> > verdict.json
//
// Output: {module, file, status, errors:[{file,line,col,text}], depFailures:[files], built}
//   status: ok           the target compiled (the listed row is stale at this tip)
//           failed       the target itself has errors; `errors` holds Lean's FULL messages for it
//           dep-failed   only modules it imports failed; the target is blocked, not broken
//           timeout      the build hit the time limit (exit code 124)
//           unknown      the build failed without any error lines that could be parsed
import fs from 'node:fs';

const [logFile, mod, codeArg] = process.argv.slice(2);
const code = +codeArg;
const file = 'src/' + mod.split('.').join('/') + '.lean';
const lines = fs.readFileSync(logFile, 'utf8').replace(/\r/g, '').split('\n');
const errors = [];
let cur = null;
const START = /^(?:.*?\s)?(error|warning|info): (?:\.\/)?((?:src\/)?[^\s:]+\.lean):(\d+):(\d+): ?(.*)$/;
const BOUNDARY = /^(?:✔|✖|⚠|info:|warning:|error:|Build completed|Some required builds|\s*\[\d+\/\d+\])/;
for (const l of lines) {
  const m = l.match(START);
  if (m) {
    if (cur) errors.push(cur);
    cur = m[1] === 'error' ? { file: m[2].startsWith('src/') ? m[2] : 'src/' + m[2], line: +m[3], col: +m[4], text: m[5] } : null;
    continue;
  }
  if (BOUNDARY.test(l)) { if (cur) errors.push(cur); cur = null; continue; }
  if (cur && cur.text.length < 6000) cur.text += '\n' + l;
}
if (cur) errors.push(cur);
const own = errors.filter(e => e.file === file).map(e => ({ ...e, text: e.text.trim().slice(0, 6000) }));
const dep = [...new Set(errors.filter(e => e.file !== file).map(e => e.file))];
const built = lines.filter(l => /Built /.test(l)).length;
let status;
if (code === 0) status = 'ok';
else if (code === 124) status = 'timeout';
else if (own.length) status = 'failed';
else if (dep.length) status = 'dep-failed';
else status = 'unknown';
process.stdout.write(JSON.stringify({ module: mod, file, status, errors: own.slice(0, 20), depFailures: dep.slice(0, 20), built }, null, 1));
