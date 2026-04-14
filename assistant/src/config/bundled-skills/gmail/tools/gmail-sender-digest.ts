import {
  batchGetMessages,
  listMessages,
} from "../../../../messaging/providers/gmail/client.js";
import type { GmailMessage } from "../../../../messaging/providers/gmail/types.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { storeScanResult } from "./scan-result-store.js";
import { err, ok } from "./shared.js";

function isRateLimitError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /\b429\b/.test(e.message);
}

const MAX_MESSAGES_CAP = 5000;
const MAX_IDS_PER_SENDER = 5000;
const MAX_SAMPLE_SUBJECTS = 3;

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
  hasMore: boolean;
  sampleSubjects: string[];
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

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const query =
    (input.query as string) ?? "in:inbox category:promotions newer_than:90d";
  const maxMessages = Math.min(
    (input.max_messages as number) ?? 2000,
    MAX_MESSAGES_CAP,
  );
  const maxSenders = (input.max_senders as number) ?? 50;
  const inputPageToken = input.page_token as string | undefined;

  try {
    const connection = await resolveOAuthConnection("google", {
      account,
    });
    // Pipeline: fire metadata fetches for each page of IDs as they arrive,
    // overlapping fetch latency with pagination latency
    const allMessageIds: string[] = [];
    const fetchPromises: Promise<GmailMessage[]>[] = [];
    let pageToken: string | undefined = inputPageToken;
    let truncated = false;
    let timeBudgetExceeded = false;
    const metadataHeaders = ["From", "List-Unsubscribe", "Subject", "Date"];
    const startTime = Date.now();
    const TIME_BUDGET_MS = 90_000;

    let rateLimited = false;

    while (allMessageIds.length < maxMessages) {
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        timeBudgetExceeded = true;
        truncated = true;
        break;
      }
      const pageSize = Math.min(100, maxMessages - allMessageIds.length);
      let listResp;
      try {
        listResp = await listMessages(
          connection,
          query,
          pageSize,
          pageToken,
        );
      } catch (e) {
        if (isRateLimitError(e)) {
          rateLimited = true;
          truncated = true;
          break;
        }
        throw e;
      }
      const ids = (listResp.messages ?? []).map((m) => m.id);
      if (ids.length === 0) break;
      allMessageIds.push(...ids);
      fetchPromises.push(
        batchGetMessages(
          connection,
          ids,
          "metadata",
          metadataHeaders,
          "id,internalDate,payload/headers",
        ),
      );
      pageToken = listResp.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    // If we stopped because we hit the cap but there were still more pages, flag truncation
    if (allMessageIds.length >= maxMessages && pageToken) {
      truncated = true;
    }

    if (allMessageIds.length === 0) {
      return ok(
        JSON.stringify({
          senders: [],
          total_scanned: 0,
          message:
            "No emails found matching the query. Try broadening the search (e.g. remove category filter or extend date range).",
        }),
      );
    }

    // Settle all fetch promises — collect successes and tolerate 429 failures
    const settled = await Promise.allSettled(fetchPromises);
    const messages: GmailMessage[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        messages.push(...result.value);
      } else if (isRateLimitError(result.reason)) {
        rateLimited = true;
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
          hasMore: false,
          sampleSubjects: [],
        };
        senderMap.set(email, agg);
      }

      agg.messageCount++;

      if (listUnsub) agg.hasUnsubscribe = true;

      // Use displayName from earliest message that has one
      if (!agg.displayName && displayName) agg.displayName = displayName;

      // Track message IDs (cap at MAX_IDS_PER_SENDER)
      if (agg.messageIds.length < MAX_IDS_PER_SENDER) {
        agg.messageIds.push(msg.id);
      } else {
        agg.hasMore = true;
      }

      // Track date range - compare using internalDate (epoch ms) for reliability
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

      // Track the newest message that actually has List-Unsubscribe so
      // gmail_unsubscribe() is called with a message that carries the header
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

    const resultSenders = sorted.map((s) => ({
      id: Buffer.from(s.email).toString("base64url"),
      display_name: s.displayName || s.email.split("@")[0],
      email: s.email,
      message_count: s.messageCount,
      has_unsubscribe: s.hasUnsubscribe,
      // When unsubscribe is available, point to a message that carries the header
      newest_message_id:
        s.hasUnsubscribe && s.newestUnsubscribableMessageId
          ? s.newestUnsubscribableMessageId
          : s.newestMessageId,
      oldest_date: s.oldestDate,
      newest_date: s.newestDate,
      // Preserve original query filters so follow-up searches stay scoped
      search_query: `from:${s.email} ${query}`,
      sample_subjects: s.sampleSubjects,
    }));

    // Store message IDs server-side to keep them out of LLM context
    const scanId = storeScanResult(
      sorted.map((s) => ({
        id: Buffer.from(s.email).toString("base64url"),
        messageIds: s.messageIds,
        newestMessageId: s.newestMessageId,
        newestUnsubscribableMessageId: s.newestUnsubscribableMessageId,
      })),
    );

    return ok(
      JSON.stringify({
        scan_id: scanId,
        senders: resultSenders,
        total_scanned: allMessageIds.length,
        query_used: query,
        ...(truncated ? { truncated: true } : {}),
        ...(timeBudgetExceeded ? { time_budget_exceeded: true } : {}),
        ...(rateLimited ? { rate_limited: true } : {}),
        note: `message_count reflects emails found per sender within the ${allMessageIds.length} messages scanned. Use scan_id with gmail_archive to archive messages (pass scan_id + sender_ids instead of message_ids).`,
      }),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
