# PR #120 fixer toolkit (`automation` branch)

This branch holds tools and agent instructions that help fix compile failures on `rohanarun/riemann-hypothesis:opt/collapse-and-consolidate-4.36` (PR #120), following https://github.com/rohanarun/alpoge-rh-replay.

It is an orphan branch: it shares no history with the Lean project, so nothing here can leak into a fix PR.

## How the work is split
- **Cloud (`.github/workflows/pr120-cloud.yml`, GitHub Actions + Claude Code):** watching, scanning, parity checks, diagnosis, fixes and verification.
  - Each ready fix is written as a git bundle plus a record and uploaded in the run's `ready-branches` artifact. The AI job has read-only access and pushes nothing.
  - The cloud never opens, edits or comments on PRs or issues. It runs with GitHub's short-lived job token, which can write only to this fork.
- **Cloud publish job (job 2, no AI, fresh runner):** right after the AI job it downloads the ready records, makes a fresh partial clone and opens the PRs with `PR120_PAT` via `tools/publish-ready.mjs --from-dir`. The PAT exists only in this job.
- **Workstation fallback (`tools/publish-ready.mjs`, started by `tools/local-loop.sh`):** once a run has finished, it publishes any record that still has no open PR, for example when job 2 failed or the PAT is missing.
- Both publishers go through `claim.mjs publish`. That step rebases onto the fresh tip and refuses landed changes, protected files, renames, banned keywords and files other people's open PRs touch. The workstation also reports progress (`tools/status.mjs`).

## Contents
| Path | What it does |
|---|---|
| `tools/rh.mjs` | Read-only helper: `show`, `marker` (bundle → original module), `resolve` (name resolution vs main), `closure` / `--has`, `newinst` (newly visible instances), `worktree`, `start`, `guard`. |
| `tools/claim.mjs` | `check <files>` lists open PRs that touch the files. `publish wt/<tree>` rebases and checks; in the AI job it then writes a bundle and a record, and the publisher pushes `fix/<leaf>` and opens the PR. |
| `tools/publish-ready.mjs`, `tools/local-loop.sh` | Publishing: job 2 in the cloud, the workstation as fallback. `local-loop.sh` also starts cloud runs and reports. |
| `tools/prep.mjs`, `tools/lookahead.mjs`, `tools/combined-prep.mjs`, `tools/section-stale.mjs`, `tools/first-seen.mjs` | Pick free rows from PR120-BUGS.md (Open and Look-ahead tables) and judge staleness. |
| `tools/precedent.mjs` | Ranks merged fixes against an error text (`--file` keeps upstream text off the command line). |
| `tools/shadow-scan.mjs`, `tools/scanlib.mjs`, `tools/scan-shards.sh`, `tools/scan-triage.mjs`, `tools/scan-verdicts.json`, `tools/scan-args.cjs` | Static scan for enclosing-namespace name captures in blocked modules, triage, and remembered verdicts. |
| `tools/disable-parity.mjs`, `tools/open-parity.mjs`, `tools/overdisable-audit.mjs` | Lines an original module has on main (instance attributes, opens) that its section at the tip lost. |
| `tools/fast-fix.workflow.js` | The parallel fixer and skeptic pipeline, for Claude Code's Workflow tool on a workstation. |
| `tools/bootstrap.sh` | Prepares a fresh Linux runner: sparse clone, the main commit, remotes, git identity, gh auth. |
| `CLAUDE.md`, `CLOUD.md`, `.claude/agents/pr120-fixer.md` | Rules and step-by-step instructions for the agents. |

## Enabling the cloud workflow (fork owner, once)
1. **Enable Actions** on the fork (Actions tab).
2. **Add the Claude secret.** Use `CLAUDE_CODE_OAUTH_TOKEN` (your Claude subscription; run `claude setup-token` and paste the token) or `ANTHROPIC_API_KEY`.
   - Safest: create an environment `pr120` (Settings → Environments), limit its deployment branches to `main`, and put the secret there instead of in repository secrets. Workflows from other branches, such as the upstream `checks` workflow running on pushed fix branches, then cannot read it.
   - `PR120_PAT` (classic PAT, `public_repo`) is used only by the publish job to open PRs on `rohanarun/riemann-hypothesis`. The AI job never sees it. Put it in the `pr120` environment too.
3. **Keep a copy of `.github/workflows/pr120-cloud.yml` on the default branch** (`schedule` only fires there; it checks out `automation` for the tools).
4. **Test it.** Actions → pr120-cloud → Run workflow → mode `selftest` (one short Claude reply), then `fix`, `scan` or `check`.

Run state (`runs/`, including the processed-rows list) and the clone persist between runs through the Actions cache.

## Rules the agents follow
- Never touch the protected files, never add `sorry`, `axiom` and the like, never change statements.
- Never push to upstream; the AI job pushes nothing at all (read-only token).
- Never open or touch PRs or issues from the cloud; never publish a fix for a file someone else's open PR touches.

`CLAUDE.md` has the full list.
