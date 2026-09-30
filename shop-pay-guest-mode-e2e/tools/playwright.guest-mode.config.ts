/**
 * Local-only Playwright config for re-running the Shop Pay guest mode evidence specs
 * on several browsers. Not tracked in World; the canonical copy lives in
 * ~/bug_hunts/shop-pay-guest-mode-e2e/tools/. Reuses everything from the main config
 * (fixtures, timeouts, globalSetup) and replaces the project list with one project per
 * browser profile, all pointing at the guest-mode specs.
 *
 *   npx playwright test --config playwright.guest-mode.config.ts <spec> --project webkit --project firefox
 *
 * Playwright names each test's artifact directory <spec>-<title>-<project>, so one run
 * over several projects leaves one trace.zip per browser under test-results/.
 */
import * as path from 'node:path';

import {devices} from '@playwright/test';

import base from './playwright.config';

type DeviceName = keyof typeof devices;

// Same suffix the main config's userAgent() adds. It keeps e2e traffic out of the
// identity graph and Bot Protection; a run without it would be treated as a real buyer.
const UA_SUFFIX = 'Playwright-checkout-e2e-tests/local';

const BROWSERS: Record<string, {device: DeviceName; channel?: string}> = {
  // Playwright-bundled engines (npx playwright install chromium|webkit|firefox)
  chromium: {device: 'Desktop Chrome'},
  webkit: {device: 'Desktop Safari'},
  firefox: {device: 'Desktop Firefox'},
  // Mobile profiles: emulated viewport, touch and user agent on the bundled engines
  'iphone-15': {device: 'iPhone 15'},
  'pixel-7': {device: 'Pixel 7'},
  // Branded browsers installed on this Mac (channel), not Playwright's build
  chrome: {device: 'Desktop Chrome', channel: 'chrome'},
  msedge: {device: 'Desktop Edge', channel: 'msedge'},
};

const config = {
  ...base,
  reporter: [
    ['list'],
    ['html', {open: 'never', outputFolder: process.env.PW_HTML_DIR ?? 'playwright-report'}],
    ['json', {outputFile: process.env.PW_JSON_OUT ?? 'test-results/guest-mode-browsers.json'}],
  ],
  projects: Object.entries(BROWSERS).map(([name, {device, channel}]) => ({
    name,
    testDir: path.resolve('e2e', 'tests'),
    testMatch: [
      '**/shop-pay/shared/guest-mode*.spec.ts',
      '**/shop-pay-installments/guest-mode*.spec.ts',
    ],
    timeout: 90_000,
    use: {
      ...devices[device],
      ...(channel ? {channel} : {}),
      userAgent: `${devices[device].userAgent} ${UA_SUFFIX}`,
      // Main config does the same for WebKit: Retina scale factor makes runs slow and flaky.
      ...(devices[device].defaultBrowserType === 'webkit' ? {deviceScaleFactor: 1} : {}),
      trace: 'on',
    },
  })),
};

export default config;
