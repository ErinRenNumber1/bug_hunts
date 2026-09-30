# bug_hunts

Evidence from hands-on bug hunts: the test scripts that were run, and a self-contained
`report.html` per spec with screenshots, checkout tokens and request IDs, one section per browser.

| Hunt | What it covers |
| --- | --- |
| [shop-pay-guest-mode-e2e](shop-pay-guest-mode-e2e/) | Shop Pay guest mode (GSD 52301): new buyer lands straight in Pay checkout after email, no phone verification |

`PLAYBOOK.md` describes how a hunt is run and written up, so the next one follows the same shape.
`tools/` holds the shared browser runner, Playwright config and report builder; each hunt folder holds only
its README, `specs.conf`, `specs/` and `runs/`.

Playwright traces are deliberately excluded (see `.gitignore`); they contain live session cookies.
