/**
 * Helper that creates, titles, and seeds a fresh conversation for the
 * conversation-launcher flow.
 *
 * Called from `handleSurfaceAction` when a persistent `ui_show` card fires a
 * `launch_conversation` action — the origin conversation's `TrustContext` is
 * forwarded so spawned conversations inherit guardian / trust class.
 *
 * The helper depends on DaemonServer state (conversation map,
 * `persistAndProcessMessage`, assistant ID, hub publisher) and is wired via
 * {@link registerLaunchConversationDeps} at daemon startup. Tests can stub
 * deps directly via the same registration.
 */

import { randomUUID } from "node:crypto";

import { updateConversationTitle } from "../memory/conversation-crud.js";
import { getOrCreateConversation as getOrCreateConversationKey } from "../memory/conversation-key-store.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getLogger } from "../util/logger.js";
import type { Conversation } from "./conversation.js";
import type { TrustContext } from "./conversation-runtime-assembly.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";
import type { ServerMessage } from "./message-protocol.js";

const log = getLogger("conversation-launch");

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
 * The seed turn (`persistAndProcessMessage`) runs **fire-and-forget** so this
 * helper returns as soon as the conversation is created, titled, and the
 * `open_conversation` event has been published. Callers driving a fan-out
 * UX (multiple launches from a single click) rely on this: blocking on the
 * full LLM turn would hold the HTTP request open for tens of seconds.
 * Errors from the seed turn are logged but not surfaced — the new
 * conversation still exists in the sidebar so the user can retry from there.
 *
 * Throws if the helper's daemon-side dependencies have not been registered
 * or if conversation creation / titling itself fails.
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
  // `handleSurfaceAction` passes the origin conversation's trustContext.
  if (params.originTrustContext) {
    conversation.setTrustContext(params.originTrustContext);
  }

  // Set the user-facing title immediately so clients that stub a sidebar
  // entry from the open_conversation event see the right label even before
  // the turn completes.
  if (params.title) {
    updateConversationTitle(conversationId, params.title, 0);
  }

  // Tell connected clients about the new conversation BEFORE kicking off the
  // seed turn so the sidebar entry appears instantly. We are the sole
  // emitter of `open_conversation` for this launch path — `handleSurfaceAction`
  // no longer publishes a second event. Pass through the caller-specified
  // `focus` so fan-out launchers can avoid stealing focus from the origin.
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
        ...(params.focus !== undefined ? { focus: params.focus } : {}),
      },
      conversationId,
    ),
  );

  // Seed the conversation by running the seed prompt through the same
  // pipeline POST /v1/messages uses. Publishing to the hub lets any
  // connected client stream the turn live. Fire-and-forget so callers
  // aren't blocked on the full LLM turn — errors are logged but swallowed.
  const hubSender = (msg: ServerMessage) => {
    const msgConversationId =
      "conversationId" in msg &&
      typeof (msg as { conversationId?: unknown }).conversationId === "string"
        ? (msg as { conversationId: string }).conversationId
        : undefined;
    deps.publishAssistantEvent(msg, msgConversationId ?? conversationId);
  };

  deps
    .persistAndProcessMessage(
      conversationId,
      params.seedPrompt,
      undefined,
      { onEvent: hubSender },
      "vellum",
      "cli",
    )
    .catch((err) => {
      log.error(
        { err, conversationId },
        "Seed turn failed for launched conversation (non-fatal)",
      );
    });

  return { conversationId };
}
