import { sendDraft } from "../../../../messaging/providers/outlook/client.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const draftId = input.draft_id as string;
  if (!draftId) return err("draft_id is required.");

  if (!context.triggeredBySurfaceAction && !context.approvedViaPrompt) {
    return err(
      "This tool requires user confirmation via a surface action. Present the draft details with a send button and wait for the user to click before proceeding.",
    );
  }

  try {
    const connection = await resolveOAuthConnection("outlook", {
      account,
    });
    await sendDraft(connection, draftId);
    return ok("Draft sent.");
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
