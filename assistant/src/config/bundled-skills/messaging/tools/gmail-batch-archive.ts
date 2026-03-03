import { batchModifyMessages } from "../../../../messaging/providers/gmail/client.js";
import { getMessagingProvider } from "../../../../messaging/registry.js";
import { withValidToken } from "../../../../security/token-manager.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { getSenderMessageIds } from "./scan-result-store.js";
import { err, ok } from "./shared.js";

const BATCH_MODIFY_LIMIT = 1000;

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!context.triggeredBySurfaceAction) {
    return err(
      "This tool requires user confirmation via a surface action. Present results in a selection table with action buttons and wait for the user to click before proceeding.",
    );
  }

  const scanId = input.scan_id as string | undefined;
  const senderIds = input.sender_ids as string[] | undefined;
  let messageIds = input.message_ids as string[] | undefined;

  // Resolve message IDs from scan store if scan_id is provided
  if (scanId && senderIds?.length) {
    const resolved = getSenderMessageIds(scanId, senderIds);
    if (!resolved) {
      return err(
        "Scan results have expired (30-minute window). Please re-run the scan to get fresh results.",
      );
    }
    messageIds = resolved;
  }

  if (!messageIds?.length) {
    return err(
      "Either message_ids or scan_id + sender_ids is required, and must resolve to at least one message.",
    );
  }

  try {
    const provider = getMessagingProvider("gmail");
    return withValidToken(provider.credentialService, async (token) => {
      for (let i = 0; i < messageIds.length; i += BATCH_MODIFY_LIMIT) {
        const chunk = messageIds.slice(i, i + BATCH_MODIFY_LIMIT);
        await batchModifyMessages(token, chunk, { removeLabelIds: ["INBOX"] });
      }
      return ok(`Archived ${messageIds.length} message(s).`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
