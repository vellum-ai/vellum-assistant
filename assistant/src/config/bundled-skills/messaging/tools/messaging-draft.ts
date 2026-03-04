import {
  createDraft,
  deleteDraft,
  listDrafts,
} from "../../../../messaging/draft-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const action = input.action as string;

  switch (action) {
    case "create": {
      const platform = input.platform as string | undefined;
      const conversationId = input.conversation_id as string | undefined;
      const text = input.text as string | undefined;

      if (!platform) return err("platform is required for creating a draft.");
      if (!conversationId)
        return err("conversation_id is required for creating a draft.");
      if (!text) return err("text is required for creating a draft.");

      const draft = createDraft({
        platform,
        conversationId,
        text,
        threadId: input.thread_id as string | undefined,
        subject: input.subject as string | undefined,
      });
      return ok(`Draft created (ID: ${draft.id}). Stored locally for review.`);
    }

    case "list": {
      const platform = input.platform as string | undefined;
      if (!platform) return err("platform is required for listing drafts.");
      const drafts = listDrafts(platform);
      if (drafts.length === 0) return ok("No drafts found.");
      return ok(JSON.stringify(drafts, null, 2));
    }

    case "delete": {
      const draftId = input.draft_id as string | undefined;
      const platform = input.platform as string | undefined;
      if (!draftId) return err("draft_id is required for deleting a draft.");
      if (!platform) return err("platform is required for deleting a draft.");
      const deleted = deleteDraft(platform, draftId);
      if (!deleted) return err("Draft not found.");
      return ok("Draft deleted.");
    }

    default:
      return err(
        `Unknown action "${action}". Use "create", "list", or "delete".`,
      );
  }
}
