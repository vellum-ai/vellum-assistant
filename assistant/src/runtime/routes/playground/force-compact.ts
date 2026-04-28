/**
 * POST /v1/conversations/:id/playground/compact
 *
 * Force-compact a conversation (dev-only playground). Wraps
 * `Conversation.forceCompact()` and returns the pre/post prompt-token
 * estimates plus the summary metadata so the playground UI can display
 * the delta.
 *
 * Guarded by `assertPlaygroundEnabled` — returns 404 when the
 * `compaction-playground` feature flag is off.
 */

import { estimatePromptTokens } from "../../../context/token-estimator.js";
import { ConflictError } from "../errors.js";
import type { RouteDefinition } from "../types.js";
import { throwConversationNotFound } from "./conversation-not-found.js";
import { assertPlaygroundEnabled } from "./guard.js";
import { getConversationById } from "./helpers.js";

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "playgroundForceCompact",
    endpoint: "conversations/:id/playground/compact",
    method: "POST",
    policyKey: "conversations/playground/compact",
    summary: "Force compaction on a conversation (dev-only playground)",
    tags: ["playground"],
    pathParams: [{ name: "id", type: "uuid" }],
    handler: async ({ pathParams }) => {
      assertPlaygroundEnabled();

      const id = pathParams!.id;
      const conversation = await getConversationById(id);
      if (!conversation) {
        throwConversationNotFound(id);
      }

      if (conversation.processing) {
        throw new ConflictError(
          "Compaction already in progress for this conversation",
        );
      }

      const messagesBefore = conversation.getMessages();
      const previousTokens = estimatePromptTokens(messagesBefore);
      const result = await conversation.forceCompact();
      const messagesAfter = conversation.getMessages();
      const newTokens = estimatePromptTokens(messagesAfter);

      return {
        compacted: result.compacted,
        previousTokens,
        newTokens,
        summaryText: result.summaryText ?? null,
        messagesRemoved: result.compactedPersistedMessages ?? 0,
        summaryFailed: result.summaryFailed ?? null,
      };
    },
  },
];
