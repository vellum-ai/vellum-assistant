import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { OutboundAttachment } from "../../../../messaging/provider-types.js";
import {
  createDraft,
  createDraftRaw,
  getProfile,
  getThread,
} from "../../../../messaging/providers/gmail/client.js";
import { buildMultipartMime } from "../../../../messaging/providers/gmail/mime-builder.js";
import {
  createDraft as createOutlookDraft,
  createReplyDraft as createOutlookReplyDraft,
  toOutlookFileAttachments,
} from "../../../../messaging/providers/outlook/client.js";
import type { OutlookDraftMessage } from "../../../../messaging/providers/outlook/types.js";
import {
  isProactivelyAddressable,
  sendChannelText,
} from "../../../../runtime/channel-send.js";
import {
  isAbortLikeError,
  throwIfCancelled,
} from "../../../../tools/shared/abort.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { guessMimeType } from "../../../../util/mime-type.js";
import {
  err,
  extractEmail,
  extractHeader,
  getProviderConnection,
  isMailboxAddress,
  ok,
  parseAddressList,
  resolveProvider,
} from "./shared.js";

/** Read attachment files from disk into in-memory parts for outbound sending. */
async function readAttachments(paths: string[]): Promise<OutboundAttachment[]> {
  return Promise.all(
    paths.map(async (filePath) => ({
      filename: basename(filePath),
      mimeType: guessMimeType(filePath),
      data: await readFile(filePath),
    })),
  );
}

/** Email providers that accept file attachments on outbound sends. */
const ATTACHMENT_CAPABLE_PLATFORMS = new Set(["gmail", "outlook"]);

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

  throwIfCancelled(context);

  try {
    // A channel whose transport can be addressed from a named chat is sent
    // through the transport, which is the one send implementation for that
    // channel, records what it sent, and reaches channels with no messaging
    // provider at all. A platform named outright is checked first; one
    // auto-detected from the connected providers is checked the same way.
    const namedChannel =
      platform && isProactivelyAddressable(platform) ? platform : undefined;
    const provider = namedChannel ? undefined : await resolveProvider(platform);
    const channel =
      namedChannel ??
      (provider && isProactivelyAddressable(provider.id)
        ? provider.id
        : undefined);

    if (channel) {
      if (attachmentPaths?.length) {
        return err("Attachments are only supported on Gmail and Outlook.");
      }
      // A channel's transport sends as the channel's one bot identity, so an
      // account cannot select where the send goes out from. Refusing is
      // safer than silently sending from the default account.
      if (input.account) {
        return err(
          `account does not apply to ${channel}: a channel send goes out as the channel's own bot.`,
        );
      }
      // Recheck: provider resolution above is an await, and this posts to
      // the channel.
      throwIfCancelled(context);
      const sent = await sendChannelText({
        channel,
        target: {
          kind: "chat",
          chatId: conversationId,
          ...(threadId ? { threadId } : {}),
        },
        text,
        renderRichly: true,
        assistantId: context.assistantId,
        sender: {
          conversationId: context.conversationId,
          executionChannel: context.executionChannel,
          requesterChatId: context.requesterChatId,
          sourceThreadId: context.sourceThreadId,
        },
      });
      const threadSuffix = sent.threadId
        ? `, "thread_id": "${sent.threadId}"`
        : "";
      return ok(`Message sent (ID: ${sent.lastMessageId}${threadSuffix}).`);
    }
    if (!provider) {
      throw new Error(`Messaging provider "${platform}" not found.`);
    }

    // Reject attachments on platforms that can't carry them.
    if (
      attachmentPaths?.length &&
      !ATTACHMENT_CAPABLE_PLATFORMS.has(provider.id)
    ) {
      return err("Attachments are only supported on Gmail and Outlook.");
    }

    const account = input.account as string | undefined;
    const conn = await getProviderConnection(provider, account);

    // Gmail: create a draft instead of sending directly
    if (provider.id === "gmail") {
      if (!conn) {
        return err(
          "Gmail requires an OAuth connection — is the account connected?",
        );
      }
      const gmailConn = conn;
      // Reply mode: thread_id provided - create a threaded draft with reply-all recipients
      if (threadId) {
        // Fetch thread messages directly via Threads API
        const thread = await getThread(gmailConn, threadId, "metadata", [
          "From",
          "To",
          "Cc",
          "Message-ID",
          "Subject",
        ]);
        const messages = thread.messages ?? [];
        if (!messages.length) {
          return err("No messages found in this thread.");
        }

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

        if (fromAddr) {
          allRecipients.add(fromAddr);
        }
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
          const attachments = await readAttachments(attachmentPaths);

          const raw = buildMultipartMime({
            to: toList.join(", "),
            subject: replySubject,
            body: text,
            inReplyTo: messageIdHeader || undefined,
            cc: ccList.length > 0 ? ccList.join(", ") : undefined,
            attachments,
          });
          // Recheck: the thread lookups and the attachment reads above are
          // awaits, and this creates a real mailbox draft.
          throwIfCancelled(context);
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

        // Recheck: the thread and profile lookups above are awaits, and this
        // creates a real mailbox draft.
        throwIfCancelled(context);
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
        const attachments = await readAttachments(attachmentPaths);

        const raw = buildMultipartMime({
          to: conversationId,
          subject: subject ?? "",
          body: text,
          inReplyTo,
          attachments,
        });
        // Recheck: the attachment reads above are awaits, and this creates a
        // real mailbox draft.
        throwIfCancelled(context);
        const draft = await createDraftRaw(gmailConn, raw, threadId);

        const filenames = attachments.map((a) => a.filename).join(", ");
        return ok(
          `Gmail draft created with ${attachments.length} attachment(s): ${filenames} (Draft ID: ${draft.id}). Review in Gmail Drafts, then tell me to send it or send it yourself.`,
        );
      }

      // Without attachments: use standard createDraft
      // Recheck: provider and connection resolution above are awaits, and
      // this creates a real mailbox draft.
      throwIfCancelled(context);
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

    // Outlook: create a Graph draft instead of sending. Recipients are
    // optional so a voice-composed email can land in Drafts before the user
    // names a To address.
    if (provider.id === "outlook") {
      if (!conn) {
        return err(
          "Outlook requires an OAuth connection. Is the account connected?",
        );
      }

      const attachments = attachmentPaths?.length
        ? await readAttachments(attachmentPaths)
        : undefined;
      const graphAttachments = attachments?.length
        ? toOutlookFileAttachments(attachments)
        : undefined;
      const toAddress = isMailboxAddress(conversationId)
        ? extractEmail(conversationId)
        : undefined;

      if (inReplyTo) {
        // Recheck: the attachment reads above are awaits, and this creates a
        // real mailbox draft.
        throwIfCancelled(context);
        const draft = await createOutlookReplyDraft(conn, inReplyTo, text);
        const recipientSummary = toAddress ? `To: ${toAddress}` : undefined;
        return ok(
          formatOutlookDraftCreated({
            draftId: draft.id,
            webLink: draft.webLink,
            recipientSummary,
            attachmentCount: attachments?.length,
            filenames: attachments?.map((a) => a.filename).join(", "),
          }),
        );
      }

      const draftBody: OutlookDraftMessage = {
        subject: subject ?? "",
        body: { contentType: "text", content: text },
        ...(toAddress
          ? { toRecipients: [{ emailAddress: { address: toAddress } }] }
          : {}),
        ...(graphAttachments ? { attachments: graphAttachments } : {}),
      };
      // Recheck: the attachment reads above are awaits, and this creates a
      // real mailbox draft.
      throwIfCancelled(context);
      const draft = await createOutlookDraft(conn, draftBody);
      const recipientSummary = toAddress ? `To: ${toAddress}` : undefined;
      return ok(
        formatOutlookDraftCreated({
          draftId: draft.id,
          webLink: draft.webLink,
          recipientSummary,
          attachmentCount: attachments?.length,
          filenames: attachments?.map((a) => a.filename).join(", "),
        }),
      );
    }

    // A provider with a send of its own and no direct transport (a plugin's,
    // for instance). Its send is tool-mediated and has no chat conversation
    // to record in.
    if (!provider.sendMessage) {
      return err(
        `${provider.displayName} cannot send from here: it has no send of its own and no channel transport to address.`,
      );
    }
    const attachments = attachmentPaths?.length
      ? await readAttachments(attachmentPaths)
      : undefined;
    throwIfCancelled(context);
    const result = await provider.sendMessage(conn, conversationId, text, {
      subject,
      inReplyTo,
      threadId,
      attachments,
      assistantId: context.assistantId,
    });

    const threadSuffix = result.threadId
      ? `, "thread_id": "${result.threadId}"`
      : "";
    return ok(`Message sent (ID: ${result.id}${threadSuffix}).`);
  } catch (e) {
    // A cancelled turn is not a send failure: let it reach the executor's
    // abort handling instead of being rendered as a tool error.
    if (isAbortLikeError(e)) {
      throw e;
    }
    return err(e instanceof Error ? e.message : String(e));
  }
}

function formatOutlookDraftCreated(opts: {
  draftId: string;
  webLink?: string;
  recipientSummary?: string;
  attachmentCount?: number;
  filenames?: string;
}): string {
  const attachmentBit =
    opts.attachmentCount && opts.filenames
      ? ` with ${opts.attachmentCount} attachment(s): ${opts.filenames}`
      : "";
  const recipientBit = opts.recipientSummary
    ? ` ${opts.recipientSummary}.`
    : " No recipient set. Open the draft in Outlook to add one.";
  const linkBit = opts.webLink ? ` Open it: ${opts.webLink}` : "";
  return `Outlook draft created${attachmentBit} (Draft ID: ${opts.draftId}).${recipientBit}${linkBit} Review it in your Outlook Drafts, then tell me to send it or send it yourself from Outlook.`;
}
