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

const MAX_MESSAGES_CAP = 5000;
const MAX_IDS_PER_SENDER = 5000;
const MAX_SAMPLE_SUBJECTS = 3;

interface OutreachSenderAggregation {
  displayName: string;
  email: string;
  messageCount: number;
  newestMessageId: string;
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
  const bare = from.trim().toLowerCase();
  return { displayName: "", email: bare };
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const maxMessages = Math.min(
    (input.max_messages as number) ?? 2000,
    MAX_MESSAGES_CAP,
  );
  const maxSenders = (input.max_senders as number) ?? 30;
  const timeRange = (input.time_range as string) ?? "90d";
  const inputPageToken = input.page_token as string | undefined;

  const query = `in:inbox -has:unsubscribe newer_than:${timeRange}`;

  try {
    const connection = resolveOAuthConnection("integration:gmail", account);
    // Pipeline: fire metadata fetches for each page of IDs as they arrive
    const allMessageIds: string[] = [];
    const fetchPromises: Promise<GmailMessage[]>[] = [];
    let pageToken: string | undefined = inputPageToken;
    let truncated = false;
    let timeBudgetExceeded = false;
    const metadataHeaders = ["From", "Subject", "Date"];
    const startTime = Date.now();
    const TIME_BUDGET_MS = 90_000;

    while (allMessageIds.length < maxMessages) {
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        timeBudgetExceeded = true;
        truncated = true;
        break;
      }
      const pageSize = Math.min(100, maxMessages - allMessageIds.length);
      const listResp = await listMessages(
        connection,
        query,
        pageSize,
        pageToken,
      );
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

    if (allMessageIds.length >= maxMessages && pageToken) {
      truncated = true;
    }

    if (allMessageIds.length === 0) {
      return ok(
        JSON.stringify({
          senders: [],
          total_scanned: 0,
          note: "No emails found matching the query.",
        }),
      );
    }

    const messages = (await Promise.all(fetchPromises)).flat();

    // Aggregate all fetched messages by sender
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
          hasMore: false,
          sampleSubjects: [],
        };
        senderMap.set(email, agg);
      }

      agg.messageCount++;

      if (!agg.displayName && displayName) agg.displayName = displayName;

      if (agg.messageIds.length < MAX_IDS_PER_SENDER) {
        agg.messageIds.push(msg.id);
      } else {
        agg.hasMore = true;
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

    // Sort by message count desc, take top N
    const sorted = [...senderMap.values()]
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, maxSenders);

    const senders = sorted.map((s) => ({
      id: Buffer.from(s.email).toString("base64url"),
      display_name: s.displayName || s.email.split("@")[0],
      email: s.email,
      message_count: s.messageCount,
      newest_message_id: s.newestMessageId,
      oldest_date: s.oldestDate,
      newest_date: s.newestDate,
      search_query: `from:${s.email}`,
      sample_subjects: s.sampleSubjects,
    }));

    // Store message IDs server-side to keep them out of LLM context
    const scanId = storeScanResult(
      sorted.map((s) => ({
        id: Buffer.from(s.email).toString("base64url"),
        messageIds: s.messageIds,
        newestMessageId: s.newestMessageId,
        newestUnsubscribableMessageId: null,
      })),
    );

    return ok(
      JSON.stringify({
        scan_id: scanId,
        senders,
        total_scanned: allMessageIds.length,
        ...(truncated ? { truncated: true } : {}),
        ...(timeBudgetExceeded ? { time_budget_exceeded: true } : {}),
        note: "Scanned inbox for senders without List-Unsubscribe headers (potential cold outreach). Use gmail_archive and gmail_filters for cleanup.",
      }),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
