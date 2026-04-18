#!/usr/bin/env bun

/**
 * Outlook inbox analysis scripts.
 * Subcommands:
 *   sender-digest  — Aggregate messages by sender with counts and unsubscribe detection
 *   outreach-scan  — Find senders without List-Unsubscribe headers (likely personal outreach)
 */

import { parseArgs, optionalArg, printError, ok } from "./lib/common.js";
import { graphRequest } from "./lib/graph-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GraphMessage {
  id: string;
  from?: {
    emailAddress?: { address?: string; name?: string };
  };
  subject?: string;
  receivedDateTime?: string;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
}

interface GraphMessagesResponse {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
}

/** Aggregated sender data (internal, includes messageIds for caching). */
interface SenderAgg {
  displayName: string;
  count: number;
  hasUnsubscribe: boolean;
  sampleSubjects: string[];
  messageIds: string[];
}

// ---------------------------------------------------------------------------
// Cache helper
// ---------------------------------------------------------------------------

/**
 * Store data in the daemon's in-memory cache via `assistant cache set`.
 * Returns the cache key. Keeps large payloads (e.g. thousands of message IDs)
 * out of the LLM conversation context.
 */
async function cacheStore(data: unknown): Promise<string> {
  const proc = Bun.spawn(
    ["assistant", "cache", "set", "--ttl", "30m", "--json"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(JSON.stringify(data));
  proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`assistant cache set failed (exit ${exitCode}): ${stdout}`);
  }

  const result = JSON.parse(stdout);
  if (!result.ok) {
    throw new Error(`assistant cache set error: ${result.error}`);
  }
  return result.key;
}

interface PaginateOptions {
  maxMessages: number;
  timeBudgetMs: number;
  account?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a time-range string like "90d", "24h", "30m" into an ISO date. */
function parseTimeRange(range: string): string {
  const match = range.match(/^(\d+)([dhm])$/);
  if (!match) {
    printError(
      `Invalid --time-range format: "${range}". Use e.g. "90d", "24h", or "30m".`,
    );
    throw new Error("unreachable");
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const date = new Date();
  switch (unit) {
    case "d":
      date.setDate(date.getDate() - value);
      break;
    case "h":
      date.setHours(date.getHours() - value);
      break;
    case "m":
      date.setMinutes(date.getMinutes() - value);
      break;
  }
  return date.toISOString();
}

/** Check if a message has a List-Unsubscribe header. */
function hasUnsubscribeHeader(msg: GraphMessage): boolean {
  if (!msg.internetMessageHeaders) return false;
  return msg.internetMessageHeaders.some(
    (h) => h.name.toLowerCase() === "list-unsubscribe",
  );
}

/**
 * Extract the path (with query string) from a full Microsoft Graph URL.
 * e.g. "https://graph.microsoft.com/v1.0/me/messages?$skip=50" -> "/v1.0/me/messages?$skip=50"
 */
function extractGraphPath(fullUrl: string): string {
  try {
    const url = new URL(fullUrl);
    return url.pathname + url.search;
  } catch {
    // If it's not a valid URL, return as-is (already a path)
    return fullUrl;
  }
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

async function paginateMessages(
  initialPath: string,
  opts: PaginateOptions,
): Promise<{ messages: GraphMessage[]; truncated: boolean }> {
  const messages: GraphMessage[] = [];
  const startTime = Date.now();
  let truncated = false;

  // Initial request
  const firstResponse = await graphRequest<GraphMessagesResponse>({
    method: "GET",
    path: initialPath,
    query: opts.query,
    account: opts.account,
    headers: opts.headers,
  });

  if (!firstResponse.ok) {
    printError(
      `Graph API request failed (status ${firstResponse.status}): ${JSON.stringify(firstResponse.data)}`,
    );
    throw new Error("unreachable");
  }

  const firstData = firstResponse.data;
  if (firstData.value) {
    messages.push(...firstData.value);
  }

  let nextLink = firstData["@odata.nextLink"];

  // Paginate
  while (nextLink) {
    // Check limits
    if (messages.length >= opts.maxMessages) {
      truncated = true;
      break;
    }
    if (Date.now() - startTime >= opts.timeBudgetMs) {
      truncated = true;
      break;
    }

    const path = extractGraphPath(nextLink);
    const response = await graphRequest<GraphMessagesResponse>({
      method: "GET",
      path,
      account: opts.account,
      headers: opts.headers,
    });

    if (!response.ok) {
      // Stop pagination on error rather than crashing
      truncated = true;
      break;
    }

    const data = response.data;
    if (data.value) {
      messages.push(...data.value);
    }

    nextLink = data["@odata.nextLink"];
  }

  if (messages.length > opts.maxMessages) {
    truncated = true;
    messages.length = opts.maxMessages;
  }

  return { messages, truncated };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function senderDigest(args: Record<string, string | boolean>) {
  const query = optionalArg(args, "query");
  const timeRange = optionalArg(args, "time-range") ?? "90d";
  const maxSendersStr = optionalArg(args, "max-senders") ?? "50";
  const account = optionalArg(args, "account");
  const maxSenders = parseInt(maxSendersStr, 10);

  if (isNaN(maxSenders) || maxSenders < 1) {
    printError(`Invalid --max-senders: "${maxSendersStr}"`);
    throw new Error("unreachable");
  }

  const startDate = parseTimeRange(timeRange);
  const timeBudgetMs = 90_000;
  const maxMessages = 10_000;

  let result: { messages: GraphMessage[]; truncated: boolean };

  if (query) {
    // Search mode: use $search WITHOUT $filter (Graph API does not support
    // combining $search with $filter on /me/messages). Date filtering is
    // applied client-side after fetching results.
    const escapedQuery = query.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const searchResult = await paginateMessages("/v1.0/me/messages", {
      maxMessages,
      timeBudgetMs,
      account,
      query: {
        $search: `"${escapedQuery}"`,
        $top: "50",
        $select: "id,from,subject,receivedDateTime,internetMessageHeaders",
      },
      // ConsistencyLevel: eventual is required when using $search
      headers: { ConsistencyLevel: "eventual" },
    });

    // Client-side date filtering since $filter cannot be combined with $search
    const startMs = new Date(startDate).getTime();
    searchResult.messages = searchResult.messages.filter((msg) => {
      if (!msg.receivedDateTime) return false;
      return new Date(msg.receivedDateTime).getTime() >= startMs;
    });

    result = searchResult;
  } else {
    // List mode: use $filter
    result = await paginateMessages("/v1.0/me/messages", {
      maxMessages,
      timeBudgetMs,
      account,
      query: {
        $filter: `receivedDateTime ge ${startDate}`,
        $top: "50",
        $select: "id,from,subject,receivedDateTime,internetMessageHeaders",
      },
    });
  }

  // Aggregate by sender
  const senderMap = new Map<string, SenderAgg>();

  for (const msg of result.messages) {
    const email = msg.from?.emailAddress?.address?.toLowerCase();
    if (!email) continue;

    let entry = senderMap.get(email);
    if (!entry) {
      entry = {
        displayName: msg.from?.emailAddress?.name ?? email,
        count: 0,
        hasUnsubscribe: false,
        sampleSubjects: [],
        messageIds: [],
      };
      senderMap.set(email, entry);
    }

    entry.count++;
    entry.messageIds.push(msg.id);

    if (entry.sampleSubjects.length < 3 && msg.subject) {
      entry.sampleSubjects.push(msg.subject);
    }

    if (!entry.hasUnsubscribe && hasUnsubscribeHeader(msg)) {
      entry.hasUnsubscribe = true;
    }
  }

  // Sort by count descending, limit to maxSenders
  const sorted = Array.from(senderMap.entries())
    .map(([email, data]) => ({ email, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxSenders);

  // Store message IDs in daemon cache to keep them out of LLM context.
  // The cache key can be used with `assistant cache get <key>` to retrieve
  // the full sender→messageIds mapping for archiving.
  const cachePayload: Record<string, string[]> = {};
  for (const s of sorted) {
    cachePayload[s.email] = s.messageIds;
  }
  const cacheKey = await cacheStore(cachePayload);

  // Return lightweight summary (no messageIds) + cache key
  ok({
    cache_key: cacheKey,
    senders: sorted.map(({ messageIds: _ids, ...rest }) => rest),
    totalMessagesScanned: result.messages.length,
    truncated: result.truncated,
  });
}

async function outreachScan(args: Record<string, string | boolean>) {
  const timeRange = optionalArg(args, "time-range") ?? "90d";
  const maxSendersStr = optionalArg(args, "max-senders") ?? "30";
  const account = optionalArg(args, "account");
  const maxSenders = parseInt(maxSendersStr, 10);

  if (isNaN(maxSenders) || maxSenders < 1) {
    printError(`Invalid --max-senders: "${maxSendersStr}"`);
    throw new Error("unreachable");
  }

  const startDate = parseTimeRange(timeRange);
  const timeBudgetMs = 90_000;
  const maxMessages = 5_000;

  const result = await paginateMessages("/v1.0/me/messages", {
    maxMessages,
    timeBudgetMs,
    account,
    query: {
      $filter: `receivedDateTime ge ${startDate}`,
      $top: "50",
      $select: "id,from,subject,receivedDateTime,internetMessageHeaders",
    },
  });

  // Two-pass approach: exclude ENTIRE senders if ANY of their messages has
  // List-Unsubscribe. This prevents false positives where a sender has some
  // messages with the header and some without.

  // Pass 1: collect sender emails that have ANY message with List-Unsubscribe
  const sendersWithUnsubscribe = new Set<string>();
  for (const msg of result.messages) {
    if (hasUnsubscribeHeader(msg)) {
      const email = msg.from?.emailAddress?.address?.toLowerCase();
      if (email) sendersWithUnsubscribe.add(email);
    }
  }

  // Pass 2: aggregate messages from senders NOT in the unsubscribe set
  const senderMap = new Map<
    string,
    {
      displayName: string;
      count: number;
      sampleSubjects: string[];
      messageIds: string[];
    }
  >();

  for (const msg of result.messages) {
    const email = msg.from?.emailAddress?.address?.toLowerCase();
    if (!email) continue;

    // Skip entire sender if ANY of their messages had List-Unsubscribe
    if (sendersWithUnsubscribe.has(email)) continue;

    let entry = senderMap.get(email);
    if (!entry) {
      entry = {
        displayName: msg.from?.emailAddress?.name ?? email,
        count: 0,
        sampleSubjects: [],
        messageIds: [],
      };
      senderMap.set(email, entry);
    }

    entry.count++;
    entry.messageIds.push(msg.id);

    if (entry.sampleSubjects.length < 3 && msg.subject) {
      entry.sampleSubjects.push(msg.subject);
    }
  }

  // Sort by count descending, limit to maxSenders
  const sorted = Array.from(senderMap.entries())
    .map(([email, data]) => ({ email, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxSenders);

  // Store message IDs in daemon cache
  const cachePayload: Record<string, string[]> = {};
  for (const s of sorted) {
    cachePayload[s.email] = s.messageIds;
  }
  const cacheKey = await cacheStore(cachePayload);

  // Return lightweight summary (no messageIds) + cache key
  ok({
    cache_key: cacheKey,
    senders: sorted.map(({ messageIds: _ids, ...rest }) => rest),
    totalMessagesScanned: result.messages.length,
    truncated: result.truncated,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const subcommand = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  switch (subcommand) {
    case "sender-digest":
      await senderDigest(args);
      break;
    case "outreach-scan":
      await outreachScan(args);
      break;
    default:
      printError(
        `Unknown subcommand: "${subcommand ?? "(none)"}". Use "sender-digest" or "outreach-scan".`,
      );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    printError(err instanceof Error ? err.message : String(err));
  });
}
