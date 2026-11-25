#!/usr/bin/env bash
# Run `lake` (which runs code from the upstream repository) as an unprivileged user with an empty environment.
# The user `lb` has no sudo and cannot read the runner's processes, tokens or $GITHUB_OUTPUT. It can write only
# inside the build tree and its own home, not the workspace files (verdicts, toolkit) that the runner owns.
#
#   bash tools/lake-sandbox.sh setup <tree>                       create lb, give it <tree>, install elan for it
#   bash tools/lake-sandbox.sh run <tree> <minutes> <log> <args…>  run `lake <args…>` in <tree>; prints the exit code
#
# Run it from the runner user (which has sudo). <log> is written by the runner, not by lb.
set -euo pipefail
cmd=${1:?setup|run}; tree=$(cd "${2:?tree}" && pwd)
LB=lb
LBHOME=/home/$LB
SAFE_PATH="$LBHOME/.elan/bin:/usr/local/bin:/usr/bin:/bin"
as_lb() { sudo -u "$LB" -H env -i HOME="$LBHOME" USER="$LB" LOGNAME="$LB" PATH="$SAFE_PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 "$@"; }
case "$cmd" in
  setup)
    id "$LB" >/dev/null 2>&1 || sudo useradd -m -s /bin/bash "$LB"
    # lb must not be able to escalate: no sudoers entry, not in admin groups.
    sudo deluser "$LB" sudo >/dev/null 2>&1 || true
    if sudo -l -U "$LB" 2>/dev/null | grep -q '(ALL'; then echo "lb has sudo rights; refusing" >&2; exit 1; fi
    sudo chown -R "$LB:$LB" "$tree"
    # lb may pass through (not list or write) the runner's directories above the tree.
    d=$(dirname "$tree"); while [ "$d" != "/" ]; do sudo chmod o+x "$d"; d=$(dirname "$d"); done
    if [ ! -x "$LBHOME/.elan/bin/lake" ]; then
      curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -o /tmp/elan-init.sh
      sudo install -o "$LB" -m 0755 /tmp/elan-init.sh "$LBHOME/elan-init.sh"
      as_lb bash "$LBHOME/elan-init.sh" -y --default-toolchain none >/dev/null
    fi
    as_lb bash -c 'cd "$1" && lake --version' _ "$tree"
    ;;
  run)
    minutes=${3:?minutes}; log=${4:?log}; shift 4
    set +e
    as_lb timeout "${minutes}m" bash -c 'cd "$1" && shift && exec lake "$@"' _ "$tree" "$@" > "$log" 2>&1
    rc=$?
    set -e
    # Stray processes from the build must not outlive it.
    sudo pkill -KILL -u "$LB" >/dev/null 2>&1 || true
    echo "$rc"
    ;;
  *) echo "usage: lake-sandbox.sh setup|run …" >&2; exit 2 ;;
esac
