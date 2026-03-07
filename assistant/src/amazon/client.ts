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

import type {
  ExtensionCommand,
  ExtensionResponse,
} from "../browser-extension-relay/protocol.js";
import { extensionRelayServer } from "../browser-extension-relay/server.js";
import {
  initAuthSigningKey,
  isSigningKeyInitialized,
  loadOrCreateSigningKey,
} from "../runtime/auth/token-service.js";
import { gatewayPost } from "../runtime/gateway-internal-client.js";
import type { ExtractedCredential } from "../tools/browser/network-recording-types.js";
import { type AmazonSession, loadSession, saveSession } from "./session.js";

export const AMAZON_BASE = "https://www.amazon.com";

// ---------------------------------------------------------------------------
// Relay command routing
// ---------------------------------------------------------------------------
// When running inside the daemon, extensionRelayServer has a live WebSocket.
// When running out-of-process (CLI), the relay isn't available, so we fall
// back to the daemon's HTTP endpoint POST /v1/browser-relay/command.
// ---------------------------------------------------------------------------

export async function sendRelayCommand(
  command: Record<string, unknown>,
): Promise<ExtensionResponse> {
  // Try in-process relay first (works when running inside the daemon)
  const status = extensionRelayServer.getStatus();
  if (status.connected) {
    return extensionRelayServer.sendCommand(
      command as Omit<ExtensionCommand, "id">,
    );
  }

  // Fall back to HTTP relay endpoint via the gateway.
  // The gateway validates edge JWTs (aud=vellum-gateway) and mints an
  // exchange token for the runtime. In CLI out-of-process contexts the
  // signing key may not be initialized yet — load it from disk.
  if (!isSigningKeyInitialized()) {
    initAuthSigningKey(loadOrCreateSigningKey());
  }

  const { data } = await gatewayPost<ExtensionResponse>(
    "/v1/browser-relay/command",
    command,
  );
  return data;
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
  // Skip cookie sync — use Chrome's own live cookies instead of overwriting with stale CLI ones
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

  // No Amazon tab open — create one
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
    await extensionRelayServer.sendCommand({
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
// Session refresh via browser extension relay
// ---------------------------------------------------------------------------

/**
 * Refresh the Amazon session by grabbing cookies directly from Chrome
 * via the browser extension relay's `get_cookies` action.
 *
 * Much faster than the CDP-based Ride Shotgun flow — no separate Chrome
 * instance, no recording. Requires the extension to be loaded and connected.
 */
export async function refreshSessionFromExtension(): Promise<AmazonSession> {
  const resp = await sendRelayCommand({
    action: "get_cookies",
    domain: "amazon.com",
  });

  if (!resp.success) {
    throw new Error(
      `Failed to get cookies from browser extension: ${resp.error ?? "unknown error"}`,
    );
  }

  const chromeCookies = resp.result as Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    expirationDate?: number;
  }>;

  if (!chromeCookies?.length) {
    throw new Error(
      "No Amazon cookies found in Chrome. " +
        "Make sure you are signed into Amazon in Chrome.",
    );
  }

  const cookies: ExtractedCredential[] = chromeCookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    httpOnly: c.httpOnly,
    secure: c.secure,
    expires: c.expirationDate ? Math.floor(c.expirationDate) : undefined,
  }));

  // Validate required cookies
  const cookieNames = new Set(cookies.map((c) => c.name));
  if (!cookieNames.has("session-id")) {
    throw new Error(
      "Chrome cookies are missing required Amazon cookie: session-id. " +
        "Make sure you are signed into Amazon in Chrome.",
    );
  }
  if (!cookieNames.has("ubid-main")) {
    throw new Error(
      "Chrome cookies are missing required Amazon cookie: ubid-main. " +
        "Make sure you are signed into Amazon in Chrome.",
    );
  }
  if (!cookieNames.has("at-main") && !cookieNames.has("x-main")) {
    throw new Error(
      "Chrome cookies are missing required Amazon auth cookie (at-main or x-main). " +
        "Make sure you are fully signed into Amazon in Chrome.",
    );
  }

  const session: AmazonSession = {
    cookies,
    importedAt: new Date().toISOString(),
  };

  saveSession(session);
  return session;
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
