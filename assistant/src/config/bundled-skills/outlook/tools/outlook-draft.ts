import {
  createDraft,
  createReplyDraft,
  patchMessage,
} from "../../../../messaging/providers/outlook/client.js";
import type { OutlookRecipient } from "../../../../messaging/providers/outlook/types.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

function toRecipients(csv: string | undefined): OutlookRecipient[] | undefined {
  if (!csv) return undefined;
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const to = input.to as string;
  const subject = input.subject as string;
  const body = input.body as string;
  const inReplyTo = input.in_reply_to as string | undefined;
  const cc = input.cc as string | undefined;
  const bcc = input.bcc as string | undefined;

  if (!to) return err("to is required.");
  if (!subject) return err("subject is required.");
  if (!body) return err("body is required.");

  try {
    const connection = await resolveOAuthConnection("outlook", {
      account,
    });

    if (inReplyTo) {
      // Create a reply draft, then optionally patch recipients
      const draft = await createReplyDraft(connection, inReplyTo, body);

      const toList = toRecipients(to);
      const ccList = toRecipients(cc);
      const bccList = toRecipients(bcc);

      const patch: Record<string, unknown> = {};
      if (toList) patch.toRecipients = toList;
      if (ccList) patch.ccRecipients = ccList;
      if (bccList) patch.bccRecipients = bccList;

      if (Object.keys(patch).length > 0) {
        await patchMessage(connection, draft.id, patch);
      }

      return ok(
        `Draft created (ID: ${draft.id}). It will appear in your Outlook Drafts folder. Tell me to send it when ready.`,
      );
    }

    const toRecipientsList = toRecipients(to) ?? [];
    const ccRecipientsList = toRecipients(cc);
    const bccRecipientsList = toRecipients(bcc);

    const draft = await createDraft(connection, {
      subject,
      body: { contentType: "text", content: body },
      toRecipients: toRecipientsList,
      ccRecipients: ccRecipientsList,
      bccRecipients: bccRecipientsList,
    });

    return ok(
      `Draft created (ID: ${draft.id}). It will appear in your Outlook Drafts folder. Tell me to send it when ready.`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
