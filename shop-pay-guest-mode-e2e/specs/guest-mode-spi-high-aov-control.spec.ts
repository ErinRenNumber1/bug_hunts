// Spec 5 control: the same Installments purchase on spi-high-aov with guest mode OFF (experiment forced
// to control), so the buyer signs up with email, phone and SMS code the ordinary way before checkout.
// Spec 5 hit 422 checkout_error on POST /pay/transactions/<token>/agreements at USD 350 and USD 100 while
// John's guest-mode spec passed on spi-e2e-testing; this run tells whether the store fails without guest
// mode too. Untracked, local only: the store is not on the e2e pod.
import {expect} from '@playwright/test';

import {defaultUSAddress} from '../../constants/address';
import {getRandomValidShopifyPaymentsCard} from '../../helpers/payment';
import {completePurchaseAndConfirmWithIframeRecovery} from '../../helpers/recovery/shop-pay-installments/complete-purchase-and-confirm';
import {serverNegotiatedAffirmIframeRecovery} from '../../helpers/recovery/shop-pay-installments/iframe-recovery-config';
import {testWithShopPayInstallmentsConfig as test} from '../../store-configs';
import {SHOP_PAY_GUEST_MODE_EXPERIMENT} from '../../test';
import {TIMINGS} from '../shop-pay-external/timings';

const SPI_VARIANT = process.env.SPI_HIGH_AOV_VARIANT ?? '55322433454221';
const BENCHMARK_OTP = '000000';
const AGREEMENTS_REQUEST = /\/pay\/transactions\/[^/]+\/agreements$/;
const INSTALLMENTS_UNAVAILABLE = /We.re experiencing technical issues|Installments aren.t available at this time/i;

test.describe('[Shop Pay Installments] spi-high-aov control (guest mode off)', () => {
  test.use({
    baseURL: 'https://spi-high-aov.myshopify.com',
    shopId: '59271905336',
    variants: {physical: {id: SPI_VARIANT}, physical_cheap: {id: SPI_VARIANT}},
    storefrontPassword: '',
    forceCheckoutExperience: 'onepage',
    country: 'US',
    experimentOverrides: {[SHOP_PAY_GUEST_MODE_EXPERIMENT]: 'control'},
  });

  test('buyer who signs up with email, phone and SMS code completes an Installments order', async ({
    navigator,
    page,
    shopPayOnePage,
    thankYouPage,
  }) => {
    test.setTimeout(TIMINGS.TOTAL_TEST_TIME_WITH_INSTALLMENTS);

    const agreementsResponses: string[] = [];
    page.on('response', async (response) => {
      if (response.request().method() !== 'POST') return;
      if (AGREEMENTS_REQUEST.test(new URL(response.url()).pathname)) {
        const body = await response.text().catch(() => '');
        agreementsResponses.push(`${response.status()} ${body.slice(0, 300)}`);
      }
    });

    await test.step('C1. Ordinary sign-up: email, phone, SMS code', async () => {
      await navigator.beginCheckout({forceShopPay: true});
      await shopPayOnePage.locator.shopPayLogin.signUp({phoneCountryCode: 'US'});
      await shopPayOnePage.waitForCheckoutHydrated();
      await test.info().attach('control-signed-up', {body: await page.screenshot(), contentType: 'image/png'});
    });

    await test.step('C2. Address, Installments, card', async () => {
      await shopPayOnePage.locator.shippingAddress.fill(defaultUSAddress);
      await shopPayOnePage.waitForShippingToFinishCalculating();
      await shopPayOnePage.locator.paymentOption.payInInstallments.check();
      await shopPayOnePage.locator.creditCard.fill({cardNumber: getRandomValidShopifyPaymentsCard()});
      await shopPayOnePage.waitForShippingToFinishCalculating();
      await test.info().attach('control-installments-selected', {body: await page.screenshot(), contentType: 'image/png'});
    });

    await test.step('C3. Continue to payment plans (phone code only if asked)', async () => {
      await shopPayOnePage.continueToPaymentPlansButton.click();
      const otp = shopPayOnePage.installments.affirmModal.phoneOtpInput;
      const affirmBody = page.frameLocator('#shop-pay-affirm-iframe').locator('body');
      await expect(otp.or(affirmBody).first()).toBeVisible({timeout: 30_000});
      if (await otp.isVisible()) {
        await test.info().attach('control-phone-otp', {body: await page.screenshot(), contentType: 'image/png'});
        await shopPayOnePage.installments.affirmModal.enterPhoneOtp(BENCHMARK_OTP);
      }
    });

    await test.step('C4. Affirm identity verification, then complete the purchase', async () => {
      const recovery = serverNegotiatedAffirmIframeRecovery(shopPayOnePage.continueToPaymentPlansButton);
      await shopPayOnePage.installments.affirmModal.identityVerificationWithRetry({recovery});
      await test.info().attach('control-affirm-identity-done', {body: await page.screenshot(), contentType: 'image/png'});

      const affirmFrame = page.frameLocator('#shop-pay-affirm-iframe');
      const reviewStep = affirmFrame.getByRole('button', {name: /Complete purchase|Accept Terms & Purchase/});
      const unavailable = affirmFrame.getByText(INSTALLMENTS_UNAVAILABLE);
      await expect(reviewStep.or(unavailable).first()).toBeVisible({timeout: 30_000});
      if (await unavailable.isVisible()) {
        await test.info().attach('control-installments-unavailable', {body: await page.screenshot(), contentType: 'image/png'});
        throw new Error(
          `Affirm reported Installments unavailable with guest mode off. POST /agreements responses: ${
            agreementsResponses.join(' | ') || 'none seen'
          }`,
        );
      }

      await completePurchaseAndConfirmWithIframeRecovery({
        page,
        submit: () => shopPayOnePage.installments.affirmModal.completePurchase({recovery}),
        confirmReceipt: () => thankYouPage.expectOrderConfirmation(TIMINGS.RECEIPT_COMPLETION_TIME),
      });
    });

    await test.step('C5. Order confirmed', async () => {
      await expect(thankYouPage.orderCompletedWithShopPayMessage).toBeVisible();
      await test.info().attach('control-order-confirmed', {body: await page.screenshot(), contentType: 'image/png'});
    });
  });
});
