/**
 * Helper that creates, titles, and seeds a fresh conversation for the
 * conversation-launcher flow.
 *
 * Called from `handleSurfaceAction` when a persistent `ui_show` card fires a
 * `launch_conversation` action — the origin conversation's `TrustContext` is
 * forwarded so spawned conversations inherit guardian / trust class.
 */

import { randomUUID } from "node:crypto";

import { updateConversationTitle } from "../memory/conversation-crud.js";
import { getOrCreateConversation as getOrCreateConversationKey } from "../memory/conversation-key-store.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import { getOrCreateConversation } from "./conversation-store.js";
import { processMessageInBackground } from "./process-message.js";
import type { TrustContext } from "./trust-context.js";

const log = getLogger("conversation-launch");

// ── Helper ──────────────────────────────────────────────────────────

export interface LaunchConversationParams {
  title: string;
  seedPrompt: string;
  anchorMessageId?: string;
  originTrustContext?: TrustContext;
  /**
   * Passed through to the `open_conversation` event. Defaults to omitted
   * (i.e. client-side default of `true`) so direct callers keep their
   * existing "jump to the new conversation" behavior. Set to `false` for
   * fan-out launchers that register the conversation in the sidebar but
   * must not steal focus from the origin.
   */
  focus?: boolean;
}

/**
 * Create, title, and seed a fresh conversation and notify connected clients
 * via an `open_conversation` event.
 *
 * If `originTrustContext` is provided, it is applied to the new conversation
 * before seeding so guardian / trust-class state is inherited from the
 * spawning context. When absent, the conversation runs without an inherited
 * trust context.
 *
 * The seed turn runs **fire-and-forget** so this helper returns as soon as
 * the conversation is created, titled, and the `open_conversation` event has
 * been published. Errors from the seed turn are logged but not surfaced.
 *
 * Throws if conversation creation / titling itself fails.
 */
export async function launchConversation(
  params: LaunchConversationParams,
): Promise<{ conversationId: string }> {
  if (!params.title || !params.seedPrompt) {
    throw new Error("launchConversation: title and seedPrompt are required");
  }

  const conversationKey = `launcher-${randomUUID()}`;
  const { conversationId } = getOrCreateConversationKey(conversationKey);

  const conversation = await getOrCreateConversation(conversationId);

  if (params.originTrustContext) {
    conversation.setTrustContext(params.originTrustContext);
  }

  if (params.title) {
    updateConversationTitle(conversationId, params.title, 0);
  }

  await assistantEventHub.publish(
    buildAssistantEvent(
      {
        type: "open_conversation",
        conversationId,
        ...(params.title ? { title: params.title } : {}),
        ...(params.anchorMessageId
          ? { anchorMessageId: params.anchorMessageId }
          : {}),
        ...(params.focus !== undefined ? { focus: params.focus } : {}),
      },
      conversationId,
    ),
  );

  processMessageInBackground(
    conversationId,
    params.seedPrompt,
    undefined,
    undefined,
    "vellum",
    "cli",
  ).catch((err) => {
    log.error(
      { err, conversationId },
      "Seed turn failed for launched conversation (non-fatal)",
    );
  });

  return { conversationId };
}
