/**
 * Auxiliary message injection for proactive artifacts.
 *
 * Injects an assistant message into a conversation without going through
 * the normal agent loop. Defers injection while the conversation is
 * actively processing to preserve chronological message ordering.
 */

import { createAssistantMessage } from "../agent/message-types.js";
import { findConversation } from "../daemon/conversation-registry.js";
import {
  conversationMessagesSyncTag,
  SYNC_TAGS,
} from "../daemon/message-types/sync.js";
import { addMessage } from "../memory/conversation-crud.js";
import type { BroadcastFn } from "../notifications/adapters/macos.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("aux-message-injector");
const IDLE_POLL_MS = 200;
const IDLE_TIMEOUT_MS = 60_000;

async function waitForIdle(conversationId: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < IDLE_TIMEOUT_MS) {
    const conv = findConversation(conversationId);
    if (!conv || !conv.isProcessing()) return true;
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
  }
  return false;
}

export async function injectAuxAssistantMessage(params: {
  conversationId: string;
  text: string;
  broadcastMessage: BroadcastFn;
}): Promise<void> {
  const conv = findConversation(params.conversationId);
  if (conv?.isProcessing()) {
    const reachedIdle = await waitForIdle(params.conversationId);
    if (!reachedIdle) {
      log.warn(
        { conversationId: params.conversationId },
        "Timed out waiting for conversation idle; injecting anyway",
      );
    }
  }

  const msg = await addMessage(
    params.conversationId,
    "assistant",
    JSON.stringify([{ type: "text", text: params.text }]),
    { skipIndexing: true },
  );

  const current = findConversation(params.conversationId);
  if (current && !current.isProcessing()) {
    current.getMessages().push(createAssistantMessage(params.text));

    params.broadcastMessage({
      type: "assistant_text_delta",
      text: params.text,
      conversationId: params.conversationId,
    });
    params.broadcastMessage({
      type: "message_complete",
      conversationId: params.conversationId,
      messageId: msg.id,
      source: "aux",
    });
  }

  // The injected aux message bumps `lastMessageAt`, which can move the
  // row in the paginated sidebar window — that's a shape change. macOS
  // refreshes its full list on `conversation_list_invalidated`; web
  // refreshes via the paired `sync_changed` `conversationsList` tag.
  //
  // TODO(electron-cutover): drop the `conversation_list_invalidated`
  // emission once macOS migrates to the Electron client and consumes
  // `sync_changed` directly. See `runtime/sync/resource-sync-events.ts`
  // for the symmetric helper used by route handlers.
  params.broadcastMessage(
    {
      type: "conversation_list_invalidated",
      reason: "reordered",
    },
    undefined,
    { targetInterfaceId: "macos" },
  );
  params.broadcastMessage({
    type: "sync_changed",
    tags: [
      SYNC_TAGS.conversationsList,
      conversationMessagesSyncTag(params.conversationId),
    ],
  });
}
