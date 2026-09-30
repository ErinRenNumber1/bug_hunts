/**
 * Local-only Playwright config for re-running bug hunt evidence specs on several
 * browsers. Not tracked in World; the canonical copy lives in ~/bug_hunts/tools/.
 * Reuses everything from the main config (fixtures, timeouts, globalSetup) and replaces
 * the project list with one project per browser profile. Any spec under e2e/tests can
 * run; pass the spec file on the command line.
 *
 *   npx playwright test --config playwright.bug-hunt.config.ts <spec> --project webkit --project firefox
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
  // Playwright-bundled engines (npx playwright install chromium webkit firefox)
  chromium: {device: 'Desktop Chrome'},
  webkit: {device: 'Desktop Safari'},
  firefox: {device: 'Desktop Firefox'},
  // Google Chrome installed on this Mac (channel), not Playwright's Chromium build
  chrome: {device: 'Desktop Chrome', channel: 'chrome'},
};

const config = {
  ...base,
  reporter: [
    ['list'],
    ['html', {open: 'never', outputFolder: process.env.PW_HTML_DIR ?? 'playwright-report'}],
    ['json', {outputFile: process.env.PW_JSON_OUT ?? 'test-results/bug-hunt-browsers.json'}],
  ],
  projects: Object.entries(BROWSERS).map(([name, {device, channel}]) => ({
    name,
    testDir: path.resolve('e2e', 'tests'),
    testMatch: '**/*.spec.ts',
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
