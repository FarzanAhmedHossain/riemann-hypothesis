#!/usr/bin/env bash
# Run tools/shadow-scan.mjs over the blocked set in N shards, one at a time, each under a memory guard.
# Waits until the commit charge is below START_PCT before each shard; kills only the scanner if it reaches KILL_PCT.
#   bash tools/scan-shards.sh [N=8] [HEAP_MB=1600] [START_PCT=85] [KILL_PCT=97]
# Shards already written (runs/shadow-findings-blocked-IofN.json) are skipped, so it can be re-run after a crash.
cd "$(dirname "$0")/.." || exit 1
N=${1:-8}; HEAP=${2:-1600}; START=${3:-85}; KILL=${4:-97}
# Memory in use, percent: Windows commit charge, or (Linux, e.g. a GitHub runner) 100 - MemAvailable/MemTotal.
pct() {
  if command -v powershell >/dev/null 2>&1; then
    powershell -NoProfile -Command '$o=Get-CimInstance Win32_OperatingSystem; [math]::Round(100*($o.TotalVirtualMemorySize-$o.FreeVirtualMemory)/$o.TotalVirtualMemorySize)' 2>/dev/null | tr -d '\r'
  elif [ -r /proc/meminfo ]; then
    awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{printf "%d\n", 100*(t-a)/t}' /proc/meminfo
  else echo 0; fi
}
stop_scanner() {
  if command -v powershell >/dev/null 2>&1; then
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'shadow-scan' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1
  else pkill -f 'tools/shadow-scan.mjs' 2>/dev/null; fi
}
for ((i = 0; i < N; i++)); do
  out="runs/shadow-findings-blocked-${i}of${N}.json"
  [ -s "$out" ] && { echo "shard $i/$N: already done"; continue; }
  for ((try = 1; try <= ${RETRIES:-3}; try++)); do
    while p=$(pct); [ -z "$p" ] || [ "$p" -ge "$START" ]; do sleep 30; done
    echo "shard $i/$N: start at commit $(pct)% $(date -u +%H:%M) (attempt $try)"
    node --max-old-space-size="$HEAP" tools/shadow-scan.mjs --set blocked --shard "$i/$N" > "runs/scan-blocked-${i}of${N}.log" 2>&1 &
    np=$!; killed=0
    while kill -0 "$np" 2>/dev/null; do
      p=$(pct)
      if [ -n "$p" ] && [ "$p" -ge "$KILL" ]; then
        echo "shard $i/$N: GUARD commit ${p}% - stopping the scanner"; kill "$np" 2>/dev/null
        stop_scanner
        killed=1; break
      fi
      sleep 15
    done
    wait "$np" 2>/dev/null
    [ "$killed" = 0 ] && break
    echo "shard $i/$N: stopped for memory; waiting to retry"; sleep 120
  done
  if [ "$killed" = 1 ]; then echo "shard $i/$N: gave up after ${RETRIES:-3} attempts; rerun later"; exit 2; fi
  echo "shard $i/$N: $(grep -E 'pass 3b|FATAL' "runs/scan-blocked-${i}of${N}.log" | tail -1 | cut -c1-200)"
done
node -e "
const fs=require('fs'); let r=[], a=[];
for (let i=0;i<$N;i++){ try{ r=r.concat(JSON.parse(fs.readFileSync('runs/shadow-findings-blocked-'+i+'of$N.json','utf8'))); }catch{} try{ a=a.concat(JSON.parse(fs.readFileSync('runs/shadow-findings-blocked-'+i+'of$N-added.json','utf8'))); }catch{} }
fs.writeFileSync('runs/shadow-findings-blocked.json', JSON.stringify(r)); fs.writeFileSync('runs/shadow-findings-blocked-added.json', JSON.stringify(a));
console.log('ALL SHARDS DONE: '+r.length+' replaced findings in '+new Set(r.map(x=>x.file)).size+' files; '+a.length+' added-overload findings in '+new Set(a.map(x=>x.file)).size+' files');
"
