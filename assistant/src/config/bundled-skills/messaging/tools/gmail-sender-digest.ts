import { batchGetMessages,listMessages } from '../../../../messaging/providers/gmail/client.js';
import { getMessagingProvider } from '../../../../messaging/registry.js';
import { withValidToken } from '../../../../security/token-manager.js';
import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { err,ok } from './shared.js';

const MAX_MESSAGES_CAP = 2000;
const MAX_IDS_PER_SENDER = 2000;
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
    return { displayName: match[1].replace(/^["']|["']$/g, '').trim(), email: match[2].toLowerCase() };
  }
  // Bare email address
  const bare = from.trim().toLowerCase();
  return { displayName: '', email: bare };
}

export async function run(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
  const query = (input.query as string) ?? 'category:promotions newer_than:90d';
  const maxMessages = Math.min((input.max_messages as number) ?? 2000, MAX_MESSAGES_CAP);
  const maxSenders = (input.max_senders as number) ?? 30;

  try {
    const provider = getMessagingProvider('gmail');
    return withValidToken(provider.credentialService, async (token) => {
      // Paginate through listMessages to collect up to maxMessages IDs
      const allMessageIds: string[] = [];
      let pageToken: string | undefined;

      while (allMessageIds.length < maxMessages) {
        const pageSize = Math.min(100, maxMessages - allMessageIds.length);
        const listResp = await listMessages(token, query, pageSize, pageToken);
        const ids = (listResp.messages ?? []).map((m) => m.id);
        if (ids.length === 0) break;
        allMessageIds.push(...ids);
        pageToken = listResp.nextPageToken ?? undefined;
        if (!pageToken) break;
      }

      if (allMessageIds.length === 0) {
        return ok(JSON.stringify({ senders: [], total_scanned: 0, message: 'No emails found matching the query. Try broadening the search (e.g. remove category filter or extend date range).' }));
      }

      // Batch-fetch metadata headers
      const messages = await batchGetMessages(token, allMessageIds, 'metadata', [
        'From', 'List-Unsubscribe', 'Subject', 'Date',
      ]);

      // Group by sender email
      const senderMap = new Map<string, SenderAggregation>();

      for (const msg of messages) {
        const headers = msg.payload?.headers ?? [];
        const fromHeader = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? '';
        const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? '';
        const dateStr = headers.find((h) => h.name.toLowerCase() === 'date')?.value ?? '';
        const listUnsub = headers.find((h) => h.name.toLowerCase() === 'list-unsubscribe')?.value;

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

        // Track date range — compare using internalDate (epoch ms) for reliability
        const msgEpoch = msg.internalDate ? Number(msg.internalDate) : 0;
        const oldestEpoch = agg.oldestDate ? new Date(agg.oldestDate).getTime() : Infinity;
        const newestEpoch = agg.newestDate ? new Date(agg.newestDate).getTime() : 0;

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

      const result = sorted.map((s) => ({
        id: Buffer.from(s.email).toString('base64url'),
        display_name: s.displayName || s.email.split('@')[0],
        email: s.email,
        message_count: s.messageCount,
        has_unsubscribe: s.hasUnsubscribe,
        // When unsubscribe is available, point to a message that carries the header
        newest_message_id: (s.hasUnsubscribe && s.newestUnsubscribableMessageId)
          ? s.newestUnsubscribableMessageId
          : s.newestMessageId,
        oldest_date: s.oldestDate,
        newest_date: s.newestDate,
        message_ids: s.messageIds,
        has_more: s.hasMore,
        // Preserve original query filters so follow-up searches stay scoped
        search_query: `from:${s.email} ${query}`,
        sample_subjects: s.sampleSubjects,
      }));

      return ok(JSON.stringify({
        senders: result,
        total_scanned: allMessageIds.length,
        query_used: query,
        note: `message_count reflects emails found per sender within the ${allMessageIds.length} messages scanned. Use the message_ids array with gmail_batch_archive to archive exactly these messages.`,
      }));
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
