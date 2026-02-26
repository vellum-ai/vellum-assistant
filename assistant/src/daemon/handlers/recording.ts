import { existsSync, realpathSync, statSync } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import { v4 as uuid } from 'uuid';

import { linkAttachmentToMessage, setAttachmentThumbnail,uploadFileBackedAttachment } from '../../memory/attachments-store.js';
import * as conversationStore from '../../memory/conversation-store.js';
import type { RecordingOptions,RecordingStatus } from '../ipc-protocol.js';
import { generateVideoThumbnailFromPath } from '../video-thumbnail.js';
import { defineHandlers, findSocketForSession, type HandlerContext,log } from './shared.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** How long to wait (ms) for a client to acknowledge a recording_stop before
 *  automatically cleaning up stale map entries. Prevents a missing client ack
 *  from permanently blocking all future recordings. */
const STOP_ACK_TIMEOUT_MS = 30_000;

const RECORDING_MIME_TYPES = new Map<string, string>([
  ['mov', 'video/quicktime'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
]);

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

/** Current restart operation token. When non-null, the recording system is
 *  mid-restart and any async completions (started/failed) from a previous
 *  cycle with a mismatched token are rejected. */
let activeRestartToken: string | null = null;

/** Tracks which conversationId has a pending restart so "no active recording"
 *  is only returned when the state is truly idle (not mid-restart). */
const pendingRestartByConversation = new Map<string, string>();

// ─── Start ───────────────────────────────────────────────────────────────────

/**
 * Initiate a standalone recording for a conversation.
 * Generates a unique recording ID, stores deterministic mappings, and sends
 * a `recording_start` message to the client.
 *
 * When `operationToken` is provided (restart flow), it is threaded through
 * to the client so that status callbacks can be validated against the token.
 */
export function handleRecordingStart(
  conversationId: string,
  options: RecordingOptions | undefined,
  socket: net.Socket,
  ctx: HandlerContext,
  operationToken?: string,
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
    ...(operationToken ? { operationToken } : {}),
  });

  log.info({ recordingId, conversationId, operationToken }, 'Standalone recording started');
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

// ─── Restart ─────────────────────────────────────────────────────────────────

export interface RecordingRestartResult {
  /** Whether the restart was initiated. false if no recording was active to stop. */
  initiated: boolean;
  /** The operation token threaded through the stop+start cycle. */
  operationToken?: string;
  /** Response text for the user. */
  responseText: string;
  /** When initiated is false, explains why the restart could not proceed. */
  reason?: 'no_active_recording' | 'restart_in_progress';
}

/**
 * Restart the active recording: stop the current one, then start a new one
 * with `promptForSource: true` (client reopens source picker).
 *
 * Uses an operation token to guard against stale async completions from
 * a previous restart cycle. The token is:
 * 1. Generated here and stored as `activeRestartToken`
 * 2. Threaded through to the new `recording_start` message
 * 3. Validated when `recording_status` callbacks arrive
 *
 * If the picker is closed/canceled during restart, the client sends a
 * `restart_cancelled` status and the daemon emits a deterministic response
 * (never "new recording started").
 */
export function handleRecordingRestart(
  conversationId: string,
  socket: net.Socket,
  ctx: HandlerContext,
): RecordingRestartResult {
  // Generate a restart operation token for race hardening
  const operationToken = uuid();

  // Stop current recording (if any)
  const stoppedRecordingId = handleRecordingStop(conversationId, ctx);

  if (!stoppedRecordingId) {
    // No active recording — check if mid-restart (state is not truly idle)
    if (pendingRestartByConversation.has(conversationId)) {
      log.info({ conversationId }, 'Restart requested while another restart is pending');
      return {
        initiated: false,
        reason: 'restart_in_progress',
        responseText: 'A restart is already in progress.',
      };
    }

    log.info({ conversationId }, 'Restart requested but no active recording to stop');
    return {
      initiated: false,
      reason: 'no_active_recording',
      responseText: 'No active recording to restart.',
    };
  }

  // Atomically set the restart token and pending state so that:
  // 1. Stale completions from a previous cycle are rejected
  // 2. "no active recording" checks know we're mid-restart
  activeRestartToken = operationToken;
  pendingRestartByConversation.set(conversationId, operationToken);

  // Resolve the actual owner conversation ID. When conversation B requests
  // a restart but the recording is owned by conversation A, the stop above
  // used the global fallback to find A's recording. We need to pass A's
  // conversationId to cleanupMaps so it can delete the correct map entry.
  let ownerConversationId = conversationId;
  if (recordingOwnerByConversation.get(conversationId) !== stoppedRecordingId && recordingOwnerByConversation.size > 0) {
    const [activeConv, activeRec] = [...recordingOwnerByConversation.entries()][0];
    if (activeRec === stoppedRecordingId) {
      ownerConversationId = activeConv;
      log.info({ conversationId, ownerConversationId, stoppedRecordingId }, 'Resolved restart cleanup to actual owner conversation');
    }
  }

  // Immediately clean up the old recording maps so the start call
  // doesn't hit the "already active" guard. The stop command has already
  // been sent; we clean maps here to ensure atomic stop/start handoff.
  cleanupMaps(stoppedRecordingId, ownerConversationId);
  cancelStopTimeout(stoppedRecordingId);

  // Start a new recording with the operation token
  const newRecordingId = handleRecordingStart(
    conversationId,
    { promptForSource: true },
    socket,
    ctx,
    operationToken,
  );

  if (!newRecordingId) {
    // Start failed (shouldn't happen after cleanup, but defensive)
    activeRestartToken = null;
    pendingRestartByConversation.delete(conversationId);
    return {
      initiated: false,
      responseText: 'Failed to restart recording.',
    };
  }

  log.info({ conversationId, operationToken, oldRecordingId: stoppedRecordingId, newRecordingId }, 'Recording restart initiated');

  return {
    initiated: true,
    operationToken,
    responseText: 'Restarting screen recording.',
  };
}

// ─── Pause ───────────────────────────────────────────────────────────────────

/**
 * Pause the active recording for a conversation.
 * Sends a `recording_pause` IPC message to the client.
 *
 * Returns the recording ID if pause was sent, or `undefined` if no active
 * recording exists.
 */
export function handleRecordingPause(
  conversationId: string,
  ctx: HandlerContext,
): string | undefined {
  let recordingId = recordingOwnerByConversation.get(conversationId);
  let ownerConversationId = conversationId;

  // Global fallback
  if (!recordingId && recordingOwnerByConversation.size > 0) {
    const [activeConv, activeRec] = [...recordingOwnerByConversation.entries()][0];
    recordingId = activeRec;
    ownerConversationId = activeConv;
  }

  if (!recordingId) {
    log.debug({ conversationId }, 'No active recording to pause');
    return undefined;
  }

  const socket = findSocketForSession(ownerConversationId, ctx)
    ?? findSocketForSession(conversationId, ctx);
  if (!socket) {
    log.warn({ conversationId, recordingId }, 'Cannot send recording_pause: no socket bound');
    return undefined;
  }

  ctx.send(socket, {
    type: 'recording_pause',
    recordingId,
  });

  log.info({ recordingId, conversationId }, 'Recording pause sent');
  return recordingId;
}

// ─── Resume ──────────────────────────────────────────────────────────────────

/**
 * Resume a paused recording for a conversation.
 * Sends a `recording_resume` IPC message to the client.
 *
 * Returns the recording ID if resume was sent, or `undefined` if no active
 * recording exists.
 */
export function handleRecordingResume(
  conversationId: string,
  ctx: HandlerContext,
): string | undefined {
  let recordingId = recordingOwnerByConversation.get(conversationId);
  let ownerConversationId = conversationId;

  // Global fallback
  if (!recordingId && recordingOwnerByConversation.size > 0) {
    const [activeConv, activeRec] = [...recordingOwnerByConversation.entries()][0];
    recordingId = activeRec;
    ownerConversationId = activeConv;
  }

  if (!recordingId) {
    log.debug({ conversationId }, 'No active recording to resume');
    return undefined;
  }

  const socket = findSocketForSession(ownerConversationId, ctx)
    ?? findSocketForSession(conversationId, ctx);
  if (!socket) {
    log.warn({ conversationId, recordingId }, 'Cannot send recording_resume: no socket bound');
    return undefined;
  }

  ctx.send(socket, {
    type: 'recording_resume',
    recordingId,
  });

  log.info({ recordingId, conversationId }, 'Recording resume sent');
  return recordingId;
}

// ─── State queries ───────────────────────────────────────────────────────────

/** Returns true if recording state is truly idle — no active recording and
 *  no pending restart. Callers should use this instead of checking maps
 *  directly to avoid returning "no active recording" during the stop/start
 *  window of a restart cycle. */
export function isRecordingIdle(): boolean {
  return recordingOwnerByConversation.size === 0 && pendingRestartByConversation.size === 0;
}

/** Returns the current active restart operation token, or null if no restart is in progress. */
export function getActiveRestartToken(): string | null {
  return activeRestartToken;
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

async function handleRecordingStatus(
  msg: RecordingStatus,
  reportingSocket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
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

  // ── Operation token validation for restart race hardening ──
  // Only reject when BOTH sides have tokens AND they don't match. This means
  // the status is from a DIFFERENT restart cycle (stale token mismatch).
  // Tokenless statuses must be allowed through because during a restart cycle,
  // the old recording's stopped/failed callbacks arrive without a token — they
  // were started before the restart was initiated. These tokenless callbacks
  // are legitimate and necessary for the deferred restart pattern (triggering
  // the new recording_start after the old recording's stopped ack).
  if (msg.operationToken && activeRestartToken && msg.operationToken !== activeRestartToken) {
    log.warn(
      { recordingId, expectedToken: activeRestartToken, receivedToken: msg.operationToken },
      'Rejecting stale recording_status — operation token mismatch (previous restart cycle)',
    );
    return;
  }

  // The client acknowledged this recording — cancel any pending stop timeout.
  cancelStopTimeout(recordingId);

  // Use the reporting socket (which delivered this message) as the primary
  // recipient. Fall back to session-based lookup if the user switched sessions.
  const notifySocket = reportingSocket ?? findSocketForSession(conversationId, ctx);

  switch (msg.status) {
    case 'started': {
      log.info({ recordingId, conversationId }, 'Standalone recording confirmed started by client');

      // If this was part of a restart cycle, clear the pending restart state
      // now that the new recording has successfully started.
      if (activeRestartToken && pendingRestartByConversation.get(conversationId) === activeRestartToken) {
        pendingRestartByConversation.delete(conversationId);
        activeRestartToken = null;
        log.info({ recordingId, conversationId }, 'Restart cycle complete — new recording started');
      }
      break;
    }

    case 'restart_cancelled': {
      // The user closed/canceled the source picker during a restart.
      // Emit a deterministic response — never "new recording started".
      log.info({ recordingId, conversationId }, 'Restart cancelled — source picker closed');

      // Clean up restart state
      cleanupMaps(recordingId, conversationId);
      pendingRestartByConversation.delete(conversationId);
      if (activeRestartToken && pendingRestartByConversation.size === 0) {
        activeRestartToken = null;
      }

      if (notifySocket) {
        ctx.send(notifySocket, {
          type: 'assistant_text_delta',
          text: 'Recording restart cancelled.',
          sessionId: conversationId,
        });
        ctx.send(notifySocket, { type: 'message_complete', sessionId: conversationId });
      }
      break;
    }

    case 'paused':
      log.info({ recordingId, conversationId }, 'Recording paused by client');
      break;

    case 'resumed':
      log.info({ recordingId, conversationId }, 'Recording resumed by client');
      break;

    case 'stopped': {
      log.info(
        { recordingId, conversationId, filePath: msg.filePath, durationMs: msg.durationMs },
        'Standalone recording stopped — file ready',
      );

      // Release recording state immediately so back-to-back recordings
      // aren't blocked by thumbnail generation or attachment processing.
      cleanupMaps(recordingId, conversationId);

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
          break;
        }

        try {
          if (!existsSync(resolvedPath)) {
            log.error({ recordingId, filePath: msg.filePath }, 'Recording file does not exist');
            if (notifySocket) {
              ctx.send(notifySocket, {
                type: 'assistant_text_delta',
                text: 'Recording failed to save.',
                sessionId: conversationId,
              });
              ctx.send(notifySocket, { type: 'message_complete', sessionId: conversationId });
            }
          } else {
            const stat = statSync(resolvedPath);
            const sizeBytes = stat.size;

            if (sizeBytes === 0) {
              log.error({ recordingId, filePath: msg.filePath }, 'Recording file is zero-length — treating as failed');
              if (notifySocket) {
                ctx.send(notifySocket, {
                  type: 'assistant_text_delta',
                  text: 'Recording failed to save.',
                  sessionId: conversationId,
                });
                ctx.send(notifySocket, { type: 'message_complete', sessionId: conversationId });
              }
              break;
            }
            const filename = path.basename(resolvedPath);

            // Infer MIME type from extension
            const ext = filename.split('.').pop()?.toLowerCase();
            const mimeType = (ext && RECORDING_MIME_TYPES.get(ext)) || 'video/mp4';

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

            // Generate thumbnail before notifying the client so it's included
            // in the message_complete payload (fire-and-forget would race).
            let thumbnailData: string | undefined;
            try {
              const thumb = await generateVideoThumbnailFromPath(resolvedPath);
              if (thumb) {
                setAttachmentThumbnail(attachment.id, thumb);
                thumbnailData = thumb;
                log.info({ recordingId, attachmentId: attachment.id }, 'Thumbnail generated for recording');
              }
            } catch (err) {
              log.warn({ err, recordingId }, 'Thumbnail generation failed — continuing without thumbnail');
            }

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
                  thumbnailData,
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

      // If this failure was part of a restart cycle, clear restart state
      if (pendingRestartByConversation.has(conversationId)) {
        pendingRestartByConversation.delete(conversationId);
        if (pendingRestartByConversation.size === 0) {
          activeRestartToken = null;
        }
      }

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
      pendingRestartByConversation.delete(convId);
    }
  }
  // Clear restart token if all pending restarts were cleaned up
  if (pendingRestartByConversation.size === 0) {
    activeRestartToken = null;
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
  pendingRestartByConversation.clear();
  activeRestartToken = null;
}

// ─── Export handler group ────────────────────────────────────────────────────

export const recordingHandlers = defineHandlers({
  recording_status: handleRecordingStatus,
});
