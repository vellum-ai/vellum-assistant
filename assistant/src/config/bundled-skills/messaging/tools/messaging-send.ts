import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  batchGetMessages,
  createDraft,
  createDraftRaw,
  getProfile,
  listMessages,
} from "../../../../messaging/providers/gmail/client.js";
import { buildMultipartMime } from "../../../../messaging/providers/gmail/mime-builder.js";
import type { OAuthConnection } from "../../../../oauth/connection.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { guessMimeType } from "./gmail-mime-helpers.js";
import {
  err,
  extractEmail,
  extractHeader,
  getProviderConnection,
  ok,
  parseAddressList,
  resolveProvider,
} from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const conversationId = input.conversation_id as string;
  const text = input.text as string;
  const subject = input.subject as string | undefined;
  const inReplyTo = input.in_reply_to as string | undefined;
  const attachmentPaths = input.attachment_paths as string[] | undefined;
  const threadId = input.thread_id as string | undefined;

  if (!conversationId) {
    return err("conversation_id is required.");
  }
  if (!text) {
    return err("text is required.");
  }

  try {
    const provider = await resolveProvider(platform);

    // Non-Gmail platforms: reject attachment_paths
    if (provider.id !== "gmail" && attachmentPaths?.length) {
      return err("Attachments are only supported on Gmail.");
    }

    const account = input.account as string | undefined;
    const conn = await getProviderConnection(provider, account);

    // Gmail: create a draft instead of sending directly
    if (provider.id === "gmail") {
      const gmailConn = conn as OAuthConnection;
      // Reply mode: thread_id provided — create a threaded draft with reply-all recipients
      if (threadId) {
        // Fetch thread messages to extract recipients and threading headers
        const list = await listMessages(gmailConn, `thread:${threadId}`, 10);
        if (!list.messages?.length) {
          return err("No messages found in this thread.");
        }

        const messages = await batchGetMessages(
          gmailConn,
          list.messages.map((m) => m.id),
          "metadata",
          ["From", "To", "Cc", "Message-ID", "Subject"],
        );

        // Use the latest message for threading and recipient extraction
        const latest = messages[messages.length - 1];
        const latestHeaders = latest.payload?.headers ?? [];

        const messageIdHeader = extractHeader(latestHeaders, "Message-ID");
        let replySubject = extractHeader(latestHeaders, "Subject");
        if (replySubject && !replySubject.startsWith("Re:")) {
          replySubject = `Re: ${replySubject}`;
        }

        // Build reply-all recipient list, excluding the user's own email
        const profile = await getProfile(gmailConn);
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

        // With attachments: build multipart MIME for threaded reply
        if (attachmentPaths?.length) {
          const attachments = await Promise.all(
            attachmentPaths.map(async (filePath) => {
              const data = await readFile(filePath);
              const filename = basename(filePath);
              const mimeType = guessMimeType(filePath);
              return { filename, mimeType, data };
            }),
          );

          const raw = buildMultipartMime({
            to: toList.join(", "),
            subject: replySubject,
            body: text,
            inReplyTo: messageIdHeader || undefined,
            cc: ccList.length > 0 ? ccList.join(", ") : undefined,
            attachments,
          });
          const draft = await createDraftRaw(gmailConn, raw, threadId);

          const filenames = attachments.map((a) => a.filename).join(", ");
          const recipientSummary =
            ccList.length > 0
              ? `To: ${toList.join(", ")}; Cc: ${ccList.join(", ")}`
              : `To: ${toList.join(", ")}`;
          return ok(
            `Gmail draft created with ${attachments.length} attachment(s): ${filenames} (Draft ID: ${draft.id}). ${recipientSummary}. Review in Gmail Drafts, then tell me to send it or send it yourself.`,
          );
        }

        const draft = await createDraft(
          gmailConn,
          toList.join(", "),
          replySubject,
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
      }

      // With attachments: build multipart MIME and use createDraftRaw
      if (attachmentPaths?.length) {
        const attachments = await Promise.all(
          attachmentPaths.map(async (filePath) => {
            const data = await readFile(filePath);
            const filename = basename(filePath);
            const mimeType = guessMimeType(filePath);
            return { filename, mimeType, data };
          }),
        );

        const raw = buildMultipartMime({
          to: conversationId,
          subject: subject ?? "",
          body: text,
          inReplyTo,
          attachments,
        });
        const draft = await createDraftRaw(gmailConn, raw, threadId);

        const filenames = attachments.map((a) => a.filename).join(", ");
        return ok(
          `Gmail draft created with ${attachments.length} attachment(s): ${filenames} (Draft ID: ${draft.id}). Review in Gmail Drafts, then tell me to send it or send it yourself.`,
        );
      }

      // Without attachments: use standard createDraft
      const draft = await createDraft(
        gmailConn,
        conversationId,
        subject ?? "",
        text,
        inReplyTo,
        undefined,
        undefined,
        threadId,
      );
      return ok(
        `Gmail draft created (ID: ${draft.id}). Review it in your Gmail Drafts, then tell me to send it or send it yourself from Gmail.`,
      );
    }

    // Non-Gmail platforms
    const result = await provider.sendMessage(conn, conversationId, text, {
      subject,
      inReplyTo,
      threadId,
      assistantId: context.assistantId,
    });

    const threadSuffix = result.threadId
      ? `, "thread_id": "${result.threadId}"`
      : "";
    return ok(`Message sent (ID: ${result.id}${threadSuffix}).`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
