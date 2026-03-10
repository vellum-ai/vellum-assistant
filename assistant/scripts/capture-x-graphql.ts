#!/usr/bin/env bun
/**
 * Capture X.com GraphQL API calls via Chrome CDP.
 *
 * Usage:
 *   1. Make sure Chrome is running with CDP (vellum x refresh will do this)
 *   2. Run: bun run scripts/capture-x-graphql.ts [--auto] [--all]
 *   3. In --auto mode, Chrome is navigated automatically. Otherwise browse X manually.
 *   4. Press Ctrl+C to stop (or wait for --auto to finish).
 *
 * Flags:
 *   --auto  Automatically navigate Chrome through X.com pages via CDP
 *   --all   Capture ALL GraphQL queries (skip relevance filter)
 */

import { existsSync, mkdirSync } from "node:fs";

const CDP_BASE = "http://localhost:9222";
const CAPTURE_DIR = "/tmp/x-graphql-capture";

// ─── Relevance filter ────────────────────────────────────────────────────────

const RELEVANT_QUERIES = new Set([
  // Reads
  "UserByScreenName",
  "UserTweets",
  "TweetDetail",
  "TweetResultByRestId",
  "SearchTimeline",
  "Bookmarks",
  "Likes",
  "Favoriters",
  "Followers",
  "Following",
  "HomeTimeline",
  "HomeLatestTimeline",
  "NotificationsTimeline",
  "ListTimeline",
  "UserMedia",
  // Writes
  "CreateTweet",
  "DeleteTweet",
  "FavoriteTweet",
  "UnfavoriteTweet",
  "CreateRetweet",
  "DeleteRetweet",
  "CreateBookmark",
  "DeleteBookmark",
]);

// ─── Types ───────────────────────────────────────────────────────────────────

interface CapturedQuery {
  queryName: string;
  queryId: string;
  method: string;
  variables: unknown;
  features?: unknown;
  response?: unknown;
  timestamp: number;
}

// ─── Minimal CDP WebSocket client ────────────────────────────────────────────

class CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private callbacks = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private eventHandlers = new Map<
    string,
    Array<(params: Record<string, unknown>) => void>
  >();

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        this.ws = ws;
        resolve();
      };
      ws.onerror = (e) => reject(new Error(`CDP error: ${e}`));
      ws.onclose = () => {
        this.ws = null;
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id != null) {
          const cb = this.callbacks.get(msg.id);
          if (cb) {
            this.callbacks.delete(msg.id);
            if (msg.error) {
              cb.reject(new Error(msg.error.message));
            } else {
              cb.resolve(msg.result);
            }
          }
        } else if (msg.method) {
          for (const h of this.eventHandlers.get(msg.method) ?? [])
            h(msg.params ?? {});
        }
      };
    });
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: Record<string, unknown>) => void) {
    const list = this.eventHandlers.get(event) ?? [];
    list.push(handler);
    this.eventHandlers.set(event, list);
  }

  close() {
    this.ws?.close();
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const autoMode = args.includes("--auto");
const captureAll = args.includes("--all");

const captured: CapturedQuery[] = [];
const seenQueries = new Set<string>();

// Ensure capture directory exists
if (!existsSync(CAPTURE_DIR)) mkdirSync(CAPTURE_DIR, { recursive: true });

// ─── Auto-navigation steps ───────────────────────────────────────────────────

interface GuideStep {
  label: string;
  url?: string;
  clickSelector?: string;
  expectedQueries: string[];
}

// Resolve the logged-in user's screen name for profile-based URLs
async function getScreenName(): Promise<string | null> {
  if (!navigationClient) return null;
  try {
    const result = (await navigationClient.send("Runtime.evaluate", {
      expression: `
        (function() {
          const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
          if (link) return link.getAttribute('href')?.replace('/', '') ?? null;
          return null;
        })()
      `,
      awaitPromise: false,
      returnByValue: true,
    })) as { result?: { value?: string | null } };
    return result?.result?.value ?? null;
  } catch {
    return null;
  }
}

const GUIDE_STEPS: GuideStep[] = [
  {
    label: "Home timeline",
    url: "https://x.com/home",
    expectedQueries: ["HomeTimeline", "HomeLatestTimeline"],
  },
  {
    label: "Profile",
    // URL set dynamically in runAutoMode after resolving screen name
    clickSelector: 'a[data-testid="AppTabBar_Profile_Link"]',
    expectedQueries: ["UserByScreenName", "UserTweets"],
  },
  {
    label: "Tweet detail",
    clickSelector: 'article[data-testid="tweet"] a[href*="/status/"]',
    expectedQueries: ["TweetDetail"],
  },
  {
    label: "Search",
    url: "https://x.com/search?q=hello&src=typed_query",
    expectedQueries: ["SearchTimeline"],
  },
  {
    label: "Bookmarks",
    url: "https://x.com/i/bookmarks",
    expectedQueries: ["Bookmarks"],
  },
  {
    label: "Notifications",
    url: "https://x.com/notifications",
    expectedQueries: ["NotificationsTimeline"],
  },
  {
    label: "Likes",
    // URL set dynamically
    expectedQueries: ["Likes"],
  },
  {
    label: "Followers",
    // URL set dynamically
    expectedQueries: ["Followers"],
  },
  {
    label: "Following",
    // URL set dynamically
    expectedQueries: ["Following"],
  },
  {
    label: "Media",
    // URL set dynamically
    expectedQueries: ["UserMedia"],
  },
];

// ─── Discover Chrome tabs ────────────────────────────────────────────────────

const res = await fetch(`${CDP_BASE}/json/list`);
if (!res.ok) {
  console.error("Chrome CDP not available. Run `vellum x refresh` first.");
  process.exit(1);
}
const targets = (await res.json()) as Array<{
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}>;
const pages = targets.filter((t) => t.type === "page");

if (pages.length === 0) {
  console.error("No pages found in Chrome.");
  process.exit(1);
}

console.log(`Found ${pages.length} tab(s). Attaching to all...`);

// ─── Pending request tracking ────────────────────────────────────────────────

const pendingRequests = new Map<string, { url: string; queryName: string }>();
// Resolve callbacks for --auto mode: queryName → resolve function
const queryWaiters = new Map<string, () => void>();

function notifyQuerySeen(queryName: string) {
  seenQueries.add(queryName);
  const waiter = queryWaiters.get(queryName);
  if (waiter) {
    queryWaiters.delete(queryName);
    waiter();
  }
}

function waitForAnyQuery(
  queryNames: string[],
  timeoutMs = 15000,
): Promise<boolean> {
  if (queryNames.some((q) => seenQueries.has(q))) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      for (const q of queryNames) queryWaiters.delete(q);
      resolve(false);
    }, timeoutMs);
    for (const q of queryNames) {
      queryWaiters.set(q, () => {
        clearTimeout(timer);
        for (const q2 of queryNames) queryWaiters.delete(q2);
        resolve(true);
      });
    }
  });
}

// ─── Attach to all tabs ──────────────────────────────────────────────────────

// We'll keep a reference to one client that's on an x.com tab for navigation
let navigationClient: CDPClient | null = null;

for (const page of pages) {
  const client = new CDPClient();
  await client.connect(page.webSocketDebuggerUrl);
  await client.send("Network.enable");

  // Track which client is on an x.com tab for navigation
  if (page.url.includes("x.com") || page.url.includes("twitter.com")) {
    navigationClient = client;
  }

  client.on("Network.requestWillBeSent", (params) => {
    const req = params.request as Record<string, unknown> | undefined;
    const url = (req?.url ?? params.url) as string | undefined;
    if (!url?.includes("/i/api/graphql/")) return;

    const match = url.match(/\/graphql\/([^/]+)\/([^?]+)/);
    const queryId = match?.[1] ?? "unknown";
    const queryName = match?.[2] ?? "unknown";
    const method = (req?.method as string) ?? "GET";

    // Apply relevance filter
    if (!captureAll && !RELEVANT_QUERIES.has(queryName)) return;

    let variables: unknown = undefined;
    let features: unknown = undefined;

    if (method === "POST" && req?.postData) {
      try {
        const body = JSON.parse(req.postData as string);
        variables = body.variables;
        features = body.features;
      } catch {
        /* ignore */
      }
    } else if (method === "GET") {
      try {
        const u = new URL(url);
        const v = u.searchParams.get("variables");
        if (v) variables = JSON.parse(v);
        const f = u.searchParams.get("features");
        if (f) features = JSON.parse(f);
      } catch {
        /* ignore */
      }
    }

    console.log(`\n>>> ${method} ${queryName} (${queryId})`);
    if (variables)
      console.log(`    variables: ${JSON.stringify(variables).slice(0, 200)}`);

    pendingRequests.set(params.requestId as string, { url, queryName });
    captured.push({
      queryName,
      queryId,
      method,
      variables,
      features,
      timestamp: Date.now(),
    });
  });

  client.on("Network.responseReceived", (params) => {
    const requestId = params.requestId as string;
    const pending = pendingRequests.get(requestId);
    if (!pending) return;

    const response = params.response as Record<string, unknown>;
    const status = response.status as number;
    console.log(`    <<< ${status}`);

    // Get full response body
    client
      .send("Network.getResponseBody", { requestId })
      .then((result) => {
        const body = (result as Record<string, unknown>).body as string;
        try {
          const json = JSON.parse(body);
          // Attach full response to the captured entry
          const entry = [...captured]
            .reverse()
            .find((e) => e.queryName === pending.queryName && !e.response);
          if (entry) {
            entry.response = json;

            // Write individual file
            const filename = `${pending.queryName}-${entry.timestamp}.json`;
            Bun.write(
              `${CAPTURE_DIR}/${filename}`,
              JSON.stringify(
                {
                  queryName: entry.queryName,
                  queryId: entry.queryId,
                  method: entry.method,
                  variables: entry.variables,
                  features: entry.features,
                  response: json,
                },
                null,
                2,
              ),
            );
          }

          // Notify waiters
          notifyQuerySeen(pending.queryName);
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* body not available */
      });

    pendingRequests.delete(requestId);
  });
}

// If no x.com tab found, use the first page for navigation
if (!navigationClient && pages.length > 0) {
  navigationClient = new CDPClient();
  await navigationClient.connect(pages[0].webSocketDebuggerUrl);
}

// ─── CDP navigation helpers ──────────────────────────────────────────────────

async function navigateTo(url: string): Promise<void> {
  if (!navigationClient) return;
  await navigationClient.send("Page.navigate", { url });
  // Wait for page to load
  await new Promise((r) => setTimeout(r, 3000));
}

async function clickElement(selector: string): Promise<boolean> {
  if (!navigationClient) return false;
  try {
    const result = (await navigationClient.send("Runtime.evaluate", {
      expression: `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        })()
      `,
      awaitPromise: false,
      returnByValue: true,
    })) as { result?: { value?: boolean } };
    return result?.result?.value === true;
  } catch {
    return false;
  }
}

async function scrollDown(): Promise<void> {
  if (!navigationClient) return;
  try {
    await navigationClient.send("Runtime.evaluate", {
      expression: "window.scrollBy(0, 800)",
      awaitPromise: false,
    });
  } catch {
    /* ignore */
  }
}

// ─── Auto mode ───────────────────────────────────────────────────────────────

async function runAutoMode() {
  console.log("\n🚗 Auto mode: navigating Chrome through X.com...\n");

  // Enable Page domain for navigation
  if (navigationClient) {
    await navigationClient.send("Page.enable").catch(() => {});
  }

  // Navigate to home first to discover the screen name
  await navigateTo("https://x.com/home");
  const screenName = await getScreenName();
  if (screenName) {
    console.log(`  Detected user: @${screenName}\n`);
    // Fill in profile-based URLs
    for (const step of GUIDE_STEPS) {
      if (step.label === "Likes")
        step.url = `https://x.com/${screenName}/likes`;
      if (step.label === "Followers")
        step.url = `https://x.com/${screenName}/followers`;
      if (step.label === "Following")
        step.url = `https://x.com/${screenName}/following`;
      if (step.label === "Media")
        step.url = `https://x.com/${screenName}/media`;
    }
  } else {
    console.log(
      "  Could not detect screen name — some steps will use click navigation\n",
    );
  }

  const completedSteps: string[] = [];
  const failedSteps: string[] = [];

  for (const step of GUIDE_STEPS) {
    const alreadySeen = step.expectedQueries.some((q) => seenQueries.has(q));
    if (alreadySeen) {
      console.log(`  ✓ ${step.label} (already captured)`);
      completedSteps.push(step.label);
      continue;
    }

    process.stdout.write(`  ⏳ ${step.label}...`);

    // Navigate if URL provided
    if (step.url) {
      await navigateTo(step.url);
    }

    // Click if selector provided
    if (step.clickSelector) {
      await new Promise((r) => setTimeout(r, 1500)); // wait for page to settle
      const clicked = await clickElement(step.clickSelector);
      if (!clicked) {
        // Try scrolling and clicking again
        await scrollDown();
        await new Promise((r) => setTimeout(r, 1000));
        await clickElement(step.clickSelector);
      }
      await new Promise((r) => setTimeout(r, 2000)); // wait for navigation
    }

    // Scroll to trigger lazy-loaded content
    await scrollDown();

    // Wait for any expected query
    const seen = await waitForAnyQuery(step.expectedQueries, 10000);

    if (seen) {
      const captured = step.expectedQueries.filter((q) => seenQueries.has(q));
      console.log(`\r  ✅ ${step.label} → ${captured.join(", ")}`);
      completedSteps.push(step.label);
    } else {
      console.log(
        `\r  ⚠️  ${step.label} → no queries captured (page may need manual interaction)`,
      );
      failedSteps.push(step.label);
    }
  }

  console.log(
    `\n🏁 Auto navigation complete: ${completedSteps.length}/${GUIDE_STEPS.length} steps succeeded`,
  );
  if (failedSteps.length > 0) {
    console.log(`   Missed: ${failedSteps.join(", ")}`);
  }

  // Finish
  printSummary();
  process.exit(0);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function printSummary() {
  console.log(`\n\n${"=".repeat(60)}`);
  console.log(`  Captured ${captured.length} GraphQL requests`);
  console.log(`${"=".repeat(60)}\n`);

  // Dedupe by queryName
  const seen = new Set<string>();
  const unique = captured.filter((q) => {
    if (seen.has(q.queryName)) return false;
    seen.add(q.queryName);
    return true;
  });

  // Print table
  const nameWidth = Math.max(25, ...unique.map((q) => q.queryName.length));
  const idWidth = 22;
  const methodWidth = 6;

  console.log(
    `  ${"Query".padEnd(nameWidth)}  ${"QueryID".padEnd(idWidth)}  ${"Method".padEnd(methodWidth)}  Variables`,
  );
  console.log(
    `  ${"─".repeat(nameWidth)}  ${"─".repeat(idWidth)}  ${"─".repeat(methodWidth)}  ${"─".repeat(30)}`,
  );

  for (const q of unique) {
    const varKeys =
      q.variables && typeof q.variables === "object"
        ? Object.keys(q.variables as Record<string, unknown>).join(", ")
        : "—";
    console.log(
      `  ${q.queryName.padEnd(nameWidth)}  ${q.queryId.padEnd(idWidth)}  ${q.method.padEnd(methodWidth)}  ${varKeys}`,
    );
  }

  // Gap analysis
  if (!captureAll) {
    const notSeen = [...RELEVANT_QUERIES].filter((q) => !seenQueries.has(q));
    if (notSeen.length > 0) {
      console.log(`\n  ⚠️  Not captured (${notSeen.length}):`);
      for (const q of notSeen) {
        console.log(`     • ${q}`);
      }
    } else {
      console.log("\n  ✅ All relevant queries captured!");
    }
  }

  // Save summary
  const summaryPath = `${CAPTURE_DIR}/summary.json`;
  const summary = {
    capturedAt: new Date().toISOString(),
    totalRequests: captured.length,
    uniqueQueries: unique.map((q) => ({
      queryName: q.queryName,
      queryId: q.queryId,
      method: q.method,
      variableKeys:
        q.variables && typeof q.variables === "object"
          ? Object.keys(q.variables as Record<string, unknown>)
          : [],
    })),
    notCaptured: captureAll
      ? []
      : [...RELEVANT_QUERIES].filter((q) => !seenQueries.has(q)),
  };
  Bun.write(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\n  Summary saved to ${summaryPath}`);
  console.log(`  Individual captures in ${CAPTURE_DIR}/`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

if (autoMode) {
  console.log("\nRecording X.com GraphQL requests (auto mode)...");
  console.log(
    `Filter: ${captureAll ? "ALL queries" : `${RELEVANT_QUERIES.size} relevant queries`}`,
  );
  // Give network listeners a moment to settle, then start auto-navigation
  setTimeout(() => runAutoMode(), 1000);
} else {
  console.log("\nRecording X.com GraphQL requests...");
  console.log(
    `Filter: ${captureAll ? "ALL queries" : `${RELEVANT_QUERIES.size} relevant queries`}`,
  );
  console.log("Browse X in Chrome — visit a profile, scroll tweets, search.");
  console.log("Press Ctrl+C to stop and dump results.\n");
}

// Ctrl+C handler
process.on("SIGINT", () => {
  printSummary();
  process.exit(0);
});
