#!/usr/bin/env bash
# Guard for wrangler.jsonc assets.run_worker_first: every "!" (Worker-bypassed) path must be an existing,
# non-HTML file in public/, and no HTML may live under public/assets/. Keeps the 21+ gate un-bypassable.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
if find public/assets -type f -iname '*.htm*' | grep -q .; then echo "check-assets: HTML under public/assets/" >&2; fail=1; fi
line=$(grep -E '^\s*"run_worker_first"' wrangler.jsonc)
for p in $(grep -oE '"![^"]+"' <<<"$line" | tr -d '"!'); do
  case "$p" in *'*'*|*.htm*|*/) echo "check-assets: bypass '$p' must be an exact non-HTML file" >&2; fail=1; continue;; esac
  [ -f "public$p" ] || { echo "check-assets: bypass '$p' has no file public$p" >&2; fail=1; }
done
[ $fail -eq 0 ] && echo "check-assets: OK ($(grep -oE '"![^"]+"' <<<"$line" | wc -l) bypassed static files)"
exit $fail
