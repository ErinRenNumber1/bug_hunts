#!/usr/bin/env bash
# Re-run guest-mode evidence specs on several browsers and build one report.html per spec,
# with a browser dropdown inside the report.
#
#   tools/run-browsers.sh <run|all> [browser ...]
#
#   <run>     1..5 or control (see SPECS below); all = every one of them in order
#   browser   project names from playwright.guest-mode.config.ts: chromium webkit firefox chrome
#             default: all four
#
# Reports land in runs/spec-run-<run>/report.html. Launches real browsers against production,
# so Erin runs it herself. Copied traces go to runs/spec-run-<run>/traces/ and stay gitignored.
set -euo pipefail

HUNT="$(cd "$(dirname "$0")/.." && pwd)"
CW="$HOME/world/trees/root/src/areas/clients/checkout-web"
CONFIG=playwright.guest-mode.config.ts

declare -A SPECS=(
  [1]=e2e/tests/shop-pay/shared/guest-mode.spec.ts
  [2]=e2e/tests/shop-pay/shared/guest-mode-lucasmrichtest.spec.ts
  [3]=e2e/tests/shop-pay/shared/guest-mode-lucasmrichtest-reload.spec.ts
  [4]=e2e/tests/shop-pay/shared/guest-mode-lucasmrichtest-account-signin.spec.ts
  [5]=e2e/tests/shop-pay-installments/guest-mode-spi-high-aov.spec.ts
  [control]=e2e/tests/shop-pay-installments/guest-mode-spi-high-aov-control.spec.ts
)
ORDER=(1 2 3 4 5 control)

WHICH="${1:?usage: run-browsers.sh <run|all> [browser ...]}"; shift
if [ "$WHICH" = all ]; then RUNS=("${ORDER[@]}"); else RUNS=("$WHICH"); fi
BROWSERS=("$@"); [ ${#BROWSERS[@]} -eq 0 ] && BROWSERS=(chromium webkit firefox chrome)
for RUN in "${RUNS[@]}"; do
  : "${SPECS[$RUN]:?unknown run '$RUN' (1..5, control, or all)}"
  [ -f "$HUNT/runs/spec-run-$RUN.meta.json" ] || { echo "missing runs/spec-run-$RUN.meta.json"; exit 1; }
done
[ -f "$CW/$CONFIG" ] || cp "$HUNT/tools/$CONFIG" "$CW/$CONFIG"

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
  JSON="test-results/guest-mode-run-$RUN.json"
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
  python3 "$HUNT/tools/make-report.py" --run "spec-run-$RUN" --meta "$META" "${REPORT_ARGS[@]}" | grep -v '^[] {"]' || true
  SUMMARY+=("$LINE -> $HUNT/runs/spec-run-$RUN/report.html")
done
echo '--- summary'
printf '%s\n' "${SUMMARY[@]}"
