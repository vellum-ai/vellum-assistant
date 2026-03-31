import {
  batchGetMessages,
  listMessages,
  searchMessages,
} from "../../../../messaging/providers/outlook/client.js";
import type { OutlookMessage } from "../../../../messaging/providers/outlook/types.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { storeScanResult } from "../../gmail/tools/scan-result-store.js";
import { err, ok } from "./shared.js";

const MAX_MESSAGES_CAP = 10000;
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

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const userQuery = input.query as string | undefined;
  const maxSenders = (input.max_senders as number) ?? 50;

  try {
    const connection = await resolveOAuthConnection("outlook", {
      account,
    });

    // Build OData filter: inbox messages from last 90 days
    const ninetyDaysAgo = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const ninetyDaysAgoEpoch = new Date(ninetyDaysAgo).getTime();
    const dateFilter = `receivedDateTime ge ${ninetyDaysAgo}`;

    const allMessageIds: string[] = [];
    const fetchPromises: Promise<OutlookMessage[]>[] = [];
    let skip = 0;
    let truncated = false;
    let timeBudgetExceeded = false;
    const startTime = Date.now();
    const TIME_BUDGET_MS = 90_000;

    // When userQuery is provided, use searchMessages (Microsoft Graph
    // doesn't support combining $filter and $search). Date filtering is
    // applied client-side instead.
    const useSearch = Boolean(userQuery);

    // Paginate through messages
    while (allMessageIds.length < MAX_MESSAGES_CAP) {
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        timeBudgetExceeded = true;
        truncated = true;
        break;
      }
      const pageSize = Math.min(100, MAX_MESSAGES_CAP - allMessageIds.length);

      let messages: OutlookMessage[];

      if (useSearch) {
        const searchResp = await searchMessages(connection, userQuery!, {
          top: pageSize,
          skip,
        });
        messages = searchResp.value ?? [];
      } else {
        const listResp = await listMessages(connection, {
          top: pageSize,
          skip,
          filter: dateFilter,
          orderby: "receivedDateTime desc",
          select: "id,from,receivedDateTime,hasAttachments,subject",
        });
        messages = listResp.value ?? [];
      }

      if (messages.length === 0) break;

      // When using search, apply 90-day date filter client-side
      const filtered = useSearch
        ? messages.filter((m) => {
            const received = m.receivedDateTime
              ? new Date(m.receivedDateTime).getTime()
              : 0;
            return received >= ninetyDaysAgoEpoch;
          })
        : messages;

      const ids = filtered.map((m) => m.id);
      allMessageIds.push(...ids);

      // Fetch internet message headers (List-Unsubscribe) for each batch
      if (ids.length > 0) {
        fetchPromises.push(
          batchGetMessages(
            connection,
            ids,
            "id,from,receivedDateTime,subject,internetMessageHeaders",
          ),
        );
      }

      skip += messages.length;

      // If we received fewer messages than requested, there are no more pages
      if (messages.length < pageSize) break;

      // When using search, if all messages in a page are older than
      // 90 days we've likely passed beyond the relevant window
      if (useSearch && filtered.length === 0) break;
    }

    // Flag truncation if we hit the cap with more pages potentially available
    if (allMessageIds.length >= MAX_MESSAGES_CAP) {
      truncated = true;
    }

    if (allMessageIds.length === 0) {
      return ok(
        JSON.stringify({
          senders: [],
          total_scanned: 0,
          message:
            "No emails found matching the query. Try broadening the search (e.g. extend date range).",
        }),
      );
    }

    const fetchedMessages = (await Promise.all(fetchPromises)).flat();

    // Group by sender email
    const senderMap = new Map<string, SenderAggregation>();

    for (const msg of fetchedMessages) {
      const fromEmail = msg.from?.emailAddress?.address?.toLowerCase();
      const fromName = msg.from?.emailAddress?.name ?? "";
      const subject = msg.subject ?? "";
      const dateStr = msg.receivedDateTime ?? "";

      if (!fromEmail) continue;

      // Check for List-Unsubscribe header
      const listUnsub = msg.internetMessageHeaders?.find(
        (h) => h.name.toLowerCase() === "list-unsubscribe",
      )?.value;

      let agg = senderMap.get(fromEmail);
      if (!agg) {
        agg = {
          displayName: fromName,
          email: fromEmail,
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
        senderMap.set(fromEmail, agg);
      }

      agg.messageCount++;

      if (listUnsub) agg.hasUnsubscribe = true;

      // Use displayName from earliest message that has one
      if (!agg.displayName && fromName) agg.displayName = fromName;

      // Track message IDs (cap at MAX_IDS_PER_SENDER)
      if (agg.messageIds.length < MAX_IDS_PER_SENDER) {
        agg.messageIds.push(msg.id);
      } else {
        agg.hasMore = true;
      }

      // Track date range using ISO date strings
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

      // Track the newest message that has List-Unsubscribe so
      // unsubscribe actions target a message that carries the header
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
      newest_message_id:
        s.hasUnsubscribe && s.newestUnsubscribableMessageId
          ? s.newestUnsubscribableMessageId
          : s.newestMessageId,
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
        newestUnsubscribableMessageId: s.newestUnsubscribableMessageId,
      })),
    );

    return ok(
      JSON.stringify({
        scan_id: scanId,
        senders: resultSenders,
        total_scanned: allMessageIds.length,
        query_used: userQuery ?? `inbox messages from last 90 days`,
        ...(truncated ? { truncated: true } : {}),
        ...(timeBudgetExceeded ? { time_budget_exceeded: true } : {}),
        note: `message_count reflects emails found per sender within the ${allMessageIds.length} messages scanned. Use scan_id with outlook_archive to archive messages (pass scan_id + sender_ids instead of message_ids).`,
      }),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
