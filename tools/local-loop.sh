#!/usr/bin/env bash
# Workstation loop for the cloud split: no fixing here. Every 2 minutes it
#   - starts a cloud `fix` run when PR120-BUGS.md was republished (the cloud decides which rows are free),
#   - starts a cloud `check` run (parity with main) when the branch tip moved, at most every 30 minutes,
#   - starts a cloud `attack` run (build, fix, rebuild, publish) when none is queued or running, at most hourly,
#   - starts a cloud `hygiene` run (redundant global instances, no AI) when none is running, at most every 3 hours,
#   - runs tools/publish-ready.mjs: reports PRs the cloud publish job opened, and opens the ones it could not (fallback).
# It exits with a one-line summary when something was published or failed, so the session can report it.
#   bash tools/local-loop.sh            (run in the background)
cd "$(dirname "$0")/.." || exit 1
FORK=FarzanAhmedHossain/riemann-hypothesis
BR=opt/collapse-and-consolidate-4.36
last=$(cat runs/last-key.txt 2>/dev/null || true)
lastTip=$(cat runs/last-check-tip.txt 2>/dev/null || true)
lastCheck=0
lastAttack=$(cat runs/last-attack.txt 2>/dev/null || echo 0)
lastHygiene=$(cat runs/last-hygiene.txt 2>/dev/null || echo 0)
while true; do
  key=$(timeout 90 bash tools/list-key.sh 2>/dev/null || true)
  if [ -n "$key" ] && [ "$key" != "$last" ]; then
    last=$key; printf '%s\n' "$key" > runs/last-key.txt
    if gh workflow run pr120-cloud.yml -R "$FORK" -f mode=fix >/dev/null 2>&1; then
      echo "$(date -u '+%Y-%m-%d %H:%M') list $key -> cloud fix run dispatched" >> runs/cycles.log
    else
      echo "$(date -u '+%Y-%m-%d %H:%M') list $key -> cloud fix dispatch FAILED" >> runs/cycles.log
    fi
  fi
  now=$(date +%s)
  tip=$(timeout 60 git -C riemann-hypothesis ls-remote origin "refs/heads/$BR" 2>/dev/null | cut -c1-10)
  if [ -n "$tip" ] && [ "$tip" != "$lastTip" ] && [ $((now - lastCheck)) -ge 1800 ]; then
    if gh workflow run pr120-cloud.yml -R "$FORK" -f mode=check >/dev/null 2>&1; then
      lastTip=$tip; lastCheck=$now; printf '%s\n' "$tip" > runs/last-check-tip.txt
      echo "$(date -u '+%Y-%m-%d %H:%M') tip $tip -> cloud check run dispatched" >> runs/cycles.log
    fi
  fi
  # Keep the build-verified attack pipeline busy: its select job decides whether any row is worth building.
  if [ $((now - lastAttack)) -ge 3600 ]; then
    active=$(timeout 60 gh run list -R "$FORK" -w pr120-attack.yml -L 5 --json status --jq '[.[] | select(.status != "completed")] | length' 2>/dev/null || echo 1)
    if [ "$active" = "0" ] && gh workflow run pr120-attack.yml -R "$FORK" -f k=2 >/dev/null 2>&1; then
      lastAttack=$now; echo "$now" > runs/last-attack.txt
      echo "$(date -u '+%Y-%m-%d %H:%M') attack pipeline idle -> attack run dispatched (k=2)" >> runs/cycles.log
    fi
  fi
  # Preventive hygiene (redundant global instances, no AI): at most every 3 hours, when none is running.
  if [ $((now - lastHygiene)) -ge 10800 ]; then
    active=$(timeout 60 gh run list -R "$FORK" -w pr120-hygiene.yml -L 5 --json status --jq '[.[] | select(.status != "completed")] | length' 2>/dev/null || echo 1)
    if [ "$active" = "0" ] && gh workflow run pr120-hygiene.yml -R "$FORK" -f k=4 >/dev/null 2>&1; then
      lastHygiene=$now; echo "$now" > runs/last-hygiene.txt
      echo "$(date -u '+%Y-%m-%d %H:%M') hygiene run dispatched (k=4)" >> runs/cycles.log
    fi
  fi
  out=$(timeout 900 node tools/publish-ready.mjs 2>&1)
  if printf '%s\n' "$out" | grep -qE '^(PUBLISHED|CLOUD-PUBLISHED|FAILED|---)'; then
    printf '%s\n' "$out" >> runs/cycles.log
    echo "PUBLISH: $(printf '%s\n' "$out" | grep -E '^(PUBLISHED|CLOUD-PUBLISHED|FAILED|SKIPPED)' | tr '\n' ' ' | cut -c1-400)"
    exit 0
  fi
  sleep 120 || true
done
