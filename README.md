# bug_hunts

Evidence from hands-on bug hunts: the test scripts that were run, and a self-contained
`report.html` per run with screenshots, checkout tokens and request IDs.

| Hunt | What it covers |
| --- | --- |
| [shop-pay-guest-mode-e2e](shop-pay-guest-mode-e2e/) | Shop Pay guest mode (GSD 52301): new buyer lands straight in Pay checkout after email, no phone verification |

Playwright traces are deliberately excluded (see `.gitignore`); they contain live session cookies.
