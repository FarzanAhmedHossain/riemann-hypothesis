#!/usr/bin/env bash
# Prepare a fresh runner (GitHub Actions, Linux) for the PR #120 tools:
#   - riemann-hypothesis/: full-history clone of the work branch, sparse checkout (README only; tools read
#     files with `git show`), plus the fixed "main" commit the original modules are compared against;
#   - remotes: origin = upstream (read only), fork = FORK_REPO (push target for fix branches);
#   - git identity = the account's GitHub noreply address; gh auth from GH_TOKEN.
# Idempotent: with a restored cache it only fetches.
# Env: GH_TOKEN (classic PAT, public_repo scope), FORK_REPO (owner/name), GIT_NAME, GIT_EMAIL.
set -euo pipefail
cd "$(dirname "$0")/.."
UPSTREAM=https://github.com/rohanarun/riemann-hypothesis.git
BRANCH=opt/collapse-and-consolidate-4.36
MAIN_REV=c7791603122c0328f79e49f6be5d7d4402effc53
: "${FORK_REPO:?set FORK_REPO=owner/riemann-hypothesis}"

# PUBLISH_ONLY=1 (the cloud publish job): a fresh partial clone (no file contents until needed, 3 days of
# history), no main commit. It never reuses a cache or a directory another step could have touched.
if [ "${PUBLISH_ONLY:-}" = "1" ]; then
  rm -rf riemann-hypothesis wt
  git clone --quiet --filter=blob:none --shallow-since="4 days ago" --no-checkout --single-branch --branch "$BRANCH" "$UPSTREAM" riemann-hypothesis
  git -C riemann-hypothesis config core.hooksPath /dev/null
  git -C riemann-hypothesis sparse-checkout set --no-cone /README.md
  git -C riemann-hypothesis checkout --quiet "$BRANCH"
elif [ ! -d riemann-hypothesis/.git ]; then
  git clone --quiet --no-checkout --single-branch --branch "$BRANCH" "$UPSTREAM" riemann-hypothesis
  git -C riemann-hypothesis sparse-checkout set --no-cone /README.md
  git -C riemann-hypothesis checkout --quiet "$BRANCH"
fi
git -C riemann-hypothesis config core.hooksPath /dev/null   # never run hooks from a restored cache
git -C riemann-hypothesis fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
[ "${PUBLISH_ONLY:-}" = "1" ] || git -C riemann-hypothesis cat-file -e "$MAIN_REV^{commit}" 2>/dev/null || git -C riemann-hypothesis fetch --quiet origin "$MAIN_REV"
git -C riemann-hypothesis remote get-url fork >/dev/null 2>&1 || git -C riemann-hypothesis remote add fork "https://github.com/$FORK_REPO.git"
git -C riemann-hypothesis config user.name "${GIT_NAME:?}"
git -C riemann-hypothesis config user.email "${GIT_EMAIL:?}"
git -C riemann-hypothesis config core.quotepath false
gh auth setup-git >/dev/null
# A restored cache holds worktree registrations and local branches from earlier runs, but not wt/ itself:
# drop the stale registrations and the local fix/cloud branches (the fork keeps what was pushed).
git -C riemann-hypothesis worktree prune
git -C riemann-hypothesis checkout --quiet --detach "origin/$BRANCH" 2>/dev/null || true
git -C riemann-hypothesis for-each-ref --format='%(refname:short)' refs/heads/fix/ refs/heads/cloud/ | xargs -r git -C riemann-hypothesis branch -q -D
mkdir -p runs wt
touch runs/processed.txt
echo "bootstrap ok: tip $(git -C riemann-hypothesis rev-parse --short=10 origin/$BRANCH), fork $FORK_REPO"
