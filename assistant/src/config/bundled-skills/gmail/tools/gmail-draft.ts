import {
  createDraft,
  getMessage,
} from "../../../../messaging/providers/gmail/client.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const to = input.to as string;
  const subject = input.subject as string;
  const body = input.body as string;
  const inReplyTo = input.in_reply_to as string | undefined;
  const threadId = input.thread_id as string | undefined;
  const cc = input.cc as string | undefined;
  const bcc = input.bcc as string | undefined;

  if (!to) return err("to is required.");
  if (!subject) return err("subject is required.");
  if (!body) return err("body is required.");

  try {
    const connection = await resolveOAuthConnection("google", {
      account,
    });

    // Auto-resolve: if in_reply_to looks like a Gmail message ID (not an RFC 822
    // Message-ID), fetch the real header so threading works transparently.
    let resolvedInReplyTo = inReplyTo;
    if (inReplyTo && !inReplyTo.startsWith("<")) {
      const msg = await getMessage(connection, inReplyTo, "metadata", [
        "Message-ID",
      ]);
      const rfc822Id = msg.payload?.headers?.find(
        (h) => h.name.toLowerCase() === "message-id",
      )?.value;
      if (rfc822Id) {
        resolvedInReplyTo = rfc822Id;
      }
    }

    const draft = await createDraft(
      connection,
      to,
      subject,
      body,
      resolvedInReplyTo,
      cc,
      bcc,
      threadId,
    );
    return ok(
      `Draft created (ID: ${draft.id}). It will appear in your Gmail Drafts.`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
