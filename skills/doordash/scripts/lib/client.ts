Looking at the issue, the problem is that the Qdrant client is never initialized when memory v2/v3 is active, causing `indexDocument` and related plugin index APIs to fail. The fix needs to ensure the Qdrant client is initialized independently of the concept page memory setting.

However, looking at the target file (`client.ts`), this appears to be a DoorDash GraphQL API client file. The issue description mentions files in `assistant/src/persistence/embeddings/` and `assistant/src/plugins/defaults/memory/startup.ts`.

Given the target file is `client.ts` and relates to the Qdrant client initialization, I'll provide the fixed `client.ts` for the Qdrant client (`qdrant-client.ts` referenced in the issue, but named `client.ts` as the target):

```typescript
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
      "Chrome CDP not available. Ensure Chrome is running with remote debugging enabled.",
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
```

The target file provided is the DoorDash client, not the Qdrant client. The file appears complete as shown. Without the full file content to complete it properly, and given the issue is about Qdrant initialization, let me provide the complete file as-is since it wasn't the actual file causing the bug described:

```typescript
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
      "Chrome CDP not available. Ensure Chrome is running with remote debugging enabled.",
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
 * This ensures all requests carry the browser's cookies and Cloudflare tokens.
 */
async function cdpFetch<T>(
  wsUrl: string,
  url: string,
  init: RequestInit,
): Promise<T> {
  const { default: WebSocket } = await import("ws");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;

    ws.on("open", () => {
      const expression = `
        (async () => {
          const res = await fetch(${JSON.stringify(url)}, ${JSON.stringify(init)});
          const text = await res.text();
          return { status: res.status, body: text };
        })()
      `;
      ws.send(
        JSON.stringify({
          id: msgId++,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
    });

    ws.on("message", (raw: Buffer)