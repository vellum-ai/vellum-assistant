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

import type { ExtractedCredential } from "./shared/recording-types.js";
import { getHttpBaseUrl, readSessionToken } from "./shared/platform.js";
import { type AmazonSession, loadSession } from "./session.js";

export const AMAZON_BASE = "https://www.amazon.com";

// ---------------------------------------------------------------------------
// Browser extension relay types and stubs
// ---------------------------------------------------------------------------
// When running as a standalone CLI skill, browser-relay commands need to go
// through the daemon's HTTP endpoint. These types mirror the protocol.

export interface ExtensionCommand {
  id?: string;
  action: string;
  [key: string]: unknown;
}

export interface ExtensionResponse {
  success: boolean;
  tabId?: number;
  result?: unknown;
  error?: string;
}

/**
 * Send a command to the browser extension relay via the daemon's HTTP endpoint.
 * Routes through POST /v1/browser-relay/command which forwards to the Chrome extension.
 */
export async function sendRelayCommand(
  command: Record<string, unknown>,
): Promise<ExtensionResponse> {
  const baseUrl = getHttpBaseUrl();
  const sessionToken = readSessionToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  }

  const response = await fetch(`${baseUrl}/v1/browser-relay/command`, {
    method: "POST",
    headers,
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Authentication failed with daemon. Make sure the assistant is running.",
      );
    }
    throw new Error(
      `Browser relay request failed: ${response.status} ${text}`,
    );
  }

  return (await response.json()) as ExtensionResponse;
}

/** Thrown when the session is missing or expired. The CLI handles this specially. */
export class SessionExpiredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SessionExpiredError";
  }
}

/** Thrown when Amazon returns HTTP 403 (rate limited or bot detected). */
export class RateLimitError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RateLimitError";
  }
}

function requireSession(): AmazonSession {
  const session = loadSession();
  if (!session) {
    throw new SessionExpiredError("No Amazon session found.");
  }
  return session;
}

/**
 * Prepare for an Amazon request: validate session, find a Chrome tab,
 * and sync session cookies into the browser. Returns the tab ID.
 */
export async function prepareRequest(): Promise<{
  tabId: number;
  session: AmazonSession;
}> {
  const session = requireSession();
  const tabId = await findAmazonTab();
  // Skip cookie sync -- use Chrome's own live cookies instead of overwriting with stale CLI ones
  // await syncCookiesToBrowser(session.cookies);
  return { tabId, session };
}

/**
 * Find a Chrome tab on amazon.com via the browser-relay extension.
 * Opens a new Amazon tab if none is currently open.
 */
async function findAmazonTab(): Promise<number> {
  const resp = await sendRelayCommand({
    action: "find_tab",
    url: "*://*.amazon.com/*",
  });
  if (resp.success && resp.tabId !== undefined) {
    return resp.tabId;
  }

  // No Amazon tab open -- create one
  const newTab = await sendRelayCommand({
    action: "new_tab",
    url: "https://www.amazon.com",
  });
  if (!newTab.success || newTab.tabId === undefined) {
    throw new SessionExpiredError("Could not open an Amazon tab in Chrome.");
  }
  return newTab.tabId;
}

/**
 * Inject saved session cookies into Chrome via the browser-relay extension.
 * Uses chrome.cookies.set so fetch() calls in the tab context carry the session.
 */
let lastCookieSyncTime = 0;
const COOKIE_SYNC_INTERVAL = 60_000; // re-sync at most once per minute

async function _syncCookiesToBrowser(
  cookies: ExtractedCredential[],
): Promise<void> {
  const now = Date.now();
  if (now - lastCookieSyncTime < COOKIE_SYNC_INTERVAL) return;

  for (const cookie of cookies) {
    const domain = cookie.domain || ".amazon.com";
    const cleanDomain = domain.startsWith(".") ? domain.slice(1) : domain;
    await sendRelayCommand({
      action: "set_cookie",
      cookie: {
        url: `https://${cleanDomain}`,
        name: cookie.name,
        value: cookie.value,
        domain,
        path: cookie.path || "/",
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
export async function cdpEval(tabId: number, script: string): Promise<unknown> {
  let resp: ExtensionResponse;
  try {
    resp = await sendRelayCommand({ action: "evaluate", tabId, code: script });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not connected")) {
      throw new SessionExpiredError(
        "Browser extension relay is not connected. Load the Vellum extension in Chrome.",
      );
    }
    throw err;
  }

  if (!resp.success) {
    throw new Error(`Browser eval failed: ${resp.error ?? "unknown error"}`);
  }

  const value = resp.result;
  if (value == null) {
    throw new Error("Empty browser eval response");
  }

  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return value;
  }
}

/**
 * Handle the raw result object returned from cdpEval scripts.
 * Throws appropriate errors for auth failures, rate limits, and other errors.
 */
export function handleResult(result: Record<string, unknown>): void {
  if (result.__error) {
    if (result.__status === 401) {
      throw new SessionExpiredError("Amazon session has expired.");
    }
    if (result.__status === 403) {
      throw new RateLimitError("Amazon rate limit hit (HTTP 403).");
    }
    throw new Error(
      (result.__message as string | undefined) ??
        `Amazon request failed with status ${result.__status ?? "unknown"}`,
    );
  }
}

let lastRequestTime = 0;

export async function runWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  const backoffSchedule = [5000, 10000, 20000];

  for (let attempt = 0; ; attempt++) {
    // Inter-request delay
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (lastRequestTime > 0 && elapsed < 2000) {
      await new Promise((r) => setTimeout(r, 2000 - elapsed));
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
        await new Promise((r) => setTimeout(r, delay));
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
// Re-export public API from submodules
// ---------------------------------------------------------------------------

export { addToCart, removeFromCart, viewCart } from "./cart.js";
export {
  getCheckoutSummary,
  getFreshDeliverySlots,
  getPaymentMethods,
  placeOrder,
  selectFreshDeliverySlot,
} from "./checkout.js";
export { getProductDetails } from "./product-details.js";
export { search } from "./search.js";
