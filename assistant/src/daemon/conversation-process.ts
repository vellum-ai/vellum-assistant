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
  parseChannelId,
  parseInterfaceId,
  type TurnChannelContext,
  type TurnInterfaceContext,
} from "../channels/types.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { listPendingRequestsByConversationScope } from "../contacts/canonical-guardian-store.js";
import { extractPreferences } from "../notifications/preference-extractor.js";
import { createPreference } from "../notifications/preferences-store.js";
import {
  addMessage,
  isHiddenMessageMetadata,
  provenanceFromTrustContext,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
} from "../persistence/conversation-crud.js";
import type { ContextWindowResult } from "../plugins/defaults/compaction/window-manager.js";
import {
  type GuardianPendingScope,
  routeGuardianReply,
} from "../runtime/guardian-reply-router.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import { getLogger } from "../util/logger.js";
import type { CleanResult, Conversation } from "./conversation.js";
import {
  persistQueuedMessageBody,
  serializePersistedUserMessageContent,
} from "./conversation-messaging.js";
import type {
  QueuedMessage,
  QueueDrainReason,
} from "./conversation-queue-manager.js";
import {
  buildSlashContextForContent,
  classifySlash,
  resolveSlash,
  type SlashContext,
} from "./conversation-slash.js";
import { getModelInfo } from "./handlers/config-model.js";
import { preactivateHostProxySkills } from "./host-proxy-preactivation.js";
import type {
  ServerMessage,
  UserMessageAttachment,
} from "./message-protocol.js";
import { buildTransportHints } from "./transport-hints.js";
import { resolveVerificationSessionIntent } from "./verification-session-intent.js";

const log = getLogger("conversation-process");

/**
 * Daemon-injected run lifecycle notifications — subagent (`subagentNotification`),
 * ACP run (`acpNotification`), and backgrounded bash/host_bash completion (the
 * `<background_event source="background-tool">` wake) — are persisted into the
 * parent conversation so the orchestrator wakes and reads the run's result, but
 * they are internal scaffolding: the user sees the run through its inline
 * progress card, not a chat turn. Skip the `user_message_echo` broadcast for
 * these so they never render as a live user bubble; the persisted row is
 * filtered from the rendered transcript on the client.
 *
 * Messages explicitly flagged `hidden` (a hidden `POST /messages` send that
 * queued behind an in-flight turn, e.g. the channel-setup wizard-close
 * marker) are suppressed the same way — the immediate route path already
 * skips their echo, and the persisted `hidden` metadata keeps them out of
 * the fetched transcript.
 */
function isEchoSuppressedUserMessage(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return (
    isHiddenMessageMetadata(metadata) ||
    metadata?.subagentNotification != null ||
    metadata?.acpNotification != null ||
    metadata?.backgroundEventSource === "background-tool"
  );
}

/** Format the result of a forced compaction into a user-facing message. */
export function formatCompactResult(result: ContextWindowResult): string {
  const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
  if (!result.compacted) {
    return [
      `Context compaction skipped — ${result.reason ?? "nothing to compact"}.`,
      `Context: ${fmt(result.estimatedInputTokens)} / ${fmt(
        result.maxInputTokens,
      )} tokens`,
    ].join("\n");
  }
  const saved =
    result.previousEstimatedInputTokens - result.estimatedInputTokens;
  return [
    "Context Compacted\n",
    `Tokens:   ${fmt(result.previousEstimatedInputTokens)} → ${fmt(result.estimatedInputTokens)} (${fmt(saved)} saved)`,
    `Context:  ${fmt(result.estimatedInputTokens)} / ${fmt(
      result.maxInputTokens,
    )} tokens`,
    `Messages: ${fmt(result.compactedMessages)} compacted`,
    `Tail:     ${fmt(result.preservedTailMessages)} preserved`,
  ].join("\n");
}

/** Format the result of a forced clean into a user-facing message. */
export function formatCleanResult(result: CleanResult): string {
  const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
  const reclaimed =
    result.previousEstimatedInputTokens - result.estimatedInputTokens;
  return [
    "Context Cleaned\n",
    `Tokens:   ${fmt(result.previousEstimatedInputTokens)} → ${fmt(result.estimatedInputTokens)} (${fmt(reclaimed)} reclaimed)`,
    `Context:  ${fmt(result.estimatedInputTokens)} / ${fmt(
      result.maxInputTokens,
    )} tokens`,
    `Messages: ${fmt(result.preservedMessages)} preserved`,
  ].join("\n");
}

/** Build a model_info event with fresh config data. */
export async function buildModelInfoEvent(
  conversationId?: string,
): Promise<ServerMessage> {
  return { type: "model_info", conversationId, ...(await getModelInfo()) };
}

/** True when the trimmed content is the /models slash command. */
export function isModelSlashCommand(content: string): boolean {
  return content.trim() === "/models";
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
export function buildSlashContext(
  content: string,
  conversation: Conversation,
): SlashContext | undefined {
  const turnInterface = conversation.getTurnInterfaceContext();
  return buildSlashContextForContent(content, {
    conversationId: conversation.conversationId,
    messageCount: conversation.messages.length,
    inputTokens: conversation.usageStats.inputTokens,
    outputTokens: conversation.usageStats.outputTokens,
    estimatedCost: conversation.usageStats.estimatedCost,
    userMessageInterface: turnInterface?.userMessageInterface,
  });
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
  conversation: Conversation,
): Promise<QueuedMessage[]> {
  const head = conversation.queue.peek(0);
  if (head === undefined) return [];

  const headInterface = resolveQueuedTurnInterfaceContext(
    head,
    conversation.getTurnInterfaceContext(),
  );
  // Pure classifier — no side effects. `resolveSlash` may run side effects
  // (e.g. /compact); if we called it here the real drain would invoke those
  // again.
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
    // The batched turn applies only the head's `clientOs`, so messages from a
    // different OS surface must not coalesce. The web, iOS, and macOS apps all
    // report `interfaceId: "web"`, so the interface check above no longer
    // separates them — split on the reported OS explicitly.
    if (candidate.transport?.clientOs !== head.transport?.clientOs) break;
    if (candidate.sourceActorPrincipalId !== head.sourceActorPrincipalId) break;
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

// ── Steer repair ────────────────────────────────────────────────────

/**
 * When a steer-to-message abort interrupts an in-flight tool call, the
 * conversation history may end with an assistant message containing one
 * or more `tool_use` blocks that have no corresponding `tool_result`.
 * LLM providers reject this sequence. This helper scans the tail of the
 * history and injects synthetic error `tool_result` messages for any
 * unmatched `tool_use` blocks.
 */
function repairPendingToolUseBlocks(conversation: Conversation): void {
  if (!conversation.pendingSteerRepair) return;
  conversation.pendingSteerRepair = false;

  const messages = conversation.messages;
  if (messages.length === 0) return;

  // Walk backwards from the tail to find the last assistant message with
  // tool_use blocks. Collect resolved IDs from any user messages between
  // the tail and that assistant message, then subtract them.
  const resolvedToolUseIds = new Set<string>();
  const pendingToolUseIds: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      for (const block of msg.content) {
        if (
          block.type === "tool_result" ||
          block.type === "web_search_tool_result"
        ) {
          resolvedToolUseIds.add(block.tool_use_id);
        }
      }
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool_use" && !resolvedToolUseIds.has(block.id)) {
          pendingToolUseIds.push(block.id);
        }
      }
      // Only repair tool_use blocks from the last assistant message that
      // has them — earlier history should already be consistent.
      break;
    }
  }

  if (pendingToolUseIds.length === 0) return;

  log.info(
    {
      conversationId: conversation.conversationId,
      pendingToolUseCount: pendingToolUseIds.length,
    },
    "Injecting synthetic tool_result for pending tool_use blocks after steer",
  );

  // Build a single user message with tool_result blocks for all pending IDs.
  const syntheticContent = pendingToolUseIds.map((toolUseId) => ({
    type: "tool_result" as const,
    tool_use_id: toolUseId,
    content: "Tool execution was interrupted by user steering.",
    is_error: true,
  }));
  conversation.messages.push({
    role: "user",
    content: syntheticContent,
  });
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
  conversation: Conversation,
  reason: QueueDrainReason = "loop_complete",
): Promise<void> {
  // After a steer, drain only the promoted head message — don't batch
  // the remaining queue items into the same turn.
  const steered = conversation.pendingSteerRepair;

  // Repair any pending tool_use blocks left over from a steered abort
  // before the drain path sends the next message to the LLM.
  repairPendingToolUseBlocks(conversation);

  if (steered) {
    const next = conversation.queue.shift();
    if (!next) return;
    return drainSingleMessage(conversation, next, reason);
  }

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
  conversation: Conversation,
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
  conversation.emitActivityState("thinking", "message_dequeued", {
    requestId: next.requestId,
  });

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
    conversation.applyClientTimezoneFromTransport(next.transport);
    conversation.applyClientOsFromTransport(next.transport);
  }

  conversation.currentTurnAuthContext = next.authContext;
  conversation.currentTurnSourceActorPrincipalId = next.sourceActorPrincipalId;

  // Re-attach and re-preactivate host-proxy skills for interactive turns.
  // The dequeue path reset `preactivatedSkillIds` above; without these
  // re-adds the relevant skill tools won't be projected to the LLM for
  // queued messages 2+. Also instantiates proxies that may not have been
  // present when the message was first enqueued (e.g. a macOS client
  // connects between enqueue and drain). Mirrors the per-message block in
  // `conversation-routes.ts` / `process-message.ts`.
  if (next.isInteractive !== false) {
    const interfaceCtx =
      queuedInterfaceCtx ?? conversation.getTurnInterfaceContext();
    const sourceInterface = interfaceCtx?.userMessageInterface;
    const sourceActorPrincipalId = next.sourceActorPrincipalId;
    conversation.ensureHostProxiesForTurn(
      sourceInterface,
      sourceActorPrincipalId,
    );
    preactivateHostProxySkills(
      conversation,
      sourceInterface,
      sourceActorPrincipalId,
    );
  }

  // Snapshot persona context at turn start so later tool turns can't pick up
  // a different actor's context if a concurrent request mutates the live fields.
  conversation.currentTurnTrustContext = conversation.trustContext;
  conversation.currentTurnChannelCapabilities =
    conversation.channelCapabilities;

  // Resolve slash commands for queued messages
  const slashResult = await resolveSlash(
    next.content,
    buildSlashContext(next.content, conversation),
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
        ...(next.metadata?.hidden === true ? { hidden: true } : {}),
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
      const contentToPersist = serializePersistedUserMessageContent(
        next.content,
        next.attachments,
        next.displayContent,
      );
      await addMessage(conversation.conversationId, "user", contentToPersist, {
        metadata: drainChannelMeta,
      });
      conversation.messages.push(llmUserMsg);

      const assistantMsg = createAssistantMessage(slashResult.message);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: { ...drainChannelMeta, sentAt: Date.now() } },
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
        next.onEvent(await buildModelInfoEvent(conversation.conversationId));
      }
      next.onEvent({
        type: "assistant_text_delta",
        text: slashResult.message,
        conversationId: conversation.conversationId,
      });
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
      publishConversationMessagesChanged(conversation.conversationId);
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
      next.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        message,
      });
    }
    // Continue draining regardless of success/failure
    await drainQueue(conversation);
    return;
  }

  // /compact — force context compaction, persist exchange, continue draining.
  if (slashResult.kind === "compact") {
    let persistedCompactMessage = false;
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
        serializePersistedUserMessageContent(
          next.content,
          next.attachments,
          next.displayContent,
        ),
        { metadata: drainChannelMeta },
      );
      persistedCompactMessage = true;
      conversation.messages.push(cleanUserMsg);

      conversation.emitActivityState("thinking", "context_compacting", {
        requestId: next.requestId,
      });
      const result = await conversation.forceCompact();
      const responseText = formatCompactResult(result);

      const assistantMsg = createAssistantMessage(responseText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: { ...drainChannelMeta, sentAt: Date.now() } },
      );
      conversation.messages.push(assistantMsg);

      next.onEvent({
        type: "assistant_text_delta",
        text: responseText,
        conversationId: conversation.conversationId,
      });
      conversation.traceEmitter.emit(
        "message_complete",
        "Compact slash command handled",
        { requestId: next.requestId, status: "success" },
      );
      next.onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
      publishConversationMessagesChanged(conversation.conversationId);
    } catch (err) {
      if (persistedCompactMessage) {
        publishConversationMessagesChanged(conversation.conversationId);
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: next.requestId,
        },
        "Failed to execute /compact",
      );
      next.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        message,
      });
    }
    await drainQueue(conversation);
    return;
  }

  // /clean — strip runtime injections and reset memory state, no LLM call.
  if (slashResult.kind === "clean") {
    let persistedCleanMessage = false;
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
        serializePersistedUserMessageContent(
          next.content,
          next.attachments,
          next.displayContent,
        ),
        { metadata: drainChannelMeta },
      );
      persistedCleanMessage = true;
      conversation.messages.push(cleanUserMsg);

      const result = await conversation.forceClean();
      const responseText = formatCleanResult(result);

      const assistantMsg = createAssistantMessage(responseText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: { ...drainChannelMeta, sentAt: Date.now() } },
      );
      conversation.messages.push(assistantMsg);

      next.onEvent({
        type: "assistant_text_delta",
        text: responseText,
        conversationId: conversation.conversationId,
      });
      conversation.traceEmitter.emit(
        "message_complete",
        "Clean slash command handled",
        { requestId: next.requestId, status: "success" },
      );
      next.onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
      publishConversationMessagesChanged(conversation.conversationId);
    } catch (err) {
      if (persistedCleanMessage) {
        publishConversationMessagesChanged(conversation.conversationId);
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: next.requestId,
        },
        "Failed to execute /clean",
      );
      next.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        message,
      });
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
  let persistResult: { id: string; deduplicated: boolean };
  try {
    persistResult = await conversation.persistUserMessage({
      content: resolvedContent,
      attachments: next.attachments,
      requestId: next.requestId,
      metadata: { ...next.metadata, sentAt: next.sentAt },
      displayContent: next.displayContent,
      clientMessageId: next.clientMessageId,
    });
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
    next.onEvent({
      type: "error",
      conversationId: conversation.conversationId,
      message,
    });
    // runAgentLoop never ran, so its finally block won't clear this
    conversation.preactivatedSkillIds = undefined;
    // Continue draining — don't strand remaining messages
    await drainQueue(conversation);
    return;
  }

  const userMessageId = persistResult.id;

  if (persistResult.deduplicated) {
    log.info(
      { conversationId: conversation.conversationId, userMessageId },
      "Skipping agent loop for deduplicated queued message",
    );
    conversation.preactivatedSkillIds = undefined;
    await drainQueue(conversation);
    return;
  }

  // Broadcast the user message to all hub subscribers so passive devices
  // see the user turn before the assistant reply starts streaming.
  if (!isEchoSuppressedUserMessage(next.metadata)) {
    next.onEvent({
      type: "user_message_echo",
      text: resolvedContent,
      conversationId: conversation.conversationId,
      messageId: userMessageId,
      requestId: next.requestId,
      clientMessageId: next.clientMessageId,
    });
  }
  publishConversationMessagesChanged(conversation.conversationId);

  // Set the active surface for the dequeued message so runAgentLoop can inject context
  conversation.currentActiveSurfaceId = next.activeSurfaceId;
  conversation.currentPage = next.currentPage;

  // Fire-and-forget: detect notification preferences in the queued message
  // and persist any that are found, mirroring the logic in processMessage.
  // Hidden rows are machine signals, not user speech — running the detector
  // on them burns an LLM call per signal and risks persisting a bogus
  // preference from text the user never typed.
  if (conversation.assistantId && !isHiddenMessageMetadata(next.metadata)) {
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

  // Fire-and-forget: persistUserMessage set the processing flag to true
  // so subsequent messages will still be enqueued.
  // runAgentLoop's finally block will call drainQueue when this run completes.
  const drainLoopOptions: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
    isHiddenPrompt?: boolean;
  } = { isUserMessage: true };
  if (next.isInteractive !== undefined)
    drainLoopOptions.isInteractive = next.isInteractive;
  if (agentLoopContent !== resolvedContent)
    drainLoopOptions.titleText = resolvedContent;
  if (isHiddenMessageMetadata(next.metadata))
    drainLoopOptions.isHiddenPrompt = true;

  conversation
    .runAgentLoop(agentLoopContent, userMessageId, {
      ...drainLoopOptions,
      onEvent: next.onEvent,
    })
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
        conversationId: conversation.conversationId,
        message: `Failed to process queued message: ${message}`,
      });
    });
}

// Drives a batched turn where multiple queued passthrough messages share one
// runAgentLoop run. Per-message dequeue events and DB persistence are
// preserved; the agent reply fans out to every batched client.
async function drainBatch(
  conversation: Conversation,
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
    conversation.applyClientTimezoneFromTransport(head.transport);
    conversation.applyClientOsFromTransport(head.transport);
  }

  conversation.currentTurnAuthContext = head.authContext;
  conversation.currentTurnSourceActorPrincipalId = head.sourceActorPrincipalId;

  // Re-attach and re-preactivate host-proxy skills for interactive turns.
  // Mirrors the single-message path exactly — sourced from `head`.
  if (head.isInteractive !== false) {
    const interfaceCtx =
      queuedInterfaceCtx ?? conversation.getTurnInterfaceContext();
    const sourceInterface = interfaceCtx?.userMessageInterface;
    const sourceActorPrincipalId = head.sourceActorPrincipalId;
    conversation.ensureHostProxiesForTurn(
      sourceInterface,
      sourceActorPrincipalId,
    );
    preactivateHostProxySkills(
      conversation,
      sourceInterface,
      sourceActorPrincipalId,
    );
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
  conversation.emitActivityState("thinking", "message_dequeued", {
    requestId: head.requestId,
  });

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
      buildSlashContext(qm.content, conversation),
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
      qm.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        message: invariantMessage,
      });
      if (i === 0) {
        // Head invariant fired — no in-flight turn yet (the check runs
        // before persistUserMessage, so the head was never persisted).
        // Clear per-turn state and recursively drain the remaining tails,
        // which were already shifted out of the queue by
        // buildPassthroughBatch and would otherwise be stranded. Mirrors
        // the head persist-failure recovery below.
        conversation.setProcessing(false);
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
      let batchPersistResult: { id: string; deduplicated: boolean };
      const persistOptions = {
        content: qmContent,
        attachments: qm.attachments,
        requestId: qm.requestId,
        metadata: { ...qm.metadata, sentAt: qm.sentAt },
        displayContent: qm.displayContent,
        clientMessageId: qm.clientMessageId,
      };
      if (i === 0) {
        batchPersistResult =
          await conversation.persistUserMessage(persistOptions);
      } else {
        batchPersistResult = await persistQueuedMessageBody(
          conversation,
          persistOptions,
        );
      }
      if (batchPersistResult.deduplicated) {
        if (i === 0) {
          // Head was deduplicated — persistUserMessage cleared the
          // processing flag. Recursively drain remaining items so the
          // first non-duplicate becomes the new batch head and sets
          // processing via persistUserMessage.
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
        continue;
      }
      lastUserMessageId = batchPersistResult.id;
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
      qm.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        message,
      });

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
    if (!isEchoSuppressedUserMessage(qm.metadata)) {
      qm.onEvent({
        type: "user_message_echo",
        text: qmContent,
        conversationId: conversation.conversationId,
        messageId: lastUserMessageId,
        requestId: qm.requestId,
        clientMessageId: qm.clientMessageId,
      });
    }
    publishConversationMessagesChanged(conversation.conversationId);

    // Persist succeeded. Update last-successful markers so a later tail
    // failure won't overwrite them.
    lastSuccessfulRequestId = qm.requestId;
    lastSuccessfulActiveSurfaceId = qm.activeSurfaceId;
    lastSuccessfulCurrentPage = qm.currentPage;
    lastSuccessfulContent = qmContent;
    successfulBatch.push(qm);

    // Fire-and-forget: detect notification preferences in each batched user
    // message and persist any that are found, mirroring drainSingleMessage
    // (including its hidden-row exclusion).
    if (conversation.assistantId && !isHiddenMessageMetadata(qm.metadata)) {
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

  // Broadcast agent-loop events only to unique sinks whose persist succeeded.
  // Multiple web-queued messages share the same broadcastMessage callback; if
  // we call it once per queued message, every text delta is published N times
  // to the same SSE stream and the client renders duplicated text.
  //
  // Members whose persist failed already received an error event in the catch
  // block above; sending them the assistant's streaming response would surface
  // a reply for a user message that isn't in their DB.
  const successfulEventSinks = Array.from(
    new Set(successfulBatch.map((qm) => qm.onEvent)),
  );
  const fanOutOnEvent = (msg: ServerMessage) => {
    for (const onEvent of successfulEventSinks) onEvent(msg);
  };

  const drainLoopOptions: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
    isHiddenPrompt?: boolean;
  } = { isUserMessage: true };
  // Source interactive flag from the last successfully-persisted sibling so
  // a trailing failed tail doesn't flip the agent loop's interactivity.
  const lastSuccessfulBatchEntry =
    successfulBatch.length > 0
      ? successfulBatch[successfulBatch.length - 1]
      : undefined;
  if (lastSuccessfulBatchEntry?.isInteractive !== undefined)
    drainLoopOptions.isInteractive = lastSuccessfulBatchEntry.isInteractive;
  // A batch counts as a hidden turn only when every message in it is a
  // hidden machine signal — one genuine user prompt justifies the
  // prompt-as-user-speech consumers (title generation).
  if (
    successfulBatch.length > 0 &&
    successfulBatch.every((qm) => isHiddenMessageMetadata(qm.metadata))
  )
    drainLoopOptions.isHiddenPrompt = true;

  // Fire-and-forget: runAgentLoop's finally block recursively calls drainQueue
  // when this run completes. Mirrors drainSingleMessage.
  conversation
    .runAgentLoop(lastSuccessfulContent, lastUserMessageId, {
      ...drainLoopOptions,
      onEvent: fanOutOnEvent,
    })
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
        conversationId: conversation.conversationId,
        message: `Failed to process queued messages: ${message}`,
      });
    });
}

// ── ProcessMessageOptions ────────────────────────────────────────────

/** Options for `processMessage`. Only `content` and `attachments` are
 *  required; everything else has a sensible default or is genuinely optional. */
export interface ProcessMessageOptions {
  content: string;
  attachments: UserMessageAttachment[];
  onEvent?: (msg: ServerMessage) => void;
  requestId?: string;
  activeSurfaceId?: string;
  currentPage?: string;
  isInteractive?: boolean;
  callSite?: LLMCallSite;
  /**
   * Optional ad-hoc inference-profile override applied to every LLM call
   * this turn issues (e.g. a schedule's pinned profile). Forwarded to
   * {@link Conversation.runAgentLoop}.
   */
  overrideProfile?: string;
  displayContent?: string;
  /** JWT-verified committer principal for turn-scoped host-proxy authorization. */
  sourceActorPrincipalId?: string;
}

// ── processMessage ───────────────────────────────────────────────────

/**
 * Convenience function that persists a user message and runs the agent loop
 * in a single call. Used by the message-handler path where blocking is expected.
 */
export async function processMessage(
  conversation: Conversation,
  options: ProcessMessageOptions,
): Promise<string> {
  const {
    content,
    attachments,
    onEvent = () => {},
    requestId,
    activeSurfaceId,
    currentPage,
    isInteractive,
    callSite,
    overrideProfile,
    displayContent,
    sourceActorPrincipalId,
  } = options;
  await conversation.ensureActorScopedHistory();
  // Snapshot persona context at turn start so later tool turns can't pick up
  // a different actor's context if a concurrent request mutates the live fields.
  conversation.currentTurnTrustContext = conversation.trustContext;
  conversation.currentTurnAuthContext = conversation.authContext;
  conversation.currentTurnSourceActorPrincipalId =
    sourceActorPrincipalId ?? conversation.authContext?.actorPrincipalId;
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
  // Empty hints → leave the scope unset (identity-fallback): the desktop
  // guardian can still resolve their pending work by identity/principal.
  const pendingScope: GuardianPendingScope | undefined =
    canonicalPendingRequestHintIdsForConversation.length > 0
      ? {
          mode: "scoped",
          requestIds: canonicalPendingRequestHintIdsForConversation,
        }
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
      pendingScope,
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
        userMessageInterface: guardianIfCtx?.userMessageInterface ?? "web",
        assistantMessageInterface:
          guardianIfCtx?.assistantMessageInterface ?? "web",
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
        serializePersistedUserMessageContent(
          content,
          attachments,
          displayContent,
        ),
        { metadata: routerChannelMeta },
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
        { metadata: routerChannelMeta },
      );
      conversation.messages.push(assistantMsg);

      onEvent({
        type: "assistant_text_delta",
        text: replyText,
        conversationId: conversation.conversationId,
      });
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
    buildSlashContext(content, conversation),
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
    const contentToPersist = serializePersistedUserMessageContent(
      content,
      attachments,
      displayContent,
    );
    const persisted = await addMessage(
      conversation.conversationId,
      "user",
      contentToPersist,
      { metadata: pmChannelMeta },
    );
    conversation.messages.push(llmUserMsg);

    const assistantMsg = createAssistantMessage(slashResult.message);
    await addMessage(
      conversation.conversationId,
      "assistant",
      JSON.stringify(assistantMsg.content),
      { metadata: pmChannelMeta },
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
      onEvent(await buildModelInfoEvent(conversation.conversationId));
    }
    onEvent({
      type: "assistant_text_delta",
      text: slashResult.message,
      conversationId: conversation.conversationId,
    });
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
    publishConversationMessagesChanged(conversation.conversationId);
    return persisted.id;
  }

  // /compact — force context compaction, persist exchange, return message ID.
  if (slashResult.kind === "compact") {
    conversation.setProcessing(true);
    let persistedCompactMessage = false;
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
        serializePersistedUserMessageContent(
          content,
          attachments,
          displayContent,
        ),
        { metadata: pmChannelMeta },
      );
      persistedCompactMessage = true;
      conversation.messages.push(cleanUserMsg);

      conversation.emitActivityState("thinking", "context_compacting", {
        requestId,
      });
      const result = await conversation.forceCompact();
      const responseText = formatCompactResult(result);

      const assistantMsg = createAssistantMessage(responseText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: pmChannelMeta },
      );
      conversation.messages.push(assistantMsg);

      onEvent({
        type: "assistant_text_delta",
        text: responseText,
        conversationId: conversation.conversationId,
      });
      conversation.traceEmitter.emit(
        "message_complete",
        "Compact slash command handled",
        { requestId, status: "success" },
      );
      onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
      publishConversationMessagesChanged(conversation.conversationId);
      return persisted.id;
    } catch (err) {
      if (persistedCompactMessage) {
        publishConversationMessagesChanged(conversation.conversationId);
      }
      throw err;
    } finally {
      conversation.setProcessing(false);
      await drainQueue(conversation);
    }
  }

  // /clean — strip runtime injections, return message ID. No LLM call.
  if (slashResult.kind === "clean") {
    conversation.setProcessing(true);
    let persistedCleanMessage = false;
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
        serializePersistedUserMessageContent(
          content,
          attachments,
          displayContent,
        ),
        { metadata: pmChannelMeta },
      );
      persistedCleanMessage = true;
      conversation.messages.push(cleanUserMsg);

      const result = await conversation.forceClean();
      const responseText = formatCleanResult(result);

      const assistantMsg = createAssistantMessage(responseText);
      await addMessage(
        conversation.conversationId,
        "assistant",
        JSON.stringify(assistantMsg.content),
        { metadata: pmChannelMeta },
      );
      conversation.messages.push(assistantMsg);

      onEvent({
        type: "assistant_text_delta",
        text: responseText,
        conversationId: conversation.conversationId,
      });
      conversation.traceEmitter.emit(
        "message_complete",
        "Clean slash command handled",
        { requestId, status: "success" },
      );
      onEvent({
        type: "message_complete",
        conversationId: conversation.conversationId,
      });
      publishConversationMessagesChanged(conversation.conversationId);
      return persisted.id;
    } catch (err) {
      if (persistedCleanMessage) {
        publishConversationMessagesChanged(conversation.conversationId);
      }
      throw err;
    } finally {
      conversation.setProcessing(false);
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

  let pmResult: { id: string; deduplicated: boolean };
  try {
    pmResult = await conversation.persistUserMessage({
      content: resolvedContent,
      attachments,
      requestId,
      displayContent,
    });
    publishConversationMessagesChanged(conversation.conversationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({
      type: "error",
      conversationId: conversation.conversationId,
      message,
    });
    // runAgentLoop never ran, so its finally block won't clear this
    conversation.preactivatedSkillIds = undefined;
    return "";
  }

  const userMessageId = pmResult.id;

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
    callSite?: LLMCallSite;
    overrideProfile?: string;
  } = { isUserMessage: true };
  if (isInteractive !== undefined) loopOptions.isInteractive = isInteractive;
  if (agentLoopContent !== resolvedContent)
    loopOptions.titleText = resolvedContent;
  if (callSite !== undefined) loopOptions.callSite = callSite;
  if (overrideProfile !== undefined)
    loopOptions.overrideProfile = overrideProfile;

  await conversation.runAgentLoop(agentLoopContent, userMessageId, {
    ...loopOptions,
    onEvent,
  });
  return userMessageId;
}
