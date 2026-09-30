# Shop Pay guest mode, end-to-end evidence

Project: GSD 52301 "Shop Pay: Remove friction at Shop Pay checkout sign-up flow".
Experiment `e_shop_pay_guest_mode`, forced to `treatment` through the `Shopify-Experiment-Overrides`
request header. Treatment means a new buyer who submits an email at the Shop Pay sign-in lands directly
in Pay checkout, with no phone entry and no SMS code.

## Runs

| Run | Store | Spec | Result | Report |
| --- | --- | --- | --- | --- |
| 1 | shoppaye2etesting | checkout-web `guest-mode.spec.ts` (tracked in World, not copied here) | passed | [runs/spec-run-1/report.html](runs/spec-run-1/report.html) |
| 2 | lucasmrichtest | [specs/guest-mode-lucasmrichtest.spec.ts](specs/guest-mode-lucasmrichtest.spec.ts) | passed, 19.9s | [runs/spec-run-2/report.html](runs/spec-run-2/report.html) |
| 3 | lucasmrichtest | [specs/guest-mode-lucasmrichtest-reload.spec.ts](specs/guest-mode-lucasmrichtest-reload.spec.ts) | passed, 22.0s | [runs/spec-run-3/report.html](runs/spec-run-3/report.html) |

Run 3 reloads the page after landing in Pay checkout and asserts the buyer is still on `/shoppay`, on the
same host, with the same email in the header, then completes the order. That proves the guest session is
cookie and server backed rather than client handoff state.

Each report embeds eight stills from the Playwright screencast, the storefront checkout token, the
checkout session identifier, and the `x-request-id` of every key request, with the email-submit request
that carried `X-Verdict-Overrides-Applied` highlighted.

## Running a spec

The specs import checkout-web helpers and are not runnable standalone. Copy one into
`areas/clients/checkout-web/e2e/tests/shop-pay/shared/` in World and run from `areas/clients/checkout-web`:

```
npx playwright test e2e/tests/shop-pay/shared/guest-mode-lucasmrichtest-reload.spec.ts \
  --project shop-pay --trace on
```

The experiment override is set inside each spec through `test.use({experimentOverrides})`, so no
environment variable is needed.

Both specs use the benchmark test identity (`shop.end_to_end_test+<uuid>@shopify.com`), which the server
recognises on any store, so the SMS code is simulated. lucasmrichtest is not on the e2e pod, so the page
objects log an "Invalid Pod ID" warning locally; keep these specs local rather than in CI.

## Building a report

```
python3 tools/make-report.py --run spec-run-N --meta runs/spec-run-N.meta.json \
  --trace path/to/trace.zip --status passed
```

The script unzips the trace into `runs/spec-run-N/`, picks one screencast frame per moment listed in the
meta file, extracts the identifiers, and writes `report.html` next to the shots. The trace files it leaves
behind are gitignored and must stay that way.
