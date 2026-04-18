#!/usr/bin/env bun

/**
 * Gmail inbox analysis scripts.
 * Subcommands:
 *   sender-digest  — Aggregate messages by sender with counts and unsubscribe detection
 *   outreach-scan  — Find senders without prior replies (likely cold outreach)
 */

import { parseArgs, optionalArg, printError, ok } from "./lib/common.js";
import {
  gmailGet,
  batchFetchMessages,
  type GmailMessage,
} from "./lib/gmail-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGES_CAP = 2000;
const MAX_IDS_PER_SENDER = 2000;
const MAX_SAMPLE_SUBJECTS = 3;
const MAX_SENDERS_CAP = 75;
const MAX_SUBJECT_LENGTH = 80;
const MAX_RESULT_CHARS = 24_000;
const TIME_BUDGET_MS = 90_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListMessagesResponse {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface SenderAggregation {
  displayName: string;
  email: string;
  messageCount: number;
  hasUnsubscribe: boolean;
  newestMessageId: string;
  newestUnsubscribableMessageId: string | null;
  newestUnsubscribableEpoch: number;
  oldestDate: string;
  newestDate: string;
  messageIds: string[];
  sampleSubjects: string[];
}

interface OutreachSenderAggregation {
  displayName: string;
  email: string;
  messageCount: number;
  newestMessageId: string;
  oldestDate: string;
  newestDate: string;
  messageIds: string[];
  sampleSubjects: string[];
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a time-range string like "90d", "24h", "30m" into an ISO date. */
function parseTimeRange(range: string): string {
  const match = range.match(/^(\d+)([dhm])$/);
  if (!match) {
    printError(
      `Invalid time-range format: "${range}". Use e.g. "90d", "24h", or "30m".`,
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

/** Parse "Display Name <email@example.com>" into parts. */
function parseFrom(from: string): { displayName: string; email: string } {
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return {
      displayName: match[1].replace(/^["']|["']$/g, "").trim(),
      email: match[2].toLowerCase(),
    };
  }
  // Bare email address
  const bare = from.trim().toLowerCase();
  return { displayName: "", email: bare };
}

function isRateLimitError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /\b429\b/.test(e.message);
}

function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === "AbortError") return true;
  if (e instanceof Error && e.message === "fetch deadline exceeded")
    return true;
  if (
    e instanceof Error &&
    "cause" in e &&
    e.cause instanceof Error &&
    e.cause.message === "fetch deadline exceeded"
  )
    return true;
  return false;
}

// ---------------------------------------------------------------------------
// sender-digest
// ---------------------------------------------------------------------------

async function senderDigest(args: Record<string, string | boolean>) {
  const query =
    optionalArg(args, "query") ?? "in:inbox category:promotions newer_than:90d";
  const maxMessages = Math.min(
    parseInt(optionalArg(args, "max-messages") ?? "1000", 10),
    MAX_MESSAGES_CAP,
  );
  const maxSenders = Math.min(
    parseInt(optionalArg(args, "max-senders") ?? "50", 10),
    MAX_SENDERS_CAP,
  );
  const inputPageToken = optionalArg(args, "page-token");
  const account = optionalArg(args, "account");

  const allMessageIds: string[] = [];
  const fetchPromises: Promise<GmailMessage[]>[] = [];
  const fetchAbort = new AbortController();
  let pageToken: string | undefined = inputPageToken;
  let truncated = false;
  let rateLimited = false;
  const metadataHeaders = ["From", "List-Unsubscribe", "Subject", "Date"];
  const startTime = Date.now();

  // Set deadline timer
  const deadlineTimer = setTimeout(() => {
    fetchAbort.abort(new Error("fetch deadline exceeded"));
  }, TIME_BUDGET_MS);

  try {
    // Pagination pipeline: list IDs and fire metadata fetches concurrently
    while (allMessageIds.length < maxMessages) {
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        truncated = true;
        break;
      }

      const pageSize = Math.min(500, maxMessages - allMessageIds.length);
      let listResp;
      try {
        listResp = await gmailGet<ListMessagesResponse>("/messages", {
          q: query,
          maxResults: String(pageSize),
          ...(pageToken ? { pageToken } : {}),
        }, account);
      } catch (e) {
        if (isRateLimitError(e)) {
          rateLimited = true;
          truncated = true;
          break;
        }
        throw e;
      }

      if (!listResp.ok) {
        if (listResp.status === 429) {
          rateLimited = true;
          truncated = true;
          break;
        }
        throw new Error(
          `Gmail API request failed (status ${listResp.status}): ${JSON.stringify(listResp.data)}`,
        );
      }

      const ids = (listResp.data.messages ?? []).map((m) => m.id);
      if (ids.length === 0) break;

      allMessageIds.push(...ids);

      // Fire metadata fetch for this batch immediately (latency hiding)
      fetchPromises.push(
        batchFetchMessages(
          ids,
          "metadata",
          metadataHeaders,
          account,
          fetchAbort.signal,
        ),
      );

      pageToken = listResp.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    // Flag truncation if we hit the cap but had more pages
    if (allMessageIds.length >= maxMessages && pageToken) {
      truncated = true;
    }

    if (allMessageIds.length === 0) {
      clearTimeout(deadlineTimer);
      ok({
        cache_key: null,
        senders: [],
        totalMessagesScanned: 0,
        queryUsed: query,
        ...(rateLimited ? { rateLimited: true } : {}),
        ...(truncated ? { truncated: true } : {}),
      });
      return;
    }

    // Settle all fetch promises — collect successes and tolerate 429/abort
    const settled = await Promise.allSettled(fetchPromises);
    clearTimeout(deadlineTimer);

    const messages: GmailMessage[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        messages.push(...result.value);
      } else if (isRateLimitError(result.reason)) {
        rateLimited = true;
        truncated = true;
      } else if (isAbortError(result.reason)) {
        truncated = true;
      } else {
        throw result.reason;
      }
    }

    // Group by sender email
    const senderMap = new Map<string, SenderAggregation>();

    for (const msg of messages) {
      const headers = msg.payload?.headers ?? [];
      const fromHeader =
        headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
      const subject =
        headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
      const dateStr =
        headers.find((h) => h.name.toLowerCase() === "date")?.value ?? "";
      const listUnsub = headers.find(
        (h) => h.name.toLowerCase() === "list-unsubscribe",
      )?.value;

      const { displayName, email } = parseFrom(fromHeader);
      if (!email) continue;

      let agg = senderMap.get(email);
      if (!agg) {
        agg = {
          displayName,
          email,
          messageCount: 0,
          hasUnsubscribe: false,
          newestMessageId: msg.id,
          newestUnsubscribableMessageId: null,
          newestUnsubscribableEpoch: 0,
          oldestDate: dateStr,
          newestDate: dateStr,
          messageIds: [],
          sampleSubjects: [],
        };
        senderMap.set(email, agg);
      }

      agg.messageCount++;

      if (listUnsub) agg.hasUnsubscribe = true;

      // Use displayName from earliest message that has one
      if (!agg.displayName && displayName) agg.displayName = displayName;

      // Track message IDs (cap per sender)
      if (agg.messageIds.length < MAX_IDS_PER_SENDER) {
        agg.messageIds.push(msg.id);
      }

      // Track date range using internalDate (epoch ms) for reliability
      const msgEpoch = msg.internalDate ? Number(msg.internalDate) : 0;
      const oldestEpoch = agg.oldestDate
        ? new Date(agg.oldestDate).getTime()
        : Infinity;
      const newestEpoch = agg.newestDate
        ? new Date(agg.newestDate).getTime()
        : 0;

      if (msgEpoch > 0 && msgEpoch < oldestEpoch) {
        agg.oldestDate = dateStr || agg.oldestDate;
      }
      if (msgEpoch > newestEpoch) {
        agg.newestDate = dateStr || agg.newestDate;
        agg.newestMessageId = msg.id;
      }

      // Track the newest message with List-Unsubscribe header
      if (listUnsub && msgEpoch >= agg.newestUnsubscribableEpoch) {
        agg.newestUnsubscribableMessageId = msg.id;
        agg.newestUnsubscribableEpoch = msgEpoch;
      }

      // Collect sample subjects
      if (subject && agg.sampleSubjects.length < MAX_SAMPLE_SUBJECTS) {
        agg.sampleSubjects.push(subject);
      }
    }

    // Sort by message count descending, take top N
    const sorted = [...senderMap.values()]
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, maxSenders);

    // Build result senders
    const resultSenders = sorted.map((s) => ({
      id: Buffer.from(s.email).toString("base64url"),
      displayName: s.displayName || s.email.split("@")[0],
      email: s.email,
      messageCount: s.messageCount,
      hasUnsubscribe: s.hasUnsubscribe,
      // When unsubscribe is available, point to a message that carries the header
      newestMessageId:
        s.hasUnsubscribe && s.newestUnsubscribableMessageId
          ? s.newestUnsubscribableMessageId
          : s.newestMessageId,
      oldestDate: s.oldestDate,
      newestDate: s.newestDate,
      searchQuery: `from:${s.email} ${query}`,
      sampleSubjects: s.sampleSubjects.map((subj) =>
        subj.length > MAX_SUBJECT_LENGTH
          ? subj.slice(0, MAX_SUBJECT_LENGTH) + "…"
          : subj,
      ),
    }));

    // Trim senders if serialized result exceeds byte budget.
    // Senders are sorted by messageCount desc, so we drop least-active first.
    while (resultSenders.length > 1) {
      const probe = JSON.stringify({ senders: resultSenders });
      if (probe.length <= MAX_RESULT_CHARS) break;
      resultSenders.pop();
    }

    // Build cache payload only for senders that survived the trim
    const keptEmails = new Set(resultSenders.map((s) => s.email));
    const cachePayload: Record<string, string[]> = {};
    for (const s of sorted) {
      if (keptEmails.has(s.email)) {
        cachePayload[s.email] = s.messageIds;
      }
    }
    const cacheKey = await cacheStore(cachePayload);

    ok({
      cache_key: cacheKey,
      senders: resultSenders,
      totalMessagesScanned: allMessageIds.length,
      queryUsed: query,
      ...(truncated ? { truncated: true } : {}),
      ...(rateLimited ? { rateLimited: true } : {}),
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
}

// ---------------------------------------------------------------------------
// outreach-scan
// ---------------------------------------------------------------------------

async function outreachScan(args: Record<string, string | boolean>) {
  const maxMessages = Math.min(
    parseInt(optionalArg(args, "max-messages") ?? "1000", 10),
    MAX_MESSAGES_CAP,
  );
  const maxSenders = parseInt(optionalArg(args, "max-senders") ?? "30", 10);
  const timeRange = optionalArg(args, "time-range") ?? "90d";
  const inputPageToken = optionalArg(args, "page-token");
  const account = optionalArg(args, "account");

  const query = `in:inbox -has:unsubscribe newer_than:${timeRange}`;

  const allMessageIds: string[] = [];
  const fetchPromises: Promise<GmailMessage[]>[] = [];
  const fetchAbort = new AbortController();
  let pageToken: string | undefined = inputPageToken;
  let truncated = false;
  let rateLimited = false;
  const metadataHeaders = ["From", "Subject", "Date"];
  const startTime = Date.now();

  // Set deadline timer
  const deadlineTimer = setTimeout(() => {
    fetchAbort.abort(new Error("fetch deadline exceeded"));
  }, TIME_BUDGET_MS);

  try {
    // Pagination pipeline: list IDs and fire metadata fetches concurrently
    while (allMessageIds.length < maxMessages) {
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        truncated = true;
        break;
      }

      const pageSize = Math.min(100, maxMessages - allMessageIds.length);
      let listResp;
      try {
        listResp = await gmailGet<ListMessagesResponse>("/messages", {
          q: query,
          maxResults: String(pageSize),
          ...(pageToken ? { pageToken } : {}),
        }, account);
      } catch (e) {
        if (isRateLimitError(e)) {
          rateLimited = true;
          truncated = true;
          break;
        }
        throw e;
      }

      if (!listResp.ok) {
        if (listResp.status === 429) {
          rateLimited = true;
          truncated = true;
          break;
        }
        throw new Error(
          `Gmail API request failed (status ${listResp.status}): ${JSON.stringify(listResp.data)}`,
        );
      }

      const ids = (listResp.data.messages ?? []).map((m) => m.id);
      if (ids.length === 0) break;

      allMessageIds.push(...ids);

      // Fire metadata fetch for this batch immediately (latency hiding)
      fetchPromises.push(
        batchFetchMessages(
          ids,
          "metadata",
          metadataHeaders,
          account,
          fetchAbort.signal,
        ),
      );

      pageToken = listResp.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    // Flag truncation if we hit the cap but had more pages
    if (allMessageIds.length >= maxMessages && pageToken) {
      truncated = true;
    }

    if (allMessageIds.length === 0) {
      clearTimeout(deadlineTimer);
      ok({
        cache_key: null,
        senders: [],
        totalMessagesScanned: 0,
        ...(rateLimited ? { rateLimited: true } : {}),
        ...(truncated ? { truncated: true } : {}),
      });
      return;
    }

    // Settle all fetch promises — collect successes and tolerate 429/abort
    const settled = await Promise.allSettled(fetchPromises);

    const messages: GmailMessage[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        messages.push(...result.value);
      } else if (isRateLimitError(result.reason)) {
        rateLimited = true;
        truncated = true;
      } else if (isAbortError(result.reason)) {
        truncated = true;
      } else {
        throw result.reason;
      }
    }

    // Aggregate by sender
    const senderMap = new Map<string, OutreachSenderAggregation>();

    for (const msg of messages) {
      const headers = msg.payload?.headers ?? [];
      const fromHeader =
        headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
      const subject =
        headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
      const dateStr =
        headers.find((h) => h.name.toLowerCase() === "date")?.value ?? "";

      const { displayName, email } = parseFrom(fromHeader);
      if (!email) continue;

      let agg = senderMap.get(email);
      if (!agg) {
        agg = {
          displayName,
          email,
          messageCount: 0,
          newestMessageId: msg.id,
          oldestDate: dateStr,
          newestDate: dateStr,
          messageIds: [],
          sampleSubjects: [],
        };
        senderMap.set(email, agg);
      }

      agg.messageCount++;

      if (!agg.displayName && displayName) agg.displayName = displayName;

      if (agg.messageIds.length < MAX_IDS_PER_SENDER) {
        agg.messageIds.push(msg.id);
      }

      // Track date range
      const msgEpoch = msg.internalDate ? Number(msg.internalDate) : 0;
      const oldestEpoch = agg.oldestDate
        ? new Date(agg.oldestDate).getTime()
        : Infinity;
      const newestEpoch = agg.newestDate
        ? new Date(agg.newestDate).getTime()
        : 0;

      if (msgEpoch > 0 && msgEpoch < oldestEpoch) {
        agg.oldestDate = dateStr || agg.oldestDate;
      }
      if (msgEpoch > newestEpoch) {
        agg.newestDate = dateStr || agg.newestDate;
        agg.newestMessageId = msg.id;
      }

      if (subject && agg.sampleSubjects.length < MAX_SAMPLE_SUBJECTS) {
        agg.sampleSubjects.push(subject);
      }
    }

    // Sort by message count desc — over-fetch before enrichment, cap after
    const sorted = [...senderMap.values()]
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, maxSenders * 3);

    // Enrich with prior-reply signal: check if user has ever sent to each sender.
    // Uses bounded concurrency (waves of 10) and AbortController for time budget.
    //
    // Three-valued enrichment:
    //   true  = confirmed prior reply (enrichment succeeded, found replies)
    //   false = confirmed no prior reply (enrichment succeeded, no replies)
    //   null  = unknown (enrichment skipped — rate-limited or timed out)
    const ENRICHMENT_CONCURRENCY = 10;
    const priorReplyMap = new Map<string, boolean>();

    if (!rateLimited) {
      const enrichmentBudgetMs = Math.max(
        TIME_BUDGET_MS - (Date.now() - startTime),
        5_000,
      );
      const enrichAbort = new AbortController();
      const enrichTimer = setTimeout(
        () => enrichAbort.abort(),
        enrichmentBudgetMs,
      );

      try {
        for (
          let i = 0;
          i < sorted.length && !enrichAbort.signal.aborted;
          i += ENRICHMENT_CONCURRENCY
        ) {
          const batch = sorted.slice(i, i + ENRICHMENT_CONCURRENCY);
          const batchChecks = batch.map(async (s) => {
            if (enrichAbort.signal.aborted) return;
            try {
              const resp = await gmailGet<ListMessagesResponse>(
                "/messages",
                { q: `from:me to:${s.email}`, maxResults: "1" },
                account,
              );
              if (resp.ok) {
                priorReplyMap.set(
                  s.email,
                  (resp.data.messages?.length ?? 0) > 0,
                );
              }
              // Non-ok responses (including 429) leave the sender absent
            } catch {
              // Non-fatal — leave absent in map (unknown status)
            }
          });
          await Promise.race([
            Promise.all(batchChecks),
            new Promise<void>((resolve) =>
              enrichAbort.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            ),
          ]);
        }
      } finally {
        clearTimeout(enrichTimer);
      }
    }

    clearTimeout(deadlineTimer);

    // Filter out senders with confirmed prior replies, cap to maxSenders.
    // Senders with unknown enrichment status are kept.
    const capped = sorted
      .filter((s) => priorReplyMap.get(s.email) !== true)
      .slice(0, maxSenders);

    const resultSenders = capped.map((s) => ({
      id: Buffer.from(s.email).toString("base64url"),
      displayName: s.displayName || s.email.split("@")[0],
      email: s.email,
      messageCount: s.messageCount,
      hasPriorReply: priorReplyMap.has(s.email)
        ? priorReplyMap.get(s.email)!
        : null,
      newestMessageId: s.newestMessageId,
      oldestDate: s.oldestDate,
      newestDate: s.newestDate,
      searchQuery: `from:${s.email}`,
      sampleSubjects: s.sampleSubjects,
    }));

    // Cache message IDs
    const cachePayload: Record<string, string[]> = {};
    for (const s of capped) {
      cachePayload[s.email] = s.messageIds;
    }
    const cacheKey = await cacheStore(cachePayload);

    ok({
      cache_key: cacheKey,
      senders: resultSenders,
      totalMessagesScanned: allMessageIds.length,
      ...(truncated ? { truncated: true } : {}),
      ...(rateLimited ? { rateLimited: true } : {}),
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
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
