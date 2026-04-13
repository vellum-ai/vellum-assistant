/**
 * Helper that creates, titles, and seeds a fresh conversation for the
 * conversation-launcher flow.
 *
 * Extracted from the `registerLaunchConversationCallback` body in
 * {@link file:./server.ts}. Callers include:
 *
 *   - The launch-conversation signal handler (no origin trust context).
 *   - `handleSurfaceAction` (future caller — will pass the origin
 *     conversation's `TrustContext` so spawned conversations inherit
 *     guardian / trust class).
 *
 * The helper depends on DaemonServer state (conversation map,
 * `persistAndProcessMessage`, assistant ID, hub publisher) and is wired via
 * {@link registerLaunchConversationDeps} at daemon startup — mirroring the
 * callback-registration pattern used by `signals/launch-conversation.ts` and
 * friends. Tests can stub deps directly via the same registration.
 */

import { randomUUID } from "node:crypto";

import { updateConversationTitle } from "../memory/conversation-crud.js";
import { getOrCreateConversation as getOrCreateConversationKey } from "../memory/conversation-key-store.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import type { Conversation } from "./conversation.js";
import type { TrustContext } from "./conversation-runtime-assembly.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";
import type { ServerMessage } from "./message-protocol.js";

// ── Dependency registry ─────────────────────────────────────────────

export interface LaunchConversationDeps {
  /**
   * Return the live {@link Conversation} instance for the given id,
   * creating + hydrating it if necessary. Wraps `DaemonServer.getOrCreateConversation`.
   */
  getOrCreateConversation: (
    conversationId: string,
    options?: ConversationCreateOptions,
  ) => Promise<Conversation>;
  /**
   * Persist the seed message and run the agent loop. Wraps
   * `DaemonServer.persistAndProcessMessage`.
   */
  persistAndProcessMessage: (
    conversationId: string,
    content: string,
    attachmentIds?: string[],
    options?: ConversationCreateOptions,
    sourceChannel?: string,
    sourceInterface?: string,
  ) => Promise<{ messageId: string }>;
  /**
   * Forward a `ServerMessage` to the process-level assistant event hub.
   * Wraps `DaemonServer.publishAssistantEvent`.
   */
  publishAssistantEvent: (
    msg: ServerMessage,
    conversationId?: string,
  ) => void;
  /** Assistant id to stamp onto the `open_conversation` event. */
  getAssistantId: () => string | undefined;
}

let _deps: LaunchConversationDeps | null = null;

/**
 * Register the daemon-side dependencies the helper needs. Called once by
 * `DaemonServer.start()` and (in tests) by unit tests that exercise
 * {@link launchConversation} directly.
 */
export function registerLaunchConversationDeps(
  deps: LaunchConversationDeps,
): void {
  _deps = deps;
}

// ── Helper ──────────────────────────────────────────────────────────

export interface LaunchConversationParams {
  title: string;
  seedPrompt: string;
  anchorMessageId?: string;
  originTrustContext?: TrustContext;
}

/**
 * Create, title, and seed a fresh conversation and notify connected clients
 * via an `open_conversation` event.
 *
 * If `originTrustContext` is provided, it is applied to the new conversation
 * before seeding so guardian / trust-class state is inherited from the
 * spawning context. When absent, the conversation runs without an inherited
 * trust context — the same behavior as the legacy signal-driven path.
 *
 * Throws if the helper's daemon-side dependencies have not been registered
 * or if any step of the pipeline fails.
 */
export async function launchConversation(
  params: LaunchConversationParams,
): Promise<{ conversationId: string }> {
  if (!_deps) {
    throw new Error(
      "launchConversation dependencies not registered — daemon may not be ready",
    );
  }
  const deps = _deps;

  // Each launch gets a globally unique conversation key so the skill always
  // creates a fresh conversation rather than reusing any prior mapping.
  // `getOrCreateConversation` will insert a new row.
  const conversationKey = `launcher-${randomUUID()}`;
  const { conversationId } = getOrCreateConversationKey(conversationKey);

  // Hydrate the live Conversation instance so we can apply trust context
  // before the seed turn begins. persistAndProcessMessage will reuse this
  // instance from the conversations map.
  const conversation = await deps.getOrCreateConversation(conversationId);

  // Inherit guardian / trust-class state from the caller when available.
  // The signal-driven callsite passes undefined; the handleSurfaceAction
  // callsite (PR 5) passes the origin conversation's trustContext.
  if (params.originTrustContext) {
    conversation.setTrustContext(params.originTrustContext);
  }

  // Set the user-facing title immediately so clients that stub a sidebar
  // entry from the open_conversation event see the right label even before
  // the turn completes.
  if (params.title) {
    updateConversationTitle(conversationId, params.title, 0);
  }

  // Seed the conversation by running the seed prompt through the same
  // pipeline POST /v1/messages uses. Publishing to the hub lets any
  // connected client stream the turn live.
  const hubSender = (msg: ServerMessage) => {
    const msgConversationId =
      "conversationId" in msg &&
      typeof (msg as { conversationId?: unknown }).conversationId === "string"
        ? (msg as { conversationId: string }).conversationId
        : undefined;
    deps.publishAssistantEvent(msg, msgConversationId ?? conversationId);
  };

  await deps.persistAndProcessMessage(
    conversationId,
    params.seedPrompt,
    undefined,
    { onEvent: hubSender },
    "vellum",
    "cli",
  );

  // Tell connected clients to focus the new conversation. The client stubs
  // a sidebar entry from the optional title if the conversation isn't
  // already in its list.
  await assistantEventHub.publish(
    buildAssistantEvent(
      deps.getAssistantId() ?? DAEMON_INTERNAL_ASSISTANT_ID,
      {
        type: "open_conversation",
        conversationId,
        title: params.title,
        ...(params.anchorMessageId
          ? { anchorMessageId: params.anchorMessageId }
          : {}),
      },
      conversationId,
    ),
  );

  return { conversationId };
}
