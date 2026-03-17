import type { CartSummary } from "./client.js";
import {
  AMAZON_BASE,
  cdpEval,
  handleResult,
  prepareRequest,
  runWithBackoff,
  sendRelayCommand,
} from "./client.js";

/**
 * Add an item to the Amazon cart.
 * First fetches the product page to extract the offerListingID required by Amazon.
 */
export async function addToCart(opts: {
  asin: string;
  quantity?: number;
  isFresh?: boolean;
  verbose?: boolean;
}): Promise<CartSummary> {
  const { tabId } = await prepareRequest();
  const quantity = opts.quantity ?? 1;
  const productUrl = `${AMAZON_BASE}/dp/${opts.asin}`;

  // Non-Fresh: navigate + click approach
  // Amazon's handle-buy-box endpoint rejects fetch() requests (returns 404)
  // because it checks Sec-Fetch-* headers that only real browser form
  // submissions provide. So for non-Fresh items we navigate the actual
  // Chrome tab to the product page and click the Add to Cart button.
  if (!opts.isFresh) {
    return runWithBackoff(async () => {
      // Step 1: Navigate to the product page
      await sendRelayCommand({ action: "navigate", tabId, url: productUrl });

      // Step 2: Wait for the page to load and the Add to Cart button to appear
      let buttonClicked = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 1000));
        const clickResult = (await cdpEval(
          tabId,
          `
          (function() {
            try {
              // Check if we're on the right product page
              var titleEl = document.querySelector('#productTitle');
              if (!titleEl) return JSON.stringify({ ready: false, reason: 'no product title yet' });

              // Set quantity if needed
              ${
                quantity > 1
                  ? `
              var qtySelect = document.querySelector('#quantity');
              if (qtySelect) {
                qtySelect.value = '${quantity}';
                qtySelect.dispatchEvent(new Event('change', { bubbles: true }));
              }
              `
                  : ""
              }

              // Find and click the Add to Cart button
              var btn = document.querySelector('#add-to-cart-button')
                     || document.querySelector('input[name="submit.add-to-cart"]')
                     || document.querySelector('#submit\\.add-to-cart');
              if (!btn) return JSON.stringify({ ready: true, clicked: false, reason: 'no add-to-cart button found' });

              btn.click();
              return JSON.stringify({ ready: true, clicked: true, buttonId: btn.id || btn.name });
            } catch(e) {
              return JSON.stringify({ ready: false, reason: e.message });
            }
          })()
        `,
        )) as Record<string, unknown>;

        if (clickResult && clickResult.clicked) {
          buttonClicked = true;
          break;
        }
      }

      if (!buttonClicked) {
        throw new Error(
          "Could not find or click the Add to Cart button on the product page after 10 seconds.",
        );
      }

      // Step 3: Wait for the cart confirmation page to load and extract cart info
      await new Promise((r) => setTimeout(r, 2000)); // initial wait for navigation
      let cartData: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const confirmResult = (await cdpEval(
          tabId,
          `
          (function() {
            try {
              var title = document.title || '';
              // Check for cart/confirmation page indicators
              var confirmEl = document.querySelector('#huc-v2-order-row-confirm-text')
                           || document.querySelector('#NATC_SMART_WAGON_CONF_MSG_SUCCESS')
                           || document.querySelector('#sw-atc-confirmation')
                           || document.querySelector('.a-alert-heading');
              var isCartPage = title.toLowerCase().indexOf('cart') !== -1
                            || title.toLowerCase().indexOf('added') !== -1;
              var confirmText = confirmEl ? confirmEl.textContent.trim().substring(0, 100) : '';
              var isConfirmed = confirmText.toLowerCase().indexOf('added') !== -1 || isCartPage;

              if (!isConfirmed) return JSON.stringify({ confirmed: false, pageTitle: title });

              // Extract cart count
              var cartCountEl = document.querySelector('#nav-cart-count');
              var cartCount = cartCountEl ? cartCountEl.textContent.trim() : '0';

              // Extract subtotal if visible
              var subtotalEl = document.querySelector('#sc-subtotal-amount-activecart')
                            || document.querySelector('.a-text-bold .sc-price');
              var subtotal = subtotalEl ? subtotalEl.textContent.trim() : '';

              return JSON.stringify({
                confirmed: true,
                pageTitle: title,
                confirmText: confirmText.substring(0, 50),
                cartCount: cartCount,
                subtotal: subtotal,
              });
            } catch(e) {
              return JSON.stringify({ confirmed: false, reason: e.message });
            }
          })()
        `,
        )) as Record<string, unknown>;

        if (confirmResult && confirmResult.confirmed) {
          cartData = confirmResult;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Build the cart summary
      const items = [
        {
          cartItemId: opts.asin,
          asin: opts.asin,
          title: "",
          quantity: quantity,
          price: "",
          isFresh: false,
        },
      ];

      const cart: CartSummary & { __debug?: unknown; __verbose?: unknown } = {
        items,
        subtotal: (cartData?.subtotal as string) || "",
        itemCount:
          parseInt((cartData?.cartCount as string) || "0", 10) || items.length,
      };

      if (!cartData?.confirmed) {
        // Button was clicked but we couldn't confirm. It likely still worked
        // (Amazon sometimes shows interstitials). Return optimistic result.
        cart.__debug = {
          warning: "Could not confirm cart page, but button click succeeded.",
        };
      } else {
        cart.__debug = {
          confirmText: cartData.confirmText,
          cartCount: cartData.cartCount,
          pageTitle: cartData.pageTitle,
        };
      }

      return cart;
    });
  }

  // Fresh items: fetch-based approach (works fine)
  return runWithBackoff(async () => {
    const script = `
      (async function() {
        try {
          // Fetch the product page to extract Fresh-specific payload
          var dpResp = await fetch(${JSON.stringify(productUrl)}, {
            credentials: 'include',
            headers: { 'Accept': 'text/html,application/xhtml+xml' }
          });
          if (dpResp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (dpResp.status === 403) return JSON.stringify({ __status: 403, __error: true });

          var html = await dpResp.text();
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');

          // Extract anti-CSRF token
          var antiCsrf = '';
          var csrfMeta = doc.querySelector('meta[name="anti-csrftoken-a2z"]');
          if (csrfMeta && csrfMeta.content) {
            antiCsrf = csrfMeta.content;
          } else {
            var csrfInp = doc.querySelector('input[name="anti-csrftoken-a2z"]');
            if (csrfInp && csrfInp.value) { antiCsrf = csrfInp.value; }
            else { var m = document.cookie.match(/anti-csrftoken-a2z=([^;]+)/); if (m) antiCsrf = decodeURIComponent(m[1]); }
          }

          // Extract csrfToken from product page
          var csrfInput = doc.querySelector('input[name="csrfToken"]');
          var csrfToken = csrfInput ? csrfInput.value : '';
          if (!csrfToken) {
            var csrfMatch = html.match(/"csrfToken"\\s*:\\s*"([^"\\\\]+)"/);
            if (csrfMatch) csrfToken = csrfMatch[1];
          }
          if (!csrfToken) { var ck = document.cookie.match(/csrf-main=([^;]+)/); if (ck) csrfToken = decodeURIComponent(ck[1]); }

          // Fresh add-to-cart: extract the EXACT payload Amazon embeds in the
          // data-fresh-add-to-cart attribute on the product page.
          var freshAtcEl = doc.querySelector('[data-action="fresh-add-to-cart"]');
          var freshPayload;
          if (freshAtcEl && freshAtcEl.getAttribute('data-fresh-add-to-cart')) {
            freshPayload = JSON.parse(freshAtcEl.getAttribute('data-fresh-add-to-cart'));
            freshPayload.qsUID = 'atfc-' + (freshPayload.clientID || 'fresh-dp') + '-' + Date.now();
            freshPayload.prevSelectedQty = 0;
            freshPayload.isStepperFlag = false;
            freshPayload.setQuantityFlag = false;
            freshPayload.quantityData = {
              quantity: String(${quantity}),
              quantitySuffix: '',
              price: '',
              renderableSellingQuantity: String(${quantity}),
            };
            freshPayload.sellingUnit = freshPayload.sellingUnit || 'units';
            freshPayload.sellingDimension = freshPayload.sellingDimension || 'count';
          } else {
            var discMatch = html.match(/\\"offerListingDiscriminator\\":\\"([^\\"]+)\\"/)
                         || html.match(/&quot;offerListingDiscriminator&quot;:&quot;([^&]+)&quot;/);
            var offerDiscriminator = discMatch ? discMatch[1] : '';
            var freshOfferIdMatch = html.match(/\\"offerListingID\\":\\"([^\\"]+)\\"/)
                                 || html.match(/&quot;offerListingID&quot;:&quot;([^&]+)&quot;/);
            var freshOfferListingID = freshOfferIdMatch ? freshOfferIdMatch[1] : '';
            var sessionMatch = document.cookie.match(/session-id=([^;]+)/);
            var sessionId = sessionMatch ? decodeURIComponent(sessionMatch[1]) : '';

            freshPayload = {
              qsUID: 'atfc-alm-mod-dp-' + Date.now(),
              prevSelectedQty: 0,
              isStepperFlag: false,
              setQuantityFlag: false,
              quantityData: {
                quantity: String(${quantity}),
                quantitySuffix: '',
                price: '',
                renderableSellingQuantity: String(${quantity}),
              },
              sellingUnit: 'units',
              sellingDimension: 'count',
              reftag: 'alm-dp-atc-so-fs',
              csrfToken: csrfToken,
              clientID: 'alm-mod-dp',
              isItemSoldByCount: 'true',
              brandId: 'QW1hem9uIEZyZXNo',
              asin: ${JSON.stringify(opts.asin)},
              sessionID: sessionId,
              storeId: 'dc6d4e0d03d7c0a581c85a754396fe17eb8e54f3',
              promotionId: 'any',
            };
            if (offerDiscriminator) freshPayload.offerListingDiscriminator = offerDiscriminator;
            if (freshOfferListingID) freshPayload.offerListingID = freshOfferListingID;
          }

          var freshReftag = freshPayload.reftag || 'alm-dp-atc-so-fs';
          var addResp = await fetch('${AMAZON_BASE}/alm/addtofreshcart?ref_=' + freshReftag + '&discoveredAsins.0=' + encodeURIComponent(${JSON.stringify(
            opts.asin,
          )}) + '&almBrandId=QW1hem9uIEZyZXNo', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json, */*',
              'anti-csrftoken-a2z': antiCsrf,
            },
            body: JSON.stringify(freshPayload),
            credentials: 'include',
          });

          if (addResp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (addResp.status === 403) return JSON.stringify({ __status: 403, __error: true });

          var addText = await addResp.text();
          var addOk = addResp.ok;
          var cartJson = null;
          try { cartJson = JSON.parse(addText); } catch(e) { console.warn('[amazon] cart response JSON parse failed', e.message); }

          var items = [];
          if (cartJson && cartJson.clientResponseModel && Array.isArray(cartJson.clientResponseModel.items)) {
            items = cartJson.clientResponseModel.items.map(function(item) {
              return {
                cartItemId: item.itemId || item.ASIN || '',
                asin: item.ASIN || '',
                title: '',
                quantity: item.quantity || 1,
                price: '',
                isFresh: true,
              };
            });
          }

          // Fresh fallback: get-cart-items
          if (items.length === 0) {
            try {
              var freshCartResp = await fetch('${AMAZON_BASE}/cart/add-to-cart/get-cart-items?clientName=SiteWideActionExecutor&_=' + Date.now(), {
                credentials: 'include',
                headers: { 'Accept': 'application/json, */*' }
              });
              if (freshCartResp.ok) {
                var freshCartData = await freshCartResp.json();
                if (Array.isArray(freshCartData)) {
                  var allFreshItems = freshCartData.filter(function(i) { return i.cartType === 'LOCAL_MARKET'; });
                  var targetFound = allFreshItems.some(function(i) { return i.asin === ${JSON.stringify(
                    opts.asin,
                  )}; });
                  if (!targetFound) {
                    return JSON.stringify({
                      __error: true,
                      __message: 'Add-to-cart failed: ASIN ' + ${JSON.stringify(
                        opts.asin,
                      )} + ' was not found in the Fresh cart after adding. The item may be unavailable or the session cookies may be stale. Try running the refresh command.'
                    });
                  }
                  items = allFreshItems.map(function(item) {
                    return { cartItemId: item.asin || '', asin: item.asin || '', title: '', quantity: item.quantity || 1, price: '', isFresh: true };
                  });
                }
              }
            } catch(fe) { console.warn('[amazon] Fresh cart fallback failed', fe.message); }
          }

          return JSON.stringify({
            __status: addResp.status,
            __ok: addOk,
            __data: { items: items, subtotal: '', itemCount: items.length },
            __addCartJson: cartJson ? JSON.stringify(cartJson).substring(0, 500) : null,
          });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = (await cdpEval(tabId, script)) as Record<string, unknown>;
    handleResult(result);

    const cart = result.__data as CartSummary & { __debug?: unknown };

    if (result.__ok === false) {
      const rawSnippet = result.__addCartJson
        ? ` | raw: ${(result.__addCartJson as string).substring(0, 150)}`
        : "";
      throw new Error(
        `Fresh add-to-cart POST failed (status=${result.__status}${rawSnippet}).`,
      );
    }

    cart.__debug = {
      addCartJson: result.__addCartJson,
      httpStatus: result.__status,
      httpOk: result.__ok,
    };
    return cart;
  });
}

/**
 * Remove an item from the Amazon cart by cart item ID.
 */
export async function removeFromCart(opts: {
  cartItemId: string;
}): Promise<CartSummary> {
  const { tabId } = await prepareRequest();

  // Run the delete POST with retries, then fetch the updated cart separately.
  // This avoids re-sending an already-successful delete when viewCart() fails.
  await runWithBackoff(async () => {
    const url = `${AMAZON_BASE}/gp/cart/view.html`;
    const body = `cartItemId.${opts.cartItemId}=${opts.cartItemId}&quantity.${opts.cartItemId}=0&submit.delete.${opts.cartItemId}=Delete&ie=UTF8&action=delete`;

    const script = `
      (async function() {
        try {
          var antiCsrf = '';
          var csrfMeta = document.querySelector('meta[name="anti-csrftoken-a2z"]');
          if (csrfMeta && csrfMeta.content) {
            antiCsrf = csrfMeta.content;
          } else {
            var csrfInp = document.querySelector('input[name="anti-csrftoken-a2z"]');
            if (csrfInp && csrfInp.value) { antiCsrf = csrfInp.value; }
            else { var m = document.cookie.match(/anti-csrftoken-a2z=([^;]+)/); if (m) antiCsrf = decodeURIComponent(m[1]); }
          }

          var resp = await fetch(${JSON.stringify(url)}, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'anti-csrftoken-a2z': antiCsrf,
            },
            body: ${JSON.stringify(body)},
            credentials: 'include',
          });
          if (resp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (resp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          return JSON.stringify({ __status: resp.status, __ok: resp.ok });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = (await cdpEval(tabId, script)) as Record<string, unknown>;
    handleResult(result);
  });

  return viewCart();
}

/**
 * View the current Amazon cart contents.
 */
export async function viewCart(): Promise<CartSummary> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    // Combine two sources:
    //   1. /gp/cart/view.html HTML page  - regular Amazon items
    //   2. get-cart-items JSON endpoint  - Fresh (LOCAL_MARKET) items only
    const script = `
      (async function() {
        try {
          var items = [];
          var subtotalText = '';

          // --- Regular cart: parse /gp/cart/view.html HTML ---
          try {
            var cartResp = await fetch('${AMAZON_BASE}/gp/cart/view.html', {
              credentials: 'include',
              headers: { 'Accept': 'text/html,application/xhtml+xml,*/*' }
            });
            if (cartResp.status === 401) return JSON.stringify({ __status: 401, __error: true });
            if (cartResp.status === 403) return JSON.stringify({ __status: 403, __error: true });
            if (cartResp.ok) {
              var cartHtml = await cartResp.text();
              var parser = new DOMParser();
              var doc = parser.parseFromString(cartHtml, 'text/html');
              // Each cart item row has data-asin and a quantity input
              doc.querySelectorAll('[data-asin]').forEach(function(el) {
                var asin = el.getAttribute('data-asin');
                if (!asin || asin.length < 6) return;
                var qtyInput = el.querySelector('[name^="quantity."]') || el.querySelector('input[type="text"]');
                var qty = qtyInput ? (parseInt(qtyInput.value, 10) || 1) : 1;
                var titleEl = el.querySelector('.a-truncate-full') || el.querySelector('.sc-product-title') || el.querySelector('[class*="product-title"]');
                var priceEl = el.querySelector('.a-price .a-offscreen') || el.querySelector('[class*="price"]');
                var cartItemIdMatch = (el.innerHTML || '').match(/cartItemId[=\\s:"]+([A-Z0-9]+)/i);
                var cartItemId = cartItemIdMatch ? cartItemIdMatch[1] : asin;
                items.push({
                  cartItemId: cartItemId,
                  asin: asin,
                  title: titleEl ? titleEl.textContent.trim() : '',
                  quantity: qty,
                  price: priceEl ? priceEl.textContent.trim() : '',
                  isFresh: false,
                });
              });
              // Subtotal
              var subtotalEl = doc.querySelector('#sc-subtotal-amount-activecart .a-price .a-offscreen') ||
                               doc.querySelector('[id*="subtotal"] .a-price .a-offscreen') ||
                               doc.querySelector('.sc-price-sign');
              if (subtotalEl) subtotalText = subtotalEl.textContent.trim();
            }
          } catch(re) { console.warn('[amazon] regular cart parsing failed', re.message); }

          // --- Fresh cart: get-cart-items JSON endpoint (LOCAL_MARKET only) ---
          try {
            var freshResp = await fetch('${AMAZON_BASE}/cart/add-to-cart/get-cart-items?clientName=SiteWideActionExecutor&_=' + Date.now(), {
              credentials: 'include',
              headers: { 'Accept': 'application/json, */*' }
            });
            if (freshResp.ok) {
              var freshData = await freshResp.json();
              if (Array.isArray(freshData)) {
                freshData.forEach(function(item) {
                  if (item.cartType === 'LOCAL_MARKET') {
                    items.push({
                      cartItemId: item.asin || '',
                      asin: item.asin || '',
                      title: '',
                      quantity: item.quantity || 1,
                      price: '',
                      isFresh: true,
                    });
                  }
                });
              }
            }
          } catch(fe) { console.warn('[amazon] Fresh cart fetch failed', fe.message); }

          return JSON.stringify({
            __status: 200,
            __data: { items: items, subtotal: subtotalText, itemCount: items.length }
          });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = (await cdpEval(tabId, script)) as Record<string, unknown>;
    handleResult(result);
    return result.__data as CartSummary;
  });
}
