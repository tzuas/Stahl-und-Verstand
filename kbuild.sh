#!/usr/bin/env bash
# Baut/prueft die Projektdateien laut CLAUDE.md:
# extrahiert den inline <script>-Block aus kunde.html und prueft ihn mit
# `node --check` auf Syntaxfehler (z.B. durch Smart/Curly Quotes aus dem
# Edit-Tool). Bricht mit Exit-Code != 0 ab, wenn etwas kaputt ist.
set -euo pipefail
cd "$(dirname "$0")"

FILES=(kunde.html)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

status=0
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "WARN: $f nicht gefunden, überspringe." >&2
    continue
  fi
  out="$TMP/$(basename "$f").js"
  python3 -c "
import re, sys
html = open('$f', encoding='utf-8').read()
m = re.search(r'<script>(.*)</script>', html, re.S)
if not m:
    print('FEHLER: kein <script>-Block in $f gefunden', file=sys.stderr)
    sys.exit(1)
open('$out', 'w', encoding='utf-8').write(m.group(1))
"
  if node --check "$out"; then
    echo "OK: $f (Script-Syntax gueltig)"
  else
    echo "FEHLER: $f hat einen Syntaxfehler im <script>-Block." >&2
    status=1
  fi
done

if [ -f worker/worker.js ]; then
  if node --check worker/worker.js; then
    echo "OK: worker/worker.js (Syntax gueltig)"
  else
    echo "FEHLER: worker/worker.js hat einen Syntaxfehler." >&2
    status=1
  fi
fi

exit $status
