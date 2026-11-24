# One automated run (GitHub Actions)

The workflow runs `tools/bootstrap.sh`, prepares work, and then asks Claude Code to follow this file with `MODE=fix` or `MODE=scan`. The rules in `CLAUDE.md` bind every step. Run Bash commands from the repository root.

At the end, append a short report to `$GITHUB_STEP_SUMMARY`: each row or file, what you did, and the PR number if you published.

**This is a non-interactive run: it ends when your turn ends, and any agent still running is killed.**
- Never start subagents in the background, never schedule follow-ups, and never end a turn saying you will check back later.
- To run several subagents in parallel, send their Agent calls in one message, without `run_in_background`, so they run in the foreground. That message returns only when all of them have finished.
- Publish or verify each result, and write the final report. Only then finish.
- On 2026-11-24 a run launched 8 fixers in the background and ended its turn, so nothing was published.

## MODE=fix: rows in `runs/fast-args.json`
The workflow already ran `node tools/combined-prep.mjs --max 6 > runs/fast-args.json`. That picked PR120-BUGS.md rows that:
- no open PR touches,
- have no commit since the oldest scratch-session head,
- this automation has not processed before.

Each row is `{tree, createTree, file, line, category, error, lineNow, hint}`.

### 1. Fix
Start one `pr120-fixer` subagent per row, all in parallel with the Agent tool. Give each one its row and these instructions:
- **Tree:** work only in `wt/<tree>`, and create it with `node tools/rh.mjs worktree <tree>` if `createTree` is true. Prefix every helper call with `RH_REPO=wt/<tree>`.
- **Precedent:** run `node tools/precedent.mjs "<error text>"` first.
- **Staleness:**
  1. If a commit after `f941065836` already addressed the reported line or its section, return already-fixed.
  2. For look-ahead rows, also check the PR120-BUGS.md history (`gh api "repos/rohanarun/alpoge-rh-replay/commits?path=PR120-BUGS.md&per_page=40"`, then each version with `gh api "repos/rohanarun/alpoge-rh-replay/contents/PR120-BUGS.md?ref=<sha>" -H "Accept: application/vnd.github.raw"`).
  3. A row that appears only while an old session head is listed, and vanishes once fresh sessions cover all four shards, is stale: the current code compiles. On 2026-11-24 this check would have prevented a regression (#1089, restored by #1090).
- **Diagnose and commit:** diagnose per `.claude/agents/pr120-fixer.md`, then commit after `RH_REPO=wt/<tree> node tools/rh.mjs start <file>`. The message is "Fix <Module>: <what>" with a body giving the original error, the original module and why. Then run `RH_REPO=wt/<tree> node tools/rh.mjs guard`.
- **PR text:** write `runs/<Parent-Leaf>/PR.md` with the original error verbatim, the original module, the evidence, a one-sentence diff and "Not built locally; relying on the coordinator's build.". End it with the Claude Code line.
- **Confidence:** each fixer reports HIGH, MEDIUM or no-defensible-fix.
  - HIGH requires one of:
    - (a) a name fix where the original's resolution is determined, the capture is shown with `closure --has` on the branch but not on main, and every affected use in the section is qualified;
    - (a2) a name fix identical in shape to a merged precedent for the same capture;
    - (b) an instance fix whose culprit `closure --has` shows was not in the original's closure, and whose shape matches a merged precedent.

### 2. Publish
- **HIGH:** run `node tools/claim.mjs publish wt/<tree>`. It rebases onto the fresh tip, refuses changes that already landed or that someone else's open PR touches, and opens a ready PR.
- **MEDIUM:** start two skeptic subagents in parallel. Both work read-only and try to refute the fix.
  - Diagnosis lens: re-derive the diagnosis independently. Does the change restore what the original saw on main and clear the error?
  - Safety lens: are protected files untouched, no banned keywords added, no statement changed, all names existing and reachable, and the change minimal?
  - Publish only if both say valid.
- **no-defensible-fix:** publish nothing, and report what was found.

## MODE=scan: static name-capture scan of blocked modules
1. The workflow has already run the scanner on the current tip (`bash tools/scan-shards.sh 8 6000 101 101`, a step before yours). Do not run it again: your commands time out long before 8 shards finish. Load `runs/shadow-findings-blocked.json`, the "replaced" findings. Skip `runs/shadow-findings-blocked-added.json` unless asked: it only flags possible overloads.
2. Group findings by file. Drop the known false-positive patterns:
   - bound variables, including untyped `{a b}` binders and names bound by `∀`, `∃` or `fun`;
   - structure-field assignments (`field args := …`);
   - named arguments `(x := …)`.
3. Check the survivors with `node tools/claim.mjs check <files…>`, and drop files that anyone's open PR touches or that changed in the last 3 hours (`git -C riemann-hypothesis log --since=3.hours origin/opt/collapse-and-consolidate-4.36 -- <file>`).
4. Use `node tools/scan-args.cjs <candidates.json> 1 "scanner"` to turn up to 8 files into rows. Its input is `[{file, orig:[…], toks:[…], lines:[…]}]`. Then fix and publish them exactly as in MODE=fix.

A fixer for a scanner row must confirm the capture before editing:
- the use is a global reference;
- `resolve` on the original module names its declaration on main;
- `closure --has` shows the capturing module is visible on the branch but was not on main.

If any of these fails, it reports no-defensible-fix.
