// Spec 5: bug hunt doc case 4 ("New buyer — Installments") on the store the bug hunt used.
// A guest-mode buyer on spi-high-aov must see no Installments address banner while the
// shipping form is still empty (PR 1021476, merged 2026-09-23), must be asked for an SMS
// code when Installments underwriting starts (the phone guest mode skipped), and must
// complete a payment-plan order. Untracked, local only: the store is not on the e2e pod.
import {expect} from '@playwright/test';

import {defaultUSAddress} from '../../constants/address';
import {getRandomValidShopifyPaymentsCard} from '../../helpers/payment';
import {completePurchaseAndConfirmWithIframeRecovery} from '../../helpers/recovery/shop-pay-installments/complete-purchase-and-confirm';
import {serverNegotiatedAffirmIframeRecovery} from '../../helpers/recovery/shop-pay-installments/iframe-recovery-config';
import {generateUserLogin} from '../../helpers/user';
import {testWithShopPayInstallmentsConfig as test} from '../../store-configs';
import {SHOP_PAY_GUEST_MODE_EXPERIMENT} from '../../test';
import {TIMINGS} from '../shop-pay-external/timings';

const SHOP_PAY_CHECKOUT_HOSTNAMES = new Set(['shop.app', 'pay.shopify.com']);
const BENCHMARK_OTP = '000000';
// product-with-unit-price USD 350 by default (what the bug hunt used). SPI_HIGH_AOV_VARIANT=68589829914646
// swaps in product-with-variants Medium, USD 100, to test whether the agreement failure is amount-bound.
const SPI_VARIANT = process.env.SPI_HIGH_AOV_VARIANT ?? '55322433454221';
// installments_condition_shipping_address with the US adjective (generated/translations/en.json).
const ADDRESS_BANNER = /Installments can only be used to ship to a valid US address/i;
const REMEMBER_ME_REQUEST = /shopify_pay\/.+\/remember_me/;
const AGREEMENTS_REQUEST = /\/pay\/transactions\/[^/]+\/agreements$/;
// installments.retryable / generic copy shown inside the Affirm iframe when the agreement fails.
const INSTALLMENTS_UNAVAILABLE = /We.re experiencing technical issues|Installments aren.t available at this time/i;

test.describe('[Shop Pay Installments] Guest mode on spi-high-aov (bug hunt case 4)', () => {
  test.use({
    // Swap the store underneath testWithShopPayInstallmentsConfig. shop 59271905336,
    // USD, US, no storefront password, offers_shop_pay_installments (meta.json).
    baseURL: 'https://spi-high-aov.myshopify.com',
    shopId: '59271905336',
    // product-with-unit-price, USD 350, requires shipping (products.json)
    variants: {physical: {id: SPI_VARIANT}, physical_cheap: {id: SPI_VARIANT}},
    storefrontPassword: '',
    forceCheckoutExperience: 'onepage',
    // Installments is US-only. Starting as a US buyer avoids a country change mid-fill.
    country: 'US',
    experimentOverrides: {[SHOP_PAY_GUEST_MODE_EXPERIMENT]: 'treatment'},
  });

  test('guest-mode buyer sees no premature address banner, gets an SMS code at underwriting, and completes an Installments order', async ({
    navigator,
    page,
    shopPayOnePage,
    thankYouPage,
  }) => {
    test.setTimeout(TIMINGS.TOTAL_TEST_TIME_WITH_INSTALLMENTS);

    const {email, phone} = generateUserLogin({phoneCountryCode: 'US'});
    const login = shopPayOnePage.locator.shopPayLogin;
    const addressBanner = page.getByText(ADDRESS_BANNER);
    const payInInstallments = shopPayOnePage.locator.paymentOption.payInInstallments;

    // Recorded passively so nothing here can time out ahead of the Affirm flow (attempt 1's design bug).
    const agreementsResponses: string[] = [];
    const rememberMeSetCookies: string[] = [];
    page.on('response', async (response) => {
      const request = response.request();
      if (request.method() !== 'POST') return;
      if (AGREEMENTS_REQUEST.test(new URL(response.url()).pathname)) {
        const body = await response.text().catch(() => '');
        agreementsResponses.push(`${response.status()} ${body.slice(0, 300)}`);
      } else if (REMEMBER_ME_REQUEST.test(response.url()) && response.ok()) {
        rememberMeSetCookies.push(...(await response.headerValues('set-cookie').catch(() => [])));
      }
    });

    await test.step('A1. New email at the Shop Pay sign-in lands directly in Pay checkout', async () => {
      await navigator.beginCheckout({forceShopPay: true});
      await login.submitEmail(email);
      await page.waitForURL(
        (url) => SHOP_PAY_CHECKOUT_HOSTNAMES.has(url.hostname) && url.pathname.endsWith('/shoppay'),
        {timeout: 30_000},
      );
      await shopPayOnePage.waitForCheckoutHydrated();
      await expect(shopPayOnePage.locator.vaultedContact.emailMatching(email)).toBeVisible();
      await expect(login.fields.phone, 'Guest mode must not ask for a phone at sign-in').toHaveCount(0);
      await expect(login.phoneVerificationStep, 'Guest mode must not ask for a phone code at sign-in').toHaveCount(0);
    });

    await test.step('A2. No Installments address banner while the shipping form is still empty', async () => {
      // PR 1021476: region defaults alone must not make the address ineligible.
      await expect(payInInstallments, 'Expected the Installments option to be offered').toBeVisible({timeout: 15_000});
      await expect(addressBanner, 'Premature address banner on an empty shipping form').toHaveCount(0);
      await expect(payInInstallments, 'Expected the Installments option to be enabled').toBeEnabled();
      await test.info().attach('empty-form-no-banner', {body: await page.screenshot({fullPage: true}), contentType: 'image/png'});
    });

    await test.step('A3. Fill a US shipping address and phone', async () => {
      await shopPayOnePage.locator.shippingAddress.fill(defaultUSAddress);
      await shopPayOnePage.locator.shippingAddress.fields.phone.fill(phone);
      await shopPayOnePage.waitForShippingToFinishCalculating();
    });

    await test.step('A4. Banner still absent with a valid US address', async () => {
      await expect(addressBanner, 'Address banner appeared for a valid US address').toHaveCount(0);
      await expect(payInInstallments).toBeEnabled();
      await test.info().attach('address-filled-no-banner', {body: await page.screenshot({fullPage: true}), contentType: 'image/png'});
    });

    await test.step('A5. Choose Pay in installments and add a card', async () => {
      await payInInstallments.check();
      await shopPayOnePage.locator.creditCard.fill({cardNumber: getRandomValidShopifyPaymentsCard()});
      await shopPayOnePage.waitForShippingToFinishCalculating();
      await test.info().attach('installments-selected', {body: await page.screenshot(), contentType: 'image/png'});
    });

    await test.step('A6. Underwriting asks for an SMS code to the part A phone; enter the benchmark code', async () => {
      // Same choreography as ShopPayOnePage.continueAndEnterPhoneOtp, split so the OTP
      // step itself is asserted and captured before the code is entered.
      const verificationWaiter = page.waitForResponse(
        (response) =>
          response.url().includes('/pay/verifications') &&
          response.request().method() === 'POST' &&
          response.status() === 201,
        {timeout: 30_000},
      );
      await shopPayOnePage.continueToPaymentPlansButton.click();
      const verificationResponse = await verificationWaiter;
      // The iframe reads the verification token from the body; wait for it before typing.
      await verificationResponse.finished();
      const otp = shopPayOnePage.installments.affirmModal.phoneOtpInput;
      await expect(otp, 'Expected a phone code step when Installments underwriting started').toBeVisible({timeout: 30_000});
      await test.info().attach('installments-phone-otp', {body: await page.screenshot(), contentType: 'image/png'});
      await shopPayOnePage.installments.affirmModal.enterPhoneOtp(BENCHMARK_OTP);
    });

    await test.step('A7. Affirm identity verification, then complete the purchase', async () => {
      const recovery = serverNegotiatedAffirmIframeRecovery(shopPayOnePage.continueToPaymentPlansButton);
      await shopPayOnePage.installments.affirmModal.identityVerificationWithRetry({recovery});
      await test.info().attach('affirm-identity-done', {body: await page.screenshot(), contentType: 'image/png'});

      // Attempt 1 failed here: POST /agreements returned 422 {"errors":[{"error":"checkout_error"}]} and the
      // iframe showed "We're experiencing technical issues". Fail on that outcome by name instead of letting
      // the 30s complete-purchase retry loop and the remember-me waiter race each other.
      const affirmFrame = page.frameLocator('#shop-pay-affirm-iframe');
      const reviewStep = affirmFrame.getByRole('button', {name: /Complete purchase|Accept Terms & Purchase/});
      const unavailable = affirmFrame.getByText(INSTALLMENTS_UNAVAILABLE);
      await expect(reviewStep.or(unavailable).first()).toBeVisible({timeout: 30_000});
      if (await unavailable.isVisible()) {
        await test.info().attach('installments-unavailable', {body: await page.screenshot(), contentType: 'image/png'});
        throw new Error(
          `Affirm reported Installments unavailable after identity verification. POST /agreements responses: ${
            agreementsResponses.join(' | ') || 'none seen'
          }`,
        );
      }

      await completePurchaseAndConfirmWithIframeRecovery({
        page,
        submit: () => shopPayOnePage.installments.affirmModal.completePurchase({recovery}),
        confirmReceipt: () => thankYouPage.expectOrderConfirmation(TIMINGS.RECEIPT_COMPLETION_TIME),
      });
      expect(rememberMeSetCookies, 'Expected Remember Me to persist the Shop Pay session').toContainEqual(
        expect.stringMatching(/^_shopify_essential=[^;]+/),
      );
    });

    await test.step('A8. Order confirmed', async () => {
      await expect(thankYouPage.orderCompletedWithShopPayMessage).toBeVisible();
      await test.info().attach('order-confirmed', {body: await page.screenshot(), contentType: 'image/png'});
    });
  });
});
