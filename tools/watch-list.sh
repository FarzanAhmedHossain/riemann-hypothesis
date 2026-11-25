#!/usr/bin/env bash
# Watch PR120-BUGS.md until a new list version has free rows, then print "CHANGE: ..." and exit.
# Lists without free rows are logged to runs/cycles.log. Run in the background:  bash tools/watch-list.sh
cd "$(dirname "$0")/.." || exit 1
last=$(cat runs/last-key.txt 2>/dev/null || true)
while true; do
  key=$(timeout 90 bash tools/list-key.sh 2>/dev/null || true)
  if [ -n "$key" ] && [ "$key" != "$last" ]; then
    last=$key; printf '%s\n' "$key" > runs/last-key.txt; printf '%s\n' "${key%%|*}" > runs/last-list.txt
    stamp=$(date -u +%H%M)
    summary=$(timeout 900 node tools/combined-prep.mjs --max 8 2>&1 >runs/fast-args-$stamp.json | tail -1)
    cp runs/fast-args-$stamp.json runs/fast-args.json 2>/dev/null || true
    n=$(node -e "try{console.log(require('./runs/fast-args-$stamp.json').rows.length)}catch{console.log(0)}" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo "CHANGE: $key; $n rows in runs/fast-args-$stamp.json; $summary"; exit 0
    else echo "$(date -u '+%Y-%m-%d %H:%M') change $key: no free rows ($summary)" >> runs/cycles.log; fi
  fi
  sleep 60 || true
done
