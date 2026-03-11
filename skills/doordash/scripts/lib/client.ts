/**
 * DoorDash GraphQL API client.
 * Executes GraphQL queries through Chrome's CDP (Runtime.evaluate) so requests
 * go through the browser's authenticated session with Cloudflare tokens intact.
 */

import {
  ADD_CART_ITEM_QUERY,
  CREATE_ORDER_FROM_CART_QUERY,
  DETAILED_CART_QUERY,
  DROPOFF_OPTIONS_QUERY,
  HOME_PAGE_QUERY,
  ITEM_PAGE_QUERY,
  LIST_CARTS_QUERY,
  PAYMENT_METHODS_QUERY,
  REMOVE_CART_ITEM_QUERY,
  RETAIL_SEARCH_QUERY,
  RETAIL_STORE_FEED_QUERY,
  SEARCH_QUERY,
  STORE_PAGE_QUERY,
} from "./queries.js";
import { loadCapturedQueries } from "./query-extractor.js";
import { type DoorDashSession, loadSession } from "./session.js";
import { ProviderError, RateLimitError } from "./shared/errors.js";
import { truncate } from "./shared/truncate.js";
import type {
  DDCart,
  DDCreateOrderResult,
  DDDropoffOption,
  DDFacetFeed,
  DDItemPage,
  DDMenuCategory,
  DDNestedExtra,
  DDOptionChoice,
  DDOptionList,
  DDPaymentMethod,
  DDRetailItemCustom,
  DDRetailSearchResult,
  DDRetailStorePageFeed,
  DDSearchClickData,
  DDStorepageFeed,
} from "./types.js";

export { RateLimitError };

const GRAPHQL_BASE = "https://www.doordash.com/graphql";
const CDP_BASE = "http://localhost:9222";

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
    this.name = "SessionExpiredError";
  }
}

function requireSession(): DoorDashSession {
  const session = loadSession();
  if (!session) {
    throw new SessionExpiredError("No DoorDash session found.");
  }
  return session;
}

/**
 * Find a Chrome tab on doordash.com and return its WebSocket debugger URL.
 */
async function findDoordashTab(): Promise<string> {
  const res = await fetch(`${CDP_BASE}/json/list`).catch(() => null);
  if (!res?.ok) {
    throw new SessionExpiredError(
      "Chrome CDP not available. Run `vellum doordash refresh` first.",
    );
  }
  const targets = (await res.json()) as Array<{
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }>;
  // Prefer a tab already on doordash.com
  const ddTab = targets.find(
    (t) => t.type === "page" && t.url.includes("doordash.com"),
  );
  const tab = ddTab ?? targets.find((t) => t.type === "page");
  if (!tab?.webSocketDebuggerUrl) {
    throw new SessionExpiredError(
      "No Chrome tab available for DoorDash requests.",
    );
  }
  return tab.webSocketDebuggerUrl;
}

/**
 * Execute a fetch() call inside Chrome's page context via CDP Runtime.evaluate.
 * This ensures the request uses the browser's cookies and Cloudflare clearance.
 */
async function cdpFetch(
  wsUrl: string,
  url: string,
  body: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("CDP fetch timed out after 30s"));
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

      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression: fetchScript,
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        );
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.close();

          if (msg.error) {
            reject(new Error(`CDP error: ${msg.error.message}`));
            return;
          }

          const value = msg.result?.result?.value;
          if (!value) {
            reject(new Error("Empty CDP response"));
            return;
          }

          const parsed = typeof value === "string" ? JSON.parse(value) : value;
          if (parsed.__error) {
            if (parsed.__status === 401) {
              reject(new SessionExpiredError("DoorDash session has expired."));
            } else if (parsed.__status === 403) {
              reject(new RateLimitError("DoorDash rate limit hit (HTTP 403)."));
            } else {
              reject(
                new Error(
                  parsed.__message ??
                    `HTTP ${parsed.__status}: ${parsed.__body ?? ""}`,
                ),
              );
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
      reject(new SessionExpiredError("CDP connection failed."));
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
      await new Promise((r) => setTimeout(r, 2000 - elapsed));
    }

    try {
      lastRequestTime = Date.now();
      const json = (await cdpFetch(wsUrl, url, body)) as GraphQLResponse<T>;

      if (json.errors?.length) {
        const msgs = json.errors
          .map((e) => e.message || JSON.stringify(e))
          .join("; ");
        throw new ProviderError(
          `Unexpected response from DoorDash API: ${msgs}`,
          "doordash",
        );
      }
      if (!json.data) {
        throw new ProviderError(
          "Unexpected response format from DoorDash API",
          "doordash",
        );
      }
      return json.data;
    } catch (err) {
      if (err instanceof RateLimitError && attempt < backoffSchedule.length) {
        const delay = backoffSchedule[attempt];
        process.stderr.write(
          `[doordash] Rate limited, retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${backoffSchedule.length})\n`,
        );
        await new Promise((r) => setTimeout(r, delay));
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
  const data = await graphql<{ autocompleteFacetFeed: DDFacetFeed }>(
    "autocompleteFacetFeed",
    getQuery("autocompleteFacetFeed", SEARCH_QUERY),
    { query, serializedBundleGlobalSearchContext: null },
  );
  return extractSearchResults(data.autocompleteFacetFeed);
}

/**
 * Search for items/stores using the home page feed with a filter query.
 * This works for convenience/retail stores that don't expose menus through storepageFeed.
 */
export async function searchItems(
  query: string,
  opts?: { debug?: boolean },
): Promise<SearchResult[]> {
  const data = await graphql<{ homePageFacetFeed: DDFacetFeed }>(
    "homePageFacetFeed",
    getQuery("homePageFacetFeed", HOME_PAGE_QUERY),
    {
      cursor: null,
      filterQuery: query,
      displayHeader: false,
      isDebug: false,
      cuisineFilterVerticalIds: "",
    },
  );
  if (opts?.debug) {
    process.stderr.write(
      `[debug] homePageFacetFeed raw: ${truncate(JSON.stringify(data.homePageFacetFeed), 3000, "")}\n`,
    );
  }
  return extractSearchResults(data.homePageFacetFeed);
}

/**
 * Search for items within a specific retail/convenience store.
 * Uses the retailSearch API (convenienceSearchQuery).
 */
export async function retailSearch(
  storeId: string,
  query: string,
  opts?: { limit?: number },
): Promise<{
  items: MenuItem[];
  totalCount: number;
  suggestedKeyword?: string;
}> {
  const data = await graphql<{ retailSearch: DDRetailSearchResult }>(
    "convenienceSearchQuery",
    getQuery("convenienceSearchQuery", RETAIL_SEARCH_QUERY),
    {
      input: {
        query,
        storeId,
        disableSpellCheck: false,
        limit: opts?.limit ?? 30,
        origin: "RETAIL_SEARCH",
        filterQuery: "",
        cursor: null,
        aggregateStoreIds: [],
        isDebug: false,
      },
    },
  );
  const result = data.retailSearch;
  const legoItems = result.legoRetailItems ?? [];
  const summary = result.searchSummary ?? {};

  const items: MenuItem[] = [];
  for (const facet of legoItems) {
    try {
      const customStr = facet.custom;
      if (!customStr) continue;
      const custom = JSON.parse(customStr) as DDRetailItemCustom;
      const itemData = custom.item_data;
      if (!itemData) continue;
      const price = itemData.price;
      const image = custom.image;
      items.push({
        id: String(itemData.item_id ?? ""),
        name: String(itemData.item_name ?? ""),
        description: itemData.description,
        price: price?.display_string,
        imageUrl: image?.remote?.uri,
        storeId: String(itemData.store_id ?? ""),
        menuId: String(itemData.menu_id ?? ""),
        unitAmount: price?.unit_amount,
      });
    } catch {
      /* skip malformed entries */
    }
  }

  return {
    items,
    totalCount: Number(summary.totalCount ?? items.length),
    suggestedKeyword: summary.suggestedSearchKeyword,
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
  const data = await graphql<{ storepageFeed: DDStorepageFeed }>(
    "storepageFeed",
    getQuery("storepageFeed", STORE_PAGE_QUERY),
    {
      storeId,
      menuId: menuId ?? null,
      isMerchantPreview: false,
      fulfillmentType: "Delivery",
      cursor: null,
      scheduledTime: null,
      entryPoint: "HomePage",
    },
  );
  const feed = data.storepageFeed;
  const rawItemLists = feed.itemLists ?? [];
  const rawCarousels = feed.carousels ?? [];

  if (opts?.debug) {
    const menuBook = feed.menuBook;
    process.stderr.write(
      `[debug] storepageFeed keys: ${Object.keys(feed).join(", ")}\n` +
        `[debug] itemLists count: ${rawItemLists.length}, carousels count: ${rawCarousels.length}\n` +
        `[debug] menuBook: ${truncate(JSON.stringify(menuBook), 2000, "")}\n`,
    );
  }

  const info = extractStoreInfo(feed);

  // If storepageFeed returned no items, try the retail store feed
  // (convenience/pharmacy stores use a different API)
  if (info.items.length === 0 && info.categories.length === 0) {
    if (opts?.debug) {
      process.stderr.write(
        "[debug] No items from storepageFeed, trying retailStorePageFeed...\n",
      );
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
  const data = await graphql<{ retailStorePageFeed: DDRetailStorePageFeed }>(
    "storeFeed",
    getQuery("storeFeed", RETAIL_STORE_FEED_QUERY),
    {
      storeId,
      attrSrc: "store",
      cursor: null,
      enableDebug: false,
    },
  );
  if (opts?.debug) {
    const feed = data.retailStorePageFeed;
    const l1Cats = feed.l1Categories ?? [];
    const collections = feed.collections ?? [];
    const page = feed.page;
    process.stderr.write(
      `[debug] retailStorePageFeed keys: ${Object.keys(feed).join(", ")}\n` +
        `[debug] l1Categories count: ${l1Cats.length}, collections count: ${collections.length}\n` +
        `[debug] page: ${truncate(JSON.stringify(page), 500, "")}\n` +
        `[debug] collections sample: ${truncate(JSON.stringify(collections.slice(0, 2)), 2000, "")}\n`,
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
  const data = await graphql<{ itemPage: DDItemPage }>(
    "itemPage",
    getQuery("itemPage", ITEM_PAGE_QUERY),
    {
      storeId,
      itemId,
      isMerchantPreview: false,
      isNested: false,
      shouldFetchPresetCarousels: false,
      fulfillmentType: "Delivery",
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
  // Use addCartItemV2 for adding items to cart (proper mutation for restaurant items)
  const data = await graphql<{ addCartItemV2: DDCart }>(
    "addCartItem",
    getQuery("addCartItem", ADD_CART_ITEM_QUERY),
    {
      addCartItemInput: {
        cartId: opts.cartId ?? "",
        itemId: opts.itemId,
        itemName: opts.itemName,
        itemDescription: opts.itemDescription ?? "",
        currency: "USD",
        quantity: opts.quantity ?? 1,
        unitPrice: opts.unitPrice,
        storeId: opts.storeId,
        menuId: opts.menuId,
        creatorId: "",
        nestedOptions: opts.nestedOptions ?? "[]",
        specialInstructions: opts.specialInstructions ?? "",
        substitutionPreference: "contact",
        purchaseTypeOptions: {
          purchaseType: "PURCHASE_TYPE_UNIT",
          unit: "qty",
          estimatedPricingDescription: "",
          continuousQuantity: 0,
        },
        isAdsItem: false,
        isBundle: false,
        bundleType: "BUNDLE_TYPE_UNSPECIFIED",
      },
      fulfillmentContext: {
        shouldUpdateFulfillment: false,
        fulfillmentType: "Delivery",
      },
      returnCartFromOrderService: false,
      shouldKeepOnlyOneActiveCart: false,
    },
  );
  return extractCartSummary(data.addCartItemV2);
}

export async function removeFromCart(
  cartId: string,
  itemId: string,
): Promise<CartSummary> {
  const data = await graphql<{ removeCartItemV2: DDCart }>(
    "removeCartItem",
    getQuery("removeCartItem", REMOVE_CART_ITEM_QUERY),
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
  const data = await graphql<{ orderCart: DDCart }>(
    "detailedCartItems",
    getQuery("detailedCartItems", DETAILED_CART_QUERY),
    { orderCartId: cartId, isCardPayment: true },
  );
  return extractCartSummary(data.orderCart);
}

export async function listCarts(storeId?: string): Promise<CartSummary[]> {
  const input: {
    cartFilter: { shouldIncludeSubmitted: boolean };
    cartContextFilter?: {
      experienceCase: string;
      multiCartExperienceContext: { storeId: string };
    };
  } = {
    cartFilter: { shouldIncludeSubmitted: true },
  };
  if (storeId) {
    input.cartContextFilter = {
      experienceCase: "MULTI_CART_EXPERIENCE_CONTEXT",
      multiCartExperienceContext: { storeId },
    };
  }
  const data = await graphql<{ listCarts: DDCart[] }>(
    "listCarts",
    getQuery("listCarts", LIST_CARTS_QUERY),
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
    dropoffOptions: DDDropoffOption[];
  }>("dropoffOptions", getQuery("dropoffOptions", DROPOFF_OPTIONS_QUERY), {
    cartId,
    addressId: addressId ?? null,
  });
  return (data.dropoffOptions ?? []).map((o) => ({
    id: String(o.id),
    displayString: String(o.displayString ?? ""),
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
  const data = await graphql<{ getPaymentMethodList: DDPaymentMethod[] }>(
    "paymentMethodQuery",
    getQuery("paymentMethodQuery", PAYMENT_METHODS_QUERY),
    {
      country: "US",
      usePaymentConfigQuery: true,
      usePaymentConfigQueryV2: true,
    },
  );
  return (data.getPaymentMethodList ?? []).map((p) => ({
    id: String(p.id ?? ""),
    type: String(p.type ?? ""),
    last4: String(p.last4 ?? ""),
    isDefault: Boolean(p.isDefault),
    uuid: String(p.paymentMethodUuid ?? p.uuid ?? ""),
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
  let pmType = opts.paymentMethodType ?? "Card";
  if (!pmUuid) {
    const methods = await getPaymentMethods();
    const defaultMethod = methods.find((m) => m.isDefault) ?? methods[0];
    if (!defaultMethod) {
      throw new ProviderError(
        "No payment method found. Add a payment method in the DoorDash app first.",
        "doordash",
      );
    }
    pmUuid = defaultMethod.uuid;
    // defaultMethod.type is the card brand (e.g. "Visa"), not the PaymentMethodType enum
    pmType = "Card";
  }

  // Build dropoff preferences
  const dropoffPreferences = opts.dropoffOptionId
    ? JSON.stringify([
        {
          typename: "DropoffPreference",
          option_id: opts.dropoffOptionId,
          is_default: true,
          instructions: "",
        },
      ])
    : "[]";

  const data = await graphql<{ createOrderFromCart: DDCreateOrderResult }>(
    "createOrderFromCart",
    getQuery("createOrderFromCart", CREATE_ORDER_FROM_CART_QUERY),
    {
      cartId: opts.cartId,
      storeId: opts.storeId,
      total: opts.total,
      sosDeliveryFee: 0,
      isPickupOrder: false,
      verifiedAgeRequirement: false,
      deliveryTime: "ASAP",
      menuOptions: null,
      attributionData: "{}",
      fulfillsOwnDeliveries: false,
      teamId: null,
      budgetId: null,
      giftOptions: null,
      recipientShippingDetails: null,
      tipAmounts: [{ tipRecipient: "DASHER", amount: opts.tipAmount ?? 0 }],
      paymentMethod: null,
      deliveryOptionType: opts.deliveryOptionType ?? "STANDARD",
      workOrderOptions: null,
      isCardPayment: true,
      clientFraudContext: null,
      programId: "",
      membershipId: "",
      dropoffPreferences,
      monitoringContext: { isGroup: false },
      routineReorderDetails: {},
      supplementalPaymentDetailsList: [],
      shouldApplyCredits: true,
      dasherPickupInstructions: "",
      paymentMethodUuid: pmUuid,
      paymentMethodType: pmType,
      deviceTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  );

  return {
    cartId: String(data.createOrderFromCart.cartId ?? ""),
    orderUuid: String(data.createOrderFromCart.orderUuid ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Response extraction helpers
// ---------------------------------------------------------------------------

function extractSearchResults(
  feed: DDFacetFeed | null | undefined,
): SearchResult[] {
  const results: SearchResult[] = [];
  if (!feed) return results;
  const bodies = feed.body ?? [];
  for (const section of bodies) {
    const items = section.body ?? [];
    for (const item of items) {
      const text = item.text;
      const images = item.images;
      const events = item.events;
      let storeId: string | undefined;
      // Try click event data first
      if (events?.click?.data) {
        try {
          const clickData = JSON.parse(events.click.data) as DDSearchClickData;
          storeId = String(clickData.store_id ?? clickData.storeId ?? "");
        } catch {
          /* ignore */
        }
      }
      // Fall back to parsing from the item ID (format: "row.search-result:STORE_ID:INDEX")
      if (!storeId) {
        const idStr = String(item.id ?? "");
        const match = idStr.match(/search-result:(\d+)/);
        if (match) storeId = match[1];
      }
      if (text?.title) {
        results.push({
          id: String(item.id ?? ""),
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

function extractStoreInfo(feed: DDStorepageFeed): StoreInfo {
  const header = feed.storeHeader ?? {};
  const menuBook = feed.menuBook ?? {};
  const itemLists = feed.itemLists ?? [];
  const address = header.address;
  const ratings = header.ratings;
  const deliveryFee = header.deliveryFeeLayout;
  const deliveryTime = header.deliveryTimeLayout;

  const categories = (menuBook.menuCategories ?? []).map(
    (c: DDMenuCategory) => ({
      id: String(c.id),
      name: String(c.name),
      numItems: Number(c.numItems ?? 0),
    }),
  );

  const items: MenuItem[] = [];
  for (const list of itemLists) {
    for (const item of list.items ?? []) {
      items.push({
        id: String(item.id),
        name: String(item.name ?? ""),
        description: item.description,
        price: item.displayPrice,
        imageUrl: item.imageUrl,
        storeId: item.storeId,
      });
    }
  }

  // Also extract from carousels (used by convenience/pharmacy stores)
  const carousels = feed.carousels ?? [];
  for (const carousel of carousels) {
    for (const item of carousel.items ?? []) {
      items.push({
        id: String(item.id),
        name: String(item.name ?? ""),
        description: item.description,
        price: item.displayPrice,
        imageUrl: item.imgUrl,
      });
    }
  }

  return {
    id: String(header.id ?? ""),
    name: String(header.name ?? ""),
    description: header.description,
    address: address?.displayAddress,
    rating: ratings?.averageRating,
    numRatings: ratings?.numRatingsDisplayString,
    deliveryFee: deliveryFee?.title,
    deliveryTime: deliveryTime?.title,
    priceRange: header.priceRangeDisplayString,
    categories,
    items,
  };
}

function extractNestedOptions(
  extrasList: DDNestedExtra[],
): ItemDetails["options"][number]["choices"][number]["nestedOptions"] {
  return extrasList.map((nested) => ({
    id: String(nested.id),
    name: String(nested.name ?? ""),
    required: !nested.isOptional,
    choices: (nested.options ?? []).map((o) => ({
      id: String(o.id),
      name: String(o.name ?? ""),
      price: o.displayString,
    })),
  }));
}

function extractItemDetails(page: DDItemPage): ItemDetails {
  const header = page.itemHeader ?? {};
  const optionLists = page.optionLists ?? [];
  const itemPreferences = page.itemPreferences;

  const result: ItemDetails = {
    id: String(header.id ?? ""),
    name: String(header.name ?? ""),
    description: header.description,
    price: header.displayString,
    unitAmount: header.unitAmount,
    currency: header.currency,
    imageUrl: header.imgUrl,
    menuId: header.menuId,
    options: optionLists.map((ol: DDOptionList) => {
      const choices = (ol.options ?? []).map((o: DDOptionChoice) => {
        const choice: ItemDetails["options"][number]["choices"][number] = {
          id: String(o.id),
          name: String(o.name ?? ""),
          price: o.displayString,
          unitAmount: o.unitAmount,
          defaultQuantity: o.defaultQuantity,
        };
        const nestedExtrasList = o.nestedExtrasList ?? [];
        if (nestedExtrasList.length > 0) {
          choice.nestedOptions = extractNestedOptions(nestedExtrasList);
        }
        return choice;
      });

      return {
        id: String(ol.id),
        name: String(ol.name ?? ""),
        required: !ol.isOptional,
        minSelections: ol.minNumOptions,
        maxSelections: ol.maxNumOptions,
        choices,
      };
    }),
  };

  if (itemPreferences) {
    const specialInstructions = itemPreferences.specialInstructions ?? {};
    result.specialInstructionsConfig = {
      maxLength: Number(specialInstructions.characterMaxLength ?? 500),
      placeholderText: specialInstructions.placeholderText,
      isEnabled: specialInstructions.isEnabled !== false,
    };
  }

  return result;
}

function extractRetailStoreInfo(feed: DDRetailStorePageFeed): StoreInfo {
  const storeDetails = feed.storeDetails ?? {};
  const storeHeader = storeDetails.storeHeader ?? {};
  const ratings = storeHeader.ratings;
  const deliveryFee = storeHeader.deliveryFeeLayout;
  const status = storeHeader.status;

  const l1Categories = feed.l1Categories ?? [];
  const collections = feed.collections ?? [];

  const categories = l1Categories.map((c) => ({
    id: String(c.id),
    name: String(c.name),
    numItems: Number(c.numItems ?? 0),
  }));

  const items: MenuItem[] = [];
  for (const collection of collections) {
    // Retail collections use `products`, not `items`
    const products = collection.products ?? collection.items ?? [];
    for (const item of products) {
      const price = item.price;
      items.push({
        id: String(item.id),
        name: String(item.name ?? ""),
        description: item.description,
        price: price?.displayString ?? item.displayPrice,
        imageUrl: item.imageUrl ?? item.imgUrl,
        storeId: item.storeId,
      });
    }
  }

  const address = storeHeader.address;

  return {
    id: String(storeDetails.id ?? ""),
    name: String(storeHeader.name ?? storeDetails.name ?? ""),
    description: storeHeader.description,
    address: address?.displayAddress,
    rating: ratings?.averageRating,
    numRatings: ratings?.numRatingsDisplayString,
    deliveryFee: deliveryFee?.title,
    deliveryTime: status?.delivery?.etaDisplayString,
    priceRange: storeHeader.priceRangeDisplayString,
    categories,
    items,
    isRetail: true,
  };
}

function extractCartSummary(cart: DDCart): CartSummary {
  const restaurant = cart.restaurant ?? {};
  const orders = cart.orders ?? [];

  const items: CartSummary["items"] = [];
  for (const order of orders) {
    for (const oi of order.orderItems ?? []) {
      const item = oi.item ?? {};
      items.push({
        id: String(oi.id ?? ""),
        name: String(item.name ?? ""),
        quantity: Number(oi.quantity ?? 1),
        price: oi.priceDisplayString,
      });
    }
  }

  return {
    cartId: String(cart.id ?? ""),
    storeName: restaurant.name,
    storeId: restaurant.id,
    subtotal: cart.subtotal,
    total: cart.total,
    items,
  };
}
