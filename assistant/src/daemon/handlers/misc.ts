import * as net from 'node:net';
import { v4 as uuid } from 'uuid';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as conversationStore from '../../memory/conversation-store.js';
import { getConfig } from '../../config/loader.js';
import { getFailoverProvider, listProviders } from '../../providers/registry.js';
import type { Provider } from '../../providers/types.js';
import { classifyInteraction } from '../classifier.js';
import { checkIngressForSecrets } from '../../security/secret-ingress.js';
import { parseSlashCandidate } from '../../skills/slash-commands.js';
import { classifySessionError, buildSessionErrorMessage } from '../session-error.js';
import { resolveBlobPath, deleteBlob, isValidBlobId } from '../ipc-blob-store.js';
import type {
  TaskSubmit,
  SuggestionRequest,
  LinkOpenRequest,
  IpcBlobProbe,
  CuSessionCreate,
} from '../ipc-protocol.js';
import { log, wireEscalationHandler, renderHistoryContent, defineHandlers, type HandlerContext } from './shared.js';
import { handleCuSessionCreate } from './computer-use.js';
import { detectQaIntent, shouldRouteQaToComputerUse } from '../qa-intent.js';
import { resolveComputerUseTargetAppHint } from '../target-app-hints.js';

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
      session.redirectToSecurePrompt(taskIngressCheck.detectedTypes, () => {
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
      });
      return;
    }

    // Slash candidates always route to text_qa — bypass classifier
    const slashCandidate = parseSlashCandidate(msg.task);
    const isQa = detectQaIntent(msg.task);
    const forceQaComputerUse = shouldRouteQaToComputerUse(msg.task);
    const interactionType = slashCandidate.kind === 'candidate'
      ? 'text_qa' as const
      : forceQaComputerUse
        ? 'computer_use' as const
        : await classifyInteraction(msg.task, msg.source);
    rlog.info({
      interactionType,
      slashBypass: slashCandidate.kind === 'candidate',
      taskLength: msg.task.length,
      isQa,
      forceQaComputerUse,
    }, 'Task classified');

    if (interactionType === 'computer_use') {
      // Create CU session (reuse handleCuSessionCreate logic)
      const sessionId = uuid();
      const targetApp = resolveComputerUseTargetAppHint(msg.task);
      const config = getConfig();
      const cuMsg: CuSessionCreate = {
        type: 'cu_session_create',
        sessionId,
        task: msg.task,
        screenWidth: msg.screenWidth,
        screenHeight: msg.screenHeight,
        attachments: msg.attachments,
        interactionType: 'computer_use',
        ...(targetApp ? { targetAppName: targetApp.appName, targetAppBundleId: targetApp.bundleId } : {}),
        ...(isQa ? { qaMode: true, reportToSessionId: msg.conversationId } : {}),
      };
      handleCuSessionCreate(cuMsg, socket, ctx);

      ctx.send(socket, {
        type: 'task_routed',
        sessionId,
        interactionType: 'computer_use',
        ...(isQa ? {
          qaMode: true,
          reportToSessionId: msg.conversationId,
          retentionDays: config.qaRecording.defaultRetentionDays,
          captureScope: config.qaRecording.captureScope,
          includeAudio: config.qaRecording.includeAudio,
        } : {}),
      });
    } else {
      // Create text QA session and immediately start processing
      const conversation = conversationStore.createConversation(msg.task);
      ctx.socketToSession.set(socket, conversation.id);
      const session = await ctx.getOrCreateSession(conversation.id, socket, true);

      // Wire escalation handler so the agent can call computer_use_request_control
      wireEscalationHandler(session, socket, ctx, msg.screenWidth, msg.screenHeight);

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
    const config = getConfig();
    if (listProviders().includes(config.provider)) {
      try {
        const provider = getFailoverProvider(config.provider, config.providerOrder);
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
