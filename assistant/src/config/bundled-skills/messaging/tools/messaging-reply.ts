import { batchGetMessages, createDraft, getProfile, listMessages } from '../../../../messaging/providers/gmail/client.js';
import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { err,ok, resolveProvider, withProviderToken } from './shared.js';

function extractHeader(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export async function run(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const conversationId = input.conversation_id as string;
  const threadId = input.thread_id as string;
  const text = input.text as string;

  if (!conversationId) {
    return err('conversation_id is required.');
  }
  if (!threadId) {
    return err('thread_id is required.');
  }
  if (!text) {
    return err('text is required.');
  }

  try {
    const provider = resolveProvider(platform);

    // Gmail: create a threaded draft with reply-all recipients
    if (provider.id === 'gmail') {
      return withProviderToken(provider, async (token) => {
        // Fetch thread messages to extract recipients and threading headers
        const list = await listMessages(token, `thread:${threadId}`, 10);
        if (!list.messages?.length) {
          return err('No messages found in this thread.');
        }

        const messages = await batchGetMessages(token, list.messages.map((m) => m.id), 'metadata', [
          'From', 'To', 'Cc', 'Message-ID', 'Subject',
        ]);

        // Use the latest message for threading and recipient extraction
        const latest = messages[messages.length - 1];
        const latestHeaders = latest.payload?.headers ?? [];

        const messageIdHeader = extractHeader(latestHeaders, 'Message-ID');
        let subject = extractHeader(latestHeaders, 'Subject');
        if (subject && !subject.startsWith('Re:')) {
          subject = `Re: ${subject}`;
        }

        // Build reply-all recipient list, excluding the user's own email
        const profile = await getProfile(token);
        const userEmail = profile.emailAddress.toLowerCase();

        const allRecipients = new Set<string>();
        const allCc = new Set<string>();

        // From the latest message: From goes to To, original To/Cc go to Cc
        const fromAddr = extractHeader(latestHeaders, 'From');
        const toAddrs = extractHeader(latestHeaders, 'To');
        const ccAddrs = extractHeader(latestHeaders, 'Cc');

        if (fromAddr) allRecipients.add(fromAddr);
        for (const addr of toAddrs.split(',').map((a) => a.trim()).filter(Boolean)) {
          allRecipients.add(addr);
        }
        for (const addr of ccAddrs.split(',').map((a) => a.trim()).filter(Boolean)) {
          allCc.add(addr);
        }

        // Remove user's own email from recipients
        const filterSelf = (addr: string) => !addr.toLowerCase().includes(userEmail);
        const toList = [...allRecipients].filter(filterSelf);
        const ccList = [...allCc].filter(filterSelf);

        if (toList.length === 0) {
          return err('Could not determine reply recipients from thread.');
        }

        const draft = await createDraft(
          token,
          toList.join(', '),
          subject,
          text,
          messageIdHeader || undefined,
          ccList.length > 0 ? ccList.join(', ') : undefined,
          undefined,
          threadId,
        );

        const recipientSummary = ccList.length > 0
          ? `To: ${toList.join(', ')}; Cc: ${ccList.join(', ')}`
          : `To: ${toList.join(', ')}`;
        return ok(`Gmail draft created (ID: ${draft.id}). ${recipientSummary}. Review in Gmail Drafts, then tell me to send it or send it yourself.`);
      });
    }

    return withProviderToken(provider, async (token) => {
      const result = await provider.sendMessage(token, conversationId, text, {
        threadId,
        assistantId: context.assistantId,
      });

      return ok(`Reply sent (ID: ${result.id}).`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
