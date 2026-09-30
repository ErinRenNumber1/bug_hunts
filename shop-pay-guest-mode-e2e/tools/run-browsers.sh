#!/usr/bin/env bash
# Re-run one guest-mode evidence spec on several browsers and build one report.html per browser.
#
#   tools/run-browsers.sh <run> [browser ...]
#
#   <run>     1..5 or control (see SPECS below)
#   browser   any project name from playwright.guest-mode.config.ts:
#             chromium webkit firefox iphone-15 pixel-7 chrome msedge
#             default: chromium webkit firefox
#
# Reports land in runs/spec-run-<run>-<browser>/report.html. Launches real browsers against
# production, so Erin runs it herself. The copied trace.zip stays gitignored.
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

RUN="${1:?usage: run-browsers.sh <run> [browser ...]}"; shift
SPEC="${SPECS[$RUN]:?unknown run '$RUN' (1..5 or control)}"
META="$HUNT/runs/spec-run-$RUN.meta.json"
BROWSERS=("$@"); [ ${#BROWSERS[@]} -eq 0 ] && BROWSERS=(chromium webkit firefox)
[ -f "$META" ] || { echo "missing $META"; exit 1; }
[ -f "$CW/$CONFIG" ] || cp "$HUNT/tools/$CONFIG" "$CW/$CONFIG"

cd "$CW"
JSON="test-results/guest-mode-run-$RUN.json"
ARGS=(); for b in "${BROWSERS[@]}"; do ARGS+=(--project "$b"); done
echo "--- playwright: $SPEC on ${BROWSERS[*]}"
PW_JSON_OUT="$JSON" npx playwright test --config "$CONFIG" "$SPEC" "${ARGS[@]}" || true

echo "--- reports"
for b in "${BROWSERS[@]}"; do
  trace=$(ls -t test-results/*-"$b"/trace.zip 2>/dev/null | head -1 || true)
  if [ -z "$trace" ]; then echo "$b: no trace.zip (browser not installed, or the run never started)"; continue; fi
  status=$(python3 - "$JSON" "$b" <<'PY'
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
)
  python3 "$HUNT/tools/make-report.py" --run "spec-run-$RUN-$b" --meta "$META" --trace "$trace" --status "$status" --browser "$b" >/dev/null
  echo "$b: $status -> $HUNT/runs/spec-run-$RUN-$b/report.html"
done
echo "--- playwright html report: (cd $CW && npx playwright show-report)"
