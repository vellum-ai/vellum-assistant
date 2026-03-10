import { existsSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

import { v4 as uuid } from "uuid";

import {
  linkAttachmentToMessage,
  uploadFileBackedAttachment,
} from "../../memory/attachments-store.js";
import { addMessage } from "../../memory/conversation-crud.js";
import type { RecordingOptions, RecordingStatus } from "../message-protocol.js";
import { type HandlerContext, log } from "./shared.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** How long to wait (ms) for a client to acknowledge a recording_stop before
 *  automatically cleaning up stale map entries. Prevents a missing client ack
 *  from permanently blocking all future recordings. */
const STOP_ACK_TIMEOUT_MS = 30_000;

const RECORDING_MIME_TYPES = new Map<string, string>([
  ["mov", "video/quicktime"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
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

/** Idempotency guard: tracks recording IDs that have already been finalized
 *  to prevent double-finalization (e.g. during restart races). Entries are
 *  auto-cleaned after 60 seconds to avoid unbounded growth. */
const finalizedRecordingIds = new Set<string>();

/** Tracks which conversationId has a pending restart so "no active recording"
 *  is only returned when the state is truly idle (not mid-restart). */
const pendingRestartByConversation = new Map<string, string>();

/** Deferred restart parameters stored when a restart is initiated. The actual
 *  recording_start is sent only after the client acknowledges the stop (via a
 *  'stopped' status callback), preventing the race where the macOS client's
 *  async stop hasn't completed when the start arrives. */
interface DeferredRestartParams {
  conversationId: string;
  operationToken: string;
}

/** Maps conversationId -> deferred restart parameters. Populated by
 *  handleRecordingRestart, consumed by the 'stopped' branch of
 *  handleRecordingStatus. */
const deferredRestartByConversation = new Map<string, DeferredRestartParams>();

// ─── Start ───────────────────────────────────────────────────────────────────

/**
 * Initiate a standalone recording for a conversation.
 * Generates a unique recording ID, stores deterministic mappings, and
 * broadcasts a `recording_start` event to connected clients.
 *
 * When `operationToken` is provided (restart flow), it is threaded through
 * to the client so that status callbacks can be validated against the token.
 */
export function handleRecordingStart(
  conversationId: string,
  options: RecordingOptions | undefined,
  ctx: HandlerContext,
  operationToken?: string,
): string | null {
  const existingRecordingId = recordingOwnerByConversation.get(conversationId);
  if (existingRecordingId) {
    log.warn(
      { conversationId, existingRecordingId },
      "Recording already active for conversation",
    );
    return null;
  }

  // Global single-active guard: only one recording at a time
  if (recordingOwnerByConversation.size > 0) {
    const [activeConv, activeRec] = [
      ...recordingOwnerByConversation.entries(),
    ][0];
    log.warn(
      {
        conversationId,
        activeConversationId: activeConv,
        activeRecordingId: activeRec,
      },
      "Recording already active globally",
    );
    return null;
  }

  const recordingId = uuid();

  standaloneRecordingConversationId.set(recordingId, conversationId);
  recordingOwnerByConversation.set(conversationId, recordingId);

  ctx.broadcast({
    type: "recording_start",
    recordingId,
    attachToConversationId: conversationId,
    options,
    ...(operationToken ? { operationToken } : {}),
  });

  log.info(
    { recordingId, conversationId, operationToken },
    "Standalone recording started",
  );
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
    const [activeConv, activeRec] = [
      ...recordingOwnerByConversation.entries(),
    ][0];
    recordingId = activeRec;
    ownerConversationId = activeConv;
    log.info(
      { conversationId, ownerConversationId, resolvedRecordingId: recordingId },
      "Resolved stop to globally active recording",
    );
  }

  if (!recordingId) {
    log.debug({ conversationId }, "No active standalone recording to stop");
    return undefined;
  }

  ctx.broadcast({
    type: "recording_stop",
    recordingId,
  });

  // Start a timeout so that if the client never acknowledges the stop (e.g.
  // client bug, app freeze), we automatically clean up the maps and unblock
  // future recordings.
  const timeoutHandle = setTimeout(() => {
    pendingStopTimeouts.delete(recordingId);
    log.warn(
      {
        recordingId,
        conversationId: ownerConversationId,
        timeoutMs: STOP_ACK_TIMEOUT_MS,
      },
      "Stop-acknowledgement timeout fired — cleaning up stale recording state",
    );
    cleanupMaps(recordingId, ownerConversationId);

    // Clean up any deferred restart that was waiting for this stop-ack
    if (deferredRestartByConversation.has(ownerConversationId)) {
      deferredRestartByConversation.delete(ownerConversationId);
      pendingRestartByConversation.delete(ownerConversationId);
      if (pendingRestartByConversation.size === 0) {
        activeRestartToken = null;
      }
      log.warn(
        { recordingId, conversationId: ownerConversationId },
        "Deferred restart cleaned up due to stop-ack timeout",
      );
    }
  }, STOP_ACK_TIMEOUT_MS);
  pendingStopTimeouts.set(recordingId, timeoutHandle);

  log.info({ recordingId, conversationId }, "Standalone recording stop sent");
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
  reason?: "no_active_recording" | "restart_in_progress";
}

/**
 * Restart the active recording: stop the current one, then defer starting a
 * new one until the client acknowledges the stop via a 'stopped' status
 * callback.
 *
 * This prevents a race condition where the macOS client processes
 * recording_stop asynchronously — if recording_start arrives before the
 * async stop completes, RecordingManager.start() rejects because state is
 * still active.
 *
 * Uses an operation token to guard against stale async completions from
 * a previous restart cycle. The token is:
 * 1. Generated here and stored as `activeRestartToken`
 * 2. Stored in `deferredRestartByConversation` for later use
 * 3. Threaded through to the new `recording_start` message when the stop ack arrives
 * 4. Validated when `recording_status` callbacks arrive
 *
 * If the stop fails or times out, the deferred restart state is cleaned up.
 */
export function handleRecordingRestart(
  conversationId: string,
  ctx: HandlerContext,
): RecordingRestartResult {
  // Generate a restart operation token for race hardening
  const operationToken = uuid();

  // Stop current recording (if any)
  const stoppedRecordingId = handleRecordingStop(conversationId, ctx);

  if (!stoppedRecordingId) {
    // No active recording — check if mid-restart (state is not truly idle)
    if (pendingRestartByConversation.has(conversationId)) {
      log.info(
        { conversationId },
        "Restart requested while another restart is pending",
      );
      return {
        initiated: false,
        reason: "restart_in_progress",
        responseText: "A restart is already in progress.",
      };
    }

    log.info(
      { conversationId },
      "Restart requested but no active recording to stop",
    );
    return {
      initiated: false,
      reason: "no_active_recording",
      responseText: "No active recording to restart.",
    };
  }

  // Resolve the actual owner conversation ID. When conversation B requests
  // a restart but the recording is owned by conversation A (cross-conversation
  // restart via global fallback), the deferred restart must be keyed by A's
  // conversationId because the stopped callback resolves the conversationId
  // from standaloneRecordingConversationId (which maps to A, the owner).
  // This lookup must happen BEFORE cleanupMaps removes the entry.
  const ownerConversationId =
    standaloneRecordingConversationId.get(stoppedRecordingId) ?? conversationId;
  if (ownerConversationId !== conversationId) {
    log.info(
      { conversationId, ownerConversationId, stoppedRecordingId },
      "Cross-conversation restart: keying deferred restart by owner conversation",
    );
  }

  // Atomically set the restart token and pending state so that:
  // 1. Stale completions from a previous cycle are rejected
  // 2. "no active recording" checks know we're mid-restart
  activeRestartToken = operationToken;
  pendingRestartByConversation.set(ownerConversationId, operationToken);

  // Store the deferred restart parameters. The actual recording_start will
  // be sent when the 'stopped' status callback arrives in handleRecordingStatus,
  // ensuring the client has fully completed the async stop before we start.
  // Keyed by ownerConversationId so the stopped handler (which resolves
  // conversationId from the recording's owner) can find this entry.
  deferredRestartByConversation.set(ownerConversationId, {
    conversationId,
    operationToken,
  });

  log.info(
    { conversationId, ownerConversationId, operationToken, stoppedRecordingId },
    "Recording restart initiated — start deferred until stop-ack",
  );

  return {
    initiated: true,
    operationToken,
    responseText: "Restarting screen recording.",
  };
}

// ─── Pause ───────────────────────────────────────────────────────────────────

/**
 * Pause the active recording for a conversation.
 * Broadcasts a `recording_pause` event to connected clients.
 *
 * Returns the recording ID if pause was sent, or `undefined` if no active
 * recording exists.
 */
export function handleRecordingPause(
  conversationId: string,
  ctx: HandlerContext,
): string | undefined {
  let recordingId = recordingOwnerByConversation.get(conversationId);

  // Global fallback
  if (!recordingId && recordingOwnerByConversation.size > 0) {
    const [_activeConv, activeRec] = [
      ...recordingOwnerByConversation.entries(),
    ][0];
    recordingId = activeRec;
  }

  if (!recordingId) {
    log.debug({ conversationId }, "No active recording to pause");
    return undefined;
  }

  ctx.broadcast({
    type: "recording_pause",
    recordingId,
  });

  log.info({ recordingId, conversationId }, "Recording pause sent");
  return recordingId;
}

// ─── Resume ──────────────────────────────────────────────────────────────────

/**
 * Resume a paused recording for a conversation.
 * Broadcasts a `recording_resume` event to connected clients.
 *
 * Returns the recording ID if resume was sent, or `undefined` if no active
 * recording exists.
 */
export function handleRecordingResume(
  conversationId: string,
  ctx: HandlerContext,
): string | undefined {
  let recordingId = recordingOwnerByConversation.get(conversationId);

  // Global fallback
  if (!recordingId && recordingOwnerByConversation.size > 0) {
    const [_activeConv, activeRec] = [
      ...recordingOwnerByConversation.entries(),
    ][0];
    recordingId = activeRec;
  }

  if (!recordingId) {
    log.debug({ conversationId }, "No active recording to resume");
    return undefined;
  }

  ctx.broadcast({
    type: "recording_resume",
    recordingId,
  });

  log.info({ recordingId, conversationId }, "Recording resume sent");
  return recordingId;
}

// ─── State queries ───────────────────────────────────────────────────────────

/** Returns true if recording state is truly idle — no active recording and
 *  no pending restart. Callers should use this instead of checking maps
 *  directly to avoid returning "no active recording" during the stop/start
 *  window of a restart cycle. */
export function isRecordingIdle(): boolean {
  return (
    recordingOwnerByConversation.size === 0 &&
    pendingRestartByConversation.size === 0
  );
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
function cleanupMaps(
  recordingId: string,
  conversationId: string | undefined,
): void {
  standaloneRecordingConversationId.delete(recordingId);
  if (conversationId) {
    const current = recordingOwnerByConversation.get(conversationId);
    if (current === recordingId) {
      recordingOwnerByConversation.delete(conversationId);
    }
  }
}

// ─── Finalization helper ──────────────────────────────────────────────────────

/**
 * Finalize a recording: validate the file path, create an attachment, generate
 * a thumbnail, create a conversation message, and notify the client.
 *
 * This is the shared finalization flow used by the normal stop path and
 * by the restart path to save the previous recording before starting a new one.
 *
 * Includes an idempotency guard so the same recording cannot be finalized
 * twice (prevents double-finalization during restart races).
 */
export async function finalizeAndPublishRecording(params: {
  recordingId: string;
  conversationId: string;
  filePath?: string;
  durationMs?: number;
  ctx: HandlerContext;
}): Promise<{ success: boolean; messageId?: string }> {
  const { recordingId, conversationId, filePath, ctx } = params;

  // Idempotency guard: prevent double-finalization.
  // Mark as finalized eagerly (before any async work) so concurrent calls
  // for the same recordingId are rejected immediately.
  if (finalizedRecordingIds.has(recordingId)) {
    log.warn(
      { recordingId, conversationId },
      "Recording already finalized — skipping duplicate finalization",
    );
    return { success: false };
  }
  finalizedRecordingIds.add(recordingId);
  setTimeout(() => finalizedRecordingIds.delete(recordingId), 60_000);

  if (!filePath) {
    // No file path — recording stopped without producing a file
    log.warn(
      { recordingId, conversationId },
      "Recording stopped without file path",
    );
    const errorText = "Recording stopped but no file was produced.";
    try {
      await addMessage(
        conversationId,
        "assistant",
        JSON.stringify([{ type: "text", text: errorText }]),
      );
    } catch (persistErr) {
      log.warn(
        { err: persistErr, recordingId, conversationId },
        "Failed to persist recording error message",
      );
    }
    ctx.broadcast({
      type: "assistant_text_delta",
      text: errorText,
      sessionId: conversationId,
    });
    ctx.broadcast({
      type: "message_complete",
      sessionId: conversationId,
    });
    return { success: false };
  }

  // Restrict accepted file paths to the app's recordings directory to
  // prevent attachment of arbitrary files via crafted IPC messages.
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(filePath);
  } catch {
    // File doesn't exist (broken symlink or missing) — use path.resolve
    // as fallback; the existsSync check below will handle the missing file.
    resolvedPath = path.resolve(filePath);
  }
  const allowedDir = path.join(
    process.env.HOME ?? "",
    "Library/Application Support/vellum-assistant/recordings",
  );
  let resolvedAllowedDir: string;
  try {
    resolvedAllowedDir = realpathSync(allowedDir);
  } catch {
    resolvedAllowedDir = allowedDir;
  }
  if (
    !resolvedPath.startsWith(resolvedAllowedDir + path.sep) &&
    resolvedPath !== resolvedAllowedDir
  ) {
    log.warn(
      { recordingId, filePath, allowedDir, resolvedAllowedDir },
      "Recording file path outside allowed directory — rejecting",
    );
    const errorText = "Recording file is unavailable or expired.";
    try {
      await addMessage(
        conversationId,
        "assistant",
        JSON.stringify([{ type: "text", text: errorText }]),
      );
    } catch (persistErr) {
      log.warn(
        { err: persistErr, recordingId, conversationId },
        "Failed to persist recording error message",
      );
    }
    ctx.broadcast({
      type: "assistant_text_delta",
      text: errorText,
      sessionId: conversationId,
    });
    ctx.broadcast({
      type: "message_complete",
      sessionId: conversationId,
    });
    return { success: false };
  }

  try {
    if (!existsSync(resolvedPath)) {
      log.error({ recordingId, filePath }, "Recording file does not exist");
      const errorText = "Recording failed to save.";
      try {
        await addMessage(
          conversationId,
          "assistant",
          JSON.stringify([{ type: "text", text: errorText }]),
        );
      } catch (persistErr) {
        log.warn(
          { err: persistErr, recordingId, conversationId },
          "Failed to persist recording error message",
        );
      }
      ctx.broadcast({
        type: "assistant_text_delta",
        text: errorText,
        sessionId: conversationId,
      });
      ctx.broadcast({
        type: "message_complete",
        sessionId: conversationId,
      });
      return { success: false };
    }

    const stat = statSync(resolvedPath);
    const sizeBytes = stat.size;

    if (sizeBytes === 0) {
      log.error(
        { recordingId, filePath },
        "Recording file is zero-length — treating as failed",
      );
      const errorText = "Recording failed to save.";
      try {
        await addMessage(
          conversationId,
          "assistant",
          JSON.stringify([{ type: "text", text: errorText }]),
        );
      } catch (persistErr) {
        log.warn(
          { err: persistErr, recordingId, conversationId },
          "Failed to persist recording error message",
        );
      }
      ctx.broadcast({
        type: "assistant_text_delta",
        text: errorText,
        sessionId: conversationId,
      });
      ctx.broadcast({
        type: "message_complete",
        sessionId: conversationId,
      });
      return { success: false };
    }

    const filename = path.basename(resolvedPath);

    // Infer MIME type from extension
    const ext = filename.split(".").pop()?.toLowerCase();
    const mimeType = (ext && RECORDING_MIME_TYPES.get(ext)) || "video/mp4";

    // Store as file-backed attachment (avoids reading large files into memory)
    const attachment = uploadFileBackedAttachment(
      filename,
      mimeType,
      resolvedPath,
      sizeBytes,
    );
    log.info(
      {
        recordingId,
        attachmentId: attachment.id,
        sizeBytes,
        filePath: resolvedPath,
      },
      "Created attachment for standalone recording",
    );

    // Always create a new assistant message for the recording attachment.
    // Reusing the last assistant message would attach the recording to an
    // unrelated older message after reload.
    const msgText = "Screen recording complete. Your recording has been saved.";
    const newMsg = await addMessage(
      conversationId,
      "assistant",
      JSON.stringify([{ type: "text", text: msgText }]),
    );
    const messageId = newMsg.id;
    log.info(
      { recordingId, conversationId, messageId },
      "Created assistant message for recording attachment",
    );

    linkAttachmentToMessage(messageId, attachment.id, 0);
    log.info(
      { recordingId, messageId, attachmentId: attachment.id },
      "Linked recording attachment to assistant message",
    );

    // Skip server-side thumbnail generation for recordings — the client
    // generates thumbnails natively from the local file path using
    // AVAssetImageGenerator, which is faster and doesn't depend on ffmpeg.
    const thumbnailData: string | undefined = undefined;

    // Notify the client via broadcast
    ctx.broadcast({
      type: "assistant_text_delta",
      text: msgText,
      sessionId: conversationId,
    });
    ctx.broadcast({
      type: "message_complete",
      sessionId: conversationId,
      attachments: [
        {
          id: attachment.id,
          filename: attachment.originalFilename,
          mimeType: attachment.mimeType,
          data: "", // empty for file-backed; client uses content endpoint
          sizeBytes: attachment.sizeBytes,
          thumbnailData,
          filePath: resolvedPath,
        },
      ],
    });

    return { success: true, messageId };
  } catch (err) {
    log.error(
      { err, recordingId, filePath },
      "Failed to create attachment for standalone recording",
    );
    const errorText = "Recording saved but failed to attach to conversation.";
    try {
      await addMessage(
        conversationId,
        "assistant",
        JSON.stringify([{ type: "text", text: errorText }]),
      );
    } catch (persistErr) {
      log.warn(
        { err: persistErr, recordingId, conversationId },
        "Failed to persist recording error message",
      );
    }
    ctx.broadcast({
      type: "assistant_text_delta",
      text: errorText,
      sessionId: conversationId,
    });
    ctx.broadcast({
      type: "message_complete",
      sessionId: conversationId,
    });
    return { success: false };
  }
}

// ─── Status (client → server lifecycle updates) ─────────────────────────────

/**
 * Core recording-status business logic. Handles conversation ID resolution,
 * operation token validation for restart race hardening, file attachment
 * after recording stops, broadcasting recording lifecycle events, and
 * triggering deferred recording restarts.
 *
 * This is the supported entry point for both HTTP routes and tests.
 */
export async function handleRecordingStatusCore(
  msg: RecordingStatus,
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
    log.info(
      { recordingId, conversationId },
      "Resolved conversationId from attachToConversationId (daemon restart fallback)",
    );
  }

  if (!conversationId) {
    log.warn(
      { recordingId },
      "Ignoring recording_status for unknown recording ID with no attachToConversationId",
    );
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
  if (
    msg.operationToken &&
    activeRestartToken &&
    msg.operationToken !== activeRestartToken
  ) {
    log.warn(
      {
        recordingId,
        expectedToken: activeRestartToken,
        receivedToken: msg.operationToken,
      },
      "Rejecting stale recording_status — operation token mismatch (previous restart cycle)",
    );
    return;
  }

  // Cancel the stop timeout for most statuses, but NOT for a 'started' that
  // won't complete the restart cycle. During restart, the stop timeout is the
  // safety net that ensures deferred restart fires even if the client never
  // sends 'stopped'. A stale tokenless 'started' from the old recording must
  // not cancel it — otherwise restart state can leak indefinitely if the real
  // 'stopped' callback is dropped.
  const completesRestart =
    activeRestartToken &&
    msg.operationToken === activeRestartToken &&
    pendingRestartByConversation.get(conversationId) === activeRestartToken;
  if (msg.status !== "started" || completesRestart || !activeRestartToken) {
    cancelStopTimeout(recordingId);
  }

  switch (msg.status) {
    case "started": {
      log.info(
        { recordingId, conversationId },
        "Standalone recording confirmed started by client",
      );

      // If this was part of a restart cycle, clear the pending restart state
      // now that the new recording has successfully started. Gate on matching
      // operationToken to prevent a stale tokenless 'started' from an old
      // recording from prematurely clearing the restart state.
      if (completesRestart) {
        pendingRestartByConversation.delete(conversationId);
        activeRestartToken = null;
        log.info(
          { recordingId, conversationId },
          "Restart cycle complete — new recording started",
        );
      }
      break;
    }

    case "restart_cancelled": {
      // The user closed/canceled the source picker during a restart.
      // Emit a deterministic response — never "new recording started".
      log.info(
        { recordingId, conversationId },
        "Restart cancelled — source picker closed",
      );

      // Clean up restart state
      cleanupMaps(recordingId, conversationId);
      pendingRestartByConversation.delete(conversationId);
      if (activeRestartToken && pendingRestartByConversation.size === 0) {
        activeRestartToken = null;
      }

      ctx.broadcast({
        type: "assistant_text_delta",
        text: "Recording restart cancelled.",
        sessionId: conversationId,
      });
      ctx.broadcast({
        type: "message_complete",
        sessionId: conversationId,
      });
      break;
    }

    case "paused":
      log.info({ recordingId, conversationId }, "Recording paused by client");
      break;

    case "resumed":
      log.info({ recordingId, conversationId }, "Recording resumed by client");
      break;

    case "stopped": {
      log.info(
        {
          recordingId,
          conversationId,
          filePath: msg.filePath,
          durationMs: msg.durationMs,
        },
        "Standalone recording stopped — file ready",
      );

      // Release recording state immediately so back-to-back recordings
      // aren't blocked by thumbnail generation or attachment processing.
      cleanupMaps(recordingId, conversationId);

      // Check for a deferred restart: if handleRecordingRestart stored
      // pending start parameters for this conversation, trigger the start
      // now that the client has fully completed the async stop.
      const deferred = deferredRestartByConversation.get(conversationId);
      if (deferred) {
        deferredRestartByConversation.delete(conversationId);

        log.info(
          {
            recordingId,
            conversationId,
            operationToken: deferred.operationToken,
          },
          "Stop-ack received — triggering deferred restart start",
        );

        const newRecordingId = handleRecordingStart(
          deferred.conversationId,
          { promptForSource: true },
          ctx,
          deferred.operationToken,
        );

        if (!newRecordingId) {
          // Start failed — clean up restart state
          activeRestartToken = null;
          pendingRestartByConversation.delete(conversationId);
          log.warn(
            { conversationId },
            "Deferred restart start failed after stop-ack",
          );
        } else {
          // Cross-conversation restart: the pendingRestartByConversation entry
          // is keyed by the old owner (conversationId), but the new recording
          // is owned by the requester (deferred.conversationId). Migrate the
          // entry so the 'started' handler can find it under the correct key.
          const startAckKey =
            conversationId !== deferred.conversationId
              ? deferred.conversationId
              : conversationId;
          if (conversationId !== deferred.conversationId) {
            pendingRestartByConversation.delete(conversationId);
            pendingRestartByConversation.set(
              startAckKey,
              deferred.operationToken,
            );
            log.info(
              { oldKey: conversationId, newKey: startAckKey },
              "Migrated pendingRestartByConversation key from owner to requester",
            );
          }
          log.info(
            {
              conversationId,
              newRecordingId,
              operationToken: deferred.operationToken,
            },
            "Deferred restart recording started",
          );

          // Safety timeout: if the 'started' ack doesn't arrive within 30s,
          // clear restart state to prevent wedging. Without this, a dropped
          // 'started' callback leaves pendingRestartByConversation stuck and
          // blocks all future restart requests with 'restart_in_progress'.
          const expectedToken = deferred.operationToken;
          setTimeout(() => {
            if (
              pendingRestartByConversation.get(startAckKey) === expectedToken
            ) {
              pendingRestartByConversation.delete(startAckKey);
              if (activeRestartToken === expectedToken) {
                activeRestartToken = null;
              }
              log.warn(
                { conversationId: startAckKey, operationToken: expectedToken },
                "Restart start-ack timeout — clearing stale restart state",
              );
            }
          }, 30_000);
        }

        // Finalize the old recording: create attachment, generate thumbnail,
        // and notify the client. The deferred start fires first so the user
        // sees immediate activity (new recording starting) before the old
        // recording's completion message appears.
        const finResult = await finalizeAndPublishRecording({
          recordingId,
          conversationId,
          filePath: msg.filePath,
          durationMs: msg.durationMs,
          ctx,
        });

        // Handle old-success + new-start-failure: the old recording saved
        // but the new one couldn't start. Send explicit follow-up text so
        // the user knows the state.
        if (!newRecordingId && finResult.success) {
          ctx.broadcast({
            type: "assistant_text_delta",
            text: "Previous recording saved. New recording failed to start.",
            sessionId: deferred.conversationId,
          });
          ctx.broadcast({
            type: "message_complete",
            sessionId: deferred.conversationId,
          });
        }

        // Prevent fall-through to the normal finalization path below since
        // we already called finalizeAndPublishRecording explicitly above.
        break;
      }

      // Finalize: attach the recording file to the conversation
      await finalizeAndPublishRecording({
        recordingId,
        conversationId,
        filePath: msg.filePath,
        durationMs: msg.durationMs,
        ctx,
      });

      break;
    }

    case "failed": {
      log.warn(
        { recordingId, conversationId, error: msg.error },
        "Standalone recording failed",
      );

      ctx.broadcast({
        type: "assistant_text_delta",
        text: `Recording failed: ${msg.error ?? "unknown error"}`,
        sessionId: conversationId,
      });
      ctx.broadcast({
        type: "message_complete",
        sessionId: conversationId,
      });

      cleanupMaps(recordingId, conversationId);

      // If this failure was part of a restart cycle, clear restart state
      // including any deferred start that will never fire
      deferredRestartByConversation.delete(conversationId);
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

// ─── Test helpers ────────────────────────────────────────────────────────────

/**
 * Inject a recording owner entry. Only for use in tests.
 * This allows tests to simulate a second active recording that blocks
 * handleRecordingStart's global single-active guard.
 */
export function __injectRecordingOwner(
  conversationId: string,
  recordingId: string,
): void {
  recordingOwnerByConversation.set(conversationId, recordingId);
}

/** Reset module-level state. Only for use in tests. */
export function __resetRecordingState(): void {
  for (const handle of pendingStopTimeouts.values()) {
    clearTimeout(handle);
  }
  pendingStopTimeouts.clear();
  standaloneRecordingConversationId.clear();
  recordingOwnerByConversation.clear();
  pendingRestartByConversation.clear();
  deferredRestartByConversation.clear();
  finalizedRecordingIds.clear();
  activeRestartToken = null;
}
