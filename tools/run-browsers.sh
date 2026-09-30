#!/usr/bin/env bash
# Run one hunt's evidence specs on several browsers and build one report.html per spec,
# with a browser dropdown inside the report.
#
#   tools/run-browsers.sh <hunt-dir> <run|all> [browser ...]
#
#   hunt-dir  a hunt folder in this repo, e.g. shop-pay-guest-mode-e2e; it must contain
#             specs.conf (one "<run> <spec path relative to checkout-web>" per line, in the
#             order "all" should run them) and runs/spec-run-<run>.meta.json for each run
#   <run>     a run id from specs.conf; all = every one of them in order
#   browser   project names from playwright.bug-hunt.config.ts: chromium webkit firefox chrome
#             default: all four
#
# Reports land in <hunt-dir>/runs/spec-run-<run>/report.html. Launches real browsers against
# production, so Erin runs it herself; agents validate arguments with BUG_HUNT_DRY_RUN=1, which
# stops after the checks and prints what would run (Playwright wipes test-results/ on start). Copied traces go to runs/spec-run-<run>/traces/ and
# stay gitignored.
set -euo pipefail

TOOLS="$(cd "$(dirname "$0")" && pwd)"
CW="$HOME/world/trees/root/src/areas/clients/checkout-web"
CONFIG=playwright.bug-hunt.config.ts

HUNT_ARG="${1:?usage: run-browsers.sh <hunt-dir> <run|all> [browser ...]}"; shift
HUNT="$(cd "$HUNT_ARG" 2>/dev/null && pwd)" || { echo "no such hunt folder: $HUNT_ARG"; exit 1; }
[ -f "$HUNT/specs.conf" ] || { echo "missing $HUNT/specs.conf"; exit 1; }

declare -A SPECS=(); ORDER=()
while read -r id spec; do
  [ -z "$id" ] || [ "${id:0:1}" = "#" ] && continue
  SPECS[$id]="$spec"; ORDER+=("$id")
done < "$HUNT/specs.conf"

WHICH="${1:?usage: run-browsers.sh <hunt-dir> <run|all> [browser ...]}"; shift
if [ "$WHICH" = all ]; then RUNS=("${ORDER[@]}"); else RUNS=("$WHICH"); fi
BROWSERS=("$@"); [ ${#BROWSERS[@]} -eq 0 ] && BROWSERS=(chromium webkit firefox chrome)
for RUN in "${RUNS[@]}"; do
  : "${SPECS[$RUN]:?unknown run '$RUN' (ids in specs.conf: ${ORDER[*]}, or all)}"
  [ -f "$HUNT/runs/spec-run-$RUN.meta.json" ] || { echo "missing $HUNT/runs/spec-run-$RUN.meta.json"; exit 1; }
  [ -f "$CW/${SPECS[$RUN]}" ] || { echo "spec not in checkout-web: ${SPECS[$RUN]} (copy it from $HUNT/specs/)"; exit 1; }
done
[ -f "$CW/$CONFIG" ] || cp "$TOOLS/$CONFIG" "$CW/$CONFIG"
if [ "${BUG_HUNT_DRY_RUN:-0}" = 1 ]; then
  for RUN in "${RUNS[@]}"; do echo "would run $RUN: ${SPECS[$RUN]} on ${BROWSERS[*]}"; done; exit 0
fi

status_of() {  # <json> <project> -> passed|failed from the Playwright JSON reporter
  python3 - "$1" "$2" <<'PY'
import json, sys
report, project = json.load(open(sys.argv[1])), sys.argv[2]
def walk(suite):
    for spec in suite.get('specs', []):
        for t in spec.get('tests', []):
            if t.get('projectName') == project: yield t.get('status')
    for s in suite.get('suites', []): yield from walk(s)
statuses = [s for top in report.get('suites', []) for s in walk(top)]
print('passed' if statuses and all(s in ('expected', 'flaky') for s in statuses) else 'failed')
PY
}

cd "$CW"
SUMMARY=()
for RUN in "${RUNS[@]}"; do
  SPEC="${SPECS[$RUN]}"; META="$HUNT/runs/spec-run-$RUN.meta.json"
  JSON="test-results/bug-hunt-run-$RUN.json"
  ARGS=(); for b in "${BROWSERS[@]}"; do ARGS+=(--project "$b"); done
  echo "--- run $RUN: $SPEC on ${BROWSERS[*]}"
  PW_JSON_OUT="$JSON" npx playwright test --config "$CONFIG" "$SPEC" "${ARGS[@]}" || true

  REPORT_ARGS=(); LINE="run $RUN:"
  for b in "${BROWSERS[@]}"; do
    trace=$(ls -t test-results/*-"$b"/trace.zip 2>/dev/null | head -1 || true)
    if [ -z "$trace" ]; then echo "$b: no trace.zip (browser not installed, or the run never started)"; LINE+=" $b=missing"; continue; fi
    status=$(status_of "$JSON" "$b")
    REPORT_ARGS+=(--trace "$b=$trace" --status "$b=$status"); LINE+=" $b=$status"
  done
  if [ ${#REPORT_ARGS[@]} -eq 0 ]; then echo "run $RUN: nothing to report"; SUMMARY+=("$LINE"); continue; fi
  python3 "$TOOLS/make-report.py" --run "spec-run-$RUN" --meta "$META" "${REPORT_ARGS[@]}" | grep -v '^[] {"]' || true
  SUMMARY+=("$LINE -> $HUNT/runs/spec-run-$RUN/report.html")
done
echo '--- summary'
printf '%s\n' "${SUMMARY[@]}"
