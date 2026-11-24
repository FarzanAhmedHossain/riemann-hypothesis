#!/usr/bin/env bash
# Prints "<Updated line>|<md5 of the Look-ahead table rows>" for the live PR120-BUGS.md (empty on fetch failure).
body=$(gh api repos/rohanarun/alpoge-rh-replay/contents/PR120-BUGS.md -H "Accept: application/vnd.github.raw" 2>/dev/null) || exit 0
u=$(printf '%s\n' "$body" | head -4 | grep -o 'Updated [0-9: -]*UTC')
[ -n "$u" ] || exit 0
la=$(printf '%s\n' "$body" | awk '/^## Look-ahead/{f=1} /^## Open PRs/{f=0} f && /^\| `/' | md5sum | cut -c1-12)
echo "$u|look-ahead $la"
