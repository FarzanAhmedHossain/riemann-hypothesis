#!/usr/bin/env bash
# Watch PR120-BUGS.md and the branch tip. Prints one line and exits when there is work:
#   "CHANGE: ..."  a new list version has free rows (written to runs/fast-args-HHMM.json)
#   "PARITY: ..."  the tip lost an attribute line that an original module has in its own source on main
#                  (tools/disable-parity.mjs, kinds disable/instance/local; details in runs/parity-<kind>.txt)
# Lists without free rows and clean parity runs are logged to runs/cycles.log. Run in the background:
#   bash tools/watch-list.sh
cd "$(dirname "$0")/.." || exit 1
BR=opt/collapse-and-consolidate-4.36
last=$(cat runs/last-key.txt 2>/dev/null || true)
lastTip=$(cat runs/last-parity-tip.txt 2>/dev/null || true)
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
  # Parity check whenever the branch tip moves (about 20 s per kind).
  tip=$(timeout 60 git -C riemann-hypothesis ls-remote origin "refs/heads/$BR" 2>/dev/null | cut -c1-10)
  if [ -n "$tip" ] && [ "$tip" != "$lastTip" ]; then
    timeout 120 git -C riemann-hypothesis fetch -q origin "$BR" 2>/dev/null
    found=""
    for k in disable instance local; do
      timeout 300 node tools/disable-parity.mjs --kind "$k" > "runs/parity-$k.txt" 2>/dev/null || true
      c=$(grep -c '^src/' "runs/parity-$k.txt" 2>/dev/null || true)
      [ "${c:-0}" -gt 0 ] && found="$found $k:$c"
    done
    lastTip=$tip; printf '%s\n' "$tip" > runs/last-parity-tip.txt
    if [ -n "$found" ]; then echo "PARITY: tip $tip lost original attribute lines ($found); see runs/parity-<kind>.txt"; exit 0
    else echo "$(date -u '+%Y-%m-%d %H:%M') parity clean at $tip" >> runs/cycles.log; fi
  fi
  sleep 60 || true
done
