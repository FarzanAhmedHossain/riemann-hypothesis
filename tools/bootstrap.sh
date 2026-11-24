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

if [ ! -d riemann-hypothesis/.git ]; then
  git clone --quiet --no-checkout --single-branch --branch "$BRANCH" "$UPSTREAM" riemann-hypothesis
  git -C riemann-hypothesis sparse-checkout set --no-cone /README.md
  git -C riemann-hypothesis checkout --quiet "$BRANCH"
fi
git -C riemann-hypothesis fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
git -C riemann-hypothesis cat-file -e "$MAIN_REV^{commit}" 2>/dev/null || git -C riemann-hypothesis fetch --quiet origin "$MAIN_REV"
git -C riemann-hypothesis remote get-url fork >/dev/null 2>&1 || git -C riemann-hypothesis remote add fork "https://github.com/$FORK_REPO.git"
git -C riemann-hypothesis config user.name "${GIT_NAME:?}"
git -C riemann-hypothesis config user.email "${GIT_EMAIL:?}"
git -C riemann-hypothesis config core.quotepath false
gh auth setup-git >/dev/null
mkdir -p runs wt
touch runs/processed.txt
echo "bootstrap ok: tip $(git -C riemann-hypothesis rev-parse --short=10 origin/$BRANCH), fork $FORK_REPO"
