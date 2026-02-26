import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as net from 'node:net';

import { v4 as uuid } from 'uuid';

import { getConfig } from '../../config/loader.js';
import * as conversationStore from '../../memory/conversation-store.js';
import { GENERATING_TITLE, queueGenerateConversationTitle } from '../../memory/conversation-title-service.js';
import { getConfiguredProvider } from '../../providers/provider-send-message.js';
import type { Provider } from '../../providers/types.js';
import { checkIngressForSecrets } from '../../security/secret-ingress.js';
import { parseSlashCandidate } from '../../skills/slash-commands.js';
import { classifyInteraction } from '../classifier.js';
import { getAssistantName } from '../identity-helpers.js';
import { deleteBlob, isValidBlobId, resolveBlobPath } from '../ipc-blob-store.js';
import type {
  CuSessionCreate,
  IpcBlobProbe,
  LinkOpenRequest,
  SuggestionRequest,
  TaskSubmit,
} from '../ipc-protocol.js';
import { executeRecordingIntent } from '../recording-executor.js';
import { resolveRecordingIntent } from '../recording-intent.js';
import { buildSessionErrorMessage,classifySessionError } from '../session-error.js';
import { handleCuSessionCreate } from './computer-use.js';
import { handleRecordingStart, handleRecordingStop } from './recording.js';
import { defineHandlers, type HandlerContext,log, renderHistoryContent, wireEscalationHandler } from './shared.js';

// ─── Task submit handler ────────────────────────────────────────────────────

export async function handleTaskSubmit(
  msg: TaskSubmit,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const requestId = uuid();
  const rlog = log.child({ requestId });

  try {
    // Block inbound tasks that contain secrets and redirect to secure prompt
    const taskIngressCheck = checkIngressForSecrets(msg.task);
    if (taskIngressCheck.blocked) {
      rlog.warn({ detectedTypes: taskIngressCheck.detectedTypes }, 'Blocked task_submit containing secrets');
      ctx.send(socket, {
        type: 'error',
        message: taskIngressCheck.userNotice!,
      });
      // Create an ephemeral session so the secret_response lifecycle works
      // end-to-end. The conversation is deleted after the prompt resolves
      // to avoid accumulating placeholder entries in session history.
      const conversation = conversationStore.createConversation('(blocked — secret detected)');
      ctx.socketToSession.set(socket, conversation.id);
      const session = await ctx.getOrCreateSession(conversation.id, socket, true);
      session.redirectToSecurePrompt(taskIngressCheck.detectedTypes, { onComplete: () => {
        conversationStore.deleteConversation(conversation.id);
        // Clean up in-memory session and socket binding so the ephemeral
        // session doesn't accumulate in the daemon's session map.
        const s = ctx.sessions.get(conversation.id);
        if (s) {
          s.dispose();
          ctx.sessions.delete(conversation.id);
        }
        // Only unbind if the socket still points to this ephemeral conversation;
        // a new task_submit may have already rebound it to a real session.
        if (ctx.socketToSession.get(socket) === conversation.id) {
          ctx.socketToSession.delete(socket);
        }
      } });
      return;
    }

    // ── Structured command intent (bypasses text parsing) ──────────────────
    const config = getConfig();
    if (config.daemon.standaloneRecording && msg.commandIntent?.domain === 'screen_recording') {
      const action = msg.commandIntent.action;
      rlog.info({ action, source: 'commandIntent' }, 'Recording command intent received');
      if (action === 'start') {
        const conversation = conversationStore.createConversation(msg.task || 'Screen Recording');
        ctx.socketToSession.set(socket, conversation.id);
        const recordingId = handleRecordingStart(conversation.id, { promptForSource: true }, socket, ctx);
        ctx.send(socket, { type: 'task_routed', sessionId: conversation.id, interactionType: 'text_qa' });
        ctx.send(socket, {
          type: 'assistant_text_delta',
          text: recordingId ? 'Starting screen recording.' : 'A recording is already active.',
          sessionId: conversation.id,
        });
        ctx.send(socket, { type: 'message_complete', sessionId: conversation.id });
        if (!recordingId) ctx.socketToSession.delete(socket);
        return;
      } else if (action === 'stop') {
        let activeSessionId = ctx.socketToSession.get(socket);
        if (!activeSessionId) {
          const conversation = conversationStore.createConversation(msg.task || 'Stop Recording');
          activeSessionId = conversation.id;
          ctx.socketToSession.set(socket, activeSessionId);
        }
        const stopped = handleRecordingStop(activeSessionId, ctx) !== undefined;
        ctx.send(socket, { type: 'task_routed', sessionId: activeSessionId, interactionType: 'text_qa' });
        ctx.send(socket, {
          type: 'assistant_text_delta',
          text: stopped ? 'Stopping the recording.' : 'No active recording to stop.',
          sessionId: activeSessionId,
        });
        ctx.send(socket, { type: 'message_complete', sessionId: activeSessionId });
        return;
      } else {
        // Unrecognized action — fall through to normal text handling so the
        // task is not silently dropped.
        rlog.warn({ action, source: 'commandIntent' }, 'Unrecognized screen_recording action, falling through to text handling');
      }
    }

    // ── Standalone recording intent interception ──────────────────────────
    let pendingRecordingStart = false;
    let pendingRecordingStop = false;
    if (config.daemon.standaloneRecording) {
      const name = getAssistantName();
      const dynamicNames = [name].filter(Boolean) as string[];
      const intentResult = resolveRecordingIntent(msg.task, dynamicNames);

      if (intentResult.kind === 'start_only') {
        // Create a conversation so the recording can be attached later
        const conversation = conversationStore.createConversation(msg.task);
        ctx.socketToSession.set(socket, conversation.id);

        const execResult = executeRecordingIntent(intentResult, {
          conversationId: conversation.id,
          socket,
          ctx,
        });

        ctx.send(socket, { type: 'task_routed', sessionId: conversation.id, interactionType: 'text_qa' });
        ctx.send(socket, { type: 'assistant_text_delta', text: execResult.responseText!, sessionId: conversation.id });
        ctx.send(socket, { type: 'message_complete', sessionId: conversation.id });

        // If recording rejected, unbind socket
        if (execResult.recordingStarted === false) {
          ctx.socketToSession.delete(socket);
        }

        rlog.info({ sessionId: conversation.id }, 'Recording-only intent intercepted — routed to standalone recording');
        return;
      }

      if (intentResult.kind === 'stop_only') {
        let activeSessionId = ctx.socketToSession.get(socket);
        if (!activeSessionId) {
          const conversation = conversationStore.createConversation(msg.task);
          activeSessionId = conversation.id;
          ctx.socketToSession.set(socket, activeSessionId);
        }

        const execResult = executeRecordingIntent(intentResult, {
          conversationId: activeSessionId,
          socket,
          ctx,
        });

        rlog.info('Recording stop intent intercepted');
        ctx.send(socket, { type: 'task_routed', sessionId: activeSessionId, interactionType: 'text_qa' });
        ctx.send(socket, { type: 'assistant_text_delta', text: execResult.responseText!, sessionId: activeSessionId });
        ctx.send(socket, { type: 'message_complete', sessionId: activeSessionId });
        return;
      }

      if (intentResult.kind === 'start_and_stop_only') {
        let activeSessionId = ctx.socketToSession.get(socket);
        if (!activeSessionId) {
          const conversation = conversationStore.createConversation(msg.task);
          activeSessionId = conversation.id;
          ctx.socketToSession.set(socket, activeSessionId);
        }

        const execResult = executeRecordingIntent(intentResult, {
          conversationId: activeSessionId,
          socket,
          ctx,
        });

        rlog.info('Recording start+stop intent intercepted');
        ctx.send(socket, { type: 'task_routed', sessionId: activeSessionId, interactionType: 'text_qa' });
        ctx.send(socket, { type: 'assistant_text_delta', text: execResult.responseText!, sessionId: activeSessionId });
        ctx.send(socket, { type: 'message_complete', sessionId: activeSessionId });
        return;
      }

      if (intentResult.kind === 'start_with_remainder' || intentResult.kind === 'stop_with_remainder' || intentResult.kind === 'start_and_stop_with_remainder') {
        // Defer recording action until after classifier creates the final conversation
        pendingRecordingStart = intentResult.kind === 'start_with_remainder' || intentResult.kind === 'start_and_stop_with_remainder';
        pendingRecordingStop = intentResult.kind === 'stop_with_remainder' || intentResult.kind === 'start_and_stop_with_remainder';
        (msg as { task: string }).task = intentResult.remainder;
        rlog.info({ remaining: intentResult.remainder }, 'Recording intent deferred, continuing with remaining text');
      }

      // 'none' falls through to normal processing
    }

    // Slash candidates always route to text_qa — bypass classifier
    const slashCandidate = parseSlashCandidate(msg.task);
    const interactionType = slashCandidate.kind === 'candidate'
      ? 'text_qa' as const
      : await classifyInteraction(msg.task, msg.source);
    rlog.info({ interactionType, slashBypass: slashCandidate.kind === 'candidate', taskLength: msg.task.length }, 'Task classified');

    if (interactionType === 'computer_use') {
      // Create CU session (reuse handleCuSessionCreate logic)
      const sessionId = uuid();
      const cuMsg: CuSessionCreate = {
        type: 'cu_session_create',
        sessionId,
        task: msg.task,
        screenWidth: msg.screenWidth,
        screenHeight: msg.screenHeight,
        attachments: msg.attachments,
        interactionType: 'computer_use',
      };
      handleCuSessionCreate(cuMsg, socket, ctx);

      // Start deferred recording from mixed intent (create a DB conversation
      // for the recording attachment since CU sessions don't have one).
      if (pendingRecordingStart || pendingRecordingStop) {
        const recConversation = conversationStore.createConversation('Screen Recording');
        if (pendingRecordingStop) handleRecordingStop(recConversation.id, ctx);
        if (pendingRecordingStart) handleRecordingStart(recConversation.id, { promptForSource: true }, socket, ctx);
      }

      ctx.send(socket, {
        type: 'task_routed',
        sessionId,
        interactionType: 'computer_use',
      });
    } else {
      // Create text QA session and immediately start processing
      const conversation = conversationStore.createConversation(GENERATING_TITLE);
      queueGenerateConversationTitle({
        conversationId: conversation.id,
        context: { origin: 'task_submit' },
        userMessage: msg.task,
      });
      ctx.socketToSession.set(socket, conversation.id);
      const session = await ctx.getOrCreateSession(conversation.id, socket, true);

      // Wire escalation handler so the agent can call computer_use_request_control
      wireEscalationHandler(session, socket, ctx, msg.screenWidth, msg.screenHeight);

      // Start deferred recording from mixed intent, now using the real conversation
      if (pendingRecordingStop) handleRecordingStop(conversation.id, ctx);
      if (pendingRecordingStart) handleRecordingStart(conversation.id, { promptForSource: true }, socket, ctx);

      ctx.send(socket, {
        type: 'task_routed',
        sessionId: conversation.id,
        interactionType: 'text_qa',
      });

      // Start streaming immediately — client doesn't need to send user_message
      session.processMessage(msg.task, msg.attachments ?? [], (event) => {
        ctx.send(socket, event);
      }, requestId).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        rlog.error({ err }, 'Error processing task_submit text QA');
        ctx.send(socket, { type: 'error', message: `Failed to process message: ${message}` });
        const classified = classifySessionError(err, { phase: 'agent_loop' });
        ctx.send(socket, buildSessionErrorMessage(conversation.id, classified));
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rlog.error({ err }, 'Error handling task_submit');
    ctx.send(socket, { type: 'error', message: `Failed to route task: ${message}` });
  }
}

// ─── Suggestion handler ─────────────────────────────────────────────────────

const SUGGESTION_CACHE_MAX = 100;
const suggestionCache = new Map<string, string>();
const suggestionInFlight = new Map<string, Promise<string | null>>();

export async function handleSuggestionRequest(
  msg: SuggestionRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const noSuggestion = () => {
    ctx.send(socket, {
      type: 'suggestion_response',
      requestId: msg.requestId,
      suggestion: null,
      source: 'none' as const,
    });
  };

  const rawMessages = conversationStore.getMessages(msg.sessionId);
  if (rawMessages.length === 0) { noSuggestion(); return; }

  // Find the most recent assistant message — only use it if it has text content.
  // Do NOT fall back to older turns; if the latest assistant message is tool-only,
  // return no suggestion rather than reusing stale text from a previous turn.
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const m = rawMessages[i];
    if (m.role !== 'assistant') continue;

    let content: unknown;
    try { content = JSON.parse(m.content); } catch { content = m.content; }
    const rendered = renderHistoryContent(content);
    const text = rendered.text.trim();
    if (!text) { noSuggestion(); return; }

    // Return cached suggestion
    const cached = suggestionCache.get(m.id);
    if (cached !== undefined) {
      ctx.send(socket, {
        type: 'suggestion_response',
        requestId: msg.requestId,
        suggestion: cached,
        source: 'llm' as const,
      });
      return;
    }

    // Try LLM suggestion using the configured provider
    const provider = getConfiguredProvider();
    if (provider) {
      try {
        let promise = suggestionInFlight.get(m.id);
        if (!promise) {
          promise = generateSuggestion(provider, text);
          suggestionInFlight.set(m.id, promise);
        }
        const llmSuggestion = await promise;
        suggestionInFlight.delete(m.id);

        if (llmSuggestion) {
          if (suggestionCache.size >= SUGGESTION_CACHE_MAX) {
            const oldest = suggestionCache.keys().next().value!;
            suggestionCache.delete(oldest);
          }
          suggestionCache.set(m.id, llmSuggestion);

          ctx.send(socket, {
            type: 'suggestion_response',
            requestId: msg.requestId,
            suggestion: llmSuggestion,
            source: 'llm' as const,
          });
          return;
        }
      } catch (err) {
        suggestionInFlight.delete(m.id);
        log.warn({ err }, 'LLM suggestion failed');
      }
    }

    noSuggestion();
    return;
  }

  noSuggestion();
}

async function generateSuggestion(provider: Provider, assistantText: string): Promise<string | null> {
  const truncated = assistantText.length > 2000
    ? assistantText.slice(-2000)
    : assistantText;

  const prompt = `Given this assistant message, write a very short tab-complete suggestion (max 50 chars) the user could send next to keep the conversation going. Be casual, curious, or actionable — like a quick reply, not a formal request. Reply with ONLY the suggestion text.\n\nAssistant's message:\n${truncated}`;
  const response = await provider.sendMessage(
    [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    [], // no tools
    undefined, // no system prompt
    { config: { max_tokens: 30 } },
  );

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && 'text' in textBlock ? textBlock.text.trim() : '';
  if (!raw || raw.length > 50) return null;

  const firstLine = raw.split('\n')[0].trim();
  return firstLine || null;
}

// ─── Link open handler ──────────────────────────────────────────────────────

export function handleLinkOpenRequest(
  msg: LinkOpenRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const parsed = new URL(msg.url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      log.warn({ url: msg.url }, 'link_open_request: blocked non-http URL');
      return;
    }
  } catch {
    log.warn({ url: msg.url }, 'link_open_request: invalid URL');
    return;
  }
  // V1: passthrough. Future: affiliate param injection based on metadata
  const finalUrl = msg.url;
  ctx.send(socket, { type: 'open_url', url: finalUrl });
}

// ─── IPC blob probe handler ─────────────────────────────────────────────────

export function handleIpcBlobProbe(
  msg: IpcBlobProbe,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  if (!isValidBlobId(msg.probeId)) {
    ctx.send(socket, {
      type: 'ipc_blob_probe_result',
      probeId: msg.probeId,
      ok: false,
      reason: 'invalid_probe_id',
    });
    return;
  }

  let filePath: string;
  try {
    filePath = resolveBlobPath(msg.probeId);
  } catch {
    ctx.send(socket, {
      type: 'ipc_blob_probe_result',
      probeId: msg.probeId,
      ok: false,
      reason: 'invalid_probe_id',
    });
    return;
  }

  let content: Buffer;
  try {
    content = readFileSync(filePath);
  } catch {
    ctx.send(socket, {
      type: 'ipc_blob_probe_result',
      probeId: msg.probeId,
      ok: false,
      reason: 'missing_probe_file',
    });
    return;
  }

  const observedHash = createHash('sha256').update(content).digest('hex');

  // Best-effort cleanup regardless of match outcome
  deleteBlob(msg.probeId);

  if (observedHash !== msg.nonceSha256) {
    ctx.send(socket, {
      type: 'ipc_blob_probe_result',
      probeId: msg.probeId,
      ok: false,
      observedNonceSha256: observedHash,
      reason: 'hash_mismatch',
    });
    return;
  }

  ctx.send(socket, {
    type: 'ipc_blob_probe_result',
    probeId: msg.probeId,
    ok: true,
    observedNonceSha256: observedHash,
  });
}

export const miscHandlers = defineHandlers({
  task_submit: handleTaskSubmit,
  suggestion_request: handleSuggestionRequest,
  link_open_request: handleLinkOpenRequest,
  ipc_blob_probe: handleIpcBlobProbe,
  ping: (_msg, socket, ctx) => { ctx.send(socket, { type: 'pong' }); },
});
