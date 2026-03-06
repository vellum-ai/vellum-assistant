import * as net from "node:net";

import {
  type Confidence,
  recordConversationSeenSignal,
  type SignalType,
} from "../../memory/conversation-attention-store.js";
import { updateDeliveryClientOutcome } from "../../notifications/deliveries-store.js";
import type { ClientMessage } from "../ipc-protocol.js";
import {
  handleRideShotgunStart,
  handleRideShotgunStop,
} from "../ride-shotgun-handler.js";
import { handleWatchObservation } from "../watch-handler.js";
import { appHandlers } from "./apps.js";
import { avatarHandlers } from "./avatar.js";
import { browserHandlers } from "./browser.js";
import { computerUseHandlers } from "./computer-use.js";
import { configHandlers } from "./config-dispatch.js";
import { inboxInviteHandlers } from "./config-inbox.js";
import { contactsHandlers } from "./contacts.js";
import { diagnosticsHandlers } from "./diagnostics.js";
import { dictationHandlers } from "./dictation.js";
import { documentHandlers } from "./documents.js";
import { guardianActionsHandlers } from "./guardian-actions.js";
import { homeBaseHandlers } from "./home-base.js";
import { identityHandlers } from "./identity.js";
import { miscHandlers } from "./misc.js";
import { oauthConnectHandlers } from "./oauth-connect.js";
import { handleOpenBundle } from "./open-bundle-handler.js";
import { pairingHandlers } from "./pairing.js";
import { publishHandlers } from "./publish.js";
import { recordingHandlers } from "./recording.js";
import { sessionHandlers } from "./sessions.js";
import {
  defineHandlers,
  type DispatchMap,
  type HandlerContext,
  log,
} from "./shared.js";
import { signingHandlers } from "./signing.js";
import { skillHandlers } from "./skills.js";
import { subagentHandlers } from "./subagents.js";
import { twitterAuthHandlers } from "./twitter-auth.js";
import { workItemHandlers } from "./work-items.js";
import { workspaceFileHandlers } from "./workspace-files.js";

// Re-export types and utilities for backwards compatibility
export { handleRecordingStart, handleRecordingStop } from "./recording.js";
export type {
  HandlerContext,
  HistorySurface,
  HistoryToolCall,
  ParsedHistoryMessage,
  RenderedHistoryContent,
  SessionCreateOptions,
} from "./shared.js";
export { mergeToolResults, renderHistoryContent } from "./shared.js";

// ─── Typed dispatch ──────────────────────────────────────────────────────────

// Inline handlers for messages not owned by any feature group
const inlineHandlers = defineHandlers({
  ride_shotgun_start: handleRideShotgunStart,
  ride_shotgun_stop: handleRideShotgunStop,
  watch_observation: handleWatchObservation,
  open_bundle: handleOpenBundle,

  ui_surface_action: (msg, _socket, ctx) => {
    const cuSession = ctx.cuSessions.get(msg.sessionId);
    if (cuSession) {
      cuSession.handleSurfaceAction(msg.surfaceId, msg.actionId, msg.data);
      return;
    }
    const session = ctx.sessions.get(msg.sessionId);
    if (session) {
      ctx.touchSession(msg.sessionId);
      session.handleSurfaceAction(msg.surfaceId, msg.actionId, msg.data);
      return;
    }
    log.warn(
      { sessionId: msg.sessionId, surfaceId: msg.surfaceId },
      "No session found for surface action",
    );
  },
  ui_surface_undo: (msg, _socket, ctx) => {
    const session = ctx.sessions.get(msg.sessionId);
    if (session) {
      ctx.touchSession(msg.sessionId);
      session.handleSurfaceUndo(msg.surfaceId);
      return;
    }
    log.warn(
      { sessionId: msg.sessionId, surfaceId: msg.surfaceId },
      "No session found for surface undo",
    );
  },

  // Stub handlers: the integration registry was removed but the Swift client
  // still sends these messages. Return safe no-op responses so the client
  // doesn't hang waiting for a reply.
  integration_list: (_msg, socket, ctx) => {
    ctx.send(socket, { type: "integration_list_response", integrations: [] });
  },
  integration_connect: (msg, socket, ctx) => {
    ctx.send(socket, {
      type: "integration_connect_result",
      integrationId: msg.integrationId,
      success: false,
      error: "Please use chat to connect integrations.",
    });
  },
  integration_disconnect: () => {
    /* no-op — integration registry removed */
  },

  // Client signal: user has seen a conversation (notification click, conversation open, etc.)
  conversation_seen_signal: (msg) => {
    try {
      recordConversationSeenSignal({
        conversationId: msg.conversationId,
        sourceChannel: msg.sourceChannel,
        signalType: msg.signalType as SignalType,
        confidence: msg.confidence as Confidence,
        source: msg.source,
        evidenceText: msg.evidenceText,
        metadata: msg.metadata,
        observedAt: msg.observedAt,
      });
    } catch (err) {
      log.error(
        { err, conversationId: msg.conversationId },
        "conversation_seen_signal: failed to record seen signal",
      );
    }
  },

  // Client ack for notification delivery outcome (UNUserNotificationCenter.add result).
  notification_intent_result: (msg) => {
    try {
      const updated = updateDeliveryClientOutcome(
        msg.deliveryId,
        msg.success,
        msg.errorMessage || msg.errorCode
          ? { code: msg.errorCode, message: msg.errorMessage }
          : undefined,
      );
      if (!updated) {
        log.warn(
          { deliveryId: msg.deliveryId },
          "notification_intent_result: no delivery row found for deliveryId",
        );
      }
    } catch (err) {
      log.error(
        { err, deliveryId: msg.deliveryId },
        "notification_intent_result: failed to persist client delivery outcome",
      );
    }
  },
});

const handlers = {
  ...sessionHandlers,
  ...skillHandlers,
  ...appHandlers,
  ...avatarHandlers,
  ...configHandlers,
  ...computerUseHandlers,
  ...publishHandlers,
  ...homeBaseHandlers,
  ...diagnosticsHandlers,
  ...miscHandlers,
  ...documentHandlers,
  ...guardianActionsHandlers,
  ...workItemHandlers,
  ...subagentHandlers,
  ...browserHandlers,
  ...signingHandlers,
  ...twitterAuthHandlers,
  ...oauthConnectHandlers,
  ...workspaceFileHandlers,
  ...identityHandlers,
  ...dictationHandlers,
  ...inboxInviteHandlers,
  ...contactsHandlers,
  ...pairingHandlers,
  ...recordingHandlers,
  ...inlineHandlers,
} satisfies DispatchMap;

export function handleMessage(
  msg: ClientMessage,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // 'auth' is handled at the transport layer and should never reach dispatch.
  if (msg.type === "auth") return;

  const handler = handlers[msg.type] as
    | ((
        msg: ClientMessage,
        socket: net.Socket,
        ctx: HandlerContext,
      ) => void | Promise<void>)
    | undefined;
  if (!handler) {
    log.warn({ type: msg.type }, "Unknown message type, ignoring");
    return;
  }
  // Handlers may be async — catch rejected promises so they don't become
  // unhandled rejections at the process level.
  const result = handler(msg, socket, ctx);
  if (result && typeof result.catch === "function") {
    result.catch((err: unknown) => {
      log.error(
        { err, type: msg.type },
        "Unhandled error in async message handler",
      );
    });
  }
}
