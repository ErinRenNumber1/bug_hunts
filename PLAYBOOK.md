# Bug hunt playbook

How a hunt in this repo is run and written up. Read this before starting or resuming one. Machine-specific
steps (what Erin runs herself, how to push to World) live in the `bug-hunt` Claude Code skill, not here.

## What a hunt is

One case from a bug hunt doc becomes one Playwright spec that runs against production through the
checkout-web page objects and helpers. Each spec runs on four browsers and produces one `report.html` with
screencast stills, the checkout token, the checkout session identifier and the `x-request-id` of every key
request. The hunt README records what each run proved, with request IDs, and names the code path in Core or
shop-server that owns the behaviour. The doc case is the contract: the spec asserts the expected behaviour
as hard expectations and fails by name on the bug, so a red run is a finding, not a flake to retry.

## Layout

```
<hunt-slug>/
  README.md                 project, runs table, findings, how to run, open items
  specs.conf                "<run id> <spec path relative to areas/clients/checkout-web>", in run order
  specs/*.spec.ts           copies of the specs; they import checkout-web helpers and only run from there
  runs/spec-run-<id>.meta.json   moments, proves, caveats for the report
  runs/spec-run-<id>/report.html and shots/<browser>/   the committed evidence
  runs/spec-run-<id>/traces/     unpacked traces, gitignored
tools/                      shared: run-browsers.sh, playwright.bug-hunt.config.ts, make-report.py, report-style.html
```

Run ids are numbers in doc-case order; a variant of a run gets a suffix (`2-base-config`, `control`).

## Writing a spec

- Start from the closest tracked spec in checkout-web (`e2e/tests/shop-pay/shared/guest-mode.spec.ts` for
  Shop Pay sign-in flows) and its page objects. Do not reimplement selectors the page objects already own.
- Before writing a locator, grep the `tests/` and page-object folders listed under
  [Where existing coverage lives](#where-existing-coverage-lives) for the button text, heading or form the doc
  case describes. Someone has usually clicked it already.
- Use the benchmark identity (`shop.end_to_end_test+<uuid>@shopify.com`); the server recognises it on any
  store, so the email code is fixed and the SMS code is simulated.
- Force an experiment inside the spec with `test.use({experimentOverrides})`, never through the URL. The
  authentication GraphQL response carries `X-Verdict-Overrides-Applied` when the override took; the report
  highlights that request.
- Attach a screenshot (`testInfo.attach`) at any moment the screencast cannot see: popups, a second window,
  the instant after a redirect chain. Name the attachment; the meta file anchors on it.
- Wrap phases in `test.step` with short prefixes (`A1`, `B2`) so meta moments can anchor on steps.
- Stores off pod 21 make the framework log "Invalid Pod ID" and are not CI-safe; keep those specs in this
  repo. A spec on an e2e store can also go to World as a PR, on its own branch, one file.
- Read the whole spec back once before running it: every `expect` should map to a sentence in the doc case.

## Where existing coverage lives

Login and customer-account flows for Shop Identity are covered by five suites. World paths are relative to
`~/world/trees/root/src`; zones missing from the sparse checkout are read with `git ls-files` and
`git show HEAD:<path>`, never `git pull`.

| Suite | Where | What it covers | Reuse |
| --- | --- | --- | --- |
| checkout-web | `areas/clients/checkout-web/e2e/` (on disk) | Checkout login: `tests/checkout/legacy-customer-account/`, Shop Pay sign-in under `tests/shop-pay/shared/` (remember-me, switch-accounts, user-consent, modal-flow, branded-button-flow, guest-mode), cookie-flow specs under `shop-pay-draft-order/` and `shop-pay-synthetic/`, Installments under `shop-pay-installments/` | Page objects `CustomerAccountLoginPage.ts`, `ClassicCustomerAccountPage.ts`, `ShopAppPage.ts`, `ShopPayOnePage.tsx`, `ThankYouPage.ts`; helpers `customer-account.ts`, `shop-pay.ts`, `shop-pay-buyer.ts`, `webauthn.ts`; stores in `store-configs.ts` |
| shop-js | GitHub `Shopify/shop-js`, `areas/clients/shop-js/e2e/` (not in World; use `github_search_code`) | Storefront sign-in: `tests/smoke/shop-identity/` (accountsLogin with SMS, horizonAccountsLogin via account modal, personalizedPayButton, shopCartSync, shopLeadCapture), `tests/daily/shop-identity/` (accountsLogin, accountsLogout, classicCustomerAccounts 1-click and register, tosLinks, windoid), `daily/shop-identity-single-project/` (fedcm, international), `synthetic/shop-identity/legacyCustomerAccounts`, `smoke/shop-identity-3p-cookies-only/` (recognition), `smoke/shop-identity-gdpr-restrictions/consentBanner` | `e2e/utils/pages/`: `ShopAccountLoginPage`, `ShopPayLoginPage`, `ShopAccountConnectionsPage`, `LegacyPasskeyEnrollmentPage`; `Storefront/`: `ClassicCustomerAccountsPage` (form `[data-login-with-shop-sign-in]`), `CustomerAuthenticationLoginPage`, `ShopifyAccountComponentPage`, `ShopLeadCapturePage`, `PasswordPage`, `CheckoutPage`, `ThankYouPage`; `ShopWeb/` account pages; fixtures `createFullyVerifiedUser*`; `e2e/utils/cookies` |
| customer-authentication-web | `areas/clients/customer-authentication-web/app/tests/e2e/` (index only) | New customer accounts login page: `tests/preact-login.spec.ts` (email, code, Orders heading, vanity domains, RTL, social login, policy modals) | `SignInEmailForm.ts`, `SignInCodeForm.ts`, `helpers/skipStoreFrontPassword.ts`, `helpers/policyModal.ts` |
| customer-account-web | `areas/clients/customer-account-web/app/tests/e2e/` (index only) | Post-login account pages: Orders, B2B/D2C, `Multipass-Login.spec.ts`, policy modal, markets, i18n, account-information mutations, `extension/` | `helpers/authenticate.ts` (OTP textbox named "code", password-page skip), `helpers/multipass.ts`, pages `CustomerAccountWebPage.ts`, `OrdersPage.ts`, `SettingsPage.ts` |
| Identity | `areas/platforms/identity/tests/e2e/` (on disk) | `login/login.spec.ts` (lookup), `login/login-with-code.spec.ts`, `passkey/login.spec.ts`, `unified-sessions/refresh-cycle.spec.ts`, folders mfa, oauth, signup, social-login, consent-gating, captcha, password-reset, saml | Guide `tests/e2e/e2e-playwright.md` |

shop-server has no browser suite; its `playwright-e2e` skill covers Bootstrap admin pages only. Map compiled
2026-09-30; folder names move, so trust `git ls-files` over this table when they disagree.

## Running

- Every run on all four browsers through `tools/run-browsers.sh <hunt> <run|all>`; one browser only when
  discriminating. WebKit here has no ITP, so Safari cookie behaviour is out of scope.
- Rebuild the report after every run, before saying anything about the result. Check the key stills by eye.
- Record the time of a run from the request-id suffix (epoch seconds), not from memory.
- Keep the meta file honest: `proves` holds only what the run shows, `caveats` holds what it assumes.

## When a spec fails

Climb this ladder and write down each rung in the README, including the rungs that changed nothing:

1. Rerun once. Read the failure by name: which `expect`, which request, which status.
2. Same spec with checkout-web's own `playwright.config.ts` (rules out the local browser config).
3. A control variant: the experiment forced to control, the ordinary sign-up path.
4. Change one input at a time: store, product amount, browser, benchmark identity.
5. Place it in time: request-id suffixes of the last pass and the first failure give the window.
6. Find the owner: the route in `config/routes.rb` of the relevant component, then the controller and the
   model it calls. `git log --since=<last pass> -- <path>` on those files.
7. Merges inside the window that touch adjacent code are candidates. Write "candidate, unverified" until a
   revert, a flag flip, or the author confirms it. Never write "caused by" on timing alone.

A failure that follows the store is a store or merchant configuration finding; one that follows the browser
is a client finding; one that follows the clock is a production change. Say which.

## Capturing cookies

Specs may read `_shopify_essential`, `_shop_app_essential` and the Pay session cookies with
`page.context().cookies()` and save them with the run. Both essential cookies are encrypted buyer.proto
sessions, so a test can assert presence, domain, expiry and whether the value changed between two moments,
but cannot read the contents. Save snapshots under `runs/spec-run-<id>/traces/` (gitignored) or as a test
attachment; the report and the shots never include values, and values never go into chat output. The repo is
public. The useful check for Remember Me is a second checkout on the same store that shows the buyer
recognised, not the cookie bytes.

## Writing it up

The hunt README has, in this order: the project and experiment; the runs table (run, store, spec, result
with per-browser durations, report link); one paragraph per run on what it proved and what it left open;
how to run; and an "Open items (resume here)" list. Every claim about production carries a request ID or a
file path. Nothing goes in that was not read from the trace, the code, Vault or Slack.

Before parking a hunt: rebuild every report, commit shots and reports but never `traces/`, update the runs
table, and fill in Open items so the next person can continue from the README alone.
