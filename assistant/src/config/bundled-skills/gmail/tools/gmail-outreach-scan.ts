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

const MAX_MESSAGES_CAP = 2000;
const MAX_IDS_PER_SENDER = 2000;
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
    (input.max_messages as number) ?? 1000,
    MAX_MESSAGES_CAP,
  );
  const maxSenders = (input.max_senders as number) ?? 30;
  const timeRange = (input.time_range as string) ?? "90d";
  const inputPageToken = input.page_token as string | undefined;

  const query = `in:inbox -has:unsubscribe newer_than:${timeRange}`;

  try {
    const connection = await resolveOAuthConnection("google", {
      account,
    });
    // Pipeline: fire metadata fetches for each page of IDs as they arrive
    const allMessageIds: string[] = [];
    const fetchPromises: Promise<GmailMessage[]>[] = [];
    let pageToken: string | undefined = inputPageToken;
    let truncated = false;
    let timeBudgetExceeded = false;
    const metadataHeaders = ["From", "Subject", "Date"];
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
        listResp = await listMessages(connection, query, pageSize, pageToken);
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

    if (allMessageIds.length >= maxMessages && pageToken) {
      truncated = true;
    }

    if (allMessageIds.length === 0) {
      if (rateLimited) {
        return ok(
          JSON.stringify({
            senders: [],
            total_scanned: 0,
            rate_limited: true,
            truncated: true,
            note: "Rate limited before any messages could be fetched. Try again later or reduce max_messages.",
          }),
        );
      }
      return ok(
        JSON.stringify({
          senders: [],
          total_scanned: 0,
          note: "No emails found matching the query.",
        }),
      );
    }

    // Settle all fetch promises — collect successes and tolerate 429 failures.
    const elapsedMs = Date.now() - startTime;
    const settleDeadlineMs = Math.max(TIME_BUDGET_MS - elapsedMs, 5_000);
    const deadlineRejection = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("fetch deadline exceeded")),
        settleDeadlineMs,
      ),
    );
    const settled = await Promise.allSettled(
      fetchPromises.map((p) => Promise.race([p, deadlineRejection])),
    );
    const messages: GmailMessage[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        messages.push(...result.value);
      } else if (isRateLimitError(result.reason)) {
        rateLimited = true;
        truncated = true;
      } else if (
        result.reason instanceof Error &&
        result.reason.message === "fetch deadline exceeded"
      ) {
        timeBudgetExceeded = true;
        truncated = true;
      } else {
        throw result.reason;
      }
    }

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

    // Sort by message count desc — over-fetch before enrichment, cap after
    const sorted = [...senderMap.values()]
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, maxSenders * 3);

    // Enrich with prior-reply signal: check if user has ever sent to each sender.
    // Uses bounded concurrency (batches of 10) and AbortController to cancel
    // in-flight requests when the time budget expires.
    //
    // Three-valued enrichment map:
    //   true  = confirmed prior reply (enrichment succeeded, found replies)
    //   false = confirmed no prior reply (enrichment succeeded, no replies)
    //   undefined (absent) = unknown (enrichment skipped — rate-limited or timed out)
    //
    // Only senders with confirmed `true` are filtered out. Senders with unknown
    // status are kept and returned with `has_prior_reply: null`.
    const ENRICHMENT_CONCURRENCY = 10;
    const priorReplyMap = new Map<string, boolean>();
    if (!rateLimited) {
      const enrichmentBudgetMs = Math.max(
        TIME_BUDGET_MS - (Date.now() - startTime),
        5_000,
      );
      const abortController = new AbortController();
      const budgetTimer = setTimeout(
        () => abortController.abort(),
        enrichmentBudgetMs,
      );

      try {
        // Process in waves to limit concurrency and stop on budget expiry
        for (
          let i = 0;
          i < sorted.length && !abortController.signal.aborted;
          i += ENRICHMENT_CONCURRENCY
        ) {
          const batch = sorted.slice(i, i + ENRICHMENT_CONCURRENCY);
          const batchChecks = batch.map(async (s) => {
            if (abortController.signal.aborted) return;
            try {
              const resp = await listMessages(
                connection,
                `from:me to:${s.email}`,
                1,
                undefined,
                undefined,
                abortController.signal,
              );
              priorReplyMap.set(s.email, (resp.messages?.length ?? 0) > 0);
            } catch {
              // Non-fatal — leave absent in map (unknown status).
              // Abort errors from the signal are also caught here, which is
              // intentional: the sender keeps unknown status rather than being
              // dropped.
            }
          });
          await Promise.race([
            Promise.all(batchChecks),
            new Promise<void>((resolve) =>
              abortController.signal.addEventListener(
                "abort",
                () => resolve(),
                {
                  once: true,
                },
              ),
            ),
          ]);
        }
      } finally {
        clearTimeout(budgetTimer);
      }
    }
    // When rate-limited or timed-out, senders simply have no entry in
    // priorReplyMap — they are kept with unknown reply status.

    // Filter out senders with confirmed prior replies, then cap to maxSenders.
    // This is the purpose of over-fetching (maxSenders * 3): enrich more
    // candidates, discard those with existing replies, then take the top N.
    // Senders with unknown enrichment status (absent from priorReplyMap) are kept.
    const capped = sorted
      .filter((s) => priorReplyMap.get(s.email) !== true)
      .slice(0, maxSenders);
    const senders = capped.map((s) => ({
      id: Buffer.from(s.email).toString("base64url"),
      display_name: s.displayName || s.email.split("@")[0],
      email: s.email,
      message_count: s.messageCount,
      has_prior_reply: priorReplyMap.has(s.email)
        ? priorReplyMap.get(s.email)!
        : null,
      newest_message_id: s.newestMessageId,
      oldest_date: s.oldestDate,
      newest_date: s.newestDate,
      search_query: `from:${s.email}`,
      sample_subjects: s.sampleSubjects,
    }));

    // Store message IDs server-side to keep them out of LLM context
    const scanId = storeScanResult(
      capped.map((s) => ({
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
        ...(rateLimited ? { rate_limited: true } : {}),
        note: "Scanned inbox for senders without List-Unsubscribe headers (potential cold outreach). Use gmail_archive and gmail_filters for cleanup.",
      }),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
