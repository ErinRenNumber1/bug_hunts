// Local, untracked copy of guest-mode.spec.ts pointed at lucasmrichtest.myshopify.com
// (the "direct payment" store from the GSD 52301 bug-hunt doc). Not meant to be committed.
import {expect} from '@playwright/test';

import {defaultAddress} from '../../../constants/address';
import {CheckoutButton} from '../../../helpers/navigation';
import {getRandomValidShopifyPaymentsCard} from '../../../helpers/payment';
import {generateUserLogin} from '../../../helpers/user';
import {testWithShopPayConfig as test} from '../../../store-configs';
import {SHOP_PAY_GUEST_MODE_EXPERIMENT} from '../../../test';

const SHOP_PAY_CHECKOUT_HOSTNAMES = new Set(['shop.app', 'pay.shopify.com']);

test.describe('[Shop Pay] Guest mode on lucasmrichtest', () => {
  // Swap the store underneath testWithShopPayConfig. Everything else (genghis token,
  // page objects, benchmark identities) is store-independent.
  test.use({
    baseURL: 'https://lucasmrichtest.myshopify.com',
    shopId: '60529737962',
    // snake-plant-laurentii, CAD 59, from /products.json
    variants: {physical: {id: '45684943880426'}},
    storefrontPassword: '',
    currency: 'CAD',
    experimentOverrides: {[SHOP_PAY_GUEST_MODE_EXPERIMENT]: 'treatment'},
  });

  test('new buyer enters guest mode after email and completes an order', async ({
    navigator,
    informationPage,
    shopPayOnePage,
    thankYouPage,
    page,
  }) => {
    const {email, phone} = generateUserLogin();

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

    // Canadian store: use the CA default address instead of defaultUSAddress.
    await shopPayOnePage.locator.shippingAddress.fill(defaultAddress);
    await shopPayOnePage.locator.shippingAddress.fields.phone.fill(phone);
    await shopPayOnePage.waitForShippingToFinishCalculating();
    await shopPayOnePage.locator.creditCard.fill({cardNumber: getRandomValidShopifyPaymentsCard()});

    const waitForRememberMeRequest = thankYouPage.waitForRememberMeRequest();
    await shopPayOnePage.clickPayNowAndWaitForOrderConfirmation(thankYouPage);
    const rememberMeResponse = await waitForRememberMeRequest;

    await expect(thankYouPage.orderCompletedWithShopPayMessage).toBeVisible();
    expect(
      await rememberMeResponse.headerValues('set-cookie'),
      'Expected Remember Me to persist the Shop Pay session',
    ).toContainEqual(expect.stringMatching(/^_shopify_essential=[^;]+/));
  });
});
