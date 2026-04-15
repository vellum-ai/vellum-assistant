/**
 * Queue drain and message processing logic extracted from Conversation.
 *
 * Conversation delegates `drainQueue` and `processMessage` to the module-level
 * functions exported here, following the same context-interface pattern
 * used by conversation-history.ts.
 */

import { enrichMessageWithSourcePaths } from "../agent/attachments.js";
import {
  createAssistantMessage,
  createUserMessage,
} from "../agent/message-types.js";
import {
  canServiceRegistryBrowser,
  parseChannelId,
  parseInterfaceId,
  supportsHostProxy,
  type TurnChannelContext,
  type TurnInterfaceContext,
} from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import type { ContextWindowResult } from "../context/window-manager.js";
import { listPendingRequestsByConversationScope } from "../memory/canonical-guardian-store.js";
import {
  addMessage,
  provenanceFromTrustContext,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
} from "../memory/conversation-crud.js";
import { extractPreferences } from "../notifications/preference-extractor.js";
import { createPreference } from "../notifications/preferences-store.js";
import type { Message } from "../providers/types.js";
import { routeGuardianReply } from "../runtime/guardian-reply-router.js";
import { getLogger } from "../util/logger.js";
import { persistQueuedMessageBody } from "./conversation-messaging.js";
import type {
  MessageQueue,
  QueuedMessage,
  QueueDrainReason,
} from "./conversation-queue-manager.js";
import type {
  ChannelCapabilities,
  TrustContext,
} from "./conversation-runtime-assembly.js";
import {
  classifySlash,
  resolveSlash,
  type SlashContext,
} from "./conversation-slash.js";
import { getModelInfo } from "./handlers/config-model.js";
import type {
  ServerMessage,
  UsageStats,
  UserMessageAttachment,
} from "./message-protocol.js";
import type { ConversationTransportMetadata } from "./message-types/conversations.js";
import type { TraceEmitter } from "./trace-emitter.js";
import { buildTransportHints } from "./transport-hints.js";
import { resolveVerificationSessionIntent } from "./verification-session-intent.js";

const log = getLogger("conversation-process");

/** Format the result of a forced compaction into a user-facing message. */
export function formatCompactResult(result: ContextWindowResult): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  if (!result.compacted) {
    return `Context compaction skipped — ${result.reason ?? "nothing to compact"}.`;
  }
  const saved =
    result.previousEstimatedInputTokens - result.estimatedInputTokens;
  return [
    "Context Compacted\n",
    `Tokens:   ${fmt(result.previousEstimatedInputTokens)} → ${fmt(result.estimatedInputTokens)} (${fmt(saved)} saved)`,
    `Messages: ${fmt(result.compactedMessages)} compacted`,
  ].join("\n");
}

/** Build a model_info event with fresh config data. */
export async function buildModelInfoEvent(): Promise<ServerMessage> {
  return { type: "model_info", ...(await getModelInfo()) };
}

/** True when the trimmed content is the /models slash command. */
export function isModelSlashCommand(content: string): boolean {
  return content.trim() === "/models";
}

// ── Context Interface ────────────────────────────────────────────────

/**
 * Subset of Conversation state that drainQueue / processMessage need access to.
 * The Conversation class implements this interface so its instances can be
 * passed directly to the extracted functions.
 */
export interface ProcessConversationContext {
  readonly conversationId: string;
  messages: Message[];
  processing: boolean;
  abortController: AbortController | null;
  currentRequestId?: string;
  readonly queue: MessageQueue;
  readonly traceEmitter: TraceEmitter;
  /**
   * Set of requestIds created by surface-action responses. Used to
   * distinguish surface-action turns from regular user turns (e.g. for
   * stale-surface auto-dismiss guards and batched-drain exclusion).
   */
  readonly surfaceActionRequestIds: Set<string>;
  currentActiveSurfaceId?: string;
  currentPage?: string;
  /** Cumulative token usage stats for the conversation. */
  readonly usageStats: UsageStats;
  /** Request-scoped skill IDs preactivated via config or programmatic injection. */
  preactivatedSkillIds?: string[];
  /** Add a skill ID to the preactivated set without replacing existing entries. */
  addPreactivatedSkillId(id: string): void;
  /** Assistant identity — used for scoping notification preferences. */
  readonly assistantId?: string;
  trustContext?: TrustContext;
  channelCapabilities?: ChannelCapabilities;
  /** Per-turn snapshot of trustContext, frozen at message-processing start. */
  currentTurnTrustContext?: TrustContext;
  /** Per-turn snapshot of channelCapabilities, frozen at message-processing start. */
  currentTurnChannelCapabilities?: ChannelCapabilities;
  ensureActorScopedHistory(): Promise<void>;
  persistUserMessage(
    content: string,
    attachments: UserMessageAttachment[],
    requestId?: string,
    metadata?: Record<string, unknown>,
    displayContent?: string,
  ): Promise<string>;
  runAgentLoop(
    content: string,
    userMessageId: string,
    onEvent: (msg: ServerMessage) => void,
    options?: {
      skipPreMessageRollback?: boolean;
      isInteractive?: boolean;
      isUserMessage?: boolean;
      titleText?: string;
    },
  ): Promise<void>;
  getTurnChannelContext(): TurnChannelContext | null;
  setTurnChannelContext(ctx: TurnChannelContext): void;
  getTurnInterfaceContext(): TurnInterfaceContext | null;
  setTurnInterfaceContext(ctx: TurnInterfaceContext): void;
  /** Mark host proxies as unavailable so tool execution uses local fallback. */
  clearProxyAvailability(): void;
  /**
   * Restore host proxy availability based on whether a real client is connected.
   * When `skipBrowser` is true, the browser proxy is left untouched — use this
   * when `restoreBrowserProxyAvailability()` will handle the browser proxy
   * separately with the correct registry-routed sender.
   */
  restoreProxyAvailability(options?: { skipBrowser?: boolean }): void;
  /** Restore only the host browser proxy (used by chrome-extension and macOS+extension drains). */
  restoreBrowserProxyAvailability(): void;
  /**
   * Registry-routed sender override for the host browser proxy. When set,
   * `restoreBrowserProxyAvailability()` uses this function instead of
   * `sendToClient`. Set by the POST /messages handler when the guardian
   * has an active extension connection (regardless of interface).
   */
  hostBrowserSenderOverride?: (msg: ServerMessage) => void;
  /** Replace or clear the conversation's host browser proxy. */
  setHostBrowserProxy(
    proxy: import("./host-browser-proxy.js").HostBrowserProxy | undefined,
  ): void;
  emitActivityState(
    phase:
      | "idle"
      | "thinking"
      | "streaming"
      | "tool_running"
      | "awaiting_confirmation",
    reason:
      | "message_dequeued"
      | "thinking_delta"
      | "first_text_delta"
      | "tool_use_start"
      | "tool_result_received"
      | "confirmation_requested"
      | "confirmation_resolved"
      | "message_complete"
      | "generation_cancelled"
      | "error_terminal"
      | "preview_start"
      | "context_compacting",
    anchor?: "assistant_turn" | "user_turn" | "global",
    requestId?: string,
    statusText?: string,
  ): void;
  /** Force context compaction regardless of threshold/cooldown. */
  forceCompact(): Promise<ContextWindowResult>;
  /** Set transport-derived hints for the conversation. */
  setTransportHints(hints: string[] | undefined): void;
  /**
   * Apply client-reported host env (home dir, username) from transport
   * metadata, gating on `supportsHostProxy` so non-host-proxy interfaces
   * clear any stale values. Shared between the create/reuse path in
   * `DaemonServer.applyTransportMetadata` and the queue-drain path below.
   */
  applyHostEnvFromTransport(transport: ConversationTransportMetadata): void;
}

function resolveQueuedTurnContext(
  queued: {
    turnChannelContext?: TurnChannelContext;
    metadata?: Record<string, unknown>;
  },
  fallback: TurnChannelContext | null,
): TurnChannelContext | null {
  if (queued.turnChannelContext) return queued.turnChannelContext;
  const metadata = queued.metadata;
  if (metadata) {
    const userMessageChannel = parseChannelId(metadata.userMessageChannel);
    const assistantMessageChannel = parseChannelId(
      metadata.assistantMessageChannel,
    );
    if (userMessageChannel && assistantMessageChannel) {
      return { userMessageChannel, assistantMessageChannel };
    }
  }
  return fallback;
}

function resolveQueuedTurnInterfaceContext(
  queued: {
    turnInterfaceContext?: TurnInterfaceContext;
    metadata?: Record<string, unknown>;
  },
  fallback: TurnInterfaceContext | null,
): TurnInterfaceContext | null {
  if (queued.turnInterfaceContext) return queued.turnInterfaceContext;
  const metadata = queued.metadata;
  if (metadata) {
    const userMessageInterface = parseInterfaceId(
      metadata.userMessageInterface,
    );
    const assistantMessageInterface = parseInterfaceId(
      metadata.assistantMessageInterface,
    );
    if (userMessageInterface && assistantMessageInterface) {
      return { userMessageInterface, assistantMessageInterface };
    }
  }
  return fallback;
}

/** Build a SlashContext from the current conversation state and config. */
function buildSlashContext(
  conversation: ProcessConversationContext,
): SlashContext {
  const config = getConfig();
  const turnInterface = conversation.getTurnInterfaceContext();
  return {
    messageCount: conversation.messages.length,
    inputTokens: conversation.usageStats.inputTokens,
    outputTokens: conversation.usageStats.outputTokens,
    maxInputTokens: config.contextWindow.maxInputTokens,
    model: config.services.inference.model,
    provider: config.services.inference.provider,
    estimatedCost: conversation.usageStats.estimatedCost,
    userMessageInterface: turnInterface?.userMessageInterface,
  };
}

/**
 * Walk the head of the queue and return the longest contiguous run of
 * passthrough messages (non-slash, non-verification-intent) that share the
 * same `userMessageInterface`. Returns `[]` when the head is itself a slash
 * command or verification-intent direct-setup — in that case `drainQueue`
 * pops the head via `queue.shift()` and the single-message path handles it.
 *
 * The builder uses `peek` for lookahead and only calls `shiftN(matched)` once
 * a contiguous passthrough run is identified. This keeps byte-budget
 * accounting centralized in `MessageQueue` rather than mutating mid-walk.
 */
async function buildPassthroughBatch(
  conversation: ProcessConversationContext,
): Promise<QueuedMessage[]> {
  const head = conversation.queue.peek(0);
  if (head === undefined) return [];

  const headInterface = resolveQueuedTurnInterfaceContext(
    head,
    conversation.getTurnInterfaceContext(),
  );
  // Pure classifier — no side effects. `resolveSlash` runs /pair's side
  // effects (pairing registration, QR PNG write); if we called it here the
  // real drain would invoke those again and the second call would fail with
  // "active pairing already in progress".
  if (classifySlash(head.content) !== "passthrough") return [];
  if (resolveVerificationSessionIntent(head.content).kind === "direct_setup") {
    // Verification intents stay on the single-message path so their per-turn
    // skill preactivation isn't leaked into batched tail messages.
    return [];
  }
  // Surface-action messages rely on per-message `activeSurfaceId` and
  // `surfaceActionRequestIds` semantics that last-wins batching would
  // corrupt (e.g. erasing the head's surface context when the last tail is
  // a regular text message). Keep them on the single-message path.
  if (
    head.activeSurfaceId !== undefined ||
    conversation.surfaceActionRequestIds.has(head.requestId)
  ) {
    return [];
  }

  let i = 1;
  for (;;) {
    const candidate = conversation.queue.peek(i);
    if (candidate === undefined) break;
    const candIf = resolveQueuedTurnInterfaceContext(
      candidate,
      conversation.getTurnInterfaceContext(),
    );
    // Treat an undefined interface as distinct from a defined one so we don't
    // silently batch cross-interface messages whose env/transport would
    // otherwise diverge.
    if (candIf?.userMessageInterface !== headInterface?.userMessageInterface)
      break;
    if (classifySlash(candidate.content) !== "passthrough") break;
    if (
      resolveVerificationSessionIntent(candidate.content).kind ===
      "direct_setup"
    )
      break;
    // Stop at the first surface-action tail; it will drain via the single-
    // message path so its per-message surface context is preserved.
    if (
      candidate.activeSurfaceId !== undefined ||
      conversation.surfaceActionRequestIds.has(candidate.requestId)
    ) {
      break;
    }
    i++;
  }

  const matched = i;
  return conversation.queue.shiftN(matched);
}

// ── drainQueue ───────────────────────────────────────────────────────

/**
 * Process the next message in the queue, if any.
 * Called from the `runAgentLoop` finally block after processing completes.
 *
 * When a dequeued message fails to persist (e.g. empty content, DB error),
 * `processMessage` catches the error and resolves without calling
 * `runAgentLoop`. Since the drain chain depends on `runAgentLoop`'s `finally`
 * block, we must explicitly continue draining on failure — otherwise
 * remaining queued messages would be stranded.
 */
export async function drainQueue(
  conversation: ProcessConversationContext,
  reason: QueueDrainReason = "loop_complete",
): Promise<void> {
  const batch = await buildPassthroughBatch(conversation);
  if (batch.length === 0) {
    // Head is a slash / verification intent / empty queue. If the queue has
    // an item the builder rejected, pop it and hand it to the single-message
    // path — which owns slash / compact / verification-intent behavior.
    const next = conversation.queue.shift();
    if (!next) return;
    return drainSingleMessage(conversation, next, reason);
  }
  if (batch.length === 1) {
    return drainSingleMessage(conversation, batch[0], reason);
  }
  return drainBatch(conversation, batch, reason);
}

async function drainSingleMessage(
  conversation: ProcessConversationContext,
  next: QueuedMessage,
  reason: QueueDrainReason,
): Promise<void> {
  // Reset per-turn preactivation so a prior iteration (e.g. an unknown-slash
  // from a desktop source that skips runAgentLoop) can't leak CU preactivation
  // into the next queued message.
  conversation.preactivatedSkillIds = undefined;

  log.info(
    {
      conversationId: conversation.conversationId,
      requestId: next.requestId,
      reason,
    },
    "Dequeuing message",
  );
  conversation.traceEmitter.emit(
    "request_dequeued",
    `Message dequeued (${reason})`,
    {
      requestId: next.requestId,
      status: "info",
      attributes: { reason },
    },
  );
  next.onEvent({
    type: "message_dequeued",
    conversationId: conversation.conversationId,
    requestId: next.requestId,
  });
  conversation.emitActivityState(
    "thinking",
    "message_dequeued",
    "assistant_turn",
    next.requestId,
  );

  const queuedTurnCtx = resolveQueuedTurnContext(
    next,
    conversation.getTurnChannelContext(),
  );
  if (queuedTurnCtx) {
    conversation.setTurnChannelContext(queuedTurnCtx);
  }

  const queuedInterfaceCtx = resolveQueuedTurnInterfaceContext(
    next,
    conversation.getTurnInterfaceContext(),
  );
  if (queuedInterfaceCtx) {
    conversation.setTurnInterfaceContext(queuedInterfaceCtx);
  }

  // Apply transport hints from the queued message so each turn uses the
  // transport metadata that arrived with its message. Messages without
  // transport (subagent notifications, surface actions, etc.) inherit the
  // conversation's existing hints — clearing them would erase the user's
  // environment context for internal turns.
  if (next.transport) {
    conversation.setTransportHints(buildTransportHints(next.transport));
    // Route client-reported host env through the same capability-gated
    // setter used by DaemonServer.applyTransportMetadata so create/reuse
    // and queue-drain stay in sync without duplicating the gate logic.
    conversation.applyHostEnvFromTransport(next.transport);
  }

  // Non-interactive queued messages (channel requests) must not execute tools
  // via the desktop host proxy. Clear proxy availability so isAvailable()
  // returns false and tool execution falls back to local.
  if (next.isInteractive === false) {
    conversation.clearProxyAvailability();
    // chrome-extension is non-interactive (no SSE prompter UI) but DOES have
    // a connected client that can service host_browser_request events. The
    // unconditional clear above turned its hostBrowserProxy off; restore it
    // here so the queued turn can still drive the browser via CDP.
    const drainInterfaceCtx =
      queuedInterfaceCtx ?? conversation.getTurnInterfaceContext();
    const drainInterface = drainInterfaceCtx?.userMessageInterface;
    if (
      drainInterface &&
      !supportsHostProxy(drainInterface) &&
      supportsHostProxy(drainInterface, "host_browser")
    ) {
      conversation.restoreBrowserProxyAvailability();
    }
  } else {
    // Restore proxy availability only for desktop-originating turns (macos)
    // in case a prior non-interactive drain disabled it. Non-desktop interactive
    // interfaces (CLI, Vellum) should not re-enable desktop host proxies. The
    // chrome-extension interface only supports host_browser, not the desktop
    // proxies or computer-use, so it is excluded by the no-arg form of
    // supportsHostProxy (which returns false for chrome-extension).
    const interfaceCtx =
      queuedInterfaceCtx ?? conversation.getTurnInterfaceContext();
    const sourceInterface = interfaceCtx?.userMessageInterface;
    if (sourceInterface && supportsHostProxy(sourceInterface)) {
      // When hostBrowserSenderOverride is set, skip the browser proxy here
      // — restoreBrowserProxyAvailability() below will handle it with the
      // correct registry-routed sender instead of the SSE hub emitter.
      conversation.restoreProxyAvailability(
        conversation.hostBrowserSenderOverride
          ? { skipBrowser: true }
          : undefined,
      );
      conversation.addPreactivatedSkillId("computer-use");
    }
    // Tear down a stale hostBrowserProxy inherited from a prior turn on a
    // different interface (e.g. chrome-extension installed one, then a CLI
    // turn drains). Without this, restoreProxyAvailability() above would
    // re-enable the proxy and getCdpClient() would route browser tools
    // through host_browser_request and hang waiting for a client that this
    // turn's interface can't service.
    //
    // Skip teardown only when BOTH conditions hold:
    //   1. `hostBrowserSenderOverride` is set (live registry-routed sender)
    //   2. The current turn's interface can service host_browser frames
    //      (chrome-extension or macOS).
    // Without the interface check, queued turns from CLI/iOS/Vellum would
    // inherit a stale override left by a prior extension-connected turn
    // and keep the proxy alive, causing cross-interface misrouting.
    const currentTurnCanServiceBrowser =
      !!sourceInterface && canServiceRegistryBrowser(sourceInterface);
    if (
      sourceInterface &&
      !supportsHostProxy(sourceInterface, "host_browser") &&
      !(conversation.hostBrowserSenderOverride && currentTurnCanServiceBrowser)
    ) {
      conversation.setHostBrowserProxy(undefined);
    }
    // When a macOS turn has a registry-routed sender override (active
    // extension connection), restore the browser proxy so host_browser
    // tools route through the extension rather than cdp-inspect/local.
    if (
      sourceInterface &&
      supportsHostProxy(sourceInterface) &&
      conversation.hostBrowserSenderOverride
    ) {
      conversation.restoreBrowserProxyAvailability();
    }
  }

  // Snapshot persona context at turn start so later tool turns can't pick up
  // a different actor's context if a concurrent request mutates the live fields.
  conversation.currentTurnTrustContext = conversation.trustContext;
  conversation.currentTurnChannelCapabilities =
    conversation.channelCapabilities;

  // Resolve slash commands for queued messages
  const slashResult = await resolveSlash(
    next.content,
    buildSlashContext(conversation),
  );

  // Unknown slash — persist the exchange and continue draining.
  // Persist each message before pushing to conversation.messages so that a
  // failed write never leaves an unpersisted message in memory.
  if (slashResult.kind === "unknown") {
    try {
      const drainProvenance = provenanceFromTrustContext(
        conversation.trustContext,
      );
      const drainImageSourcePaths: Record<string, string> = {};
      for (let i = 0; i < next.attachments.length; i++) {
        const a = next.attachments[i];
        if (a.filePath && a.mimeType.toLowerCase().startsWith("image/")) {
          drainImageSourcePaths[`${i}:${a.filename}`] = a.filePath;
        }
      }
      const drainChannelMeta = {
        ...drainProvenance,
        ...(queuedTurnCtx
          ? {
              userMessageChannel: queuedTurnCtx.userMessageChannel,
              assistantMessageChannel: queuedTurnCtx.assistantMessageChannel,
            }
          : {}),
        ...(queuedInterfaceCtx
          ? {
              userMessageInterface: queuedInterfaceCtx.userMessageInterface,
              assistantMessageInterface:
                queuedInterfaceCtx.assistantMessageInterface,
            }
          : {}),
        ...(next.metadata?.automated ? { automated: true } : {}),
        ...(Object.keys(drainImageSourcePaths).length > 0
          ? { imageSourcePaths: drainImageSourcePaths }
          : {}),
        sentAt: next.sentAt,
      };
      const cleanUserMsg = createUserMessage(next.content, next.attachments);
      const llmUserMsg = enrichMessageWithSourcePaths(
        cleanUserMsg,
        next.attachments,
      );
      // When displayContent is provided (e.g. original text before recording
      // intent stripping), persist that to DB so users see the full message.
      // The in-memory userMessage (sent to the LLM) still uses the stripped content.
      const contentToPersist = next.displayContent
        ? JSON.stringify(
            createUserMessage(next.displayContent, next.attachments).content,
          )
        : JSON.stringify(cleanUserMsg.content);
      await addMessage(
        conversation.conversationId,
        "user",
        contentToPersist,
        drainChannelMeta,
      );
      conversation.messages.push(llmUserMsg);

      const assistantMsg = createAssistantMessage(slashResult.message);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { ...drainChannelMeta, sentAt: Date.now() },
      );
      conversation.messages.push(assistantMsg);

      if (queuedTurnCtx) {
        setConversationOriginChannelIfUnset(
          conversation.conversationId,
          queuedTurnCtx.userMessageChannel,
        );
      }
      if (queuedInterfaceCtx) {
        setConversationOriginInterfaceIfUnset(
          conversation.conversationId,
          queuedInterfaceCtx.userMessageInterface,
        );
      }

      // Emit fresh model info before the text delta so the client has
      // up-to-date configuredProviders when rendering /model or /models UI.
      if (isModelSlashCommand(next.content)) {
        next.onEvent(await buildModelInfoEvent());
      }
      next.onEvent({ type: "assistant_text_delta", text: slashResult.message });
      conversation.traceEmitter.emit(
        "message_complete",
        "Unknown slash command handled",
        {
          requestId: next.requestId,
          status: "success",
        },
      );
      next.onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: next.requestId,
        },
        "Failed to persist unknown-slash exchange",
      );
      conversation.traceEmitter.emit(
        "request_error",
        `Unknown-slash persist failed: ${message}`,
        {
          requestId: next.requestId,
          status: "error",
          attributes: { reason: "persist_failure" },
        },
      );
      next.onEvent({ type: "error", message });
    }
    // Continue draining regardless of success/failure
    await drainQueue(conversation);
    return;
  }

  // /compact — force context compaction, persist exchange, continue draining.
  if (slashResult.kind === "compact") {
    try {
      const drainProvenance = provenanceFromTrustContext(
        conversation.trustContext,
      );
      const drainChannelMeta = {
        ...drainProvenance,
        ...(queuedTurnCtx
          ? {
              userMessageChannel: queuedTurnCtx.userMessageChannel,
              assistantMessageChannel: queuedTurnCtx.assistantMessageChannel,
            }
          : {}),
        ...(queuedInterfaceCtx
          ? {
              userMessageInterface: queuedInterfaceCtx.userMessageInterface,
              assistantMessageInterface:
                queuedInterfaceCtx.assistantMessageInterface,
            }
          : {}),
        sentAt: next.sentAt,
      };
      const cleanUserMsg = createUserMessage(next.content, next.attachments);
      await addMessage(
        conversation.conversationId,
        "user",
        JSON.stringify(cleanUserMsg.content),
        drainChannelMeta,
      );
      conversation.messages.push(cleanUserMsg);

      conversation.emitActivityState(
        "thinking",
        "context_compacting",
        "assistant_turn",
        next.requestId,
      );
      const result = await conversation.forceCompact();
      const responseText = formatCompactResult(result);

      const assistantMsg = createAssistantMessage(responseText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { ...drainChannelMeta, sentAt: Date.now() },
      );
      conversation.messages.push(assistantMsg);

      next.onEvent({ type: "assistant_text_delta", text: responseText });
      conversation.traceEmitter.emit(
        "message_complete",
        "Compact slash command handled",
        { requestId: next.requestId, status: "success" },
      );
      next.onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: next.requestId,
        },
        "Failed to execute /compact",
      );
      next.onEvent({ type: "error", message });
    }
    await drainQueue(conversation);
    return;
  }

  const resolvedContent = slashResult.content;

  // Guardian verification intent interception for queued messages.
  // Preserve the original user content for persistence; only the agent
  // loop receives the rewritten instruction.
  let agentLoopContent = resolvedContent;
  if (slashResult.kind === "passthrough") {
    const verificationIntent =
      resolveVerificationSessionIntent(resolvedContent);
    if (verificationIntent.kind === "direct_setup") {
      log.info(
        {
          conversationId: conversation.conversationId,
          channelHint: verificationIntent.channelHint,
        },
        "Verification session intent intercepted in queue — forcing skill flow",
      );
      agentLoopContent = verificationIntent.rewrittenContent;
      conversation.preactivatedSkillIds = ["guardian-verify-setup"];
    }
  }

  // Try to persist and run the dequeued message. If persistUserMessage
  // succeeds, runAgentLoop is called and its finally block will drain
  // the next message. If persistUserMessage fails, processMessage
  // resolves early (no runAgentLoop call), so we must continue draining.
  let userMessageId: string;
  try {
    userMessageId = await conversation.persistUserMessage(
      resolvedContent,
      next.attachments,
      next.requestId,
      { ...next.metadata, sentAt: next.sentAt },
      next.displayContent,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      {
        err,
        conversationId: conversation.conversationId,
        requestId: next.requestId,
      },
      "Failed to persist queued message",
    );
    conversation.traceEmitter.emit(
      "request_error",
      `Queued message persist failed: ${message}`,
      {
        requestId: next.requestId,
        status: "error",
        attributes: { reason: "persist_failure" },
      },
    );
    next.onEvent({ type: "error", message });
    // runAgentLoop never ran, so its finally block won't clear this
    conversation.preactivatedSkillIds = undefined;
    // Continue draining — don't strand remaining messages
    await drainQueue(conversation);
    return;
  }

  // Broadcast the user message to all hub subscribers so passive devices
  // see the user turn before the assistant reply starts streaming.
  next.onEvent({
    type: "user_message_echo",
    text: resolvedContent,
    conversationId: conversation.conversationId,
    messageId: userMessageId,
    requestId: next.requestId,
  });

  // Set the active surface for the dequeued message so runAgentLoop can inject context
  conversation.currentActiveSurfaceId = next.activeSurfaceId;
  conversation.currentPage = next.currentPage;

  // Fire-and-forget: detect notification preferences in the queued message
  // and persist any that are found, mirroring the logic in processMessage.
  if (conversation.assistantId) {
    extractPreferences(resolvedContent)
      .then((result) => {
        if (!result.detected) return;
        for (const pref of result.preferences) {
          createPreference({
            preferenceText: pref.preferenceText,
            appliesWhen: pref.appliesWhen,
            priority: pref.priority,
          });
        }
        log.info(
          {
            count: result.preferences.length,
            conversationId: conversation.conversationId,
          },
          "Persisted extracted notification preferences (queued)",
        );
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err: errMsg, conversationId: conversation.conversationId },
          "Background preference extraction failed (queued)",
        );
      });
  }

  // Fire-and-forget: persistUserMessage set conversation.processing = true
  // so subsequent messages will still be enqueued.
  // runAgentLoop's finally block will call drainQueue when this run completes.
  const drainLoopOptions: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
  } = { isUserMessage: true };
  if (next.isInteractive !== undefined)
    drainLoopOptions.isInteractive = next.isInteractive;
  if (agentLoopContent !== resolvedContent)
    drainLoopOptions.titleText = resolvedContent;

  conversation
    .runAgentLoop(
      agentLoopContent,
      userMessageId,
      next.onEvent,
      drainLoopOptions,
    )
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: next.requestId,
        },
        "Error processing queued message",
      );
      next.onEvent({
        type: "error",
        message: `Failed to process queued message: ${message}`,
      });
    });
}

// Drives a batched turn where multiple queued passthrough messages share one
// runAgentLoop run. Per-message dequeue events and DB persistence are
// preserved; the agent reply fans out to every batched client.
async function drainBatch(
  conversation: ProcessConversationContext,
  batch: QueuedMessage[],
  reason: QueueDrainReason,
): Promise<void> {
  // Head-wins: the batch-builder guarantees identical userMessageInterface
  // across the batch; channel/transport divergence is accepted with the head's
  // environment.
  const head = batch[0];

  // Reset per-turn preactivation so a prior iteration can't leak CU
  // preactivation into this batched turn.
  conversation.preactivatedSkillIds = undefined;

  log.info(
    {
      conversationId: conversation.conversationId,
      requestId: head.requestId,
      reason,
      batchSize: batch.length,
    },
    "Dequeuing batched messages",
  );

  const queuedTurnCtx = resolveQueuedTurnContext(
    head,
    conversation.getTurnChannelContext(),
  );
  if (queuedTurnCtx) {
    conversation.setTurnChannelContext(queuedTurnCtx);
  }

  const queuedInterfaceCtx = resolveQueuedTurnInterfaceContext(
    head,
    conversation.getTurnInterfaceContext(),
  );
  if (queuedInterfaceCtx) {
    conversation.setTurnInterfaceContext(queuedInterfaceCtx);
  }

  // Apply transport hints from the head message so this batched turn uses
  // the head's transport metadata. Tail transport divergence is accepted
  // per the head-wins contract.
  if (head.transport) {
    conversation.setTransportHints(buildTransportHints(head.transport));
    conversation.applyHostEnvFromTransport(head.transport);
  }

  // Non-interactive queued messages (channel requests) must not execute tools
  // via the desktop host proxy. Clear proxy availability so isAvailable()
  // returns false and tool execution falls back to local. Mirrors the
  // single-message path exactly — sourced from `head`.
  if (head.isInteractive === false) {
    conversation.clearProxyAvailability();
    const drainInterfaceCtx =
      queuedInterfaceCtx ?? conversation.getTurnInterfaceContext();
    const drainInterface = drainInterfaceCtx?.userMessageInterface;
    if (
      drainInterface &&
      !supportsHostProxy(drainInterface) &&
      supportsHostProxy(drainInterface, "host_browser")
    ) {
      conversation.restoreBrowserProxyAvailability();
    }
  } else {
    const interfaceCtx =
      queuedInterfaceCtx ?? conversation.getTurnInterfaceContext();
    const sourceInterface = interfaceCtx?.userMessageInterface;
    if (sourceInterface && supportsHostProxy(sourceInterface)) {
      conversation.restoreProxyAvailability(
        conversation.hostBrowserSenderOverride
          ? { skipBrowser: true }
          : undefined,
      );
      conversation.addPreactivatedSkillId("computer-use");
    }
    const currentTurnCanServiceBrowser =
      !!sourceInterface && canServiceRegistryBrowser(sourceInterface);
    if (
      sourceInterface &&
      !supportsHostProxy(sourceInterface, "host_browser") &&
      !(conversation.hostBrowserSenderOverride && currentTurnCanServiceBrowser)
    ) {
      conversation.setHostBrowserProxy(undefined);
    }
    if (
      sourceInterface &&
      supportsHostProxy(sourceInterface) &&
      conversation.hostBrowserSenderOverride
    ) {
      conversation.restoreBrowserProxyAvailability();
    }
  }

  // Snapshot persona context at turn start so later tool turns can't pick up
  // a different actor's context if a concurrent request mutates the live fields.
  conversation.currentTurnTrustContext = conversation.trustContext;
  conversation.currentTurnChannelCapabilities =
    conversation.channelCapabilities;

  // Single activity-state transition for the batched turn. Per-message
  // emissions would publish N "thinking" phase transitions to every
  // connected SSE client (via activityVersion increments), whipsawing the
  // client-side thinking indicator. The single-message path emits exactly
  // one such event per turn; match it here.
  conversation.emitActivityState(
    "thinking",
    "message_dequeued",
    "assistant_turn",
    head.requestId,
  );

  // Per-message dequeue events and persistence loop. Track the last
  // SUCCESSFUL persist separately from the batch tail — a failed tail
  // must not corrupt the requestId/surface context that `runAgentLoop`
  // will tag `message_complete` / `generation_cancelled` with.
  let lastSuccessfulRequestId: string | undefined;
  let lastSuccessfulActiveSurfaceId: string | undefined;
  let lastSuccessfulCurrentPage: string | undefined;
  let lastSuccessfulContent: string | undefined;
  let lastUserMessageId: string | undefined;
  // Members whose persist succeeded. `fanOutOnEvent` below must only
  // broadcast agent-loop events to these — clients whose persist failed
  // already received an error event and must not also receive the
  // assistant's streaming response for a turn that isn't theirs.
  const successfulBatch: QueuedMessage[] = [];
  for (let i = 0; i < batch.length; i++) {
    const qm = batch[i];
    qm.onEvent({
      type: "message_dequeued",
      conversationId: conversation.conversationId,
      requestId: qm.requestId,
    });
    conversation.traceEmitter.emit(
      "request_dequeued",
      "Message dequeued (batched)",
      {
        requestId: qm.requestId,
        status: "info",
        attributes: { reason, batchIndex: i, batchSize: batch.length },
      },
    );

    const qmSlash = await resolveSlash(
      qm.content,
      buildSlashContext(conversation),
    );
    if (qmSlash.kind !== "passthrough") {
      // Defensive recovery. `buildPassthroughBatch` should make this
      // unreachable, but if it ever fires we must avoid stranding
      // per-turn state and dropping the batch tails that have already
      // been shifted out of the queue. Log, emit an error to the
      // affected client, and either recover-and-drain (head case) or
      // skip the tail (tail case) so the rest of the batch still runs.
      const invariantMessage =
        "Internal error: batch drain invariant violated (non-passthrough message in batch)";
      log.error(
        {
          conversationId: conversation.conversationId,
          requestId: qm.requestId,
          batchIndex: i,
          batchSize: batch.length,
          slashKind: qmSlash.kind,
        },
        "drainBatch invariant violated — non-passthrough message found in batch",
      );
      conversation.traceEmitter.emit("request_error", invariantMessage, {
        requestId: qm.requestId,
        status: "error",
        attributes: { reason: "batch_invariant_violation" },
      });
      qm.onEvent({ type: "error", message: invariantMessage });
      if (i === 0) {
        // Head invariant fired — no in-flight turn yet (the check runs
        // before persistUserMessage, so the head was never persisted).
        // Clear per-turn state and recursively drain the remaining tails,
        // which were already shifted out of the queue by
        // buildPassthroughBatch and would otherwise be stranded. Mirrors
        // the head persist-failure recovery below.
        conversation.processing = false;
        conversation.abortController = null;
        conversation.currentRequestId = undefined;
        conversation.preactivatedSkillIds = undefined;
        const remaining = batch.slice(1);
        if (remaining.length >= 2) {
          await drainBatch(conversation, remaining, reason);
        } else if (remaining.length === 1) {
          await drainSingleMessage(conversation, remaining[0], reason);
        } else {
          await drainQueue(conversation);
        }
        return;
      }
      // Tail case — processing is live, just skip this message. Loop
      // continues to drain any remaining tails.
      continue;
    }
    const qmContent = qmSlash.content;

    try {
      if (i === 0) {
        lastUserMessageId = await conversation.persistUserMessage(
          qmContent,
          qm.attachments,
          qm.requestId,
          { ...qm.metadata, sentAt: qm.sentAt },
          qm.displayContent,
        );
      } else {
        lastUserMessageId = await persistQueuedMessageBody(
          conversation,
          qmContent,
          qm.attachments,
          qm.requestId,
          { ...qm.metadata, sentAt: qm.sentAt },
          qm.displayContent,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: qm.requestId,
          batchIndex: i,
        },
        "Failed to persist batched queued message",
      );
      conversation.traceEmitter.emit(
        "request_error",
        `Queued message persist failed: ${message}`,
        {
          requestId: qm.requestId,
          status: "error",
          attributes: { reason: "persist_failure" },
        },
      );
      qm.onEvent({ type: "error", message });

      if (i === 0) {
        // Head persist failed — processing is not set yet, no in-flight turn
        // to fan tails into. We've already shifted the tails out of the queue
        // as part of this batch, so if we simply called drainQueue the tails
        // would be stranded. Reset per-turn state and recursively drain the
        // remaining tails (they're still valid by the batch invariant).
        conversation.preactivatedSkillIds = undefined;
        const remaining = batch.slice(1);
        if (remaining.length >= 2) {
          await drainBatch(conversation, remaining, reason);
        } else if (remaining.length === 1) {
          await drainSingleMessage(conversation, remaining[0], reason);
        } else {
          await drainQueue(conversation);
        }
        return;
      }
      // Tail persist failed — we cannot abandon the batch without stranding
      // the head's in-flight turn. Processing state is already set; skip
      // this message and continue accumulating siblings. The emitted error
      // event lets the tail client see the failure. Crucially we do NOT
      // update lastSuccessful* here, so runAgentLoop tags completion with
      // the most recent successfully-persisted message's requestId.
      continue;
    }

    // Broadcast the user message to all hub subscribers so passive devices
    // see each batched user turn before the assistant reply starts streaming.
    qm.onEvent({
      type: "user_message_echo",
      text: qmContent,
      conversationId: conversation.conversationId,
      messageId: lastUserMessageId,
      requestId: qm.requestId,
    });

    // Persist succeeded. Update last-successful markers so a later tail
    // failure won't overwrite them.
    lastSuccessfulRequestId = qm.requestId;
    lastSuccessfulActiveSurfaceId = qm.activeSurfaceId;
    lastSuccessfulCurrentPage = qm.currentPage;
    lastSuccessfulContent = qmContent;
    successfulBatch.push(qm);

    // Fire-and-forget: detect notification preferences in each batched user
    // message and persist any that are found, mirroring drainSingleMessage.
    if (conversation.assistantId) {
      extractPreferences(qmContent)
        .then((result) => {
          if (!result.detected) return;
          for (const pref of result.preferences) {
            createPreference({
              preferenceText: pref.preferenceText,
              appliesWhen: pref.appliesWhen,
              priority: pref.priority,
            });
          }
          log.info(
            {
              count: result.preferences.length,
              conversationId: conversation.conversationId,
            },
            "Persisted extracted notification preferences (batched)",
          );
        })
        .catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn(
            { err: errMsg, conversationId: conversation.conversationId },
            "Background preference extraction failed (batched)",
          );
        });
    }

    // If the user hit abort mid-batch, stop persisting remaining tails.
    // runAgentLoop's existing abort handling will emit generation_cancelled
    // and clear processing state for whatever did persist.
    if (conversation.abortController?.signal.aborted) {
      log.info(
        {
          conversationId: conversation.conversationId,
          requestId: qm.requestId,
          batchIndex: i,
          batchSize: batch.length,
        },
        "drainBatch: abort signaled mid-batch; stopping tail persist",
      );
      break;
    }
  }

  if (lastUserMessageId === undefined || lastSuccessfulContent === undefined) {
    // Nothing persisted — either the head's invariant-violation recovery
    // already drained and returned, or every message failed. Head failure
    // has its own recovery path above; if we get here it's because a
    // defensive code path left us with nothing to run. Log and bail.
    log.error(
      {
        conversationId: conversation.conversationId,
        batchSize: batch.length,
      },
      "drainBatch: no messages persisted successfully; skipping runAgentLoop",
    );
    conversation.preactivatedSkillIds = undefined;
    return;
  }

  // Tag turn-completion state with the last SUCCESSFUL persist so client-
  // side correlation (message_complete / generation_cancelled /
  // generation_handoff) surfaces a requestId that actually has a DB row.
  conversation.currentRequestId = lastSuccessfulRequestId;
  conversation.currentActiveSurfaceId = lastSuccessfulActiveSurfaceId;
  conversation.currentPage = lastSuccessfulCurrentPage;

  // Broadcast agent-loop events only to members whose persist succeeded.
  // Members whose persist failed already received an error event in the
  // catch block above; sending them the assistant's streaming response
  // would surface a reply for a user message that isn't in their DB.
  const fanOutOnEvent = (msg: ServerMessage) => {
    for (const qm of successfulBatch) qm.onEvent(msg);
  };

  const drainLoopOptions: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
  } = { isUserMessage: true };
  // Source interactive flag from the last successfully-persisted sibling so
  // a trailing failed tail doesn't flip the agent loop's interactivity.
  const lastSuccessfulBatchEntry =
    successfulBatch.length > 0
      ? successfulBatch[successfulBatch.length - 1]
      : undefined;
  if (lastSuccessfulBatchEntry?.isInteractive !== undefined)
    drainLoopOptions.isInteractive = lastSuccessfulBatchEntry.isInteractive;

  // Fire-and-forget: runAgentLoop's finally block recursively calls drainQueue
  // when this run completes. Mirrors drainSingleMessage.
  conversation
    .runAgentLoop(
      lastSuccessfulContent,
      lastUserMessageId,
      fanOutOnEvent,
      drainLoopOptions,
    )
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: lastSuccessfulRequestId,
          batchSize: batch.length,
        },
        "Error processing batched queued messages",
      );
      fanOutOnEvent({
        type: "error",
        message: `Failed to process queued messages: ${message}`,
      });
    });
}

// ── processMessage ───────────────────────────────────────────────────

/**
 * Convenience function that persists a user message and runs the agent loop
 * in a single call. Used by the message-handler path where blocking is expected.
 */
export async function processMessage(
  conversation: ProcessConversationContext,
  content: string,
  attachments: UserMessageAttachment[],
  onEvent: (msg: ServerMessage) => void,
  requestId?: string,
  activeSurfaceId?: string,
  currentPage?: string,
  options?: { isInteractive?: boolean },
  displayContent?: string,
): Promise<string> {
  await conversation.ensureActorScopedHistory();
  // Snapshot persona context at turn start so later tool turns can't pick up
  // a different actor's context if a concurrent request mutates the live fields.
  conversation.currentTurnTrustContext = conversation.trustContext;
  conversation.currentTurnChannelCapabilities =
    conversation.channelCapabilities;
  conversation.currentActiveSurfaceId = activeSurfaceId;
  conversation.currentPage = currentPage;
  const trimmedContent = content.trim();
  const canonicalPendingRequestHintIdsForConversation =
    trimmedContent.length > 0
      ? listPendingRequestsByConversationScope(
          conversation.conversationId,
          "vellum",
        ).map((request) => request.id)
      : [];
  const canonicalPendingRequestIdsForConversation =
    canonicalPendingRequestHintIdsForConversation.length > 0
      ? canonicalPendingRequestHintIdsForConversation
      : undefined;

  // ── Canonical guardian reply router (desktop/conversation path) ──
  // Desktop/conversation guardian replies are canonical-only. Messages consumed
  // by the router never hit the general agent loop.
  if (trimmedContent.length > 0) {
    const routerResult = await routeGuardianReply({
      messageText: trimmedContent,
      channel: "vellum",
      actor: {
        actorPrincipalId:
          conversation.trustContext?.guardianPrincipalId ?? undefined,
        actorExternalUserId: conversation.trustContext?.guardianExternalUserId,
        channel: "vellum",
        guardianPrincipalId:
          conversation.trustContext?.guardianPrincipalId ?? undefined,
      },
      conversationId: conversation.conversationId,
      pendingRequestIds: canonicalPendingRequestIdsForConversation,
      // Desktop path: disable NL classification to avoid consuming non-decision
      // messages while a tool confirmation is pending. Deterministic code-prefix
      // and callback parsing remain active.
      approvalConversationGenerator: undefined,
    });

    if (routerResult.consumed) {
      const guardianIfCtx = conversation.getTurnInterfaceContext();
      const guardianImageSourcePaths: Record<string, string> = {};
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        if (a.filePath && a.mimeType.toLowerCase().startsWith("image/")) {
          guardianImageSourcePaths[`${i}:${a.filename}`] = a.filePath;
        }
      }
      const routerChannelMeta = {
        userMessageChannel: "vellum" as const,
        assistantMessageChannel: "vellum" as const,
        userMessageInterface: guardianIfCtx?.userMessageInterface ?? "vellum",
        assistantMessageInterface:
          guardianIfCtx?.assistantMessageInterface ?? "vellum",
        provenanceTrustClass: "guardian" as const,
        ...(Object.keys(guardianImageSourcePaths).length > 0
          ? { imageSourcePaths: guardianImageSourcePaths }
          : {}),
      };

      const cleanUserMsg = createUserMessage(content, attachments);
      const llmUserMsg = enrichMessageWithSourcePaths(
        cleanUserMsg,
        attachments,
      );
      const persisted = await addMessage(
        conversation.conversationId,
        "user",
        JSON.stringify(cleanUserMsg.content),
        routerChannelMeta,
      );
      conversation.messages.push(llmUserMsg);

      const replyText =
        routerResult.replyText ??
        (routerResult.decisionApplied
          ? "Decision applied."
          : "Request already resolved.");
      const assistantMsg = createAssistantMessage(replyText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        routerChannelMeta,
      );
      conversation.messages.push(assistantMsg);

      onEvent({ type: "assistant_text_delta", text: replyText });
      onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });

      log.info(
        {
          conversationId: conversation.conversationId,
          routerType: routerResult.type,
          requestId: routerResult.requestId,
        },
        "Conversation guardian reply routed through canonical pipeline",
      );

      return persisted.id;
    }
  }

  // Resolve slash commands before persistence
  const slashResult = await resolveSlash(
    content,
    buildSlashContext(conversation),
  );

  // Unknown slash command — persist the exchange (user + assistant) so the
  // messageId is real.  Persist each message before pushing to conversation.messages
  // so that a failed write never leaves an unpersisted message in memory.
  if (slashResult.kind === "unknown") {
    const pmTurnCtx = conversation.getTurnChannelContext();
    const pmInterfaceCtx = conversation.getTurnInterfaceContext();
    const pmProvenance = provenanceFromTrustContext(conversation.trustContext);
    const pmImageSourcePaths: Record<string, string> = {};
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      if (a.filePath && a.mimeType.toLowerCase().startsWith("image/")) {
        pmImageSourcePaths[`${i}:${a.filename}`] = a.filePath;
      }
    }
    const pmChannelMeta = {
      ...pmProvenance,
      ...(pmTurnCtx
        ? {
            userMessageChannel: pmTurnCtx.userMessageChannel,
            assistantMessageChannel: pmTurnCtx.assistantMessageChannel,
          }
        : {}),
      ...(pmInterfaceCtx
        ? {
            userMessageInterface: pmInterfaceCtx.userMessageInterface,
            assistantMessageInterface: pmInterfaceCtx.assistantMessageInterface,
          }
        : {}),
      ...(Object.keys(pmImageSourcePaths).length > 0
        ? { imageSourcePaths: pmImageSourcePaths }
        : {}),
    };
    const cleanUserMsg = createUserMessage(content, attachments);
    const llmUserMsg = enrichMessageWithSourcePaths(cleanUserMsg, attachments);
    // When displayContent is provided (e.g. original text before recording
    // intent stripping), persist that to DB so users see the full message.
    // The in-memory userMessage (sent to the LLM) still uses the stripped content.
    const contentToPersist = displayContent
      ? JSON.stringify(createUserMessage(displayContent, attachments).content)
      : JSON.stringify(cleanUserMsg.content);
    const persisted = await addMessage(
      conversation.conversationId,
      "user",
      contentToPersist,
      pmChannelMeta,
    );
    conversation.messages.push(llmUserMsg);

    const assistantMsg = createAssistantMessage(slashResult.message);
    await addMessage(
      conversation.conversationId,
      "assistant",
      JSON.stringify(assistantMsg.content),
      pmChannelMeta,
    );
    conversation.messages.push(assistantMsg);

    if (pmTurnCtx) {
      setConversationOriginChannelIfUnset(
        conversation.conversationId,
        pmTurnCtx.userMessageChannel,
      );
    }
    if (pmInterfaceCtx) {
      setConversationOriginInterfaceIfUnset(
        conversation.conversationId,
        pmInterfaceCtx.userMessageInterface,
      );
    }

    // Emit fresh model info before the text delta so the client has
    // up-to-date configuredProviders when rendering /model or /models UI.
    if (isModelSlashCommand(content)) {
      onEvent(await buildModelInfoEvent());
    }
    onEvent({ type: "assistant_text_delta", text: slashResult.message });
    conversation.traceEmitter.emit(
      "message_complete",
      "Unknown slash command handled",
      {
        requestId,
        status: "success",
      },
    );
    onEvent({
      type: "message_complete",
      conversationId: conversation.conversationId,
    });
    return persisted.id;
  }

  // /compact — force context compaction, persist exchange, return message ID.
  if (slashResult.kind === "compact") {
    conversation.processing = true;
    try {
      const pmTurnCtx = conversation.getTurnChannelContext();
      const pmInterfaceCtx = conversation.getTurnInterfaceContext();
      const pmProvenance = provenanceFromTrustContext(
        conversation.trustContext,
      );
      const pmChannelMeta = {
        ...pmProvenance,
        ...(pmTurnCtx
          ? {
              userMessageChannel: pmTurnCtx.userMessageChannel,
              assistantMessageChannel: pmTurnCtx.assistantMessageChannel,
            }
          : {}),
        ...(pmInterfaceCtx
          ? {
              userMessageInterface: pmInterfaceCtx.userMessageInterface,
              assistantMessageInterface:
                pmInterfaceCtx.assistantMessageInterface,
            }
          : {}),
      };
      const cleanUserMsg = createUserMessage(content, attachments);
      const persisted = await addMessage(
        conversation.conversationId,
        "user",
        JSON.stringify(cleanUserMsg.content),
        pmChannelMeta,
      );
      conversation.messages.push(cleanUserMsg);

      conversation.emitActivityState(
        "thinking",
        "context_compacting",
        "assistant_turn",
        requestId,
      );
      const result = await conversation.forceCompact();
      const responseText = formatCompactResult(result);

      const assistantMsg = createAssistantMessage(responseText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        pmChannelMeta,
      );
      conversation.messages.push(assistantMsg);

      onEvent({ type: "assistant_text_delta", text: responseText });
      conversation.traceEmitter.emit(
        "message_complete",
        "Compact slash command handled",
        { requestId, status: "success" },
      );
      onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
      return persisted.id;
    } finally {
      conversation.processing = false;
      await drainQueue(conversation);
    }
  }

  const resolvedContent = slashResult.content;

  // Guardian verification intent interception — force direct guardian
  // verification requests into the guardian-verify-setup skill flow on
  // the first turn, avoiding conceptual preambles from the agent.
  // We keep the original user content for persistence and use the
  // rewritten content only for the agent loop instruction.
  let agentLoopContent = resolvedContent;
  if (slashResult.kind === "passthrough") {
    const verificationIntent =
      resolveVerificationSessionIntent(resolvedContent);
    if (verificationIntent.kind === "direct_setup") {
      log.info(
        {
          conversationId: conversation.conversationId,
          channelHint: verificationIntent.channelHint,
        },
        "Verification session intent intercepted — forcing skill flow",
      );
      agentLoopContent = verificationIntent.rewrittenContent;
      conversation.preactivatedSkillIds = ["guardian-verify-setup"];
    }
  }

  let userMessageId: string;
  try {
    userMessageId = await conversation.persistUserMessage(
      resolvedContent,
      attachments,
      requestId,
      undefined,
      displayContent,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ type: "error", message });
    // runAgentLoop never ran, so its finally block won't clear this
    conversation.preactivatedSkillIds = undefined;
    return "";
  }

  // Fire-and-forget: detect notification preferences in the user message
  // and persist any that are found. Runs in the background so it doesn't
  // block the main conversation flow.
  if (conversation.assistantId) {
    extractPreferences(resolvedContent)
      .then((result) => {
        if (!result.detected) return;
        for (const pref of result.preferences) {
          createPreference({
            preferenceText: pref.preferenceText,
            appliesWhen: pref.appliesWhen,
            priority: pref.priority,
          });
        }
        log.info(
          {
            count: result.preferences.length,
            conversationId: conversation.conversationId,
          },
          "Persisted extracted notification preferences",
        );
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { err: errMsg, conversationId: conversation.conversationId },
          "Background preference extraction failed",
        );
      });
  }

  const loopOptions: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
  } = { isUserMessage: true };
  if (options?.isInteractive !== undefined)
    loopOptions.isInteractive = options.isInteractive;
  if (agentLoopContent !== resolvedContent)
    loopOptions.titleText = resolvedContent;

  await conversation.runAgentLoop(
    agentLoopContent,
    userMessageId,
    onEvent,
    loopOptions,
  );
  return userMessageId;
}
