import {
  batchGetMessages,
  listMessages,
} from "../../../../messaging/providers/outlook/client.js";
import type { OutlookMessage } from "../../../../messaging/providers/outlook/types.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { storeScanResult } from "../../gmail/tools/scan-result-store.js";
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

/** Parse a time range string like "90d" or "30d" into milliseconds. */
function parseTimeRange(timeRange: string): number {
  const match = timeRange.match(/^(\d+)([dhm])$/);
  if (!match) return 90 * 24 * 60 * 60 * 1000; // default 90 days
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "m":
      return value * 60 * 1000;
    default:
      return 90 * 24 * 60 * 60 * 1000;
  }
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const maxSenders = (input.max_senders as number) ?? 30;
  const timeRange = (input.time_range as string) ?? "90d";

  try {
    const connection = await resolveOAuthConnection("outlook", {
      account,
    });

    // Build OData filter: inbox messages from the specified time range
    const sinceDate = new Date(
      Date.now() - parseTimeRange(timeRange),
    ).toISOString();
    const dateFilter = `receivedDateTime ge ${sinceDate}`;

    const allMessageIds: string[] = [];
    const fetchPromises: Promise<OutlookMessage[]>[] = [];
    let skip = 0;
    let truncated = false;
    let timeBudgetExceeded = false;
    const startTime = Date.now();
    const TIME_BUDGET_MS = 90_000;

    // Paginate through messages
    while (allMessageIds.length < MAX_MESSAGES_CAP) {
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        timeBudgetExceeded = true;
        truncated = true;
        break;
      }
      const pageSize = Math.min(100, MAX_MESSAGES_CAP - allMessageIds.length);

      const listResp = await listMessages(connection, {
        top: pageSize,
        skip,
        filter: dateFilter,
        orderby: "receivedDateTime desc",
        select: "id,from,receivedDateTime,subject",
      });

      const messages = listResp.value ?? [];
      if (messages.length === 0) break;

      const ids = messages.map((m) => m.id);
      allMessageIds.push(...ids);

      // Fetch internet message headers to check for List-Unsubscribe
      fetchPromises.push(
        batchGetMessages(
          connection,
          ids,
          "id,from,receivedDateTime,subject,internetMessageHeaders",
        ),
      );

      skip += messages.length;
      if (messages.length < pageSize) break;
    }

    if (allMessageIds.length >= MAX_MESSAGES_CAP) {
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

    const fetchedMessages = (await Promise.all(fetchPromises)).flat();

    // First pass: track which senders have ANY messages with List-Unsubscribe
    const sendersWithUnsubscribe = new Set<string>();
    for (const msg of fetchedMessages) {
      const fromEmail = msg.from?.emailAddress?.address?.toLowerCase();
      if (!fromEmail) continue;
      const hasUnsub = msg.internetMessageHeaders?.some(
        (h) => h.name.toLowerCase() === "list-unsubscribe",
      );
      if (hasUnsub) sendersWithUnsubscribe.add(fromEmail);
    }

    // Second pass: aggregate only senders WITHOUT List-Unsubscribe
    const senderMap = new Map<string, OutreachSenderAggregation>();

    for (const msg of fetchedMessages) {
      const fromEmail = msg.from?.emailAddress?.address?.toLowerCase();
      const fromName = msg.from?.emailAddress?.name ?? "";
      const subject = msg.subject ?? "";
      const dateStr = msg.receivedDateTime ?? "";

      if (!fromEmail) continue;
      // Skip senders that have any messages with List-Unsubscribe
      if (sendersWithUnsubscribe.has(fromEmail)) continue;

      let agg = senderMap.get(fromEmail);
      if (!agg) {
        agg = {
          displayName: fromName,
          email: fromEmail,
          messageCount: 0,
          newestMessageId: msg.id,
          oldestDate: dateStr,
          newestDate: dateStr,
          messageIds: [],
          hasMore: false,
          sampleSubjects: [],
        };
        senderMap.set(fromEmail, agg);
      }

      agg.messageCount++;

      if (!agg.displayName && fromName) agg.displayName = fromName;

      if (agg.messageIds.length < MAX_IDS_PER_SENDER) {
        agg.messageIds.push(msg.id);
      } else {
        agg.hasMore = true;
      }

      // Track date range
      const msgEpoch = dateStr ? new Date(dateStr).getTime() : 0;
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
        note: "Scanned inbox for senders without List-Unsubscribe headers (potential cold outreach). Use outlook_archive and outlook_mail_rules for cleanup.",
      }),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
