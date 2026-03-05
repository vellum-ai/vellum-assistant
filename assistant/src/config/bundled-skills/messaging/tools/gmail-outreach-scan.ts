import type { EmailMetadata } from "../../../../messaging/email-classifier.js";
import {
  classifyOutreach,
  type OutreachClassification,
} from "../../../../messaging/outreach-classifier.js";
import {
  batchGetMessages,
  listMessages,
} from "../../../../messaging/providers/gmail/client.js";
import type { GmailMessage } from "../../../../messaging/providers/gmail/types.js";
import { getMessagingProvider } from "../../../../messaging/registry.js";
import { withValidToken } from "../../../../security/token-manager.js";
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
  outreachTypes: string[];
  confidenceSum: number;
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

function buildSuggestedActions(email: string, count: number): string[] {
  const actions: string[] = [`Archive all ${count} messages`];
  if (count >= 2) {
    actions.push(`Create filter to auto-archive future emails from ${email}`);
  }
  if (count >= 3) {
    const domain = email.split("@")[1];
    if (domain) {
      actions.push(
        `Create filter to auto-archive future emails from @${domain}`,
      );
    }
  }
  return actions;
}

/** Find the most common string in an array. */
function mostCommon(items: string[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  let best = items[0] ?? "other";
  let bestCount = 0;
  for (const [item, count] of counts) {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  }
  return best;
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const maxMessages = Math.min(
    (input.max_messages as number) ?? 2000,
    MAX_MESSAGES_CAP,
  );
  const maxSenders = (input.max_senders as number) ?? 30;
  const timeRange = (input.time_range as string) ?? "90d";
  const minConfidence = (input.min_confidence as number) ?? 0.5;
  const inputPageToken = input.page_token as string | undefined;

  const query = `in:inbox -has:unsubscribe newer_than:${timeRange}`;

  try {
    const provider = getMessagingProvider("gmail");
    return withValidToken(provider.credentialService, async (token) => {
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
        const listResp = await listMessages(token, query, pageSize, pageToken);
        const ids = (listResp.messages ?? []).map((m) => m.id);
        if (ids.length === 0) break;
        allMessageIds.push(...ids);
        fetchPromises.push(
          batchGetMessages(
            token,
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
            outreach_detected: 0,
            message: "No emails found matching the query.",
          }),
        );
      }

      const messages = (await Promise.all(fetchPromises)).flat();

      // Build EmailMetadata for the classifier
      const emailMetadata: EmailMetadata[] = messages.map((msg) => {
        const headers = msg.payload?.headers ?? [];
        const from =
          headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
        const subject =
          headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
        return { id: msg.id, from, subject, snippet: "", labels: [] };
      });

      // Classify in batches
      const classifications = await classifyOutreach(emailMetadata);

      // Index classifications by message ID
      const classificationMap = new Map<string, OutreachClassification>();
      for (const c of classifications) {
        if (c.isOutreach) {
          classificationMap.set(c.id, c);
        }
      }

      // Aggregate by sender email (only outreach-classified messages)
      const senderMap = new Map<string, OutreachSenderAggregation>();

      for (const msg of messages) {
        const classification = classificationMap.get(msg.id);
        if (!classification) continue;

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
            outreachTypes: [],
            confidenceSum: 0,
          };
          senderMap.set(email, agg);
        }

        agg.messageCount++;
        agg.outreachTypes.push(classification.outreachType);
        agg.confidenceSum += classification.confidence;

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

      // Sort by message count desc, filter by confidence, take top N
      const qualified = [...senderMap.values()]
        .map((s) => ({
          ...s,
          avgConfidence:
            s.messageCount > 0 ? s.confidenceSum / s.messageCount : 0,
          outreachType: mostCommon(s.outreachTypes),
        }))
        .filter((s) => s.avgConfidence >= minConfidence)
        .sort((a, b) => b.messageCount - a.messageCount);

      const totalOutreachDetected = qualified.length;
      const sorted = qualified.slice(0, maxSenders);

      const senders = sorted.map((s) => ({
        id: Buffer.from(s.email).toString("base64url"),
        display_name: s.displayName || s.email.split("@")[0],
        email: s.email,
        message_count: s.messageCount,
        outreach_type: s.outreachType,
        confidence: Math.round(s.avgConfidence * 100) / 100,
        newest_message_id: s.newestMessageId,
        oldest_date: s.oldestDate,
        newest_date: s.newestDate,
        search_query: `from:${s.email}`,
        sample_subjects: s.sampleSubjects,
        suggested_actions: buildSuggestedActions(s.email, s.messageCount),
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
          outreach_detected: totalOutreachDetected,
          ...(truncated ? { truncated: true } : {}),
          ...(timeBudgetExceeded ? { time_budget_exceeded: true } : {}),
        }),
      );
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
