import * as net from 'node:net';
import { existsSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { v4 as uuid } from 'uuid';
import type { RecordingStatus, RecordingOptions } from '../ipc-protocol.js';
import { log, findSocketForSession, defineHandlers, type HandlerContext } from './shared.js';
import * as conversationStore from '../../memory/conversation-store.js';
import { uploadFileBackedAttachment, linkAttachmentToMessage } from '../../memory/attachments-store.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** How long to wait (ms) for a client to acknowledge a recording_stop before
 *  automatically cleaning up stale map entries. Prevents a missing client ack
 *  from permanently blocking all future recordings. */
const STOP_ACK_TIMEOUT_MS = 30_000;

// ─── Deterministic maps ──────────────────────────────────────────────────────
// These ensure stop resolves the exact active recording for a conversation,
// prevent ambiguous cross-thread stop behavior, and maintain conversation
// linkage for future file attachment (M4).

/** Maps recordingId -> conversationId. */
const standaloneRecordingConversationId = new Map<string, string>();

/** Maps conversationId -> recordingId (active recording). */
const recordingOwnerByConversation = new Map<string, string>();

/** Pending stop-acknowledgement timeouts keyed by recordingId. */
const pendingStopTimeouts = new Map<string, NodeJS.Timeout>();

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
): string | null {
  const existingRecordingId = recordingOwnerByConversation.get(conversationId);
  if (existingRecordingId) {
    log.warn({ conversationId, existingRecordingId }, 'Recording already active for conversation');
    return null;
  }

  // Global single-active guard: only one recording at a time
  if (recordingOwnerByConversation.size > 0) {
    const [activeConv, activeRec] = [...recordingOwnerByConversation.entries()][0];
    log.warn({ conversationId, activeConversationId: activeConv, activeRecordingId: activeRec }, 'Recording already active globally');
    return null;
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
 * Stop the active standalone recording.
 * First checks if the given conversation owns a recording; if not, falls back
 * to the globally active recording (since only one can be active at a time).
 * This allows users to stop a recording from a different conversation than
 * the one that started it.
 *
 * Returns the recording ID if a stop was sent, or `undefined` if no active
 * recording exists.
 */
export function handleRecordingStop(
  conversationId: string,
  ctx: HandlerContext,
): string | undefined {
  let recordingId = recordingOwnerByConversation.get(conversationId);
  let ownerConversationId = conversationId;

  // Global fallback: since only one recording can be active at a time,
  // resolve globally if the current conversation doesn't own a recording.
  if (!recordingId && recordingOwnerByConversation.size > 0) {
    const [activeConv, activeRec] = [...recordingOwnerByConversation.entries()][0];
    recordingId = activeRec;
    ownerConversationId = activeConv;
    log.info({ conversationId, ownerConversationId, resolvedRecordingId: recordingId }, 'Resolved stop to globally active recording');
  }

  if (!recordingId) {
    log.debug({ conversationId }, 'No active standalone recording to stop');
    return undefined;
  }

  // Look up the socket currently bound to the owning conversation so we can
  // send the stop command to the correct client connection.
  const socket = findSocketForSession(ownerConversationId, ctx)
    ?? findSocketForSession(conversationId, ctx);
  if (!socket) {
    // Keep maps intact so the recording can be stopped later when a socket
    // reconnects. Cleaning up here would orphan the client-side recording
    // (still running) while the daemon thinks no recording is active.
    log.warn({ conversationId, ownerConversationId, recordingId }, 'Cannot send recording_stop: no socket bound to conversation — keeping state for retry');
    return undefined;
  }

  ctx.send(socket, {
    type: 'recording_stop',
    recordingId,
  });

  // Start a timeout so that if the client never acknowledges the stop (e.g.
  // client bug, app freeze), we automatically clean up the maps and unblock
  // future recordings.
  const timeoutHandle = setTimeout(() => {
    pendingStopTimeouts.delete(recordingId);
    log.warn({ recordingId, conversationId: ownerConversationId, timeoutMs: STOP_ACK_TIMEOUT_MS }, 'Stop-acknowledgement timeout fired — cleaning up stale recording state');
    cleanupMaps(recordingId, ownerConversationId);
  }, STOP_ACK_TIMEOUT_MS);
  pendingStopTimeouts.set(recordingId, timeoutHandle);

  log.info({ recordingId, conversationId }, 'Standalone recording stop sent');
  return recordingId;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Cancel a pending stop-acknowledgement timeout for a recording, if any. */
function cancelStopTimeout(recordingId: string): void {
  const handle = pendingStopTimeouts.get(recordingId);
  if (handle) {
    clearTimeout(handle);
    pendingStopTimeouts.delete(recordingId);
  }
}

/** Remove a recording from both deterministic maps. */
function cleanupMaps(recordingId: string, conversationId: string | undefined): void {
  standaloneRecordingConversationId.delete(recordingId);
  if (conversationId) {
    const current = recordingOwnerByConversation.get(conversationId);
    if (current === recordingId) {
      recordingOwnerByConversation.delete(conversationId);
    }
  }
}

// ─── Status (client → server lifecycle updates) ─────────────────────────────

function handleRecordingStatus(
  msg: RecordingStatus,
  reportingSocket: net.Socket,
  ctx: HandlerContext,
): void {
  const recordingId = msg.sessionId;
  let conversationId = standaloneRecordingConversationId.get(recordingId);

  // Fall back to attachToConversationId when the in-memory map is missing
  // (e.g. after daemon restart). The daemon originally sent this ID to the
  // client in recording_start, so it is trustworthy. The allowedDir path
  // restriction below still prevents arbitrary file attachment.
  if (!conversationId && msg.attachToConversationId) {
    conversationId = msg.attachToConversationId;
    log.info({ recordingId, conversationId }, 'Resolved conversationId from attachToConversationId (daemon restart fallback)');
  }

  if (!conversationId) {
    log.warn({ recordingId }, 'Ignoring recording_status for unknown recording ID with no attachToConversationId');
    return;
  }

  // The client acknowledged this recording — cancel any pending stop timeout.
  cancelStopTimeout(recordingId);

  // Use the reporting socket (which delivered this message) as the primary
  // recipient. Fall back to session-based lookup if the user switched sessions.
  const notifySocket = reportingSocket ?? findSocketForSession(conversationId, ctx);

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
        // Restrict accepted file paths to the app's recordings directory to
        // prevent attachment of arbitrary files via crafted IPC messages.
        let resolvedPath: string;
        try {
          resolvedPath = realpathSync(msg.filePath);
        } catch {
          // File doesn't exist (broken symlink or missing) — use path.resolve
          // as fallback; the existsSync check below will handle the missing file.
          resolvedPath = path.resolve(msg.filePath);
        }
        const allowedDir = path.join(
          process.env.HOME ?? '',
          'Library/Application Support/vellum-assistant/recordings',
        );
        let resolvedAllowedDir: string;
        try {
          resolvedAllowedDir = realpathSync(allowedDir);
        } catch {
          resolvedAllowedDir = allowedDir;
        }
        if (!resolvedPath.startsWith(resolvedAllowedDir + path.sep) && resolvedPath !== resolvedAllowedDir) {
          log.warn({ recordingId, filePath: msg.filePath, allowedDir, resolvedAllowedDir }, 'Recording file path outside allowed directory — rejecting');
          if (notifySocket) {
            ctx.send(notifySocket, {
              type: 'assistant_text_delta',
              text: 'Recording file is unavailable or expired.',
              sessionId: conversationId,
            });
            ctx.send(notifySocket, { type: 'message_complete', sessionId: conversationId });
          }
          // Clean up maps before breaking so future recordings aren't blocked
          cleanupMaps(recordingId, conversationId);
          break;
        }

        try {
          if (!existsSync(resolvedPath)) {
            log.error({ recordingId, filePath: msg.filePath }, 'Recording file does not exist');
            if (notifySocket) {
              ctx.send(notifySocket, {
                type: 'assistant_text_delta',
                text: 'Recording file is unavailable or expired.',
                sessionId: conversationId,
              });
              ctx.send(notifySocket, { type: 'message_complete', sessionId: conversationId });
            }
          } else {
            const stat = statSync(resolvedPath);
            const sizeBytes = stat.size;
            const filename = path.basename(resolvedPath);

            // Infer MIME type from extension
            const ext = filename.split('.').pop()?.toLowerCase();
            const mimeType = ext === 'mov' ? 'video/quicktime' : ext === 'mp4' ? 'video/mp4' : 'video/mp4';

            // Store as file-backed attachment (avoids reading large files into memory)
            const attachment = uploadFileBackedAttachment(filename, mimeType, resolvedPath, sizeBytes);
            log.info({ recordingId, attachmentId: attachment.id, sizeBytes, filePath: resolvedPath }, 'Created attachment for standalone recording');

            // Always create a new assistant message for the recording attachment.
            // Reusing the last assistant message would attach the recording to an
            // unrelated older message after reload.
            const newMsg = conversationStore.addMessage(
              conversationId,
              'assistant',
              JSON.stringify([{ type: 'text', text: 'Screen recording attached.' }]),
            );
            const messageId = newMsg.id;
            log.info({ recordingId, conversationId, messageId }, 'Created assistant message for recording attachment');

            linkAttachmentToMessage(messageId, attachment.id, 0);
            log.info({ recordingId, messageId, attachmentId: attachment.id }, 'Linked recording attachment to assistant message');

            // Notify the client via the reporting socket
            if (notifySocket) {
              ctx.send(notifySocket, {
                type: 'assistant_text_delta',
                text: 'Screen recording complete. Your recording has been saved.',
                sessionId: conversationId,
              });
              ctx.send(notifySocket, {
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
          if (notifySocket) {
            ctx.send(notifySocket, {
              type: 'assistant_text_delta',
              text: 'Recording saved but failed to attach to conversation.',
              sessionId: conversationId,
            });
            ctx.send(notifySocket, { type: 'message_complete', sessionId: conversationId });
          }
        }
      } else {
        // No file path — recording stopped without producing a file
        log.warn({ recordingId, conversationId }, 'Recording stopped without file path');
        if (notifySocket) {
          ctx.send(notifySocket, {
            type: 'assistant_text_delta',
            text: 'Recording stopped but no file was produced.',
            sessionId: conversationId,
          });
          ctx.send(notifySocket, { type: 'message_complete', sessionId: conversationId });
        }
      }

      cleanupMaps(recordingId, conversationId);
      break;
    }

    case 'failed': {
      log.warn(
        { recordingId, conversationId, error: msg.error },
        'Standalone recording failed',
      );

      if (notifySocket) {
        ctx.send(notifySocket, {
          type: 'assistant_text_delta',
          text: `Recording failed: ${msg.error ?? 'unknown error'}`,
          sessionId: conversationId,
        });
        ctx.send(notifySocket, {
          type: 'message_complete',
          sessionId: conversationId,
        });
      }

      cleanupMaps(recordingId, conversationId);
      break;
    }
  }
}

// ─── Socket disconnect cleanup ───────────────────────────────────────────────

/**
 * Clean up recording state for recordings whose owning conversation is bound
 * to the disconnecting socket. Accepts a lookup function that resolves a
 * conversation ID to its current socket, so we only clean up recordings
 * affected by this specific socket disconnect — not unrelated sessions.
 */
export function cleanupRecordingsOnDisconnect(
  disconnectedSocket: net.Socket,
  findSocketForConversation: (conversationId: string) => net.Socket | undefined,
): void {
  if (recordingOwnerByConversation.size === 0) return;
  for (const [convId, recId] of [...recordingOwnerByConversation.entries()]) {
    const ownerSocket = findSocketForConversation(convId);
    // Clean up if the owner conversation's socket is the one disconnecting,
    // or if the owner conversation has no socket bound at all.
    if (!ownerSocket || ownerSocket === disconnectedSocket) {
      log.warn({ conversationId: convId, recordingId: recId }, 'Cleaning up recording state for disconnected socket');
      cancelStopTimeout(recId);
      standaloneRecordingConversationId.delete(recId);
      recordingOwnerByConversation.delete(convId);
    }
  }
}

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Reset module-level state. Only for use in tests. */
export function __resetRecordingState(): void {
  for (const handle of pendingStopTimeouts.values()) {
    clearTimeout(handle);
  }
  pendingStopTimeouts.clear();
  standaloneRecordingConversationId.clear();
  recordingOwnerByConversation.clear();
}

// ─── Export handler group ────────────────────────────────────────────────────

export const recordingHandlers = defineHandlers({
  recording_status: handleRecordingStatus,
});
