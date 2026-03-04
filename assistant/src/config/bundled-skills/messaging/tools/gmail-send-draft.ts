import { sendDraft } from "../../../../messaging/providers/gmail/client.js";
import { getMessagingProvider } from "../../../../messaging/registry.js";
import { withValidToken } from "../../../../security/token-manager.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const draftId = input.draft_id as string;
  if (!draftId) return err("draft_id is required.");

  try {
    const provider = getMessagingProvider("gmail");
    return withValidToken(provider.credentialService, async (token) => {
      const msg = await sendDraft(token, draftId);
      return ok(`Draft sent (Message ID: ${msg.id}).`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
