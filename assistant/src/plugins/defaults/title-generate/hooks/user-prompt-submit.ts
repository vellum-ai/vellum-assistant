/**
 * Default `user-prompt-submit` hook: kicks off conversation-title generation
 * from the submitted prompt.
 *
 * Title generation is a self-contained side effect that only needs the user's
 * prompt as context, so it belongs at the prompt-submit boundary rather than
 * threaded through the agent loop. The hook is a pure trigger — it schedules
 * the work and returns; persistence and the resulting
 * `conversation_title_updated` / `sync_changed` broadcast are owned by the
 * title service (see `memory/conversation-title-service.ts`).
 */

import type {
  PluginHookFn,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import { getConversation } from "../../../../memory/conversation-crud.js";
import { queueGenerateConversationTitle } from "../../../../memory/conversation-title-service.js";

const userPromptSubmit: PluginHookFn<UserPromptSubmitContext> = async (ctx) => {
  // System conversations (background/scheduled) carry a deterministic title
  // from bootstrap. Their own job prompts arrive as non-interactive turns and
  // must not spend an LLM call on a title nobody reads — only a genuine user
  // message (interactive turn) upgrades the deterministic title to a
  // generated one. The lookup fails open: on a read error the hook behaves
  // as before (queues generation; the service re-checks replaceability).
  if (ctx.isNonInteractive) {
    try {
      const conversation = getConversation(ctx.conversationId);
      if (conversation && conversation.conversationType !== "standard") return;
    } catch {
      // Fall through to queueing.
    }
  }

  // Deferred to a later macrotask so the main agent-loop LLM request is
  // issued first; on strict single-slot provider configs this keeps the
  // background title call from claiming the rate-limit slot ahead of the
  // user-visible response. The title service is itself fire-and-forget and
  // re-checks title replaceability before making any LLM call, so an
  // already-titled conversation incurs no generation.
  setTimeout(() => {
    queueGenerateConversationTitle({
      conversationId: ctx.conversationId,
      userMessage: ctx.prompt,
    });
  }, 0);
};

export default userPromptSubmit;
