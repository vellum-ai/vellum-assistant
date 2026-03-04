import {
  batchGetMessages,
  createDraft,
  getProfile,
  listMessages,
} from "../../../../messaging/providers/gmail/client.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok, resolveProvider, withProviderToken } from "./shared.js";

function extractHeader(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string {
  return (
    headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

/**
 * RFC 5322-aware address list parser. Splits a header value like
 * `"Doe, Jane" <jane@example.com>, bob@example.com` into individual
 * addresses without breaking on commas inside quoted display names.
 */
function parseAddressList(header: string): string[] {
  const addresses: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;

  for (let i = 0; i < header.length; i++) {
    const ch = header[i];

    if (ch === '"' && !inAngle) {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "<" && !inQuotes) {
      inAngle = true;
      current += ch;
    } else if (ch === ">" && !inQuotes) {
      inAngle = false;
      current += ch;
    } else if (ch === "," && !inQuotes && !inAngle) {
      const trimmed = current.trim();
      if (trimmed) addresses.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed) addresses.push(trimmed);

  return addresses;
}

/**
 * Extracts the bare email from an address that may be in any of these forms:
 *   - `user@example.com`
 *   - `<user@example.com>`
 *   - `"Display Name" <user@example.com>`
 *   - `Display Name <user@example.com>`
 *   - `"Team <Ops>" <user@example.com>`
 *   - `user@example.com (team <ops>)`
 *
 * Extracts all angle-bracketed segments and picks the last one containing `@`,
 * preferring the actual mailbox over display-name fragments like
 * `"Acme <support@acme.com>" <owner@example.com>`. If no segment contains `@`,
 * strips angle-bracketed portions and parenthetical comments, returning the
 * remaining text. This handles display names with angle brackets and trailing
 * RFC 5322 comments.
 */
function extractEmail(address: string): string {
  // Strip parenthetical comments first to avoid matching addresses inside them
  const cleaned = address.replace(/\(.*?\)/g, "");
  const segments = [...cleaned.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  if (segments.length > 0) {
    const emailSegment = [...segments].reverse().find((s) => s.includes("@"));
    if (emailSegment) return emailSegment.trim().toLowerCase();
  }
  return address
    .replace(/<[^>]+>/g, "")
    .replace(/\(.*?\)/g, "")
    .trim()
    .toLowerCase();
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const conversationId = input.conversation_id as string;
  const threadId = input.thread_id as string;
  const text = input.text as string;

  if (!conversationId) {
    return err("conversation_id is required.");
  }
  if (!threadId) {
    return err("thread_id is required.");
  }
  if (!text) {
    return err("text is required.");
  }

  try {
    const provider = resolveProvider(platform);

    // Gmail: create a threaded draft with reply-all recipients
    if (provider.id === "gmail") {
      return withProviderToken(provider, async (token) => {
        // Fetch thread messages to extract recipients and threading headers
        const list = await listMessages(token, `thread:${threadId}`, 10);
        if (!list.messages?.length) {
          return err("No messages found in this thread.");
        }

        const messages = await batchGetMessages(
          token,
          list.messages.map((m) => m.id),
          "metadata",
          ["From", "To", "Cc", "Message-ID", "Subject"],
        );

        // Use the latest message for threading and recipient extraction
        const latest = messages[messages.length - 1];
        const latestHeaders = latest.payload?.headers ?? [];

        const messageIdHeader = extractHeader(latestHeaders, "Message-ID");
        let subject = extractHeader(latestHeaders, "Subject");
        if (subject && !subject.startsWith("Re:")) {
          subject = `Re: ${subject}`;
        }

        // Build reply-all recipient list, excluding the user's own email
        const profile = await getProfile(token);
        const userEmail = profile.emailAddress.toLowerCase();

        const allRecipients = new Set<string>();
        const allCc = new Set<string>();

        // From the latest message: From goes to To, original To/Cc go to Cc
        const fromAddr = extractHeader(latestHeaders, "From");
        const toAddrs = extractHeader(latestHeaders, "To");
        const ccAddrs = extractHeader(latestHeaders, "Cc");

        if (fromAddr) allRecipients.add(fromAddr);
        for (const addr of parseAddressList(toAddrs)) {
          allRecipients.add(addr);
        }
        for (const addr of parseAddressList(ccAddrs)) {
          allCc.add(addr);
        }

        // Remove user's own email from recipients using exact email comparison
        const filterSelf = (addr: string) => extractEmail(addr) !== userEmail;
        const toList = [...allRecipients].filter(filterSelf);
        const ccList = [...allCc].filter(filterSelf);

        if (toList.length === 0) {
          return err("Could not determine reply recipients from thread.");
        }

        const draft = await createDraft(
          token,
          toList.join(", "),
          subject,
          text,
          messageIdHeader || undefined,
          ccList.length > 0 ? ccList.join(", ") : undefined,
          undefined,
          threadId,
        );

        const recipientSummary =
          ccList.length > 0
            ? `To: ${toList.join(", ")}; Cc: ${ccList.join(", ")}`
            : `To: ${toList.join(", ")}`;
        return ok(
          `Gmail draft created (ID: ${draft.id}). ${recipientSummary}. Review in Gmail Drafts, then tell me to send it or send it yourself.`,
        );
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
