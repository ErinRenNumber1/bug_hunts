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
| 4 | lucasmrichtest, then reinis-test-store | [specs/guest-mode-lucasmrichtest-account-signin.spec.ts](specs/guest-mode-lucasmrichtest-account-signin.spec.ts) | passed, 38.9s (attempt 8; attempts 4 to 6 recorded the same behaviour as soft failures) | [runs/spec-run-4/report.html](runs/spec-run-4/report.html) |
| 5 | spi-high-aov | [specs/guest-mode-spi-high-aov.spec.ts](specs/guest-mode-spi-high-aov.spec.ts) | failed the same way on all four browsers: chromium 29.6s, webkit 41.0s, firefox 35.4s, chrome 28.4s (two earlier Chromium attempts failed the same way) | [runs/spec-run-5/report.html](runs/spec-run-5/report.html) |

Run 3 reloads the page after landing in Pay checkout and asserts the buyer is still on `/shoppay`, on the
same host, with the same email in the header, then completes the order. That proves the guest session is
cookie and server backed rather than client handoff state.

Run 4 takes the guest-mode buyer from run 3 to a second store. Signing in to reinis-test-store's customer
account through Sign in with Shop asks for an email code and then an SMS code to the part A shipping phone,
which had not been verified before. After that sign-in, a cart permalink on reinis-test-store goes straight
into Shop Pay checkout with the address and card vaulted and no further verification. Erin confirmed on
2026-09-30 that both are the intended behaviour, so the spec asserts them as hard expectations.

Run 5 is bug hunt doc case 4, "New buyer — Installments", on the store the bug hunt used (USD 350 product). The
guest-mode buyer sees no Installments address banner on the empty shipping form or after a valid US address,
and Installments underwriting asks for an SMS code to the shipping phone that guest mode skipped. After Affirm
identity verification, `POST /pay/transactions/<token>/agreements` returned 422 `checkout_error` on both
attempts on 2026-09-30 and the iframe showed "We're experiencing technical issues", so no payment plan was
offered and the order was not placed. The spec fails by name on that outcome. Three more runs the same day pinned it down: John's tracked guest-mode spec on spi-e2e-testing passed with the
agreement returning 202; spec 5 with a USD 100 product on spi-high-aov failed the same way; and
[specs/guest-mode-spi-high-aov-control.spec.ts](specs/guest-mode-spi-high-aov-control.spec.ts), guest mode forced
to control with an ordinary email, phone and SMS-code sign-up, failed the same way too. The failure follows the
store, not guest mode or the amount. Both specs take `SPI_HIGH_AOV_VARIANT=<variant id>` to change the product.

Each report is one `report.html` per spec. A browser dropdown at the top switches between one section per
browser; each section embeds eight stills from that browser's Playwright screencast, the storefront checkout
token, the checkout session identifier, and the `x-request-id` of every key request, with the email-submit
request that carried `X-Verdict-Overrides-Applied` highlighted. A summary table under the heading lists every
browser's result, duration and checkout session identifier. Runs 1 to 4 were first recorded on Chromium only;
their reports gain the other browsers when the spec is re-run through `tools/run-browsers.sh`.

## Running a spec

The specs import checkout-web helpers and are not runnable standalone. Copy one into
`areas/clients/checkout-web/e2e/tests/shop-pay/shared/` in World (spec 5 goes under
`e2e/tests/shop-pay-installments/` and runs with `--project shop-pay-installments`) and run from `areas/clients/checkout-web`:

```
npx playwright test e2e/tests/shop-pay/shared/guest-mode-lucasmrichtest-reload.spec.ts \
  --project shop-pay --trace on
```

The experiment override is set inside each spec through `test.use({experimentOverrides})`, so no
environment variable is needed.

Both specs use the benchmark test identity (`shop.end_to_end_test+<uuid>@shopify.com`), which the server
recognises on any store, so the SMS code is simulated. lucasmrichtest is not on the e2e pod, so the page
objects log an "Invalid Pod ID" warning locally; keep these specs local rather than in CI.

## Running on other browsers

`tools/playwright.guest-mode.config.ts` is a local Playwright config (copy it to the checkout-web root; it is
not tracked in World) that reuses the main config and defines one project per browser profile, all pointing at
the guest-mode specs: `chromium`, `webkit` (Desktop Safari profile), `firefox`, and `chrome` (the Google Chrome
installed on the Mac, through Playwright's `channel`). Every project keeps the `Playwright-checkout-e2e-tests/local` user agent suffix that
keeps e2e traffic out of the identity graph and bot protection.

`tools/run-browsers.sh <run|all> [browser ...]` runs one spec (or every spec, in order 1 to 5 then control) on
each browser and rebuilds that spec's `runs/spec-run-<run>/report.html` with one section per browser behind the
dropdown (default browsers: all four):

```
tools/run-browsers.sh all
tools/run-browsers.sh 5
tools/run-browsers.sh 2 webkit
```

Stills are chosen per browser, so timing differences do not misalign them. A moment in a meta file anchors
on an `attachment` (a screenshot the spec attached), a `step` (a `test.step` title prefix such as
`"step": "A2"`), a `request` (a regex on `METHOD STATUS host/path OperationName`, plus an optional `offset` in
seconds), or `"nav": "reload"`, with a fixed `t` as the last resort. Specs 1 to 3 have no steps and use request
anchors.
Playwright's WebKit is the Safari engine without Safari's tracking prevention, so it will not reproduce
ITP-specific cookie behaviour. `webkit` and `firefox` need `npx playwright install webkit firefox` once.

## Building a report

```
python3 tools/make-report.py --run spec-run-N --meta runs/spec-run-N.meta.json \
  --trace chromium=path/to/trace.zip --trace webkit=path/to/trace.zip \
  --status chromium=passed --status webkit=failed
```

The script copies and unzips each trace into `runs/spec-run-N/traces/<browser>/`, picks one screencast frame
per moment listed in the meta file into `shots/<browser>/`, extracts the identifiers, and writes one
`report.html` with a section per browser. A bare `--trace path` with `--status passed` builds a single-browser
report (named by `--browser`, default chromium). The `traces/` folder is gitignored and must stay that way.
