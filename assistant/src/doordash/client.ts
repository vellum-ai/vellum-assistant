/**
 * DoorDash GraphQL API client.
 * Executes GraphQL queries through Chrome's CDP (Runtime.evaluate) so requests
 * go through the browser's authenticated session with Cloudflare tokens intact.
 */

import {
  loadSession,
  type DoorDashSession,
} from './session.js';
import {
  SEARCH_QUERY,
  HOME_PAGE_QUERY,
  STORE_PAGE_QUERY,
  RETAIL_STORE_FEED_QUERY,
  RETAIL_SEARCH_QUERY,
  ITEM_PAGE_QUERY,
  REMOVE_CART_ITEM_QUERY,
  DETAILED_CART_QUERY,
  LIST_CARTS_QUERY,
  DROPOFF_OPTIONS_QUERY,
  CREATE_ORDER_FROM_CART_QUERY,
  PAYMENT_METHODS_QUERY,
  UPDATE_CART_ITEM_QUERY,
} from './queries.js';
import { loadCapturedQueries } from './query-extractor.js';

const GRAPHQL_BASE = 'https://www.doordash.com/graphql';
const CDP_BASE = 'http://localhost:9222';

/**
 * Returns a captured query if one exists for the given operation name,
 * otherwise falls back to the static query string from queries.ts.
 */
function getQuery(operationName: string, staticFallback: string): string {
  const captured = loadCapturedQueries();
  return captured[operationName]?.query ?? staticFallback;
}

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; extensions?: unknown }>;
}

/** Thrown when the session is missing or expired. The CLI handles this specially. */
export class SessionExpiredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SessionExpiredError';
  }
}

/** Thrown when DoorDash returns HTTP 403 (rate limited). */
export class RateLimitError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RateLimitError';
  }
}

function requireSession(): DoorDashSession {
  const session = loadSession();
  if (!session) {
    throw new SessionExpiredError('No DoorDash session found.');
  }
  return session;
}

/**
 * Find a Chrome tab on doordash.com and return its WebSocket debugger URL.
 */
async function findDoordashTab(): Promise<string> {
  const res = await fetch(`${CDP_BASE}/json/list`).catch(() => null);
  if (!res?.ok) {
    throw new SessionExpiredError('Chrome CDP not available. Run `vellum doordash refresh` first.');
  }
  const targets = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  // Prefer a tab already on doordash.com
  const ddTab = targets.find(
    t => t.type === 'page' && t.url.includes('doordash.com'),
  );
  const tab = ddTab ?? targets.find(t => t.type === 'page');
  if (!tab?.webSocketDebuggerUrl) {
    throw new SessionExpiredError('No Chrome tab available for DoorDash requests.');
  }
  return tab.webSocketDebuggerUrl;
}

/**
 * Execute a fetch() call inside Chrome's page context via CDP Runtime.evaluate.
 * This ensures the request uses the browser's cookies and Cloudflare clearance.
 */
async function cdpFetch(wsUrl: string, url: string, body: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP fetch timed out after 30s'));
    }, 30000);

    ws.onopen = () => {
      // First navigate to doordash.com if not already there (needed for CORS)
      // Extract CSRF token from cookies and include in fetch headers
      const fetchScript = `
        (function() {
          var csrf = (document.cookie.match(/csrf_token=([^;]+)/) || [])[1] || '';
          return fetch(${JSON.stringify(url)}, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-channel-id': 'marketplace',
              'x-experience-id': 'doordash',
              'x-csrftoken': csrf,
              'apollographql-client-name': '@doordash/app-consumer-production-ssr-client',
              'apollographql-client-version': '3.0',
            },
            body: ${JSON.stringify(body)},
            credentials: 'include',
          })
          .then(function(r) {
            if (!r.ok) return r.text().then(function(t) {
              return JSON.stringify({ __status: r.status, __error: true, __body: t.substring(0, 500) });
            });
            return r.text();
          })
          .catch(function(e) { return JSON.stringify({ __error: true, __message: e.message }); });
        })()
      `;

      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression: fetchScript,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.close();

          if (msg.error) {
            reject(new Error(`CDP error: ${msg.error.message}`));
            return;
          }

          const value = msg.result?.result?.value;
          if (!value) {
            reject(new Error('Empty CDP response'));
            return;
          }

          const parsed = typeof value === 'string' ? JSON.parse(value) : value;
          if (parsed.__error) {
            if (parsed.__status === 401) {
              reject(new SessionExpiredError('DoorDash session has expired.'));
            } else if (parsed.__status === 403) {
              reject(new RateLimitError('DoorDash rate limit hit (HTTP 403).'));
            } else {
              reject(new Error(parsed.__message ?? `HTTP ${parsed.__status}: ${parsed.__body ?? ''}`));
            }
            return;
          }
          resolve(parsed);
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new SessionExpiredError('CDP connection failed.'));
    };
  });
}

let lastRequestTime = 0;

async function graphql<T = unknown>(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  _session?: DoorDashSession,
): Promise<T> {
  if (!_session) requireSession();

  const wsUrl = await findDoordashTab();
  const url = `${GRAPHQL_BASE}/${operationName}?operation=${operationName}`;
  const body = JSON.stringify({ operationName, variables, query });

  const backoffSchedule = [5000, 10000, 20000];

  for (let attempt = 0; ; attempt++) {
    // Inter-request delay
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (lastRequestTime > 0 && elapsed < 2000) {
      await new Promise(r => setTimeout(r, 2000 - elapsed));
    }

    try {
      const json = (await cdpFetch(wsUrl, url, body)) as GraphQLResponse<T>;
      lastRequestTime = Date.now();

      if (json.errors?.length) {
        const msgs = json.errors.map(e => e.message || JSON.stringify(e)).join('; ');
        throw new Error(`Unexpected response from DoorDash API: ${msgs}`);
      }
      if (!json.data) {
        throw new Error('Unexpected response format from DoorDash API');
      }
      return json.data;
    } catch (err) {
      if (err instanceof RateLimitError && attempt < backoffSchedule.length) {
        const delay = backoffSchedule[attempt];
        process.stderr.write(
          `[doordash] Rate limited, retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${backoffSchedule.length})\n`,
        );
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SearchResult {
  id: string;
  name: string;
  description?: string;
  imageUrl?: string;
  rating?: string;
  deliveryFee?: string;
  storeId?: string;
}

export async function search(query: string): Promise<SearchResult[]> {
  const data = await graphql<{ autocompleteFacetFeed: unknown }>(
    'autocompleteFacetFeed',
    getQuery('autocompleteFacetFeed', SEARCH_QUERY),
    { query, serializedBundleGlobalSearchContext: null },
  );
  return extractSearchResults(data.autocompleteFacetFeed);
}

/**
 * Search for items/stores using the home page feed with a filter query.
 * This works for convenience/retail stores that don't expose menus through storepageFeed.
 */
export async function searchItems(query: string, opts?: { debug?: boolean }): Promise<SearchResult[]> {
  const data = await graphql<{ homePageFacetFeed: unknown }>(
    'homePageFacetFeed',
    getQuery('homePageFacetFeed', HOME_PAGE_QUERY),
    {
      cursor: null,
      filterQuery: query,
      displayHeader: false,
      isDebug: false,
      cuisineFilterVerticalIds: '',
    },
  );
  if (opts?.debug) {
    process.stderr.write(
      `[debug] homePageFacetFeed raw: ${JSON.stringify(data.homePageFacetFeed).substring(0, 3000)}\n`,
    );
  }
  return extractSearchResults(data.homePageFacetFeed);
}

/**
 * Search for items within a specific retail/convenience store.
 * Uses the retailSearch API (convenienceSearchQuery).
 */
export async function retailSearch(storeId: string, query: string, opts?: { limit?: number }): Promise<{
  items: MenuItem[];
  totalCount: number;
  suggestedKeyword?: string;
}> {
  const data = await graphql<{ retailSearch: Record<string, unknown> }>(
    'convenienceSearchQuery',
    getQuery('convenienceSearchQuery', RETAIL_SEARCH_QUERY),
    {
      input: {
        query,
        storeId,
        disableSpellCheck: false,
        limit: opts?.limit ?? 30,
        origin: 'RETAIL_SEARCH',
        filterQuery: '',
        cursor: null,
        aggregateStoreIds: [],
        isDebug: false,
      },
    },
  );
  const result = data.retailSearch;
  const legoItems = (result.legoRetailItems ?? []) as Array<Record<string, unknown>>;
  const summary = (result.searchSummary ?? {}) as Record<string, unknown>;

  const items: MenuItem[] = [];
  for (const facet of legoItems) {
    try {
      const customStr = facet.custom as string | undefined;
      if (!customStr) continue;
      const custom = JSON.parse(customStr) as Record<string, unknown>;
      const itemData = custom.item_data as Record<string, unknown> | undefined;
      if (!itemData) continue;
      const price = itemData.price as Record<string, unknown> | undefined;
      const image = custom.image as Record<string, Record<string, string>> | undefined;
      items.push({
        id: String(itemData.item_id ?? ''),
        name: String(itemData.item_name ?? ''),
        description: itemData.description as string | undefined,
        price: price?.display_string as string | undefined,
        imageUrl: image?.remote?.uri,
        storeId: String(itemData.store_id ?? ''),
        menuId: String(itemData.menu_id ?? ''),
        unitAmount: price?.unit_amount as number | undefined,
      });
    } catch { /* skip malformed entries */ }
  }

  return {
    items,
    totalCount: Number(summary.totalCount ?? items.length),
    suggestedKeyword: summary.suggestedSearchKeyword as string | undefined,
  };
}

export interface StoreInfo {
  id: string;
  name: string;
  description?: string;
  address?: string;
  rating?: number;
  numRatings?: string;
  deliveryFee?: string;
  deliveryTime?: string;
  priceRange?: string;
  categories: Array<{ id: string; name: string; numItems: number }>;
  items: Array<MenuItem>;
  /** True for convenience/pharmacy stores that require store-search for items */
  isRetail?: boolean;
}

export interface MenuItem {
  id: string;
  name: string;
  description?: string;
  price?: string;
  imageUrl?: string;
  storeId?: string;
  menuId?: string;
  unitAmount?: number;
}

export async function getStoreMenu(
  storeId: string,
  menuId?: string,
  opts?: { debug?: boolean },
): Promise<StoreInfo> {
  const data = await graphql<{ storepageFeed: Record<string, unknown> }>(
    'storepageFeed',
    getQuery('storepageFeed', STORE_PAGE_QUERY),
    {
      storeId,
      menuId: menuId ?? null,
      isMerchantPreview: false,
      fulfillmentType: 'Delivery',
      cursor: null,
      scheduledTime: null,
      entryPoint: 'HomePage',
    },
  );
  const feed = data.storepageFeed;
  const rawItemLists = (feed.itemLists ?? []) as unknown[];
  const rawCarousels = (feed.carousels ?? []) as unknown[];

  if (opts?.debug) {
    const menuBook = feed.menuBook as Record<string, unknown> | undefined;
    process.stderr.write(
      `[debug] storepageFeed keys: ${Object.keys(feed).join(', ')}\n` +
      `[debug] itemLists count: ${rawItemLists.length}, carousels count: ${rawCarousels.length}\n` +
      `[debug] menuBook: ${JSON.stringify(menuBook).substring(0, 2000)}\n`,
    );
  }

  const info = extractStoreInfo(feed);

  // If storepageFeed returned no items, try the retail store feed
  // (convenience/pharmacy stores use a different API)
  if (info.items.length === 0 && info.categories.length === 0) {
    if (opts?.debug) {
      process.stderr.write('[debug] No items from storepageFeed, trying retailStorePageFeed...\n');
    }
    return getRetailStoreMenu(storeId, opts);
  }

  return info;
}

/**
 * Get menu for a retail/convenience store (CVS, Duane Reade, etc.).
 * These stores use `retailStorePageFeed` instead of `storepageFeed`.
 */
export async function getRetailStoreMenu(
  storeId: string,
  opts?: { debug?: boolean },
): Promise<StoreInfo> {
  const data = await graphql<{ retailStorePageFeed: Record<string, unknown> }>(
    'storeFeed',
    getQuery('storeFeed', RETAIL_STORE_FEED_QUERY),
    {
      storeId,
      attrSrc: 'store',
      cursor: null,
      enableDebug: false,
    },
  );
  if (opts?.debug) {
    const feed = data.retailStorePageFeed;
    const l1Cats = (feed.l1Categories ?? []) as unknown[];
    const collections = (feed.collections ?? []) as unknown[];
    const page = feed.page as Record<string, unknown> | undefined;
    process.stderr.write(
      `[debug] retailStorePageFeed keys: ${Object.keys(feed).join(', ')}\n` +
      `[debug] l1Categories count: ${l1Cats.length}, collections count: ${collections.length}\n` +
      `[debug] page: ${JSON.stringify(page).substring(0, 500)}\n` +
      `[debug] collections sample: ${JSON.stringify(collections.slice(0, 2)).substring(0, 2000)}\n`,
    );
  }
  return extractRetailStoreInfo(data.retailStorePageFeed);
}

export interface ItemDetails {
  id: string;
  name: string;
  description?: string;
  price?: string;
  unitAmount?: number;
  currency?: string;
  imageUrl?: string;
  menuId?: string;
  options: Array<{
    id: string;
    name: string;
    required: boolean;
    minSelections?: number;
    maxSelections?: number;
    choices: Array<{
      id: string;
      name: string;
      price?: string;
      unitAmount?: number;
      defaultQuantity?: number;
      nestedOptions?: Array<{
        id: string;
        name: string;
        required: boolean;
        choices: Array<{
          id: string;
          name: string;
          price?: string;
        }>;
      }>;
    }>;
  }>;
  specialInstructionsConfig?: {
    maxLength: number;
    placeholderText?: string;
    isEnabled: boolean;
  };
}

export async function getItemDetails(
  storeId: string,
  itemId: string,
): Promise<ItemDetails> {
  const data = await graphql<{ itemPage: Record<string, unknown> }>(
    'itemPage',
    getQuery('itemPage', ITEM_PAGE_QUERY),
    {
      storeId,
      itemId,
      isMerchantPreview: false,
      isNested: false,
      shouldFetchPresetCarousels: false,
      fulfillmentType: 'Delivery',
      shouldFetchStoreLiteData: false,
    },
  );
  return extractItemDetails(data.itemPage);
}

export interface CartSummary {
  cartId: string;
  storeName?: string;
  storeId?: string;
  subtotal?: number;
  total?: number;
  items: Array<{
    id: string;
    name: string;
    quantity: number;
    price?: string;
  }>;
}

export async function addToCart(opts: {
  storeId: string;
  menuId: string;
  itemId: string;
  itemName: string;
  itemDescription?: string;
  unitPrice: number;
  quantity?: number;
  cartId?: string;
  nestedOptions?: string;
  specialInstructions?: string;
}): Promise<CartSummary> {
  // Use updateCartItemV2 — DoorDash now uses this for both adding and updating cart items
  const data = await graphql<{ updateCartItemV2: Record<string, unknown> }>(
    'updateCartItem',
    getQuery('updateCartItem', UPDATE_CART_ITEM_QUERY),
    {
      updateCartItemApiParams: {
        cartId: opts.cartId ?? '',
        cartItemId: '',
        itemId: opts.itemId,
        itemName: opts.itemName,
        itemDescription: opts.itemDescription ?? '',
        currency: 'USD',
        quantity: opts.quantity ?? 1,
        unitPrice: opts.unitPrice,
        storeId: opts.storeId,
        menuId: opts.menuId,
        creatorId: '',
        nestedOptions: opts.nestedOptions ?? '[]',
        specialInstructions: opts.specialInstructions ?? '',
        substitutionPreference: 'contact',
        purchaseTypeOptions: {
          purchaseType: 'PURCHASE_TYPE_UNIT',
          unit: 'qty',
          estimatedPricingDescription: '',
          continuousQuantity: 0,
        },
        isAdsItem: false,
        isBundle: false,
        bundleType: 'BUNDLE_TYPE_UNSPECIFIED',
        cartFilter: null,
      },
      fulfillmentContext: {
        shouldUpdateFulfillment: false,
        fulfillmentType: 'Delivery',
      },
      returnCartFromOrderService: false,
      shouldKeepOnlyOneActiveCart: false,
    },
  );
  return extractCartSummary(data.updateCartItemV2);
}

export async function removeFromCart(
  cartId: string,
  itemId: string,
): Promise<CartSummary> {
  const data = await graphql<{ removeCartItemV2: Record<string, unknown> }>(
    'removeCartItem',
    getQuery('removeCartItem', REMOVE_CART_ITEM_QUERY),
    {
      cartId,
      itemId,
      returnCartFromOrderService: false,
      monitoringContext: { isGroup: false },
      cartFilter: null,
      cartContext: { deleteBundleCarts: false },
    },
  );
  return extractCartSummary(data.removeCartItemV2);
}

export async function viewCart(cartId: string): Promise<CartSummary> {
  const data = await graphql<{ orderCart: Record<string, unknown> }>(
    'detailedCartItems',
    getQuery('detailedCartItems', DETAILED_CART_QUERY),
    { orderCartId: cartId, isCardPayment: true },
  );
  return extractCartSummary(data.orderCart);
}

export async function listCarts(storeId?: string): Promise<CartSummary[]> {
  const input: Record<string, unknown> = {
    cartFilter: { shouldIncludeSubmitted: true },
  };
  if (storeId) {
    input.cartContextFilter = {
      experienceCase: 'MULTI_CART_EXPERIENCE_CONTEXT',
      multiCartExperienceContext: { storeId },
    };
  }
  const data = await graphql<{ listCarts: Record<string, unknown>[] }>(
    'listCarts',
    getQuery('listCarts', LIST_CARTS_QUERY),
    { input },
  );
  return (data.listCarts ?? []).map(extractCartSummary);
}

export interface DropoffOption {
  id: string;
  displayString: string;
  isDefault: boolean;
  isEnabled: boolean;
}

export async function getDropoffOptions(
  cartId: string,
  addressId?: string,
): Promise<DropoffOption[]> {
  const data = await graphql<{
    dropoffOptions: Array<Record<string, unknown>>;
  }>('dropoffOptions', getQuery('dropoffOptions', DROPOFF_OPTIONS_QUERY), {
    cartId,
    addressId: addressId ?? null,
  });
  return (data.dropoffOptions ?? []).map(o => ({
    id: String(o.id),
    displayString: String(o.displayString ?? ''),
    isDefault: Boolean(o.isDefault),
    isEnabled: Boolean(o.isEnabled),
  }));
}

export interface PaymentMethod {
  id: string;
  type: string;
  last4: string;
  isDefault: boolean;
  uuid: string;
}

export async function getPaymentMethods(): Promise<PaymentMethod[]> {
  const data = await graphql<{ getPaymentMethodList: Array<Record<string, unknown>> }>(
    'paymentMethodQuery',
    getQuery('paymentMethodQuery', PAYMENT_METHODS_QUERY),
    {
      country: 'US',
      usePaymentConfigQuery: true,
      usePaymentConfigQueryV2: true,
    },
  );
  return (data.getPaymentMethodList ?? []).map(p => ({
    id: String(p.id ?? ''),
    type: String(p.type ?? ''),
    last4: String(p.last4 ?? ''),
    isDefault: Boolean(p.isDefault),
    uuid: String(p.paymentMethodUuid ?? p.uuid ?? ''),
  }));
}

export interface PlaceOrderResult {
  cartId: string;
  orderUuid: string;
}

export async function placeOrder(opts: {
  cartId: string;
  storeId: string;
  total: number;
  tipAmount?: number;
  deliveryOptionType?: string;
  dropoffOptionId?: string;
  paymentMethodUuid?: string;
  paymentMethodType?: string;
}): Promise<PlaceOrderResult> {
  // If no payment method specified, use the default one
  let pmUuid = opts.paymentMethodUuid;
  let pmType = opts.paymentMethodType ?? 'Card';
  if (!pmUuid) {
    const methods = await getPaymentMethods();
    const defaultMethod = methods.find(m => m.isDefault) ?? methods[0];
    if (!defaultMethod) {
      throw new Error('No payment method found. Add a payment method in the DoorDash app first.');
    }
    pmUuid = defaultMethod.uuid;
    // defaultMethod.type is the card brand (e.g. "Visa"), not the PaymentMethodType enum
    pmType = 'Card';
  }

  // Build dropoff preferences
  const dropoffPreferences = opts.dropoffOptionId
    ? JSON.stringify([{ typename: 'DropoffPreference', option_id: opts.dropoffOptionId, is_default: true, instructions: '' }])
    : '[]';

  const data = await graphql<{ createOrderFromCart: Record<string, unknown> }>(
    'createOrderFromCart',
    getQuery('createOrderFromCart', CREATE_ORDER_FROM_CART_QUERY),
    {
      cartId: opts.cartId,
      storeId: opts.storeId,
      total: opts.total,
      sosDeliveryFee: 0,
      isPickupOrder: false,
      verifiedAgeRequirement: false,
      deliveryTime: 'ASAP',
      menuOptions: null,
      attributionData: '{}',
      fulfillsOwnDeliveries: false,
      teamId: null,
      budgetId: null,
      giftOptions: null,
      recipientShippingDetails: null,
      tipAmounts: [{ tipRecipient: 'DASHER', amount: opts.tipAmount ?? 0 }],
      paymentMethod: null,
      deliveryOptionType: opts.deliveryOptionType ?? 'STANDARD',
      workOrderOptions: null,
      isCardPayment: true,
      clientFraudContext: null,
      programId: '',
      membershipId: '',
      dropoffPreferences,
      monitoringContext: { isGroup: false },
      routineReorderDetails: {},
      supplementalPaymentDetailsList: [],
      shouldApplyCredits: true,
      dasherPickupInstructions: '',
      paymentMethodUuid: pmUuid,
      paymentMethodType: pmType,
      deviceTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  );

  return {
    cartId: String(data.createOrderFromCart.cartId ?? ''),
    orderUuid: String(data.createOrderFromCart.orderUuid ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Response extraction helpers
// ---------------------------------------------------------------------------

function extractSearchResults(feed: unknown): SearchResult[] {
  const results: SearchResult[] = [];
  if (!feed || typeof feed !== 'object') return results;
  const f = feed as Record<string, unknown>;
  const bodies = (f.body ?? []) as Array<Record<string, unknown>>;
  for (const section of bodies) {
    const items = (section.body ?? []) as Array<Record<string, unknown>>;
    for (const item of items) {
      const text = item.text as Record<string, string> | undefined;
      const images = item.images as Record<string, Record<string, string>> | undefined;
      const events = item.events as Record<string, Record<string, string>> | undefined;
      let storeId: string | undefined;
      // Try click event data first
      if (events?.click?.data) {
        try {
          const clickData = JSON.parse(events.click.data) as Record<string, unknown>;
          storeId = String(clickData.store_id ?? clickData.storeId ?? '');
        } catch { /* ignore */ }
      }
      // Fall back to parsing from the item ID (format: "row.search-result:STORE_ID:INDEX")
      if (!storeId) {
        const idStr = String(item.id ?? '');
        const match = idStr.match(/search-result:(\d+)/);
        if (match) storeId = match[1];
      }
      if (text?.title) {
        results.push({
          id: String(item.id ?? ''),
          name: text.title,
          description: text.subtitle || text.description,
          imageUrl: images?.main?.uri,
          rating: text.accessory,
          storeId,
        });
      }
    }
  }
  return results;
}

function extractStoreInfo(feed: Record<string, unknown>): StoreInfo {
  const header = (feed.storeHeader ?? {}) as Record<string, unknown>;
  const menuBook = (feed.menuBook ?? {}) as Record<string, unknown>;
  const itemLists = (feed.itemLists ?? []) as Array<Record<string, unknown>>;
  const address = header.address as Record<string, string> | undefined;
  const ratings = header.ratings as Record<string, unknown> | undefined;
  const deliveryFee = header.deliveryFeeLayout as Record<string, string> | undefined;
  const deliveryTime = header.deliveryTimeLayout as Record<string, string> | undefined;

  const categories = ((menuBook.menuCategories ?? []) as Array<Record<string, unknown>>).map(c => ({
    id: String(c.id),
    name: String(c.name),
    numItems: Number(c.numItems ?? 0),
  }));

  const items: MenuItem[] = [];
  for (const list of itemLists) {
    for (const item of (list.items ?? []) as Array<Record<string, unknown>>) {
      items.push({
        id: String(item.id),
        name: String(item.name ?? ''),
        description: item.description as string | undefined,
        price: item.displayPrice as string | undefined,
        imageUrl: item.imageUrl as string | undefined,
        storeId: item.storeId as string | undefined,
      });
    }
  }

  // Also extract from carousels (used by convenience/pharmacy stores)
  const carousels = (feed.carousels ?? []) as Array<Record<string, unknown>>;
  for (const carousel of carousels) {
    for (const item of (carousel.items ?? []) as Array<Record<string, unknown>>) {
      items.push({
        id: String(item.id),
        name: String(item.name ?? ''),
        description: item.description as string | undefined,
        price: item.displayPrice as string | undefined,
        imageUrl: item.imgUrl as string | undefined,
      });
    }
  }

  return {
    id: String(header.id ?? ''),
    name: String(header.name ?? ''),
    description: header.description as string | undefined,
    address: address?.displayAddress,
    rating: ratings?.averageRating as number | undefined,
    numRatings: ratings?.numRatingsDisplayString as string | undefined,
    deliveryFee: deliveryFee?.title,
    deliveryTime: deliveryTime?.title,
    priceRange: header.priceRangeDisplayString as string | undefined,
    categories,
    items,
  };
}

function extractNestedOptions(extrasList: Array<Record<string, unknown>>): ItemDetails['options'][number]['choices'][number]['nestedOptions'] {
  return extrasList.map(nested => ({
    id: String(nested.id),
    name: String(nested.name ?? ''),
    required: !nested.isOptional,
    choices: ((nested.options ?? []) as Array<Record<string, unknown>>).map(o => ({
      id: String(o.id),
      name: String(o.name ?? ''),
      price: o.displayString as string | undefined,
    })),
  }));
}

function extractItemDetails(page: Record<string, unknown>): ItemDetails {
  const header = (page.itemHeader ?? {}) as Record<string, unknown>;
  const optionLists = (page.optionLists ?? []) as Array<Record<string, unknown>>;
  const itemPreferences = page.itemPreferences as Record<string, unknown> | undefined;

  const result: ItemDetails = {
    id: String(header.id ?? ''),
    name: String(header.name ?? ''),
    description: header.description as string | undefined,
    price: header.displayString as string | undefined,
    unitAmount: header.unitAmount as number | undefined,
    currency: header.currency as string | undefined,
    imageUrl: header.imgUrl as string | undefined,
    menuId: header.menuId as string | undefined,
    options: optionLists.map(ol => {
      const choices = ((ol.options ?? []) as Array<Record<string, unknown>>).map(o => {
        const choice: ItemDetails['options'][number]['choices'][number] = {
          id: String(o.id),
          name: String(o.name ?? ''),
          price: o.displayString as string | undefined,
          unitAmount: o.unitAmount as number | undefined,
          defaultQuantity: o.defaultQuantity as number | undefined,
        };
        const nestedExtrasList = (o.nestedExtrasList ?? []) as Array<Record<string, unknown>>;
        if (nestedExtrasList.length > 0) {
          choice.nestedOptions = extractNestedOptions(nestedExtrasList);
        }
        return choice;
      });

      return {
        id: String(ol.id),
        name: String(ol.name ?? ''),
        required: !ol.isOptional,
        minSelections: ol.minNumOptions as number | undefined,
        maxSelections: ol.maxNumOptions as number | undefined,
        choices,
      };
    }),
  };

  if (itemPreferences) {
    const specialInstructions = (itemPreferences.specialInstructions ?? {}) as Record<string, unknown>;
    result.specialInstructionsConfig = {
      maxLength: Number(specialInstructions.characterMaxLength ?? 500),
      placeholderText: specialInstructions.placeholderText as string | undefined,
      isEnabled: specialInstructions.isEnabled !== false,
    };
  }

  return result;
}

function extractRetailStoreInfo(feed: Record<string, unknown>): StoreInfo {
  const storeDetails = (feed.storeDetails ?? {}) as Record<string, unknown>;
  const storeHeader = (storeDetails.storeHeader ?? {}) as Record<string, unknown>;
  const ratings = storeHeader.ratings as Record<string, unknown> | undefined;
  const deliveryFee = storeHeader.deliveryFeeLayout as Record<string, string> | undefined;
  const status = storeHeader.status as Record<string, Record<string, unknown>> | undefined;

  const l1Categories = (feed.l1Categories ?? []) as Array<Record<string, unknown>>;
  const collections = (feed.collections ?? []) as Array<Record<string, unknown>>;

  const categories = l1Categories.map(c => ({
    id: String(c.id),
    name: String(c.name),
    numItems: Number(c.numItems ?? 0),
  }));

  const items: MenuItem[] = [];
  for (const collection of collections) {
    // Retail collections use `products`, not `items`
    const products = (collection.products ?? collection.items ?? []) as Array<Record<string, unknown>>;
    for (const item of products) {
      const price = item.price as Record<string, unknown> | undefined;
      items.push({
        id: String(item.id),
        name: String(item.name ?? ''),
        description: item.description as string | undefined,
        price: (price?.displayString ?? item.displayPrice) as string | undefined,
        imageUrl: (item.imageUrl ?? item.imgUrl) as string | undefined,
        storeId: item.storeId as string | undefined,
      });
    }
  }

  const address = storeHeader.address as Record<string, string> | undefined;

  return {
    id: String(storeDetails.id ?? ''),
    name: String(storeHeader.name ?? storeDetails.name ?? ''),
    description: storeHeader.description as string | undefined,
    address: address?.displayAddress,
    rating: ratings?.averageRating as number | undefined,
    numRatings: ratings?.numRatingsDisplayString as string | undefined,
    deliveryFee: deliveryFee?.title,
    deliveryTime: status?.delivery?.etaDisplayString as string | undefined,
    priceRange: storeHeader.priceRangeDisplayString as string | undefined,
    categories,
    items,
    isRetail: true,
  };
}

function extractCartSummary(cart: Record<string, unknown>): CartSummary {
  const restaurant = (cart.restaurant ?? {}) as Record<string, unknown>;
  const orders = (cart.orders ?? []) as Array<Record<string, unknown>>;

  const items: CartSummary['items'] = [];
  for (const order of orders) {
    for (const oi of (order.orderItems ?? []) as Array<Record<string, unknown>>) {
      const item = (oi.item ?? {}) as Record<string, unknown>;
      items.push({
        id: String(oi.id ?? ''),
        name: String(item.name ?? ''),
        quantity: Number(oi.quantity ?? 1),
        price: oi.priceDisplayString as string | undefined,
      });
    }
  }

  return {
    cartId: String(cart.id ?? ''),
    storeName: restaurant.name as string | undefined,
    storeId: restaurant.id as string | undefined,
    subtotal: cart.subtotal as number | undefined,
    total: cart.total as number | undefined,
    items,
  };
}
