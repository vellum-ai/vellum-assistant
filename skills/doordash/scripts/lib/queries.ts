/**
 * Barrel re-export of all DoorDash GraphQL queries.
 * Individual query modules are split by domain:
 *   - search-queries.ts  — search and homepage discovery
 *   - store-queries.ts   — store pages, item details, retail feeds
 *   - cart-queries.ts    — cart CRUD (add, remove, update, list, detail)
 *   - order-queries.ts   — checkout, delivery options, payment methods
 */

export {
  ADD_CART_ITEM_QUERY,
  DETAILED_CART_QUERY,
  LIST_CARTS_QUERY,
  REMOVE_CART_ITEM_QUERY,
  UPDATE_CART_ITEM_QUERY,
} from "./cart-queries.js";
export {
  CREATE_ORDER_FROM_CART_QUERY,
  DROPOFF_OPTIONS_QUERY,
  PAYMENT_METHODS_QUERY,
} from "./order-queries.js";
export { HOME_PAGE_QUERY, SEARCH_QUERY } from "./search-queries.js";
export {
  ITEM_PAGE_QUERY,
  RETAIL_SEARCH_QUERY,
  RETAIL_STORE_FEED_QUERY,
  STORE_PAGE_QUERY,
} from "./store-queries.js";
