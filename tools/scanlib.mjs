// Shared loaders for the batch scanners (tools/shadow-scan.mjs). Read-only: local git objects + one gh call.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.join(HOME, 'riemann-hypothesis');
export const BASE = 'origin/opt/collapse-and-consolidate-4.36';
export const MAIN = 'c7791603122c0328f79e49f6be5d7d4402effc53';
export const CACHE = path.join(HOME, 'runs', 'scan-cache');
fs.mkdirSync(CACHE, { recursive: true });

export const git = (...a) => execFileSync('git', ['-C', REPO, '-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 1 << 30 });
export const pathToMod = p => p.replace(/^src\//, '').replace(/\.lean$/, '').split('/').join('.');
export const modToPath = m => 'src/' + m.replace(/[«»]/g, '').split('.').join('/') + '.lean';
export const say = s => process.stderr.write(s + '\n');

// Stream many blobs through one `git cat-file --batch`; calls onFile(path, text) for each.
export function catStream(rev, paths, onFile) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['-C', REPO, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = Buffer.alloc(0), i = 0, want = -1, header = '';
    p.stdout.on('data', chunk => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (want < 0) {
          const nl = buf.indexOf(10); if (nl < 0) break;
          header = buf.subarray(0, nl).toString('utf8'); buf = buf.subarray(nl + 1);
          const m = header.match(/ blob (\d+)$/);
          if (!m) { onFile(paths[i++], null); continue; }
          want = +m[1];
        }
        if (buf.length < want + 1) break;
        onFile(paths[i++], buf.subarray(0, want).toString('utf8'));
        buf = buf.subarray(want + 1); want = -1;
      }
    });
    p.on('close', code => (code ? reject(new Error('cat-file exit ' + code)) : resolve()));
    p.stdin.on('error', () => {});
    for (const x of paths) p.stdin.write(`${rev}:${x}\n`);
    p.stdin.end();
  });
}

export function parseHeader(text) {
  const imports = []; let isModule = false, inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (inBlock) { if (line.includes('-/')) inBlock = false; continue; }
    if (line.startsWith('/-')) { if (!line.includes('-/')) inBlock = true; continue; }
    if (line === '' || line.startsWith('--') || line === 'prelude') continue;
    if (line === 'module') { isModule = true; continue; }
    const m = line.match(/^((?:(?:public|private|meta)\s+)*)import\s+(?:all\s+)?(\S+)/);
    if (!m) break;
    imports.push({ mod: m[2].replace(/[«»]/g, ''), pub: /\bpublic\b/.test(m[1]) });
  }
  return { isModule, imports };
}

// Import graph of a revision from `git grep` on import lines (fast; no full reads). Cached per rev.
export function importGraph(rev) {
  const cf = path.join(CACHE, `graph-${rev.replace(/[^\w]/g, '_').slice(-40)}-${git('rev-parse', '--short', rev).trim()}.json`);
  if (fs.existsSync(cf)) return JSON.parse(fs.readFileSync(cf, 'utf8'));
  const out = git('grep', '-n', '-E', '^(public |private |meta )*import ', rev, '--', 'src');
  const graph = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^[^:]+:(src\/[^:]+\.lean):(\d+):(.*)$/); if (!m) continue;
    const h = m[3].match(/^((?:(?:public|private|meta)\s+)*)import\s+(?:all\s+)?(\S+)/); if (!h) continue;
    const mod = pathToMod(m[1]);
    (graph[mod] ||= { imports: [], isModule: false }).imports.push({ mod: h[2].replace(/[«»]/g, ''), pub: /\bpublic\b/.test(h[1]) });
  }
  let mods = '';
  try { mods = git('grep', '-l', '-E', '^module$', rev, '--', 'src'); } catch {}
  for (const line of mods.split('\n')) { const m = line.match(/^[^:]+:(src\/.+\.lean)$/); if (m && graph[pathToMod(m[1])]) graph[pathToMod(m[1])].isModule = true; }
  for (const p of git('ls-tree', '-r', '--name-only', rev, '--', 'src').split('\n')) if (p.endsWith('.lean')) graph[pathToMod(p)] ||= { imports: [], isModule: false };
  fs.writeFileSync(cf, JSON.stringify(graph));
  return graph;
}

// Modules whose declarations `root` sees: past the root, only public imports of `module` files re-export.
export function closureOf(graph, root) {
  const seen = new Set([root]); const stack = [root];
  while (stack.length) {
    const m = stack.pop(); const g = graph[m]; if (!g) continue;
    for (const imp of g.imports) {
      if (m !== root && g.isModule && !imp.pub) continue;
      if (!seen.has(imp.mod) && graph[imp.mod]) { seen.add(imp.mod); stack.push(imp.mod); }
    }
  }
  return seen;
}

// Modules that cannot compile while `failing` modules fail: everything importing them, through any edge.
export function blockedBy(graph, failing) {
  const rev = {};
  for (const [m, g] of Object.entries(graph)) for (const imp of g.imports) (rev[imp.mod] ||= []).push(m);
  const out = new Set(failing); const stack = [...failing];
  while (stack.length) { const m = stack.pop(); for (const r of rev[m] || []) if (!out.has(r)) { out.add(r); stack.push(r); } }
  return out;
}

export function failingFromList() {
  const md = execFileSync('gh', ['api', 'repos/rohanarun/alpoge-rh-replay/contents/PR120-BUGS.md', '-H', 'Accept: application/vnd.github.raw'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const files = new Set();
  for (const m of md.matchAll(/^\|\s*`([^`]+?\.lean):\d+`/gm)) files.add('src/' + m[1].replace(/^src\//, ''));
  return { md, files: [...files] };
}
