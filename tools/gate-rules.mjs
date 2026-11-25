// Content rules every published fix must pass (claim.mjs publish, and tools/diff-gate.mjs before a fix is built).
import { execFileSync } from 'node:child_process';

export const PROTECTED = /^(src\/(Challenge|Statements)\.lean|comparator\.json|lakefile.*|lean-toolchain|lake-manifest\.json)$/;
export const FILE_RE = /^src\/[A-Za-z0-9_./-]+\.lean$/;
// Forbidden in added text, checked on the joined added text (multi-line attributes included):
// - the project's rules: no sorry, axioms, unsafe, native_decide, implemented_by, extern;
// - code that runs at elaboration or build time, or changes how Lean reads the file. A fix to a build error never
//   needs it, and it could hide errors from a build (an elaborator that swallows them).
export const BANNED = new RegExp([
  String.raw`\b(sorry|sorryAx|admit|admitGoal|axiom|unsafe|native_decide|implemented_by|initialize|builtin_initialize)\b`,
  String.raw`(@\[|\battribute\s*\[)[^\]]*\b(extern|init|builtin_init|command_elab|term_elab|tactic|macro|builtin_command_elab|builtin_term_elab|builtin_tactic|code_action_provider|env_linter)\b`,
  String.raw`#eval|#exit|#print\s+axioms|\brun_cmd\b|\brun_tac\b|\brun_elab\b|\brun_meta\b`,
  String.raw`(^|\n)\s*(local\s+|scoped\s+)?(elab|elab_rules|macro|macro_rules|syntax|declare_syntax_cat|notation\d*|infix[lr]?|prefix|postfix|binder_predicate|declare_simp_like_tactic)\b`,
  String.raw`\bLean\.Elab\b|\bLean\.Meta\b|\bIO\.|\bunsafeCast\b|debug\.skipKernelTC|Lean\.ofReduceBool|Lean\.trustCompiler`,
].join('|'));

// Check the change from base to head in a git repository. Returns {files, error}: error is '' when it passes.
// expect: optional list of the files the change must touch exactly.
export function checkDiff(repoDir, base, head, expect) {
  const g = (...a) => execFileSync('git', ['-C', repoDir, '-c', 'core.quotepath=false', '-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const raw = g('diff', '--raw', '--no-renames', '--no-abbrev', base, head).split('\n').filter(Boolean).map(l => {
    const m = l.match(/^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*\t(.+)$/);
    return m ? { mode: m[2], s: m[3], f: m[4] } : { s: '?', f: l };
  });
  const files = raw.map(x => x.f);
  if (!files.length) return { files, error: 'nothing to publish: no diff' };
  const bad = raw.filter(x => !['M', 'A'].includes(x.s) || x.mode !== '100644' || !FILE_RE.test(x.f) || x.f.includes('..') || PROTECTED.test(x.f));
  if (bad.length) return { files, error: `refusing: diff ${bad.map(x => `${x.s} ${x.mode || ''} ${x.f}`).join(', ')} (only modified or added regular src/**/*.lean files outside the protected ones)` };
  if (expect && expect.slice().sort().join(',') !== files.slice().sort().join(',')) return { files, error: `refusing: the change touches ${files.join(', ')}, not the recorded files` };
  const added = []; let inHunk = false;
  for (const l of g('diff', '--text', '-U0', '--no-renames', '--no-color', base, head).split('\n')) {
    if (l.startsWith('diff --git ')) { inHunk = false; continue; }
    if (l.startsWith('@@')) { inHunk = true; continue; }
    if (inHunk && l.startsWith('+')) added.push(l.slice(1));
    if (!inHunk && /^Binary files /.test(l)) return { files, error: 'refusing: binary change' };
  }
  const hit = added.join('\n').match(BANNED);
  if (hit) return { files, error: `refusing: added text contains a forbidden construct (${hit[0].trim().slice(0, 40)})` };
  return { files, error: '' };
}
