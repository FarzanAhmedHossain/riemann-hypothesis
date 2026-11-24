# PR #120 fixer toolkit (`automation` branch)

This branch holds tools and agent instructions that help fix compile failures on `rohanarun/riemann-hypothesis:opt/collapse-and-consolidate-4.36` (PR #120), following https://github.com/rohanarun/alpoge-rh-replay.

It is an orphan branch: it shares no history with the Lean project, so nothing here can leak into a fix PR.

## Contents
| Path | What it does |
|---|---|
| `tools/rh.mjs` | Read-only helper: `show`, `marker` (bundle → original module), `resolve` (name resolution vs main), `closure` / `--has`, `newinst` (newly visible instances), `worktree`, `start`, `guard`. |
| `tools/claim.mjs` | `check <files>` (does any open PR touch these files?) and `publish wt/<tree>` (rebase, refuse duplicates or landed changes, push to the fork, open a ready PR). |
| `tools/prep.mjs`, `tools/lookahead.mjs`, `tools/combined-prep.mjs` | Pick free rows from PR120-BUGS.md (Open and Look-ahead tables). |
| `tools/precedent.mjs` | Ranks merged fixes against an error text. |
| `tools/shadow-scan.mjs`, `tools/scanlib.mjs`, `tools/scan-shards.sh`, `tools/scan-args.cjs` | Static scan for enclosing-namespace name captures (playbook Pattern 1) in modules blocked behind failures. |
| `tools/fast-fix.workflow.js` | The parallel fixer and skeptic pipeline, for Claude Code's Workflow tool on a workstation. |
| `tools/bootstrap.sh` | Prepares a fresh Linux runner: sparse clone, the main commit, remotes, git identity, gh auth. |
| `CLAUDE.md`, `CLOUD.md`, `.claude/agents/pr120-fixer.md` | Rules and step-by-step instructions for the agents. |
| `.github/workflows/pr120-cloud.yml` | The GitHub Actions workflow. |

## Enabling the cloud workflow (fork owner, once)
1. **Enable Actions.** On the fork, open the Actions tab and enable workflows. Forks start with them disabled.
2. **Add the secrets.** Under Settings → Secrets and variables → Actions → New repository secret, add:
   - Either `ANTHROPIC_API_KEY` (an Anthropic Console API key; usage bills to it), or `CLAUDE_CODE_OAUTH_TOKEN`. The OAuth token uses your Claude subscription instead: run `claude setup-token` once in a terminal and paste the printed token.
   - `PR120_PAT`: a classic personal access token with the `public_repo` scope. It is needed to push fix branches to this fork and to open PRs on `rohanarun/riemann-hypothesis`. The built-in `GITHUB_TOKEN` cannot open PRs on another repository.
3. **Make it schedulable.** GitHub runs `schedule` triggers only from the default branch. Pick one:
   - set `automation` as the fork's default branch (Settings → General → Default branch), or
   - copy `.github/workflows/pr120-cloud.yml` to the fork's current default branch. It always checks out `automation` for the tools.
4. **Test it.** Actions → pr120-cloud → Run workflow, with mode `fix` or `scan`.

Run state (`runs/`, including the processed-rows list and caches) and the clone persist between runs through the Actions cache.

## Rules the agents follow
- Never touch the protected files, and never add `sorry`, `axiom` and the like.
- Never change statements, and never push to upstream.
- Never open a PR for a file someone else's open PR touches.

`CLAUDE.md` has the full list.
