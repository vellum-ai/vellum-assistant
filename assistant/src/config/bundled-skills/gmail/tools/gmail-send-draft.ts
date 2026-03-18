import { sendDraft } from "../../../../messaging/providers/gmail/client.js";
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
  const draftId = input.draft_id as string;
  if (!draftId) return err("draft_id is required.");

  try {
    const connection = await resolveOAuthConnection("integration:google", {
      account,
    });
    const msg = await sendDraft(connection, draftId);
    return ok(`Draft sent (Message ID: ${msg.id}).`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
