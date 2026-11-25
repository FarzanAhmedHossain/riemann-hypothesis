#!/usr/bin/env bash
# Run `lake` (which runs code from the upstream repository) inside a throwaway Docker container:
#   - only the build directory is mounted (read-write);
#   - nothing else from the host is visible: no runner files, no tokens, no $GITHUB_* files, no host binaries;
#   - no capabilities and no privilege escalation; the user is uid 1000 inside the container;
#   - every process the build starts dies with the container.
# Network stays on (dependencies, Mathlib cache); these jobs hold no secrets.
#
#   bash tools/lake-sandbox.sh setup <tree>                       pull the image, prepare the toolchain volume
#   bash tools/lake-sandbox.sh run <dir> <minutes> <log> <args…>  run `lake <args…>` in <dir>; prints the exit code
#
# <dir> is the build tree or a directory inside it (e.g. <tree>/.lake/packages/mathlib for `exe cache get`).
# <log> is written by the runner, not by the container.
set -euo pipefail
cmd=${1:?setup|run}; dir=$(cd "${2:?dir}" && pwd)
IMAGE=buildpack-deps:bookworm-scm   # Debian with git, curl and CA certificates
VOL=pr120-elan                      # elan + Lean toolchains, inside Docker only
UID_IN=1000
case "$cmd" in
  setup)
    docker pull -q "$IMAGE" >/dev/null
    docker volume create "$VOL" >/dev/null
    docker run --rm -v "$VOL":/home/u "$IMAGE" chown "$UID_IN:$UID_IN" /home/u
    sudo chown -R "$UID_IN:$UID_IN" "$dir"
    echo "sandbox ready: $IMAGE, uid $UID_IN, tree $dir"
    ;;
  run)
    minutes=${3:?minutes}; log=${4:?log}; shift 4
    name="lake-$$-$RANDOM"
    set +e
    docker run --rm --name "$name" \
      --cap-drop ALL --security-opt no-new-privileges --pids-limit 8192 \
      --user "$UID_IN:$UID_IN" -e HOME=/home/u -e PATH=/home/u/.elan/bin:/usr/local/bin:/usr/bin:/bin -e LANG=C.UTF-8 \
      -v "$VOL":/home/u -v "$dir":/w -w /w "$IMAGE" \
      bash -c '[ -x "$HOME/.elan/bin/lake" ] || curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none >/dev/null; exec timeout "$0m" lake "$@"' "$minutes" "$@" \
      > "$log" 2>&1
    rc=$?
    set -e
    docker rm -f "$name" >/dev/null 2>&1 || true
    echo "$rc"
    ;;
  *) echo "usage: lake-sandbox.sh setup|run …" >&2; exit 2 ;;
esac
