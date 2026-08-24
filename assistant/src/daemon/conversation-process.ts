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
import type { AssistantEvent } from "../api/index.js";
import { listPendingRequestsByScopeOrEmpty } from "../channels/gateway-guardian-requests.js";
import {
  parseChannelId,
  parseInterfaceId,
  type TurnChannelContext,
  type TurnInterfaceContext,
} from "../channels/types.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { extractPreferences } from "../notifications/preference-extractor.js";
import { createPreference } from "../notifications/preferences-store.js";
import {
  addMessage,
  isEchoSuppressedUserMessage,
  isHiddenMessageMetadata,
  isSuppressedQueuedMessage,
  provenanceFromTrustContext,
  recordConversationPersistedSeq,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
} from "../persistence/conversation-crud.js";
import { isReplyPushIneligibleUserMessage } from "../persistence/conversation-types.js";
import type { ContextWindowResult } from "../plugins/defaults/compaction/window-manager.js";
import { getCurrentSeq } from "../runtime/assistant-stream-state.js";
import {
  type GuardianPendingScope,
  routeGuardianReply,
} from "../runtime/guardian-reply-router.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import { stampTurnOutcome } from "../telemetry/turn-outcome.js";
import { getLogger } from "../util/logger.js";
import type { CleanResult, Conversation } from "./conversation.js";
import {
  CONVERSATION_BUSY_MESSAGE,
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
import type { UserMessageAttachment } from "./message-protocol.js";
import { buildTransportHints } from "./transport-hints.js";
import { sameTrustIdentity, type TrustContext } from "./trust-context-types.js";
import { turnOrRestingTrust } from "./trust-context-types.js";
import { resolveVerificationSessionIntent } from "./verification-session-intent.js";

const log = getLogger("conversation-process");

/** Locale-formatted count for the user-facing context stats cards. */
const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");

/** Format the result of a forced compaction into a user-facing message. */
export function formatCompactResult(result: ContextWindowResult): string {
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

/**
 * User-facing copy for the compactor's internal skip-reason strings, keyed by
 * the exact `ContextWindowResult.reason` values reachable from the
 * "summarize up to here" path. Unknown reasons fall back to the raw string.
 */
const SUMMARIZE_SKIP_REASON_COPY: Record<string, string> = {
  "fixed boundary out of range": "nothing to summarize before this point",
  "tail_start at head — nothing to compact":
    "nothing to summarize before this point",
  "no messages to compact": "nothing to summarize",
  "compaction disabled": "summarization is disabled in the assistant's config",
  "provider error": "the summary could not be generated — try again",
  "unparseable response": "the summary could not be generated — try again",
};

/**
 * Format the result of a "summarize up to here" compaction into a user-facing
 * card.
 */
export function formatSummarizeUpToResult(result: ContextWindowResult): string {
  if (!result.compacted) {
    const reason = result.reason
      ? (SUMMARIZE_SKIP_REASON_COPY[result.reason] ?? result.reason)
      : "nothing to summarize";
    return `Summarization skipped — ${reason}.`;
  }
  const saved =
    result.previousEstimatedInputTokens - result.estimatedInputTokens;
  return [
    "**Conversation summarized**",
    // Persisted (row-space) count — `compactedMessages` is history-space and
    // counts the synthetic summary head on a repeat summarize, which is not
    // a message the user ever saw. The kept tail never contains the head.
    `Summarized ${fmt(result.compactedPersistedMessages)} earlier messages. ${fmt(
      result.preservedTailMessages,
    )} recent messages kept in full.`,
    `Context: ${fmt(result.previousEstimatedInputTokens)} → ${fmt(
      result.estimatedInputTokens,
    )} tokens (${fmt(saved)} saved)`,
  ].join("\n");
}

/** Format the result of a forced clean into a user-facing message. */
export function formatCleanResult(result: CleanResult): string {
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
): Promise<AssistantEvent> {
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
  if (queued.turnChannelContext) {
    return queued.turnChannelContext;
  }
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
  if (queued.turnInterfaceContext) {
    return queued.turnInterfaceContext;
  }
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
  if (head === undefined) {
    return [];
  }

  const headInterface = resolveQueuedTurnInterfaceContext(
    head,
    conversation.getTurnInterfaceContext(),
  );
  // Pure classifier — no side effects. `resolveSlash` may run side effects
  // (e.g. /compact); if we called it here the real drain would invoke those
  // again.
  if (classifySlash(head.content) !== "passthrough") {
    return [];
  }
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
    if (candidate === undefined) {
      break;
    }
    const candIf = resolveQueuedTurnInterfaceContext(
      candidate,
      conversation.getTurnInterfaceContext(),
    );
    // Treat an undefined interface as distinct from a defined one so we don't
    // silently batch cross-interface messages whose env/transport would
    // otherwise diverge.
    if (candIf?.userMessageInterface !== headInterface?.userMessageInterface) {
      break;
    }
    // The batched turn applies only the head's `clientOs`, so messages from a
    // different OS surface must not coalesce. Browser, mobile, and desktop apps
    // report `interfaceId: "web"`, so the interface check above no longer
    // separates them, so split on the reported OS explicitly.
    if (candidate.transport?.clientOs !== head.transport?.clientOs) {
      break;
    }
    // Same head-wins problem for the app on screen: batching a message sent
    // while a different app was open would run it against the head's
    // `visible_app`, pointing "the app" at the wrong one.
    if (candidate.transport?.visibleAppId !== head.transport?.visibleAppId) {
      break;
    }
    if (candidate.sourceActorPrincipalId !== head.sourceActorPrincipalId) {
      break;
    }
    // Channel senders carry no principal, so the check above leaves two
    // different Slack contacts looking identical (`undefined === undefined`).
    // The batch runs under a single trust context, so split on the sender's
    // trust identity too or a tail executes with the head's privileges.
    if (!sameTrustIdentity(candidate.trustContext, head.trustContext)) {
      break;
    }
    if (classifySlash(candidate.content) !== "passthrough") {
      break;
    }
    if (
      resolveVerificationSessionIntent(candidate.content).kind ===
      "direct_setup"
    ) {
      break;
    }
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

// ── Steer / interrupt repair ────────────────────────────────────────

/**
 * When a steer-to-message abort (or a user interrupt with messages still
 * queued behind the stopped turn) cuts off an in-flight tool call, the
 * conversation history may end with an assistant message containing one
 * or more `tool_use` blocks that have no corresponding `tool_result`.
 * LLM providers reject this sequence. This helper scans the tail of the
 * history and injects synthetic error `tool_result` messages for any
 * unmatched `tool_use` blocks.
 */
function repairPendingToolUseBlocks(conversation: Conversation): void {
  const steered = conversation.pendingSteerRepair;
  if (!steered && !conversation.pendingInterruptRepair) {
    return;
  }
  conversation.pendingSteerRepair = false;
  conversation.pendingInterruptRepair = false;

  const messages = conversation.messages;
  if (messages.length === 0) {
    return;
  }

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

  if (pendingToolUseIds.length === 0) {
    return;
  }

  log.info(
    {
      conversationId: conversation.conversationId,
      pendingToolUseCount: pendingToolUseIds.length,
      trigger: steered ? "steer" : "interrupt",
    },
    "Injecting synthetic tool_result for pending tool_use blocks",
  );

  // Build a single user message with tool_result blocks for all pending IDs.
  const syntheticContent = pendingToolUseIds.map((toolUseId) => ({
    type: "tool_result" as const,
    tool_use_id: toolUseId,
    content: steered
      ? "Tool execution was interrupted by user steering."
      : "Tool execution was interrupted by the user.",
    is_error: true,
  }));
  conversation.messages.push({
    role: "user",
    content: syntheticContent,
  });
}

// ── drainQueue ───────────────────────────────────────────────────────

/**
 * Tell this message's sender it left the queue for a turn, and remember that
 * we did. The flag is what makes the requeue paths able to distinguish a
 * message clients still believe is running from one they never stopped
 * showing as queued. See {@link requeueDrainedMessages}.
 *
 * Queue events come in pairs. A row with no client-visible queued counterpart
 * ({@link isSuppressedQueuedMessage} — hidden sends and the daemon-injected
 * subagent/ACP/wake notifications) never produced a `message_queued` ack, so
 * releasing one produces no dequeue either: an unpaired dequeue would retire a
 * client's counter entry for a message that is still waiting. Nothing was
 * announced, so the flag stays false and the requeue paths correctly send
 * nothing for it. The activity-state transition callers emit alongside this is
 * unrelated to the queue and always fires: the turn really is starting.
 */
function announceDequeue(
  conversation: Conversation,
  message: QueuedMessage,
): void {
  if (isSuppressedQueuedMessage(message.metadata)) {
    return;
  }
  message.onEvent({
    type: "message_dequeued",
    conversationId: conversation.conversationId,
    requestId: message.requestId,
    ...(message.clientMessageId
      ? { clientMessageId: message.clientMessageId }
      : {}),
  });
  message.dequeueAnnounced = true;
}

/**
 * 1-based position of `requestId` among the queue's VISIBLE items, or
 * undefined when the queue holds no such message. Mirrors the accounting the
 * `message_queued` ack uses (and the list-messages queued snapshot filter),
 * so a corrective requeue event places the row exactly where a cold reload
 * would render it.
 */
function visibleQueuePosition(
  conversation: Conversation,
  requestId: string,
): number | undefined {
  let position = 0;
  for (const item of conversation.queue.snapshot()) {
    if (isSuppressedQueuedMessage(item.metadata)) {
      continue;
    }
    position += 1;
    if (item.requestId === requestId) {
      return position;
    }
  }
  return undefined;
}

/**
 * Restore drained messages to the front of the queue, in their original
 * order, when the drain cannot run them: another turn (e.g. a barged-in
 * voice turn woken by the idle transition) owns the processing lock, or the
 * dispatch threw before the turn took over. The next drain trigger (the lock
 * holder's own finally block, or `kickQueueDrain`'s retry) picks them back
 * up. A steered drain also re-arms `pendingSteerRepair` so the re-drain
 * promotes the steered head on its own instead of batching it with tails;
 * the tool-use repair it re-triggers is idempotent.
 *
 * Any message whose dequeue was already announced gets the corrective
 * `message_requeued`: its sender cleared the pending indicator on the
 * `message_dequeued` and would otherwise see the row vanish until a later
 * drain. Messages requeued before the announcement (the pre-flight
 * processing-lock checks) get nothing, because clients never stopped showing
 * them as queued and an event there would be noise. Rows with no client-visible
 * queued counterpart ({@link isSuppressedQueuedMessage} — hidden sends and
 * daemon-injected subagent/ACP/wake notifications) are suppressed for the same
 * reason they get no queued ack: they have no client row.
 */
function requeueDrainedMessages(
  conversation: Conversation,
  messages: QueuedMessage[],
  steered: boolean,
  logMessage: string,
): void {
  log.info(
    {
      conversationId: conversation.conversationId,
      requestId: messages[0].requestId,
      batchSize: messages.length,
    },
    logMessage,
  );
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    conversation.queue.unshift(messages[i]);
  }
  if (steered) {
    conversation.pendingSteerRepair = true;
  }
  for (const message of messages) {
    if (!message.dequeueAnnounced) {
      continue;
    }
    message.dequeueAnnounced = false;
    if (isSuppressedQueuedMessage(message.metadata)) {
      continue;
    }
    const position = visibleQueuePosition(conversation, message.requestId);
    if (position === undefined) {
      continue;
    }
    message.onEvent({
      type: "message_requeued",
      conversationId: conversation.conversationId,
      requestId: message.requestId,
      position,
      ...(message.clientMessageId
        ? { clientMessageId: message.clientMessageId }
        : {}),
    });
  }
}

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
    if (!next) {
      return;
    }
    return dispatchDrainWithRestore(conversation, [next], true, () =>
      drainSingleMessage(conversation, next, reason, true),
    );
  }

  const batch = await buildPassthroughBatch(conversation);
  if (batch.length === 0) {
    // Head is a slash / verification intent / empty queue. If the queue has
    // an item the builder rejected, pop it and hand it to the single-message
    // path — which owns slash / compact / verification-intent behavior.
    const next = conversation.queue.shift();
    if (!next) {
      return;
    }
    return dispatchDrainWithRestore(conversation, [next], false, () =>
      drainSingleMessage(conversation, next, reason),
    );
  }
  if (batch.length === 1) {
    return dispatchDrainWithRestore(conversation, batch, false, () =>
      drainSingleMessage(conversation, batch[0], reason),
    );
  }
  return dispatchDrainWithRestore(conversation, batch, false, () =>
    drainBatch(conversation, batch, reason),
  );
}

/**
 * Errors that already triggered a queue restore on their way up. Drains
 * recurse (a dropped message's error path re-drains the remaining queue), so
 * without the marker an inner dispatch failure would also restore the outer
 * dispatch's messages — resurrecting a message whose sender was already told
 * it failed.
 */
const restoredDrainErrors = new WeakSet<object>();

/**
 * Run a drain dispatch whose messages are already removed from the queue,
 * restoring them to the front if the dispatch throws. `drainQueue` pops
 * messages before the throw-prone turn-start steps (slash resolution,
 * per-turn context application), so without the restore a retry would skip
 * the failed message entirely: it drains the NEXT item, succeeds, and the
 * removed message is silently lost with no `queue_drain_failed` event.
 */
async function dispatchDrainWithRestore(
  conversation: Conversation,
  messages: QueuedMessage[],
  steered: boolean,
  dispatch: () => Promise<void>,
): Promise<void> {
  try {
    return await dispatch();
  } catch (err) {
    const alreadyRestored =
      typeof err === "object" && err !== null && restoredDrainErrors.has(err);
    if (!alreadyRestored) {
      if (typeof err === "object" && err !== null) {
        restoredDrainErrors.add(err);
      }
      requeueDrainedMessages(
        conversation,
        messages,
        steered,
        "Requeueing drained messages: drain dispatch threw",
      );
    }
    throw err;
  }
}

/**
 * Fire-and-forget entry point for drain triggers that sit outside the drain
 * promise chain (the agent loop's `finally`, route handlers releasing the
 * processing lock). `drainQueue` is async — batch building awaits slash
 * resolution and can throw — and nothing re-triggers a drain whose promise
 * rejects: the queued messages would sit stranded until an unrelated later
 * turn completes. This wrapper never rejects. A failed drain is retried
 * once — `dispatchDrainWithRestore` has already returned any popped
 * messages to the queue head, so the retry retries the same messages. If
 * the retry also fails, every queued sender is notified so the stall is
 * visible to the user instead of silent, and the messages remain queued
 * for the next drain trigger.
 *
 * `origin` names the triggering site for log correlation.
 */
export async function kickQueueDrain(
  conversation: Conversation,
  reason: QueueDrainReason = "loop_complete",
  origin?: string,
): Promise<void> {
  try {
    await drainQueue(conversation, reason);
    return;
  } catch (err) {
    log.error(
      {
        err,
        conversationId: conversation.conversationId,
        reason,
        origin,
        queueDepth: conversation.queue.length,
      },
      "drainQueue rejected; retrying once",
    );
  }
  try {
    await drainQueue(conversation, reason);
  } catch (err) {
    log.error(
      {
        err,
        conversationId: conversation.conversationId,
        reason,
        origin,
        queueDepth: conversation.queue.length,
      },
      "drainQueue retry rejected; queued messages remain stranded until the next drain trigger",
    );
    // Only the sends a user is waiting on get the failure notice. A stranded
    // row with no client-visible queued counterpart (hidden machine signal,
    // daemon-injected subagent/ACP/wake notification) has no queued bubble to
    // explain, so a "your queued message" error would describe something the
    // user never sent.
    const strandedVisible = conversation.queue
      .snapshot()
      .filter((queued) => !isSuppressedQueuedMessage(queued.metadata));
    for (const queued of strandedVisible) {
      queued.onEvent({
        type: "error",
        conversationId: conversation.conversationId,
        requestId: queued.requestId,
        message:
          "The assistant couldn't start your queued message due to an internal error. The message is still queued and will be retried after the next reply; you can also cancel and resend it.",
        category: "queue_drain_failed",
      });
    }
  }
}

async function drainSingleMessage(
  conversation: Conversation,
  next: QueuedMessage,
  reason: QueueDrainReason,
  steered = false,
): Promise<void> {
  // Another turn already owns the processing lock: requeue before touching
  // ANY conversation state. The lock holder installed its own per-turn
  // context (turn channel/interface, trust, transport hints) and a drain
  // that proceeded past this point would clobber it. The persist-busy
  // requeue below stays as the TOCTOU backstop for a lock taken after
  // this check.
  if (conversation.isProcessing()) {
    requeueDrainedMessages(
      conversation,
      [next],
      steered,
      "Requeueing drained message: processing lock is held",
    );
    return;
  }

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
  announceDequeue(conversation, next);
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
    conversation.applyVisibleAppFromTransport(next.transport);
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
  // Trust comes from the queued message, not the live slot: the slot holds
  // whichever actor sent most recently, which is this sender only when nobody
  // else sent while this message waited.
  conversation.currentTurnTrustContext =
    next.trustContext ?? conversation.trustContext;
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
        turnOrRestingTrust(conversation),
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
      const cleanUserMsg = await createUserMessage(
        next.content,
        next.attachments,
      );
      const llmUserMsg = enrichMessageWithSourcePaths(
        cleanUserMsg,
        next.attachments,
      );
      // When displayContent is provided (e.g. original text before recording
      // intent stripping), persist that to DB so users see the full message.
      // The in-memory userMessage (sent to the LLM) still uses the stripped content.
      const contentToPersist = await serializePersistedUserMessageContent(
        next.content,
        next.displayContent,
        next.attachments,
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
        turnOrRestingTrust(conversation),
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
      const cleanUserMsg = await createUserMessage(
        next.content,
        next.attachments,
      );
      await addMessage(
        conversation.conversationId,
        "user",
        await serializePersistedUserMessageContent(
          next.content,
          next.displayContent,
          next.attachments,
        ),
        { metadata: drainChannelMeta },
      );
      persistedCompactMessage = true;
      conversation.messages.push(cleanUserMsg);

      conversation.emitActivityState("thinking", "context_compacting", {
        requestId: next.requestId,
      });
      // Push the usage refresh to the queued item's own sink, the one the
      // result card below streams on. `sendToClient` is reset to a no-op once
      // an interactive turn finishes, so a `/compact` draining behind one
      // would otherwise refresh nothing.
      const result = await conversation.forceCompact(next.onEvent);
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
        turnOrRestingTrust(conversation),
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
      const cleanUserMsg = await createUserMessage(
        next.content,
        next.attachments,
      );
      await addMessage(
        conversation.conversationId,
        "user",
        await serializePersistedUserMessageContent(
          next.content,
          next.displayContent,
          next.attachments,
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
      // Attribute the stored row to the sender this turn runs as, not to
      // whoever happens to occupy the conversation slot at drain time.
      trustContext: next.trustContext,
      ...(next.transport?.clientOs
        ? { requestClientOs: next.transport.clientOs }
        : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // runAgentLoop never ran, so its finally block won't clear this
    conversation.preactivatedSkillIds = undefined;
    if (message === CONVERSATION_BUSY_MESSAGE) {
      // Another turn took the lock between this drain's dequeue and its
      // persist. The message is still valid — requeue it at the front and
      // stop; the lock holder's own finally re-drains the queue.
      requeueDrainedMessages(
        conversation,
        [next],
        steered,
        "Requeueing drained message: processing lock was retaken",
      );
      return;
    }
    log.error(
      {
        err,
        conversationId: conversation.conversationId,
        requestId: next.requestId,
      },
      "Failed to persist queued message",
    );
    next.onEvent({
      type: "error",
      conversationId: conversation.conversationId,
      message,
    });
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
    // The row this echo announces is already durably persisted, so advance
    // the snapshot↔stream anchor to the echo's seq (stamped inline by the
    // publish path). Without this, `/messages` returns the row while still
    // advertising the previous flush's anchor — under-claiming, which breaks
    // the contract that the rows reflect all of this conversation's events
    // through the advertised seq. Safe to claim here: the previous turn's
    // content flushed at turn end and this turn's loop hasn't started, so no
    // streamed-but-unflushed content exists for this conversation.
    recordConversationPersistedSeq(
      conversation.conversationId,
      getCurrentSeq(),
    );
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
        if (!result.detected) {
          return;
        }
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
    turnTrustContext?: TrustContext;
  } = {
    isUserMessage: true,
    // Carry the sender's trust into the run. The loop re-initializes the
    // per-turn snapshot on entry, so without this the stamp above is undone
    // and the turn reverts to the conversation's most recent actor.
    turnTrustContext: conversation.currentTurnTrustContext,
  };
  if (next.isInteractive !== undefined) {
    drainLoopOptions.isInteractive = next.isInteractive;
  }
  if (agentLoopContent !== resolvedContent) {
    drainLoopOptions.titleText = resolvedContent;
  }
  if (isHiddenMessageMetadata(next.metadata)) {
    drainLoopOptions.isHiddenPrompt = true;
  }

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
  // Another turn already owns the processing lock: requeue the whole batch
  // before touching ANY conversation state, mirroring `drainSingleMessage`.
  // The head persist-busy requeue below stays as the TOCTOU backstop.
  // Steered drains never batch, so there is no steer promotion to restore.
  if (conversation.isProcessing()) {
    requeueDrainedMessages(
      conversation,
      batch,
      false,
      "Requeueing drained batch: processing lock is held",
    );
    return;
  }

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
    conversation.applyVisibleAppFromTransport(head.transport);
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
  // The head's trust governs the batch, which is sound only because
  // `buildPassthroughBatch` refuses to coalesce messages from different
  // actors; without that boundary this would run a tail under the head's
  // trust.
  conversation.currentTurnTrustContext =
    head.trustContext ?? conversation.trustContext;
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
  // `messages.id` of the last member the reply-push producer would actually
  // notify about. Selected with the producer's own eligibility predicate so a
  // trailing row it suppresses (a hidden marker, a channel send) cannot stand
  // in for the prompt ahead of it and swallow that prompt's push.
  let lastPushEligibleUserMessageId: string | undefined;
  // Members whose persist succeeded. `fanOutOnEvent` below must only
  // broadcast agent-loop events to these — clients whose persist failed
  // already received an error event and must not also receive the
  // assistant's streaming response for a turn that isn't theirs.
  const successfulBatch: QueuedMessage[] = [];
  // `messages.id` of every successfully-persisted, non-deduplicated member,
  // in persist order. All but the last are coalesced heads whose shared
  // response lives on the final member's turn — stamped `batched` below so
  // turn telemetry can tell them apart from failed turns.
  const persistedMessageIds: string[] = [];
  for (let i = 0; i < batch.length; i++) {
    const qm = batch[i];
    announceDequeue(conversation, qm);

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
        // Same attribution rule as the single-message drain. Batch members
        // share one sender, so every row here names that sender.
        trustContext: qm.trustContext,
        ...(qm.transport?.clientOs
          ? { requestClientOs: qm.transport.clientOs }
          : {}),
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
      persistedMessageIds.push(batchPersistResult.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (i === 0 && message === CONVERSATION_BUSY_MESSAGE) {
        // The head hit lock contention before any batch state was set:
        // another turn took the lock between dequeue and persist. The
        // whole batch is still valid — requeue it at the front in order
        // and stop; the lock holder's finally re-drains the queue.
        conversation.preactivatedSkillIds = undefined;
        requeueDrainedMessages(
          conversation,
          batch,
          false,
          "Requeueing drained batch: processing lock was retaken",
        );
        return;
      }
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: qm.requestId,
          batchIndex: i,
        },
        "Failed to persist batched queued message",
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

    if (!isReplyPushIneligibleUserMessage(qm.metadata)) {
      lastPushEligibleUserMessageId = lastUserMessageId;
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
      // Advance the snapshot↔stream anchor to this echo's seq — the batched
      // row persisted just above and the agent loop for the batch has not
      // started. See the identical advance in `drainSingleMessage`.
      recordConversationPersistedSeq(
        conversation.conversationId,
        getCurrentSeq(),
      );
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
          if (!result.detected) {
            return;
          }
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

  // Every persisted member except the last is a coalesced-batch head: its
  // window holds no assistant response because the shared response is
  // attributed to the final member's turn. Stamp them `batched` (pointing at
  // that final turn) so the turn-event scan reports them as coalesced rather
  // than leaving them indistinguishable from failed turns. Stamping happens
  // while the conversation is still processing, so the telemetry reporter's
  // settled-turn barrier guarantees the stamp is visible before these turns
  // ship.
  for (const headId of persistedMessageIds.slice(0, -1)) {
    stampTurnOutcome(headId, "batched", { batchedInto: lastUserMessageId });
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
  const fanOutOnEvent = (msg: AssistantEvent) => {
    for (const onEvent of successfulEventSinks) {
      onEvent(msg);
    }
  };

  const drainLoopOptions: {
    isInteractive?: boolean;
    isUserMessage?: boolean;
    titleText?: string;
    isHiddenPrompt?: boolean;
    notifyUserMessageId?: string;
    turnTrustContext?: TrustContext;
  } = {
    isUserMessage: true,
    // Same reason as the single-message drain: the loop re-initializes the
    // per-turn snapshot, so the head's trust has to travel with the call.
    turnTrustContext: conversation.currentTurnTrustContext,
  };
  if (lastPushEligibleUserMessageId !== undefined) {
    drainLoopOptions.notifyUserMessageId = lastPushEligibleUserMessageId;
  }
  // Source interactive flag from the last successfully-persisted sibling so
  // a trailing failed tail doesn't flip the agent loop's interactivity.
  const lastSuccessfulBatchEntry =
    successfulBatch.length > 0
      ? successfulBatch[successfulBatch.length - 1]
      : undefined;
  if (lastSuccessfulBatchEntry?.isInteractive !== undefined) {
    drainLoopOptions.isInteractive = lastSuccessfulBatchEntry.isInteractive;
  }
  // A batch counts as a hidden turn only when every message in it is a
  // hidden machine signal — one genuine user prompt justifies the
  // prompt-as-user-speech consumers (title generation).
  if (
    successfulBatch.length > 0 &&
    successfulBatch.every((qm) => isHiddenMessageMetadata(qm.metadata))
  ) {
    drainLoopOptions.isHiddenPrompt = true;
  }

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
  onEvent?: (msg: AssistantEvent) => void;
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
  /**
   * The actor this turn is being started for. Stamped onto the conversation
   * before history is scoped, so the run hydrates as its committer rather
   * than as whoever last left the resting slot set. Callers with no actor of
   * their own (internal dispatch) omit it and the resting actor stands.
   */
  trustContext?: TrustContext;
  /**
   * True when this turn was auto-sent on the user's behalf rather than typed
   * (see `PersistMessageOptions.scripted`). Forwarded to persistence so the
   * turn is excluded from activation counts. Defaults to false. A caller
   * sending machine-authored content into a `standard` conversation must set
   * it explicitly.
   *
   * Related to `metadata.automated` below but not the same knob: `automated`
   * implies scripted (machine-authored is by definition not typed), while
   * `scripted` carries no memory-indexing side effect. A caller that wants a
   * turn excluded from activation but still indexed sets this, not that.
   */
  scripted?: boolean;
  /**
   * Extra metadata stamped onto the persisted user row alongside the channel
   * and provenance fields the turn derives. Callers that drive a turn on
   * someone's behalf use it to mark the row's provenance (e.g. the plugin-api
   * facade stamps `automated`).
   */
  metadata?: Record<string, unknown>;
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
    scripted,
    metadata: callerMetadata,
    trustContext: committingTrustContext,
  } = options;
  if (committingTrustContext) {
    conversation.setTrustContext(committingTrustContext);
  }
  await conversation.ensureActorScopedHistory();
  // Snapshot persona context at turn start so later tool turns can't pick up
  // a different actor's context if a concurrent request mutates the live fields.
  //
  // Held in a local as well as on the conversation: the field is writable
  // out-of-band while this turn is in flight (`agent-wake` stamps it and
  // restores the prior value in a `finally`), so reading it back at the agent
  // loop call below would reintroduce the late read this capture exists to
  // avoid. The local is what the loop runs under.
  const turnTrustContext = conversation.trustContext;
  conversation.currentTurnTrustContext = turnTrustContext;
  conversation.currentTurnAuthContext = conversation.authContext;
  conversation.currentTurnSourceActorPrincipalId =
    sourceActorPrincipalId ?? conversation.authContext?.actorPrincipalId;
  conversation.currentTurnChannelCapabilities =
    conversation.channelCapabilities;
  conversation.currentActiveSurfaceId = activeSurfaceId;
  conversation.currentPage = currentPage;
  const trimmedContent = content.trim();
  // Hint read degrades to empty on gateway failure — the scope then stays
  // unset and identity-fallback still resolves the guardian's pending work.
  const pendingRequestHintIdsForConversation =
    trimmedContent.length > 0
      ? (
          await listPendingRequestsByScopeOrEmpty(
            conversation.conversationId,
            "vellum",
          )
        ).map((request) => request.id)
      : [];
  // Empty hints → leave the scope unset (identity-fallback): the desktop
  // guardian can still resolve their pending work by identity/principal.
  const pendingScope: GuardianPendingScope | undefined =
    pendingRequestHintIdsForConversation.length > 0
      ? {
          mode: "scoped",
          requestIds: pendingRequestHintIdsForConversation,
        }
      : undefined;

  // ── Guardian reply router (desktop/conversation path) ──
  // Desktop/conversation guardian replies route only through the guardian
  // decision pipeline. Messages consumed by the router never hit the general
  // agent loop.
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

      const cleanUserMsg = await createUserMessage(content, attachments);
      const llmUserMsg = enrichMessageWithSourcePaths(
        cleanUserMsg,
        attachments,
      );
      const persisted = await addMessage(
        conversation.conversationId,
        "user",
        await serializePersistedUserMessageContent(
          content,
          displayContent,
          attachments,
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
        "Conversation guardian reply routed through the guardian decision pipeline",
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
    const pmProvenance = provenanceFromTrustContext(
      turnOrRestingTrust(conversation),
    );
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
    const cleanUserMsg = await createUserMessage(content, attachments);
    const llmUserMsg = enrichMessageWithSourcePaths(cleanUserMsg, attachments);
    // When displayContent is provided (e.g. original text before recording
    // intent stripping), persist that to DB so users see the full message.
    // The in-memory userMessage (sent to the LLM) still uses the stripped content.
    const contentToPersist = await serializePersistedUserMessageContent(
      content,
      displayContent,
      attachments,
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
        turnOrRestingTrust(conversation),
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
      const cleanUserMsg = await createUserMessage(content, attachments);
      const persisted = await addMessage(
        conversation.conversationId,
        "user",
        await serializePersistedUserMessageContent(
          content,
          displayContent,
          attachments,
        ),
        { metadata: pmChannelMeta },
      );
      persistedCompactMessage = true;
      conversation.messages.push(cleanUserMsg);

      conversation.emitActivityState("thinking", "context_compacting", {
        requestId,
      });
      // Same sink the result card below streams on (see the drain branch).
      const result = await conversation.forceCompact(onEvent);
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
      // `kickQueueDrain` never rejects, so a failed drain in this `finally`
      // cannot mask the error the try block is unwinding, and its retry plus
      // sender notification replace a silently stranded queue.
      await kickQueueDrain(conversation, "loop_complete", "compact_command");
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
        turnOrRestingTrust(conversation),
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
      const cleanUserMsg = await createUserMessage(content, attachments);
      const persisted = await addMessage(
        conversation.conversationId,
        "user",
        await serializePersistedUserMessageContent(
          content,
          displayContent,
          attachments,
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
      // Same never-rejecting drain as the `/compact` branch above.
      await kickQueueDrain(conversation, "loop_complete", "clean_command");
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
      scripted,
      ...(callerMetadata ? { metadata: callerMetadata } : {}),
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
        if (!result.detected) {
          return;
        }
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
    turnTrustContext?: TrustContext;
  } = {
    isUserMessage: true,
    // Carry the trust captured at turn start into the run. Several awaits sit
    // between that capture and the loop opening, and both the conversation
    // slot and the per-turn field are writable throughout that window, so
    // reading either here would run this turn as whoever wrote last. The
    // local captured at turn start is the only value no other writer can move.
    turnTrustContext,
  };
  if (isInteractive !== undefined) {
    loopOptions.isInteractive = isInteractive;
  }
  if (agentLoopContent !== resolvedContent) {
    loopOptions.titleText = resolvedContent;
  }
  if (callSite !== undefined) {
    loopOptions.callSite = callSite;
  }
  if (overrideProfile !== undefined) {
    loopOptions.overrideProfile = overrideProfile;
  }

  await conversation.runAgentLoop(agentLoopContent, userMessageId, {
    ...loopOptions,
    onEvent,
  });
  return userMessageId;
}
