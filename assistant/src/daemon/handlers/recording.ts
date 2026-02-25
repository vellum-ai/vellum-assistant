import * as net from 'node:net';
import { v4 as uuid } from 'uuid';
import type { RecordingStatus, RecordingOptions } from '../ipc-protocol.js';
import { log, findSocketForSession, defineHandlers, type HandlerContext } from './shared.js';

// ─── Deterministic maps ──────────────────────────────────────────────────────
// These ensure stop resolves the exact active recording for a conversation,
// prevent ambiguous cross-thread stop behavior, and maintain conversation
// linkage for future file attachment (M4).

/** Maps recordingId -> conversationId. */
const standaloneRecordingConversationId = new Map<string, string>();

/** Maps conversationId -> recordingId (active recording). */
const recordingOwnerByConversation = new Map<string, string>();

// ─── Start ───────────────────────────────────────────────────────────────────

/**
 * Initiate a standalone recording for a conversation.
 * Generates a unique recording ID, stores deterministic mappings, and sends
 * a `recording_start` message to the client.
 */
export function handleRecordingStart(
  conversationId: string,
  options: RecordingOptions | undefined,
  socket: net.Socket,
  ctx: HandlerContext,
): string {
  const recordingId = uuid();

  standaloneRecordingConversationId.set(recordingId, conversationId);
  recordingOwnerByConversation.set(conversationId, recordingId);

  ctx.send(socket, {
    type: 'recording_start',
    recordingId,
    attachToConversationId: conversationId,
    options,
  });

  log.info({ recordingId, conversationId }, 'Standalone recording started');
  return recordingId;
}

// ─── Stop ────────────────────────────────────────────────────────────────────

/**
 * Stop the active standalone recording for a conversation.
 * Looks up the recording ID from `recordingOwnerByConversation` and sends
 * a `recording_stop` message to the client.
 *
 * Returns the recording ID if a stop was sent, or `undefined` if no active
 * recording was found for the conversation.
 */
export function handleRecordingStop(
  conversationId: string,
  ctx: HandlerContext,
): string | undefined {
  const recordingId = recordingOwnerByConversation.get(conversationId);
  if (!recordingId) {
    log.debug({ conversationId }, 'No active standalone recording to stop for conversation');
    return undefined;
  }

  // Look up the socket currently bound to the conversation so we can send
  // the stop command to the correct client connection.
  const socket = findSocketForSession(conversationId, ctx);
  if (!socket) {
    log.warn({ conversationId, recordingId }, 'Cannot send recording_stop: no socket bound to conversation');
    return undefined;
  }

  ctx.send(socket, {
    type: 'recording_stop',
    recordingId,
  });

  log.info({ recordingId, conversationId }, 'Standalone recording stop sent');
  return recordingId;
}

// ─── Status (client → server lifecycle updates) ─────────────────────────────

function handleRecordingStatus(
  msg: RecordingStatus,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  const recordingId = msg.sessionId;
  const conversationId = standaloneRecordingConversationId.get(recordingId)
    ?? msg.attachToConversationId;

  switch (msg.status) {
    case 'started':
      log.info({ recordingId, conversationId }, 'Standalone recording confirmed started by client');
      break;

    case 'stopped': {
      log.info(
        { recordingId, conversationId, filePath: msg.filePath, durationMs: msg.durationMs },
        'Standalone recording stopped — file ready',
      );
      // Clean up deterministic maps. Full finalization (attaching the file
      // to the conversation as a message) is M4 scope.
      standaloneRecordingConversationId.delete(recordingId);
      if (conversationId) {
        const current = recordingOwnerByConversation.get(conversationId);
        if (current === recordingId) {
          recordingOwnerByConversation.delete(conversationId);
        }
      }
      break;
    }

    case 'failed': {
      log.warn(
        { recordingId, conversationId, error: msg.error },
        'Standalone recording failed',
      );
      standaloneRecordingConversationId.delete(recordingId);
      if (conversationId) {
        const current = recordingOwnerByConversation.get(conversationId);
        if (current === recordingId) {
          recordingOwnerByConversation.delete(conversationId);
        }
      }
      break;
    }
  }
}

// ─── Export handler group ────────────────────────────────────────────────────

export const recordingHandlers = defineHandlers({
  recording_status: handleRecordingStatus,
});
