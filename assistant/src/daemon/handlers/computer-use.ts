import * as net from 'node:net';
import { getConfig } from '../../config/loader.js';
import { getFailoverProvider } from '../../providers/registry.js';
import { RateLimitProvider } from '../../providers/ratelimit.js';
import { ComputerUseSession } from '../computer-use-session.js';
import { readBlob, deleteBlob, validateBlobKindEncoding } from '../ipc-blob-store.js';
import type {
  CuSessionCreate,
  CuSessionAbort,
  CuSessionFinalized,
  CuObservation,
  ServerMessage,
} from '../ipc-protocol.js';
import * as conversationStore from '../../memory/conversation-store.js';
import { createFileBackedAttachment, linkAttachmentToMessage } from '../../memory/attachments-store.js';
import { log, defineHandlers, findSocketForSession, type HandlerContext, type CuSessionMetadata } from './shared.js';

const cuObservationSequenceBySession = new Map<string, number>();

function removeCuSessionReferences(
  ctx: HandlerContext,
  sessionId: string,
  expectedSession?: ComputerUseSession,
): void {
  const current = ctx.cuSessions.get(sessionId);
  if (expectedSession && current && current !== expectedSession) {
    return;
  }
  ctx.cuSessions.delete(sessionId);
  // NOTE: cuSessionMetadata is intentionally NOT deleted here.
  // onTerminal fires before cu_session_finalized arrives from the client,
  // so deleting metadata here would race with handleCuSessionFinalized
  // which still needs to read it. Metadata is cleaned up explicitly at the
  // end of handleCuSessionFinalized instead.
  cuObservationSequenceBySession.delete(sessionId);
  ctx.cuObservationParseSequence.delete(sessionId);
  // NOTE: socketToCuSession is intentionally NOT cleaned up here.
  // The socket close handler in server.ts is the sole owner of
  // socketToCuSession cleanup — it uses the mapping to find and delete
  // cuSessionMetadata entries. Removing the session here would race:
  // if a CU session reaches terminal state (triggering this function)
  // and then the socket disconnects before cu_session_finalized,
  // the close handler wouldn't see the session and metadata would leak.
}

export function handleCuSessionCreate(
  msg: CuSessionCreate,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Abort any existing session with the same ID to prevent zombies,
  // and remove it from the previous owner's socket set so disconnect
  // cleanup doesn't accidentally abort the replacement session.
  const existingSession = ctx.cuSessions.get(msg.sessionId);
  if (existingSession) {
    existingSession.abort();
    removeCuSessionReferences(ctx, msg.sessionId, existingSession);
    // Clean up stale metadata from the replaced session; the new session
    // will set its own metadata below if needed.
    ctx.cuSessionMetadata.delete(msg.sessionId);
    // Remove the session ID from the old socket's set so the old socket's
    // close handler won't abort the replacement session.
    for (const [sock, ids] of ctx.socketToCuSession) {
      if (ids.delete(msg.sessionId) && ids.size === 0) {
        ctx.socketToCuSession.delete(sock);
      }
    }
  }

  const config = getConfig();
  let provider = getFailoverProvider(config.provider, config.providerOrder);
  const { rateLimit } = config;
  if (rateLimit.maxRequestsPerMinute > 0 || rateLimit.maxTokensPerSession > 0) {
    provider = new RateLimitProvider(provider, rateLimit, ctx.sharedRequestTimestamps);
  }

  const sendToClient = (serverMsg: ServerMessage) => {
    ctx.send(socket, serverMsg);
  };

  const sessionRef: { current?: ComputerUseSession } = {};
  const onTerminal = (sessionId: string) => {
    removeCuSessionReferences(ctx, sessionId, sessionRef.current);
    log.info({ sessionId }, 'Computer-use session cleaned up after terminal state');
  };

  const session = new ComputerUseSession(
    msg.sessionId,
    msg.task,
    msg.screenWidth,
    msg.screenHeight,
    provider,
    sendToClient,
    msg.interactionType,
    onTerminal,
  );
  sessionRef.current = session;

  ctx.cuSessions.set(msg.sessionId, session);

  // Store QA metadata so handleCuSessionFinalized can inject results
  // into the originating chat session.
  if (msg.reportToSessionId || msg.qaMode) {
    const meta: CuSessionMetadata = {};
    if (msg.reportToSessionId) meta.reportToSessionId = msg.reportToSessionId;
    if (msg.qaMode) meta.qaMode = msg.qaMode;
    ctx.cuSessionMetadata.set(msg.sessionId, meta);
  }

  // Track all CU sessions per socket so disconnect cleans up all of them
  let sessionIds = ctx.socketToCuSession.get(socket);
  if (!sessionIds) {
    sessionIds = new Set();
    ctx.socketToCuSession.set(socket, sessionIds);
  }
  sessionIds.add(msg.sessionId);

  log.info({ sessionId: msg.sessionId, taskLength: msg.task.length }, 'Computer-use session created');
}

export function handleCuSessionAbort(
  msg: CuSessionAbort,
  _socket: net.Socket,
  ctx: HandlerContext,
): void {
  const session = ctx.cuSessions.get(msg.sessionId);
  if (!session) {
    log.debug({ sessionId: msg.sessionId }, 'CU session abort: session not found (already finished?)');
    return;
  }
  session.abort();
  removeCuSessionReferences(ctx, msg.sessionId, session);
  // On explicit abort, clean up metadata too — no finalized event is guaranteed.
  ctx.cuSessionMetadata.delete(msg.sessionId);
  log.info({ sessionId: msg.sessionId }, 'Computer-use session aborted by client');
}

export async function handleCuObservation(
  msg: CuObservation,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const receiveTimestampMs = Date.now();

  // Hydrate blob refs to inline values before any other processing.
  // Strategy: blob-first, inline-fallback, cu_error if neither available.
  if (msg.axTreeBlob) {
    try {
      validateBlobKindEncoding(msg.axTreeBlob, 'axTreeBlob');
      const buf = await readBlob(msg.axTreeBlob);
      msg.axTree = buf.toString('utf8');
      deleteBlob(msg.axTreeBlob.id);
    } catch (err) {
      log.warn({ err, blobId: msg.axTreeBlob.id }, 'Failed to hydrate axTreeBlob, checking inline fallback');
      deleteBlob(msg.axTreeBlob.id);
      if (!msg.axTree) {
        log.warn({ blobId: msg.axTreeBlob.id }, 'No inline axTree fallback; continuing with partial observation');
      }
    }
  }

  if (msg.screenshotBlob) {
    try {
      validateBlobKindEncoding(msg.screenshotBlob, 'screenshotBlob');
      const buf = await readBlob(msg.screenshotBlob);
      msg.screenshot = buf.toString('base64');
      deleteBlob(msg.screenshotBlob.id);
    } catch (err) {
      log.warn({ err, blobId: msg.screenshotBlob.id }, 'Failed to hydrate screenshotBlob, checking inline fallback');
      deleteBlob(msg.screenshotBlob.id);
      if (!msg.screenshot) {
        log.warn({ blobId: msg.screenshotBlob.id }, 'No inline screenshot fallback; continuing with partial observation');
      }
    }
  }

  const previousSequence = cuObservationSequenceBySession.get(msg.sessionId) ?? 0;
  const sequence = previousSequence + 1;
  cuObservationSequenceBySession.set(msg.sessionId, sequence);
  const axTreeBytes = msg.axTree ? Buffer.byteLength(msg.axTree, 'utf8') : 0;
  const axDiffBytes = msg.axDiff ? Buffer.byteLength(msg.axDiff, 'utf8') : 0;
  const secondaryWindowsBytes = msg.secondaryWindows ? Buffer.byteLength(msg.secondaryWindows, 'utf8') : 0;
  const screenshotBase64Bytes = msg.screenshot ? Buffer.byteLength(msg.screenshot, 'utf8') : 0;
  const screenshotApproxRawBytes = msg.screenshot
    ? Math.floor((msg.screenshot.length / 4) * 3)
    : 0;
  log.info({
    sessionId: msg.sessionId,
    sequence,
    receiveTimestampMs,
    axTreeBytes,
    axDiffBytes,
    secondaryWindowsBytes,
    screenshotBase64Bytes,
    screenshotApproxRawBytes,
  }, 'IPC_METRIC cu_observation_daemon_receive');

  const session = ctx.cuSessions.get(msg.sessionId);
  if (!session) {
    ctx.send(socket, {
      type: 'cu_error',
      sessionId: msg.sessionId,
      message: `No computer-use session found for id ${msg.sessionId}`,
    });
    return;
  }

  // Fire-and-forget: the session sends messages via its sendToClient callback
  session.handleObservation(msg).catch((err) => {
    log.error({ err, sessionId: msg.sessionId }, 'Error handling CU observation');
  });
}

export function handleCuSessionFinalized(
  msg: CuSessionFinalized,
  _socket: net.Socket,
  ctx: HandlerContext,
): void {
  const meta = ctx.cuSessionMetadata.get(msg.sessionId);

  log.info(
    {
      sessionId: msg.sessionId,
      status: msg.status,
      stepCount: msg.stepCount,
      hasRecording: !!msg.recording,
      recordingSizeBytes: msg.recording?.sizeBytes,
      recordingDurationMs: msg.recording?.durationMs,
      reportToSessionId: meta?.reportToSessionId,
      qaMode: meta?.qaMode,
    },
    'CU session finalized by client',
  );

  // Inject a summary message into the originating chat session if configured.
  if (meta?.reportToSessionId && msg.summary) {
    const reportSessionId = meta.reportToSessionId;
    const reportSocket = findSocketForSession(reportSessionId, ctx);

    // Persist the assistant message in the conversation store so it appears
    // in history even if the client is not currently connected.
    const conversation = conversationStore.getConversation(reportSessionId);
    if (conversation) {
      const assistantContent = JSON.stringify([{ type: 'text', text: msg.summary }]);
      const persistedMessage = conversationStore.addMessage(reportSessionId, 'assistant', assistantContent, {
        source: 'cu_session_finalized',
        cuSessionId: msg.sessionId,
        cuStatus: msg.status,
        cuStepCount: msg.stepCount,
        qaMode: meta.qaMode ?? false,
        ...(msg.recording ? { recordingPath: msg.recording.localPath } : {}),
      });

      // Create a file-backed attachment from the recording and link it to the message.
      let recordingAttachment: { id: string; filename: string; mimeType: string; sizeBytes: number } | undefined;
      if (msg.recording) {
        try {
          const attachment = createFileBackedAttachment({
            filename: `qa-recording-${msg.sessionId}.mp4`,
            mimeType: msg.recording.mimeType || 'video/mp4',
            sizeBytes: msg.recording.sizeBytes,
            filePath: msg.recording.localPath,
            sha256: undefined,
            expiresAt: msg.recording.expiresAt,
          });
          linkAttachmentToMessage(persistedMessage.id, attachment.id, 0);
          recordingAttachment = {
            id: attachment.id,
            filename: attachment.originalFilename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          };
          log.info(
            {
              sessionId: msg.sessionId,
              attachmentId: attachment.id,
              filePath: msg.recording.localPath,
              sizeBytes: msg.recording.sizeBytes,
            },
            'Created file-backed attachment for CU session recording',
          );
        } catch (err) {
          log.error(
            { err, sessionId: msg.sessionId, localPath: msg.recording.localPath },
            'Failed to create file-backed attachment for recording',
          );
        }
      }

      // Also append to the in-memory Session.messages so subsequent turns
      // in the same session see the injected summary without a reload.
      const activeSession = ctx.sessions.get(reportSessionId);
      if (activeSession) {
        activeSession.messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: msg.summary }],
        });
      }

      // If the reporting session has a connected client, stream the summary
      // so it appears in real time.
      if (reportSocket) {
        ctx.send(reportSocket, {
          type: 'assistant_text_delta',
          text: msg.summary,
          sessionId: reportSessionId,
        });
        ctx.send(reportSocket, {
          type: 'message_complete',
          sessionId: reportSessionId,
          ...(recordingAttachment ? {
            attachments: [{
              id: recordingAttachment.id,
              filename: recordingAttachment.filename,
              mimeType: recordingAttachment.mimeType,
              data: '',
              sizeBytes: recordingAttachment.sizeBytes,
            }],
          } : {}),
        });
      }

      log.info(
        { cuSessionId: msg.sessionId, reportToSessionId: reportSessionId },
        'Injected CU finalization summary into reporting session',
      );
    } else {
      log.warn(
        { cuSessionId: msg.sessionId, reportToSessionId: reportSessionId },
        'Reporting session conversation not found; summary not persisted',
      );
    }
  }

  // Clean up all CU session state.
  removeCuSessionReferences(ctx, msg.sessionId);
  // Delete metadata last — after it has been consumed for summary injection
  // above and after removeCuSessionReferences (which intentionally skips it).
  ctx.cuSessionMetadata.delete(msg.sessionId);
}

export const computerUseHandlers = defineHandlers({
  cu_session_create: handleCuSessionCreate,
  cu_session_abort: handleCuSessionAbort,
  cu_session_finalized: handleCuSessionFinalized,
  cu_observation: handleCuObservation,
});
