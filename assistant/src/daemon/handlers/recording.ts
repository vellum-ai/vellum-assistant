import * as net from 'node:net';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { v4 as uuid } from 'uuid';
import type { RecordingStatus, RecordingOptions } from '../ipc-protocol.js';
import { log, findSocketForSession, defineHandlers, type HandlerContext } from './shared.js';
import * as conversationStore from '../../memory/conversation-store.js';
import { uploadFileBackedAttachment, linkAttachmentToMessage } from '../../memory/attachments-store.js';

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
  const existingRecordingId = recordingOwnerByConversation.get(conversationId);
  if (existingRecordingId) {
    log.warn({ conversationId, existingRecordingId }, 'Recording already active for conversation');
    ctx.send(socket, {
      type: 'assistant_text_delta',
      text: 'A recording is already active.',
      sessionId: conversationId,
    });
    ctx.send(socket, { type: 'message_complete', sessionId: conversationId });
    return existingRecordingId;
  }

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
    standaloneRecordingConversationId.delete(recordingId);
    recordingOwnerByConversation.delete(conversationId);
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
  ctx: HandlerContext,
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

      // Finalize: attach the recording file to the conversation
      if (msg.filePath) {
        try {
          if (!existsSync(msg.filePath)) {
            log.error({ recordingId, filePath: msg.filePath }, 'Recording file does not exist');
          } else if (!conversationId) {
            log.warn({ recordingId }, 'No conversationId found for recording — cannot link attachment');
          } else {
            const stat = statSync(msg.filePath);
            const sizeBytes = stat.size;
            const filename = path.basename(msg.filePath);

            // Infer MIME type from extension
            const ext = filename.split('.').pop()?.toLowerCase();
            const mimeType = ext === 'mov' ? 'video/quicktime' : ext === 'mp4' ? 'video/mp4' : 'video/mp4';

            // Store as file-backed attachment (avoids reading large files into memory)
            const attachment = uploadFileBackedAttachment(filename, mimeType, msg.filePath, sizeBytes);
            log.info({ recordingId, attachmentId: attachment.id, sizeBytes, filePath: msg.filePath }, 'Created attachment for standalone recording');

            // Find or create an assistant message to attach the recording to
            const existingMessages = conversationStore.getMessages(conversationId);
            const lastAssistantMsg = [...existingMessages].reverse().find((m) => m.role === 'assistant');

            let messageId: string;
            if (lastAssistantMsg) {
              messageId = lastAssistantMsg.id;
            } else {
              const newMsg = conversationStore.addMessage(
                conversationId,
                'assistant',
                JSON.stringify([{ type: 'text', text: 'Screen recording attached.' }]),
              );
              messageId = newMsg.id;
              log.info({ recordingId, conversationId, messageId }, 'Created assistant message for recording attachment');
            }

            linkAttachmentToMessage(messageId, attachment.id, 0);
            log.info({ recordingId, messageId, attachmentId: attachment.id }, 'Linked recording attachment to assistant message');

            // Notify the client
            const socket = findSocketForSession(conversationId, ctx);
            if (socket) {
              ctx.send(socket, {
                type: 'assistant_text_delta',
                text: 'Screen recording complete. Your recording has been saved.',
                sessionId: conversationId,
              });
              ctx.send(socket, {
                type: 'message_complete',
                sessionId: conversationId,
                attachments: [{
                  id: attachment.id,
                  filename: attachment.originalFilename,
                  mimeType: attachment.mimeType,
                  data: '',  // empty for file-backed; client uses content endpoint
                  sizeBytes: attachment.sizeBytes,
                }],
              });
            }
          }
        } catch (err) {
          log.error({ err, recordingId, filePath: msg.filePath }, 'Failed to create attachment for standalone recording');
          // Notify the client about the finalization failure
          if (conversationId) {
            const errSocket = findSocketForSession(conversationId, ctx);
            if (errSocket) {
              ctx.send(errSocket, {
                type: 'assistant_text_delta',
                text: 'Recording saved but failed to attach to conversation.',
                sessionId: conversationId,
              });
              ctx.send(errSocket, { type: 'message_complete', sessionId: conversationId });
            }
          }
        }
      }

      // Clean up deterministic maps
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

      // Notify the client about the failure
      if (conversationId) {
        const socket = findSocketForSession(conversationId, ctx);
        if (socket) {
          ctx.send(socket, {
            type: 'assistant_text_delta',
            text: `Recording failed: ${msg.error ?? 'unknown error'}`,
            sessionId: conversationId,
          });
          ctx.send(socket, {
            type: 'message_complete',
            sessionId: conversationId,
          });
        }
      }

      // Clean up deterministic maps
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
