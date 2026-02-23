import * as net from 'node:net';
import type { ClientMessage } from '../ipc-protocol.js';
import { handleRideShotgunStart, handleRideShotgunStop } from '../ride-shotgun-handler.js';
import { handleWatchObservation } from '../watch-handler.js';
import { handleOpenBundle } from './open-bundle-handler.js';
import { log, defineHandlers, type HandlerContext, type DispatchMap } from './shared.js';

import { sessionHandlers } from './sessions.js';
import { skillHandlers } from './skills.js';
import { appHandlers } from './apps.js';
import { configHandlers } from './config.js';
import { computerUseHandlers } from './computer-use.js';
import { publishHandlers } from './publish.js';
import { homeBaseHandlers } from './home-base.js';
import { diagnosticsHandlers } from './diagnostics.js';
import { miscHandlers } from './misc.js';
import { documentHandlers } from './documents.js';
import { workItemHandlers } from './work-items.js';
import { subagentHandlers } from './subagents.js';
import { browserHandlers } from './browser.js';
import { signingHandlers } from './signing.js';
import { twitterAuthHandlers } from './twitter-auth.js';
import { workspaceFileHandlers } from './workspace-files.js';
import { identityHandlers } from './identity.js';
import { dictationHandlers } from './dictation.js';

// Re-export types and utilities for backwards compatibility
export type {
  HandlerContext,
  SessionCreateOptions,
  HistoryToolCall,
  HistorySurface,
  RenderedHistoryContent,
  ParsedHistoryMessage,
} from './shared.js';

export {
  renderHistoryContent,
  mergeToolResults,
} from './shared.js';

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
    log.warn({ sessionId: msg.sessionId, surfaceId: msg.surfaceId }, 'No session found for surface action');
  },
  ui_surface_undo: (msg, _socket, ctx) => {
    const session = ctx.sessions.get(msg.sessionId);
    if (session) {
      ctx.touchSession(msg.sessionId);
      session.handleSurfaceUndo(msg.surfaceId);
      return;
    }
    log.warn({ sessionId: msg.sessionId, surfaceId: msg.surfaceId }, 'No session found for surface undo');
  },

  // Stub handlers: the integration registry was removed but the Swift client
  // still sends these messages. Return safe no-op responses so the client
  // doesn't hang waiting for a reply.
  integration_list: (_msg, socket, ctx) => {
    ctx.send(socket, { type: 'integration_list_response', integrations: [] });
  },
  integration_connect: (msg, socket, ctx) => {
    ctx.send(socket, {
      type: 'integration_connect_result',
      integrationId: msg.integrationId,
      success: false,
      error: 'Please use chat to connect integrations.',
    });
  },
  integration_disconnect: () => { /* no-op — integration registry removed */ },

});

const handlers = {
  ...sessionHandlers,
  ...skillHandlers,
  ...appHandlers,
  ...configHandlers,
  ...computerUseHandlers,
  ...publishHandlers,
  ...homeBaseHandlers,
  ...diagnosticsHandlers,
  ...miscHandlers,
  ...documentHandlers,
  ...workItemHandlers,
  ...subagentHandlers,
  ...browserHandlers,
  ...signingHandlers,
  ...twitterAuthHandlers,
  ...workspaceFileHandlers,
  ...identityHandlers,
  ...dictationHandlers,
  ...inlineHandlers,
} satisfies DispatchMap;

export function handleMessage(
  msg: ClientMessage,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // 'auth' is handled at the transport layer and should never reach dispatch.
  if (msg.type === 'auth') return;

  const handler = handlers[msg.type] as
    | ((msg: ClientMessage, socket: net.Socket, ctx: HandlerContext) => void)
    | undefined;
  if (!handler) {
    log.warn({ type: msg.type }, 'Unknown message type, ignoring');
    return;
  }
  handler(msg, socket, ctx);
}
