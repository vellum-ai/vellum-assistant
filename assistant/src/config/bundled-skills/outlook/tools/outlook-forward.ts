import { createForwardDraft } from "../../../../messaging/providers/outlook/client.js";
import type { OutlookRecipient } from "../../../../messaging/providers/outlook/types.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

function toRecipients(csv: string): OutlookRecipient[] {
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
  const messageId = input.message_id as string;
  const to = input.to as string;
  const comment = input.comment as string | undefined;

  if (!messageId) return err("message_id is required.");
  if (!to) return err("to is required.");

  try {
    const connection = await resolveOAuthConnection("outlook", {
      account,
    });

    const toRecipientsList = toRecipients(to);
    const draft = await createForwardDraft(
      connection,
      messageId,
      toRecipientsList,
      comment,
    );

    return ok(
      `Forward draft created (ID: ${draft.id}). Review in Outlook Drafts, then tell me to send it.`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
