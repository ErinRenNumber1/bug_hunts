// Spec 4: three parts in one browser, one buyer.
//   A. Spec 3 in full on lucasmrichtest: guest-mode email, land in Pay checkout, reload, complete the
//      order. This creates a fresh email-only, unverified Shop account whose only phone is the
//      shipping-address phone typed at checkout, never verified.
//   B. Same browser opens reinis-test-store's customer account sign-in (new customer accounts, Sign in
//      with Shop). Expected: an email code, then a code sent to the part A phone, then signed in on the
//      account page. Confirmed as the intended behaviour on 2026-09-30 after runs 4 to 6 showed it.
//   C. Same browser opens a cart permalink on reinis-test-store. Expected: with the phone verified in
//      part B, the buyer goes straight into Pay checkout with the part A address and card vaulted, and no
//      further email, phone or SMS step.
// Untracked, local only. The guest-mode override header applies to every request in this context,
// including parts B and C.
import {expect, type Frame, type Locator, type Page} from '@playwright/test';

import {defaultAddress} from '../../../constants/address';
import {CheckoutButton} from '../../../helpers/navigation';
import {getRandomValidShopifyPaymentsCard} from '../../../helpers/payment';
import {generateUserLogin} from '../../../helpers/user';
import {testWithShopPayConfig as test} from '../../../store-configs';
import {SHOP_PAY_GUEST_MODE_EXPERIMENT} from '../../../test';

const SHOP_PAY_CHECKOUT_HOSTNAMES = new Set(['shop.app', 'pay.shopify.com']);

// reinis-test-store.myshopify.com, the direct-pay store from the bug hunt doc. /account/login
// 302s to shopify.com/<shopId>/account, then through /services/login_with_shop/buyer/start to
// shopify.com/authentication/<shopId>/login (customer-authentication-web). Shop id from that redirect.
const ACCOUNT_STORE = 'https://reinis-test-store.myshopify.com';
const ACCOUNT_SHOP_ID = '8013840406';
// heather-t-shirt-blue, 73.00, available, requires shipping (from /products.json on 2026-09-30)
const ACCOUNT_STORE_VARIANT_ID = '51304521662486';
const BENCHMARK_OTP = '000000';

type Root = Page | Frame;

// The customer-account login UI may render in the top document, inside a Sign in with Shop iframe,
// or in a popup window, and it re-renders between steps. Poll every page and frame in the context.
async function findAcrossFrames(
  page: Page,
  build: (root: Root) => Locator,
  description: string,
  timeout = 30_000,
): Promise<Locator> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const p of page.context().pages()) {
      for (const root of [p, ...p.frames()]) {
        const locator = build(root).first();
        if (await locator.isVisible().catch(() => false)) return locator;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${description}. URL: ${page.url()}`);
}

const otpField = (root: Root) =>
  root
    .getByRole('textbox', {name: /code|verification|verify your email|check your email|confirm it['’]s you/i})
    .or(root.getByTestId('otp-field'))
    .or(root.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength="6"], input[name*="code" i]'));

test.describe('[Shop Pay] Guest mode on lucasmrichtest, then reinis-test-store account sign-in and Shop Pay checkout', () => {
  test.use({
    baseURL: 'https://lucasmrichtest.myshopify.com',
    shopId: '60529737962',
    // snake-plant-laurentii, CAD 59, from /products.json
    variants: {physical: {id: '45684943880426'}},
    storefrontPassword: '',
    currency: 'CAD',
    experimentOverrides: {[SHOP_PAY_GUEST_MODE_EXPERIMENT]: 'treatment'},
  });

  test('guest-mode buyer: email then phone code at customer account sign-in, straight into Pay checkout on that store', async ({
    navigator,
    informationPage,
    shopPayOnePage,
    thankYouPage,
    page,
  }) => {
    test.setTimeout(240_000);
    const {email, phone} = generateUserLogin();

    // ---------- Part A: spec 3 ----------
    await test.step('A. Guest mode: straight into Pay checkout, survives a reload, order completes', async () => {
      await navigator.beginCheckout();
      await informationPage.locator.expressCheckout.wallets.shopPay.click();
      await shopPayOnePage.locator.shopPayLogin.submitEmail(email);

      await page.waitForURL(
        (url) => SHOP_PAY_CHECKOUT_HOSTNAMES.has(url.hostname) && url.pathname.endsWith('/shoppay'),
        {timeout: 30_000},
      );
      await shopPayOnePage.waitForCheckoutHydrated();
      await expect(shopPayOnePage.locator.vaultedContact.emailMatching(email)).toBeVisible();
      await shopPayOnePage.waitForButtonToBeVisible(CheckoutButton.PayNow);

      const urlBeforeReload = page.url();
      await page.reload({waitUntil: 'domcontentloaded'});
      await page.waitForLoadState('networkidle').catch(() => {});
      expect(page.url(), 'Expected to stay on Pay checkout after reload').toMatch(/\/shoppay(?:[?#]|$)/);
      expect(new URL(page.url()).hostname).toBe(new URL(urlBeforeReload).hostname);
      await shopPayOnePage.waitForCheckoutHydrated();
      await expect(shopPayOnePage.locator.vaultedContact.emailMatching(email)).toBeVisible();
      await shopPayOnePage.waitForButtonToBeVisible(CheckoutButton.PayNow);

      await shopPayOnePage.locator.shippingAddress.fill(defaultAddress);
      await shopPayOnePage.locator.shippingAddress.fields.phone.fill(phone);
      await shopPayOnePage.waitForShippingToFinishCalculating();
      await shopPayOnePage.locator.creditCard.fill({cardNumber: getRandomValidShopifyPaymentsCard()});

      const waitForRememberMeRequest = thankYouPage.waitForRememberMeRequest();
      await shopPayOnePage.clickPayNowAndWaitForOrderConfirmation(thankYouPage);
      await waitForRememberMeRequest;
      await expect(thankYouPage.orderCompletedWithShopPayMessage).toBeVisible();
    });

    // ---------- Part B: customer account sign-in, email code then phone code ----------
    const onAccountPage = (url: URL) =>
      url.hostname === 'shopify.com' &&
      url.pathname.startsWith(`/${ACCOUNT_SHOP_ID}/account`) &&
      !url.pathname.includes('/authentication/');

    await test.step('B1. Open reinis-test-store customer account sign-in', async () => {
      await page.goto(`${ACCOUNT_STORE}/account/login`, {waitUntil: 'domcontentloaded'});
      await page.waitForURL(
        (url) =>
          (url.hostname === 'shopify.com' && url.pathname.startsWith(`/authentication/${ACCOUNT_SHOP_ID}/`)) ||
          url.hostname === 'shop.app' ||
          onAccountPage(url),
        {timeout: 30_000},
      );
    });

    // Run 2's trace: shopify.com/authentication/<shop>/login renders "Continue with Shop" as a
    // pointer-events-none button under div[data-testid="login-button-container"], which takes the
    // click. The click opens a popup window at shop.app/accounts/login (ux_mode=windoid,
    // authentication_level=email, sign_up_enabled=false) showing the ordinary Accounts email step
    // (form EmailInputStepView, input IdentityEmailForm-email-input). The buyer was not recognised
    // there despite the part A session. So: click the container, catch the popup, type the email in it.
    let popup: Page | null = null;

    await test.step('B2. Continue with Shop opens the Shop sign-in window; enter the email there', async () => {
      const container = page.getByTestId('login-button-container');
      const shopButton = page.getByRole('button', {name: /continue with shop/i});
      await container.or(shopButton).first().waitFor({state: 'visible', timeout: 30_000});

      const popupPromise = page.context().waitForEvent('page', {timeout: 20_000}).catch(() => null);
      if (await container.first().isVisible().catch(() => false)) {
        await container.first().click();
      } else {
        await shopButton.first().click({force: true});
      }
      popup = await popupPromise;
      if (!popup) {
        throw new Error(`Continue with Shop did not open the Shop sign-in window. URL: ${page.url()}`);
      }
      await popup.waitForLoadState('domcontentloaded');

      const emailField = popup.getByTestId('IdentityEmailForm-email-input').or(popup.getByRole('textbox', {name: /email/i}));
      await emailField.first().waitFor({state: 'visible', timeout: 30_000});
      await emailField.first().fill(email);
      await popup.getByRole('button', {name: /^continue$/i}).first().click();
    });

    await test.step('B3. Email code first (no phone number entry), enter the benchmark code', async () => {
      // An unverified session must not be enough on its own (bug hunt case 15). If the account page
      // shows up before any code was asked for, fail with a message that says so.
      if (onAccountPage(new URL(page.url()))) {
        throw new Error('Signed in to the customer account without being asked for a code');
      }
      const code = await findAcrossFrames(page, otpField, 'an email verification code field');
      for (const p of page.context().pages()) {
        await expect(
          p.getByRole('textbox', {name: /phone/i}),
          'Did not expect a phone number field at customer account sign-in for an email-only buyer',
        ).toHaveCount(0);
      }
      await expect(
        (popup ?? page).getByText(/confirm your email|check your email|verify your email/i).first(),
        'Expected the email verification step',
      ).toBeVisible({timeout: 10_000});
      await code.fill(BENCHMARK_OTP);
      // Most OTP fields auto-submit on the sixth digit. Run 3 clicked a generic Continue across every
      // page and hit the main page's empty email form (POST /authentication/<shop>/login -> 400,
      // "Couldn't sign you in"), so only click a submit that sits in the same window as the code field.
      const submit = code.page().getByRole('button', {name: /^(continue|submit|verify)$/i}).first();
      if (await submit.isVisible().catch(() => false)) await submit.click().catch(() => {});
    });

    await test.step('B3b. Phone code sent to the part A phone; enter the benchmark code', async () => {
      // Runs 4 to 6 (2026-09-30): after the email code, the Shop window shows "Verify your phone, Enter
      // code sent to +1 ••• ••• •NNN", the shipping-address phone typed in part A, which was never
      // verified. Erin confirmed this is the intended behaviour, so it is now a hard expectation.
      const root = popup ?? page;
      await expect(root.getByText(/verify your phone/i).first(), 'Expected a phone code step after the email code').toBeVisible({
        timeout: 15_000,
      });
      await test.info().attach('popup-phone-step', {body: await root.screenshot(), contentType: 'image/png'});
      const phoneCode = root.getByRole('textbox', {name: /verify your phone|code/i}).or(root.locator('input[autocomplete="one-time-code"]')).first();
      await phoneCode.waitFor({state: 'visible', timeout: 10_000});
      await phoneCode.fill(BENCHMARK_OTP);
      const submit = root.getByRole('button', {name: /^(continue|submit|verify)$/i}).first();
      if (await submit.isVisible().catch(() => false)) await submit.click().catch(() => {});
    });

    await test.step('B4. Signed in: lands on the customer account page', async () => {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && !onAccountPage(new URL(page.url()))) {
        await page.waitForTimeout(500);
      }
      if (!onAccountPage(new URL(page.url()))) {
        // Say what both windows show instead of a bare navigation timeout.
        const describe = async (p: Page | null, label: string) => {
          if (!p || p.isClosed()) return `${label}: closed`;
          const text = await p.locator('body').innerText({timeout: 2_000}).catch(() => '(no text)');
          await test.info().attach(label, {body: await p.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png'});
          return `${label}: ${p.url()} :: ${text.replace(/\s+/g, ' ').slice(0, 400)}`;
        };
        throw new Error(
          `Did not reach the customer account page within 45s.\n${await describe(page, 'main')}\n${await describe(popup, 'popup')}`,
        );
      }
      await expect(
        page.getByRole('heading', {name: /orders|account|welcome/i}).first(),
        'Expected an account page heading after sign-in',
      ).toBeVisible({timeout: 30_000});
    });

    // ---------- Part C: cart permalink on reinis-test-store goes straight into Pay checkout ----------
    // Runs 4 to 6: with the buyer signed in to the customer account, /cart/<variant>:1 never reaches a
    // merchant checkout page. It goes /cart -> shopify.com/authentication/.../oauth/authorize (silent)
    // -> /customer_authentication/callback -> /cart?shop_sign_in=true -> shop.app/pay/session/
    // create_and_redirect -> shop.app/checkout/<shop>/cn/<token>/en-ca/shoppay. Erin confirmed this is
    // the intended behaviour: the phone was verified in part B, so Shop Pay has nothing left to ask.
    const isPayCheckoutUrl = (url: URL) => SHOP_PAY_CHECKOUT_HOSTNAMES.has(url.hostname) && url.pathname.endsWith('/shoppay');

    await test.step('C1. Cart permalink on reinis-test-store lands directly in Pay checkout', async () => {
      await page.goto(`${ACCOUNT_STORE}/cart/${ACCOUNT_STORE_VARIANT_ID}:1`, {waitUntil: 'domcontentloaded'});
      await page.waitForURL((url) => url.pathname.includes('/checkouts/') || isPayCheckoutUrl(url), {timeout: 45_000});
      await test.info().attach('reinis-cart-permalink-landing', {body: await page.screenshot(), contentType: 'image/png'});
      expect(isPayCheckoutUrl(new URL(page.url())), `Expected Pay checkout, got a merchant checkout page: ${page.url()}`).toBe(true);
    });

    await test.step('C2. Pay checkout is vaulted for the same email, with no email, phone or SMS step', async () => {
      await shopPayOnePage.waitForCheckoutHydrated();
      const login = shopPayOnePage.locator.shopPayLogin;
      await expect(login.fields.email, 'Did not expect an email field at Pay checkout').toHaveCount(0);
      await expect(login.fields.phone, 'Did not expect a phone field at Pay checkout').toHaveCount(0);
      await expect(login.emailVerificationStep, 'Did not expect an email code at Pay checkout').toHaveCount(0);
      await expect(login.phoneVerificationStep, 'Did not expect a phone code at Pay checkout').toHaveCount(0);
      await expect(shopPayOnePage.locator.vaultedContact.emailMatching(email)).toBeVisible();
      await expect(page.getByRole('button', {name: /pay now/i}), 'Expected the vaulted Pay now button').toBeVisible({timeout: 30_000});
      await test.info().attach('reinis-pay-checkout', {body: await page.screenshot(), contentType: 'image/png'});
    });
  });
});
