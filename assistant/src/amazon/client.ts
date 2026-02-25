/**
 * Amazon REST API client.
 *
 * ARCHITECTURE
 * ============
 * All requests run inside a Chrome browser tab via CDP Runtime.evaluate(), NOT
 * from Node.js directly. This means:
 *
 *   1. There are TWO DOMs in every function:
 *      - `document`  = the browser's currently-rendered page (e.g. amazon.com homepage)
 *      - `doc`       = a DOMParser-parsed document from a fetch() response (e.g. product page)
 *      CSRF tokens, offer IDs, and form fields must be extracted from `doc` (the fetched
 *      page), NOT from `document`. The browser's live page rarely has the data we need.
 *
 *   2. Session cookies live in the Chrome-CDP browser profile
 *      (~Library/Application Support/Google/Chrome-CDP). The session.json on disk is only
 *      used to validate that a session exists. Actual auth goes through the browser's cookies.
 *
 * AMAZON FRESH vs REGULAR CART
 * ============================
 * Fresh and regular Amazon use completely different cart APIs:
 *   - Fresh:   POST /alm/addtofreshcart  (JSON body)
 *   - Regular: POST /gp/add-to-cart/json  (form-encoded body)
 *
 * Fresh cart POST requires ALL of these fields or it silently fails:
 *   - `offerListingDiscriminator` (short code like "A0P3", from escaped JSON in product HTML)
 *   - `offerListingID`           (long URL-encoded hash, from escaped JSON in product HTML)
 *   - `anti-csrftoken-a2z` header (from <input> or <meta> in the FETCHED product page doc)
 *   - `csrfToken` in payload     (from escaped JSON in product HTML)
 *
 * DEBUGGING
 * =========
 * Use `--verbose` on `cart add` to dump all extracted fields and raw responses.
 * If a field shows "EMPTY", the product page format likely changed and the
 * extraction regex needs updating. Check the escaped JSON patterns in the HTML:
 *   - Fields are typically in: \\"fieldName\\":\\"value\\" (backslash-escaped quotes)
 *   - Or HTML entities: &quot;fieldName&quot;:&quot;value&quot;
 *
 * ERROR HANDLING
 * ==============
 * NEVER silently fall through to stale data. If a POST fails, throw an error with
 * the extracted field values so the caller knows exactly what went wrong. The
 * get-cart-items fallback endpoint returns whatever is already in the cart, NOT
 * what was just added. Always validate the target ASIN is present before returning.
 *
 * runWithBackoff() retries on HTTP 403, but not all 403s are rate limits. A 403
 * from /alm/addtofreshcart with "fakeOfferId" means the request payload was wrong,
 * not that we're rate-limited. Check the response body before classifying the error.
 */

import {
  loadSession,
  type AmazonSession,
} from './session.js';
import type { ExtractedCredential } from '../tools/browser/network-recording-types.js';
import { extensionRelayServer } from '../browser-extension-relay/server.js';
import type { ExtensionCommand, ExtensionResponse } from '../browser-extension-relay/protocol.js';
import { readHttpToken } from '../util/platform.js';
import { getRuntimeHttpPort } from '../config/env.js';

const AMAZON_BASE = 'https://www.amazon.com';

// ---------------------------------------------------------------------------
// Relay command routing
// ---------------------------------------------------------------------------
// When running inside the daemon, extensionRelayServer has a live WebSocket.
// When running out-of-process (CLI), the relay isn't available, so we fall
// back to the daemon's HTTP endpoint POST /v1/browser-relay/command.
// ---------------------------------------------------------------------------

async function sendRelayCommand(command: Record<string, unknown>): Promise<ExtensionResponse> {
  // Try in-process relay first (works when running inside the daemon)
  const status = extensionRelayServer.getStatus();
  if (status.connected) {
    return extensionRelayServer.sendCommand(command as Omit<ExtensionCommand, 'id'>);
  }

  // Fall back to HTTP relay endpoint on the daemon
  const token = readHttpToken();
  if (!token) {
    throw new Error('Browser extension relay is not connected and no HTTP token found. Is the daemon running?');
  }

  const port = getRuntimeHttpPort() ?? 7821;
  const resp = await fetch(`http://127.0.0.1:${port}/v1/browser-relay/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(command),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Relay HTTP command failed (${resp.status}): ${body}`);
  }

  return await resp.json() as ExtensionResponse;
}

/** Thrown when the session is missing or expired. The CLI handles this specially. */
export class SessionExpiredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SessionExpiredError';
  }
}

/** Thrown when Amazon returns HTTP 403 (rate limited or bot detected). */
export class RateLimitError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RateLimitError';
  }
}

function requireSession(): AmazonSession {
  const session = loadSession();
  if (!session) {
    throw new SessionExpiredError('No Amazon session found.');
  }
  return session;
}

/**
 * Prepare for an Amazon request: validate session, find a Chrome tab,
 * and sync session cookies into the browser. Returns the tab ID.
 */
async function prepareRequest(): Promise<{ tabId: number; session: AmazonSession }> {
  const session = requireSession();
  const tabId = await findAmazonTab();
  // Skip cookie sync — use Chrome's own live cookies instead of overwriting with stale CLI ones
  // await syncCookiesToBrowser(session.cookies);
  return { tabId, session };
}

/**
 * Find a Chrome tab on amazon.com via the browser-relay extension.
 * Opens a new Amazon tab if none is currently open.
 */
async function findAmazonTab(): Promise<number> {
  const resp = await sendRelayCommand({ action: 'find_tab', url: '*://*.amazon.com/*' });
  if (resp.success && resp.tabId !== undefined) {
    return resp.tabId;
  }

  // No Amazon tab open — create one
  const newTab = await sendRelayCommand({
    action: 'new_tab',
    url: 'https://www.amazon.com',
  });
  if (!newTab.success || newTab.tabId === undefined) {
    throw new SessionExpiredError('Could not open an Amazon tab in Chrome.');
  }
  return newTab.tabId;
}

/**
 * Inject saved session cookies into Chrome via the browser-relay extension.
 * Uses chrome.cookies.set so fetch() calls in the tab context carry the session.
 */
let lastCookieSyncTime = 0;
const COOKIE_SYNC_INTERVAL = 60_000; // re-sync at most once per minute

async function _syncCookiesToBrowser(cookies: ExtractedCredential[]): Promise<void> {
  const now = Date.now();
  if (now - lastCookieSyncTime < COOKIE_SYNC_INTERVAL) return;

  for (const cookie of cookies) {
    const domain = cookie.domain || '.amazon.com';
    const cleanDomain = domain.startsWith('.') ? domain.slice(1) : domain;
    await extensionRelayServer.sendCommand({
      action: 'set_cookie',
      cookie: {
        url: `https://${cleanDomain}`,
        name: cookie.name,
        value: cookie.value,
        domain,
        path: cookie.path || '/',
        secure: cookie.secure ?? true,
        httpOnly: cookie.httpOnly ?? false,
        ...(cookie.expires ? { expirationDate: cookie.expires } : {}),
      },
    });
  }

  lastCookieSyncTime = Date.now();
}

/**
 * Execute a JavaScript expression inside a Chrome tab via the browser-relay extension.
 * Drop-in replacement for the former CDP Runtime.evaluate path.
 * Returns the JSON-parsed result value.
 */
async function cdpEval(tabId: number, script: string): Promise<unknown> {
  let resp: ExtensionResponse;
  try {
    resp = await sendRelayCommand({ action: 'evaluate', tabId, code: script });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not connected')) {
      throw new SessionExpiredError(
        'Browser extension relay is not connected. Load the Vellum extension in Chrome.',
      );
    }
    throw err;
  }

  if (!resp.success) {
    throw new Error(`Browser eval failed: ${resp.error ?? 'unknown error'}`);
  }

  const value = resp.result;
  if (value == null) {
    throw new Error('Empty browser eval response');
  }

  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return value;
  }
}

/**
 * Handle the raw result object returned from cdpEval scripts.
 * Throws appropriate errors for auth failures, rate limits, and other errors.
 */
function handleResult(result: Record<string, unknown>): void {
  if (result.__error) {
    if (result.__status === 401) {
      throw new SessionExpiredError('Amazon session has expired.');
    }
    if (result.__status === 403) {
      throw new RateLimitError('Amazon rate limit hit (HTTP 403).');
    }
    throw new Error(
      (result.__message as string | undefined) ??
      `Amazon request failed with status ${result.__status ?? 'unknown'}`,
    );
  }
}

let lastRequestTime = 0;

async function runWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  const backoffSchedule = [5000, 10000, 20000];

  for (let attempt = 0; ; attempt++) {
    // Inter-request delay
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (lastRequestTime > 0 && elapsed < 2000) {
      await new Promise(r => setTimeout(r, 2000 - elapsed));
    }

    try {
      lastRequestTime = Date.now();
      return await fn();
    } catch (err) {
      if (err instanceof RateLimitError && attempt < backoffSchedule.length) {
        const delay = backoffSchedule[attempt];
        process.stderr.write(
          `[amazon] Rate limited, retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${backoffSchedule.length})\n`,
        );
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProductSearchResult {
  asin: string;
  title: string;
  price: string;
  priceValue: number | null;
  isPrime: boolean;
  isFresh: boolean;
  imageUrl?: string;
  rating?: string;
  reviewCount?: string;
}

export interface ProductVariation {
  dimensionName: string;
  value: string;
  asin: string;
  isAvailable: boolean;
  priceValue: number | null;
}

export interface ProductDetails {
  asin: string;
  parentAsin?: string;
  title: string;
  price: string;
  priceValue: number | null;
  variations: ProductVariation[];
  isFresh: boolean;
  imageUrl?: string;
  rating?: string;
  reviewCount?: string;
}

export interface CartItem {
  cartItemId: string;
  asin: string;
  title: string;
  quantity: number;
  price: string;
  isFresh: boolean;
}

export interface CartSummary {
  items: CartItem[];
  subtotal: string;
  itemCount: number;
}

export interface DeliverySlot {
  slotId: string;
  date: string;
  timeWindow: string;
  price: string;
  isAvailable: boolean;
}

export interface PaymentMethod {
  paymentMethodId: string;
  type: string;
  last4: string;
  isDefault: boolean;
}

export interface CheckoutSummary {
  subtotal: string;
  shipping: string;
  tax: string;
  total: string;
  paymentMethods: PaymentMethod[];
  deliveryDate?: string;
}

export interface PlaceOrderResult {
  orderId: string;
  estimatedDelivery?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search Amazon for products.
 * Use isFresh: true to search Amazon Fresh grocery items.
 */
export async function search(
  query: string,
  opts: { isFresh?: boolean; limit?: number } = {},
): Promise<ProductSearchResult[]> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    const url = opts.isFresh
      ? `${AMAZON_BASE}/s?k=${encodeURIComponent(query)}&i=fresh-foods`
      : `${AMAZON_BASE}/s?k=${encodeURIComponent(query)}`;
    const limit = opts.limit ?? 20;
    const isFreshFlag = JSON.stringify(!!opts.isFresh);

    const script = `
      (async function() {
        try {
          var resp = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
          if (resp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (resp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var html = await resp.text();
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');
          var results = [];
          var cards = doc.querySelectorAll('[data-component-type="s-search-result"][data-asin]');
          for (var i = 0; i < Math.min(cards.length, ${limit}); i++) {
            var el = cards[i];
            var asin = el.getAttribute('data-asin');
            if (!asin || asin.length < 6) continue;
            var titleEl = el.querySelector('h2 .a-text-normal') || el.querySelector('h2 a span') || el.querySelector('.s-title-instructions-style');
            var priceEl = el.querySelector('.a-price .a-offscreen');
            var imgEl = el.querySelector('img.s-image');
            var ratingEl = el.querySelector('.a-icon-star-small .a-icon-alt') || el.querySelector('[aria-label*="stars"]');
            var reviewEl = el.querySelector('[aria-label*="reviews"]') || el.querySelector('.s-underline-text');
            var isPrime = !!el.querySelector('.a-icon-prime');
            var isFreshEl = !!el.querySelector('[aria-label*="Fresh"]') || html.includes('amazon.com/fresh') && i < 5;
            var priceText = priceEl ? priceEl.textContent.trim() : '';
            var priceNum = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, '')) : null;
            results.push({
              asin: asin,
              title: titleEl ? titleEl.textContent.trim() : '',
              price: priceText,
              priceValue: isNaN(priceNum) ? null : priceNum,
              isPrime: isPrime,
              isFresh: ${isFreshFlag} || isFreshEl,
              imageUrl: imgEl ? imgEl.getAttribute('src') : undefined,
              rating: ratingEl ? ratingEl.getAttribute('aria-label') || ratingEl.textContent.trim() : undefined,
              reviewCount: reviewEl ? reviewEl.textContent.trim() : undefined,
            });
          }
          return JSON.stringify({ __status: resp.status, __data: results });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = await cdpEval(tabId, script) as Record<string, unknown>;
    handleResult(result);
    return result.__data as ProductSearchResult[];
  });
}

/**
 * Get product details for a specific ASIN, including variations.
 */
export async function getProductDetails(
  asin: string,
  opts: { isFresh?: boolean } = {},
): Promise<ProductDetails> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    const url = `${AMAZON_BASE}/dp/${asin}`;
    const isFreshFlag = JSON.stringify(!!opts.isFresh);

    const script = `
      (async function() {
        try {
          var resp = await fetch(${JSON.stringify(url)}, {
            credentials: 'include',
            headers: { 'Accept': 'text/html,application/xhtml+xml' }
          });
          if (resp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (resp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var html = await resp.text();
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');

          // Title
          var titleEl = doc.getElementById('productTitle') ||
                        doc.querySelector('.product-title-word-break') ||
                        doc.querySelector('h1#title');
          var title = titleEl ? titleEl.textContent.trim() : '';

          // Price
          var priceEl = doc.querySelector('#priceblock_ourprice .a-offscreen') ||
                        doc.querySelector('#priceblock_dealprice .a-offscreen') ||
                        doc.querySelector('.a-price .a-offscreen') ||
                        doc.querySelector('#price_inside_buybox');
          var priceText = priceEl ? priceEl.textContent.trim() : '';
          var priceNum = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, '')) : null;

          // Image
          var imgEl = doc.getElementById('landingImage') || doc.querySelector('#imgBlkFront');
          var imageUrl = imgEl ? (imgEl.getAttribute('data-a-dynamic-image') ? Object.keys(JSON.parse(imgEl.getAttribute('data-a-dynamic-image') || '{}'))[0] : imgEl.getAttribute('src')) : undefined;

          // Rating
          var ratingEl = doc.querySelector('#acrPopover') || doc.querySelector('[data-hook="rating-out-of-text"]');
          var rating = ratingEl ? ratingEl.getAttribute('title') || ratingEl.textContent.trim() : undefined;

          var reviewEl = doc.getElementById('acrCustomerReviewText');
          var reviewCount = reviewEl ? reviewEl.textContent.trim() : undefined;

          // Parent ASIN (for variation child products)
          var parentAsinEl = doc.querySelector('[data-asin]') || doc.querySelector('[name="ASIN"]');
          var parentAsin = undefined;
          var m = html.match(/"parentAsin"\s*:\s*"([A-Z0-9]+)"/);
          if (m) parentAsin = m[1];

          // Detect Fresh
          var isFresh = ${isFreshFlag} || html.includes('amazon.com/fresh') || !!doc.querySelector('[aria-label*="Fresh"]');

          // Variations — parse from inline JS objects
          var variations = [];
          try {
            var dimMatch = html.match(/dimensionRelationshipsStr\s*=\s*'([^']+)'/);
            if (!dimMatch) dimMatch = html.match(/"dimensionRelationshipsStr"\s*:\s*"([^"]+)"/);
            if (dimMatch) {
              var dimStr = dimMatch[1].replace(/\\\\/g, '\\\\').replace(/\\'/g, "'");
              var dimData = JSON.parse(dimStr);
              if (Array.isArray(dimData)) {
                for (var i = 0; i < dimData.length; i++) {
                  var dimItem = dimData[i];
                  var attrs = dimItem.variationAttributes || [];
                  for (var j = 0; j < attrs.length; j++) {
                    variations.push({
                      dimensionName: attrs[j].variationName || '',
                      value: attrs[j].value || '',
                      asin: dimItem.asin || '',
                      isAvailable: dimItem.isPrime !== undefined ? true : !dimItem.unavailable,
                      priceValue: dimItem.price ? parseFloat(String(dimItem.price).replace(/[^0-9.]/g, '')) : null,
                    });
                  }
                }
              }
            }
          } catch(ve) { console.warn('[amazon] variation parsing failed', ve.message); }

          // Fallback: look for asinVariationValues
          if (variations.length === 0) {
            try {
              var asinVarMatch = html.match(/asinVariationValues\s*=\s*(\{[^;]+\})/);
              if (asinVarMatch) {
                var asinVarData = JSON.parse(asinVarMatch[1]);
                var dims = Object.keys(asinVarData);
                for (var di = 0; di < dims.length; di++) {
                  var dim = dims[di];
                  var asins = Object.keys(asinVarData[dim]);
                  for (var ai = 0; ai < asins.length; ai++) {
                    variations.push({
                      dimensionName: dim,
                      value: asinVarData[dim][asins[ai]],
                      asin: asins[ai],
                      isAvailable: true,
                      priceValue: null,
                    });
                  }
                }
              }
            } catch(ve2) { console.warn('[amazon] asinVariationValues parsing failed', ve2.message); }
          }

          return JSON.stringify({
            __status: resp.status,
            __data: {
              asin: ${JSON.stringify(asin)},
              parentAsin: parentAsin,
              title: title,
              price: priceText,
              priceValue: isNaN(priceNum) ? null : priceNum,
              variations: variations,
              isFresh: isFresh,
              imageUrl: imageUrl,
              rating: rating,
              reviewCount: reviewCount,
            }
          });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = await cdpEval(tabId, script) as Record<string, unknown>;
    handleResult(result);
    return result.__data as ProductDetails;
  });
}

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

  // ─── Non-Fresh: navigate + click approach ───────────────────────────
  // Amazon's handle-buy-box endpoint rejects fetch() requests (returns 404)
  // because it checks Sec-Fetch-* headers that only real browser form
  // submissions provide. So for non-Fresh items we navigate the actual
  // Chrome tab to the product page and click the Add to Cart button.
  if (!opts.isFresh) {
    return runWithBackoff(async () => {
      // Step 1: Navigate to the product page
      await sendRelayCommand({ action: 'navigate', tabId, url: productUrl });

      // Step 2: Wait for the page to load and the Add to Cart button to appear
      // Poll up to 10 seconds for the button
      let buttonClicked = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(r => setTimeout(r, 1000));
        const clickResult = await cdpEval(tabId, `
          (function() {
            try {
              // Check if we're on the right product page
              var titleEl = document.querySelector('#productTitle');
              if (!titleEl) return JSON.stringify({ ready: false, reason: 'no product title yet' });

              // Set quantity if needed
              ${quantity > 1 ? `
              var qtySelect = document.querySelector('#quantity');
              if (qtySelect) {
                qtySelect.value = '${quantity}';
                qtySelect.dispatchEvent(new Event('change', { bubbles: true }));
              }
              ` : ''}

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
        `) as Record<string, unknown>;

        if (clickResult && clickResult.clicked) {
          buttonClicked = true;
          break;
        }
      }

      if (!buttonClicked) {
        throw new Error('Could not find or click the Add to Cart button on the product page after 10 seconds.');
      }

      // Step 3: Wait for the cart confirmation page to load and extract cart info
      // Poll up to 8 seconds for the confirmation
      await new Promise(r => setTimeout(r, 2000)); // initial wait for navigation
      let cartData: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const confirmResult = await cdpEval(tabId, `
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
        `) as Record<string, unknown>;

        if (confirmResult && confirmResult.confirmed) {
          cartData = confirmResult;
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      // Build the cart summary
      const items = [{
        cartItemId: opts.asin,
        asin: opts.asin,
        title: '',
        quantity: quantity,
        price: '',
        isFresh: false,
      }];

      const cart: CartSummary & { __debug?: unknown; __verbose?: unknown } = {
        items,
        subtotal: (cartData?.subtotal as string) || '',
        itemCount: parseInt((cartData?.cartCount as string) || '0', 10) || items.length,
      };

      if (!cartData?.confirmed) {
        // Button was clicked but we couldn't confirm. It likely still worked
        // (Amazon sometimes shows interstitials). Return optimistic result.
        cart.__debug = { warning: 'Could not confirm cart page, but button click succeeded.' };
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

  // ─── Fresh items: fetch-based approach (works fine) ─────────────────
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
          var addResp = await fetch('${AMAZON_BASE}/alm/addtofreshcart?ref_=' + freshReftag + '&discoveredAsins.0=' + encodeURIComponent(${JSON.stringify(opts.asin)}) + '&almBrandId=QW1hem9uIEZyZXNo', {
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
                  var targetFound = allFreshItems.some(function(i) { return i.asin === ${JSON.stringify(opts.asin)}; });
                  if (!targetFound) {
                    return JSON.stringify({
                      __error: true,
                      __message: 'Add-to-cart failed: ASIN ' + ${JSON.stringify(opts.asin)} + ' was not found in the Fresh cart after adding. The item may be unavailable or the session cookies may be stale. Try running vellum amazon refresh.'
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

    const result = await cdpEval(tabId, script) as Record<string, unknown>;
    handleResult(result);

    const cart = result.__data as CartSummary & { __debug?: unknown };

    if (result.__ok === false) {
      const rawSnippet = result.__addCartJson ? ` | raw: ${(result.__addCartJson as string).substring(0, 150)}` : '';
      throw new Error(`Fresh add-to-cart POST failed (status=${result.__status}${rawSnippet}).`);
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

  return runWithBackoff(async () => {
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

    const result = await cdpEval(tabId, script) as Record<string, unknown>;
    handleResult(result);
    return viewCart();
  });
}

/**
 * View the current Amazon cart contents.
 */
export async function viewCart(): Promise<CartSummary> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    // Combine two sources:
    //   1. /gp/cart/view.html HTML page  — regular Amazon items
    //   2. get-cart-items JSON endpoint  — Fresh (LOCAL_MARKET) items only
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

    const result = await cdpEval(tabId, script) as Record<string, unknown>;
    handleResult(result);
    return result.__data as CartSummary;
  });
}

/**
 * Get available Amazon Fresh delivery slots.
 */
export async function getFreshDeliverySlots(): Promise<DeliverySlot[]> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    // Amazon Fresh delivery windows API
    const url = `${AMAZON_BASE}/fresh/deliverywindows`;

    const script = `
      (async function() {
        try {
          var resp = await fetch(${JSON.stringify(url)}, {
            credentials: 'include',
            headers: {
              'Accept': 'application/json, text/html,*/*',
              'x-requested-with': 'XMLHttpRequest',
            }
          });
          if (resp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (resp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var text = await resp.text();

          var slots = [];
          try {
            var data = JSON.parse(text);
            // Normalize various possible response shapes
            var windows = data.deliveryWindows || data.windows || data.slots || (Array.isArray(data) ? data : []);
            windows.forEach(function(w) {
              slots.push({
                slotId: w.windowId || w.slotId || w.id || '',
                date: w.date || w.windowStartDate || (w.windowStartDateTimeUtc || '').split('T')[0] || '',
                timeWindow: w.timeWindow || w.displayString || (w.windowStartDateTimeUtc && w.windowEndDateTimeUtc
                  ? w.windowStartDateTimeUtc.split('T')[1].substring(0,5) + ' - ' + w.windowEndDateTimeUtc.split('T')[1].substring(0,5)
                  : ''),
                price: (w.price && w.price.localizedDisplayString) ? w.price.localizedDisplayString
                       : (w.deliveryFee || w.fee || 'FREE'),
                isAvailable: w.isAvailable !== false && !w.isFull,
              });
            });
          } catch(pe) {
            // HTML response — parse from page
            var parser = new DOMParser();
            var doc = parser.parseFromString(text, 'text/html');
            doc.querySelectorAll('[data-slot-id], [data-window-id]').forEach(function(el) {
              slots.push({
                slotId: el.getAttribute('data-slot-id') || el.getAttribute('data-window-id') || '',
                date: el.getAttribute('data-date') || '',
                timeWindow: el.getAttribute('data-time-window') || el.textContent.trim(),
                price: (el.querySelector('.a-price') || el.querySelector('.slot-price') || {textContent: 'FREE'}).textContent.trim(),
                isAvailable: !el.classList.contains('unavailable') && !el.hasAttribute('disabled'),
              });
            });
          }

          return JSON.stringify({ __status: resp.status, __data: slots });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = await cdpEval(tabId, script) as Record<string, unknown>;
    handleResult(result);
    return result.__data as DeliverySlot[];
  });
}

/**
 * Select an Amazon Fresh delivery slot.
 */
export async function selectFreshDeliverySlot(slotId: string): Promise<{ ok: boolean }> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    // Amazon Fresh slot selection endpoint
    const url = `${AMAZON_BASE}/fresh/api/deliverywindows/select`;
    const body = JSON.stringify({ windowId: slotId });

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
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'anti-csrftoken-a2z': antiCsrf,
              'x-requested-with': 'XMLHttpRequest',
            },
            body: ${JSON.stringify(body)},
            credentials: 'include',
          });
          if (resp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (resp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var text = await resp.text();
          return JSON.stringify({ __status: resp.status, __ok: resp.ok, __body: text.substring(0, 500) });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = await cdpEval(tabId, script) as Record<string, unknown>;
    handleResult(result);
    return { ok: Boolean(result.__ok) };
  });
}

/**
 * Get payment methods from the checkout page.
 */
export async function getPaymentMethods(): Promise<PaymentMethod[]> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    const url = `${AMAZON_BASE}/gp/buy/payselect/handlers/display.html`;

    const script = `
      (async function() {
        try {
          var resp = await fetch(${JSON.stringify(url)}, {
            credentials: 'include',
            headers: { 'Accept': 'text/html,application/xhtml+xml' }
          });
          if (resp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (resp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var html = await resp.text();
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');

          var methods = [];
          var seen = new Set();

          // Look for payment instruments in the page
          doc.querySelectorAll('[data-pmid], [id^="payment-instrument-"]').forEach(function(el) {
            var pmid = el.getAttribute('data-pmid') || el.id.replace('payment-instrument-', '');
            if (!pmid || seen.has(pmid)) return;
            seen.add(pmid);

            var textContent = el.textContent || '';
            var last4Match = textContent.match(/(?:ending|\\*{3,})(\\d{4})/);
            var last4 = last4Match ? last4Match[1] : '';

            var type = 'Card';
            if (textContent.toLowerCase().includes('visa')) type = 'Visa';
            else if (textContent.toLowerCase().includes('mastercard')) type = 'Mastercard';
            else if (textContent.toLowerCase().includes('amex') || textContent.toLowerCase().includes('american express')) type = 'AmEx';
            else if (textContent.toLowerCase().includes('discover')) type = 'Discover';

            var isDefault = el.classList.contains('pmts-selected') || !!el.querySelector('[selected]') || false;

            if (last4 || pmid) {
              methods.push({ paymentMethodId: pmid, type, last4, isDefault });
            }
          });

          // Fallback: look for payment method data in inline JSON
          if (methods.length === 0) {
            var jsonMatch = html.match(/"paymentInstruments"\s*:\s*(\[[^\]]+\])/);
            if (jsonMatch) {
              try {
                var instruments = JSON.parse(jsonMatch[1]);
                instruments.forEach(function(inst) {
                  methods.push({
                    paymentMethodId: inst.paymentMethodId || inst.id || '',
                    type: inst.cardType || inst.type || 'Card',
                    last4: inst.last4 || inst.maskedCardNumber || '',
                    isDefault: !!inst.isDefault,
                  });
                });
              } catch(e) { console.warn('[amazon] payment instruments JSON parse failed', e.message); }
            }
          }

          return JSON.stringify({ __status: resp.status, __data: methods });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = await cdpEval(tabId, script) as Record<string, unknown>;
    handleResult(result);
    return result.__data as PaymentMethod[];
  });
}

/**
 * Get the checkout summary (totals, shipping, payment options).
 */
export async function getCheckoutSummary(): Promise<CheckoutSummary> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    const url = `${AMAZON_BASE}/gp/buy/spc/handlers/static-submit-merchantId-data.html`;

    const script = `
      (async function() {
        try {
          var resp = await fetch(${JSON.stringify(url)}, {
            credentials: 'include',
            headers: { 'Accept': 'text/html,application/xhtml+xml' }
          });
          if (resp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (resp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var html = await resp.text();
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');

          var getPrice = function(selector) {
            var el = doc.querySelector(selector);
            return el ? el.textContent.trim() : '';
          };

          var subtotal = getPrice('#subtotals-marketplace-table tr:first-child td:last-child') ||
                         getPrice('.order-summary-line-item-price') ||
                         getPrice('[data-component="subtotalAmount"]');
          var shipping = getPrice('#subtotals-marketplace-table .shipping-row td:last-child') ||
                         getPrice('[data-component="shippingAmount"]') || 'FREE';
          var tax = getPrice('#subtotals-marketplace-table .tax-row td:last-child') ||
                    getPrice('[data-component="taxAmount"]') || '';
          var total = getPrice('#subtotals-marketplace-table .grand-total-price') ||
                      getPrice('[data-component="orderTotalAmount"]') ||
                      getPrice('.grand-total-price');

          var deliveryDateEl = doc.querySelector('.delivery-date') || doc.querySelector('[class*="delivery-date"]');
          var deliveryDate = deliveryDateEl ? deliveryDateEl.textContent.trim() : '';

          // Payment methods
          var methods = [];
          doc.querySelectorAll('[data-pmid], .payment-instrument').forEach(function(el) {
            var pmid = el.getAttribute('data-pmid') || '';
            if (!pmid) return;
            var text = el.textContent || '';
            var last4Match = text.match(/(?:ending|\\*{3,})(\\d{4})/);
            methods.push({
              paymentMethodId: pmid,
              type: text.toLowerCase().includes('visa') ? 'Visa' :
                    text.toLowerCase().includes('mastercard') ? 'Mastercard' : 'Card',
              last4: last4Match ? last4Match[1] : '',
              isDefault: !!el.querySelector('[selected]') || el.classList.contains('selected'),
            });
          });

          return JSON.stringify({
            __status: resp.status,
            __data: { subtotal, shipping, tax, total, paymentMethods: methods, deliveryDate }
          });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = await cdpEval(tabId, script) as Record<string, unknown>;
    handleResult(result);
    return result.__data as CheckoutSummary;
  });
}

/**
 * Place an Amazon order.
 * WARNING: This submits a real order. Always confirm with the user first.
 */
export async function placeOrder(opts: {
  paymentMethodId?: string;
  deliverySlotId?: string;
} = {}): Promise<PlaceOrderResult> {
  const { tabId } = await prepareRequest();

  return runWithBackoff(async () => {
    // First load the SPC page to get the order submission token
    const spcUrl = `${AMAZON_BASE}/gp/buy/spc/handlers/static-submit-merchantId-data.html`;

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

          // Load checkout page to get form token
          var spcResp = await fetch(${JSON.stringify(spcUrl)}, {
            credentials: 'include',
            headers: { 'Accept': 'text/html,application/xhtml+xml' }
          });
          if (spcResp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (spcResp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var spcHtml = await spcResp.text();

          // Extract form action and hidden fields
          var parser = new DOMParser();
          var doc = parser.parseFromString(spcHtml, 'text/html');
          var form = doc.querySelector('form#turbo-checkout-pyo-form') || doc.querySelector('form[name="checkout"]') || doc.querySelector('#placeYourOrder form');

          if (!form) {
            return JSON.stringify({ __error: true, __message: 'Could not find order form on checkout page. Please complete checkout manually in the browser.' });
          }

          var formAction = form.getAttribute('action') || '/gp/buy/spc/handlers/static-submit-merchantId-data.html';
          if (!formAction.startsWith('http')) formAction = 'https://www.amazon.com' + formAction;

          // Build form data from hidden inputs
          var formData = new URLSearchParams();
          form.querySelectorAll('input[type="hidden"]').forEach(function(inp) {
            formData.set(inp.name, inp.value);
          });

          // Apply payment method if specified
          if (${JSON.stringify(opts.paymentMethodId || '')}) {
            formData.set('ppw-instrumentId', ${JSON.stringify(opts.paymentMethodId || '')});
          }

          // Submit order
          var submitResp = await fetch(formAction, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'anti-csrftoken-a2z': antiCsrf,
            },
            body: formData.toString(),
            credentials: 'include',
          });
          if (submitResp.status === 401) return JSON.stringify({ __status: 401, __error: true });
          if (submitResp.status === 403) return JSON.stringify({ __status: 403, __error: true });
          var resultHtml = await submitResp.text();
          var resultDoc = parser.parseFromString(resultHtml, 'text/html');

          // Extract order ID from confirmation page
          var orderIdEl = resultDoc.querySelector('[class*="order-id"]') ||
                          resultDoc.querySelector('[data-order-id]') ||
                          resultDoc.querySelector('[class*="confirmation"]');
          var orderId = '';
          if (orderIdEl) {
            var oidMatch = (orderIdEl.textContent || '').match(/\\d{3}-\\d{7}-\\d{7}/);
            if (oidMatch) orderId = oidMatch[0];
          }
          // Also check URL for order ID
          var urlMatch = submitResp.url.match(/orderId=([\\d-]+)/);
          if (!orderId && urlMatch) orderId = urlMatch[1];

          var deliveryEl = resultDoc.querySelector('[class*="delivery-date"]') || resultDoc.querySelector('[class*="estimated-delivery"]');
          var estimatedDelivery = deliveryEl ? deliveryEl.textContent.trim() : '';

          return JSON.stringify({
            __status: submitResp.status,
            __data: { orderId: orderId || 'confirmed', estimatedDelivery }
          });
        } catch(e) {
          return JSON.stringify({ __error: true, __message: e.message });
        }
      })()
    `;

    const result = await cdpEval(tabId, script) as Record<string, unknown>;
    handleResult(result);
    return result.__data as PlaceOrderResult;
  });
}
