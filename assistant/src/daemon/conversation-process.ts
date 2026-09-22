/**
 * Message processing logic extracted from Conversation.
 *
 * Conversation delegates `processMessage` to the module-level functions
 * exported here, following the same context-interface pattern used by
 * conversation-history.ts.
 */

import { enrichMessageWithSourcePaths } from "../agent/attachments.js";
import {
  createAssistantMessage,
  createUserMessage,
} from "../agent/message-types.js";
import type { AssistantEvent } from "../api/index.js";
import { listPendingRequestsByScopeOrEmpty } from "../channels/gateway-guardian-requests.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { extractPreferences } from "../notifications/preference-extractor.js";
import { createPreference } from "../notifications/preferences-store.js";
import {
  addMessage,
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
import { CONVERSATION_BUSY_MESSAGE } from "./conversation-busy-error.js";
import { serializePersistedUserMessageContent } from "./conversation-messaging.js";
import {
  buildSlashContextForContent,
  resolveSlash,
  type SlashContext,
} from "./conversation-slash.js";
import { getModelInfo } from "./handlers/config-model.js";
import type { UserMessageAttachment } from "./message-protocol.js";
import type { TrustContext } from "./trust-context-types.js";
import { restingTrust, turnOrRestingTrust } from "./trust-context-types.js";
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
  const priorRestingTrust = restingTrust(conversation);
  if (committingTrustContext) {
    conversation.setTrustContext(committingTrustContext);
  }
  // Held in a local as well as on the conversation: the field is writable
  // out-of-band while this turn is in flight (`agent-wake` stamps it and
  // restores the prior value in a `finally`), so reading it back at the agent
  // loop call below would reintroduce the late read this capture exists to
  // avoid. The local is what the loop runs under. Captured before the history
  // reload for the same reason: that await is one of the windows a writer can
  // land in.
  const turnTrustContext = restingTrust(conversation);
  conversation.currentTurnTrustContext = turnTrustContext;
  try {
    await conversation.ensureActorScopedHistory();
  } catch (err) {
    // This is the commitment point for the turn, so the stamp above is
    // correct, but a reload that fails starts no turn: the conversation must
    // not be left attributed to a sender that never ran. Guarded on identity
    // so a writer that legitimately moved the slot across the await keeps it.
    // Only the resting slot needs putting back; `runAgentLoopImpl` re-seeds
    // the per-turn field at the head of every turn, so no later dispatch can
    // inherit it.
    if (
      committingTrustContext &&
      restingTrust(conversation) === committingTrustContext
    ) {
      conversation.setTrustContext(priorRestingTrust ?? null);
    }
    throw err;
  }
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
    // Taken rather than set: `processMessage` never checks the flag itself, so
    // the idle decision behind this branch was made by a caller several awaits
    // ago (history scoping, guardian routing, slash resolution all sit
    // between). A hold taken since belongs to a real turn, and this reports
    // busy the way that caller's own gate does rather than claiming it away.
    const compactOwner = await conversation.acquireProcessingFenced();
    if (compactOwner === null) {
      throw new Error(CONVERSATION_BUSY_MESSAGE);
    }
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
      conversation.releaseProcessing(compactOwner);
    }
  }

  // /clean — strip runtime injections, return message ID. No LLM call.
  if (slashResult.kind === "clean") {
    // Taken rather than set: `processMessage` never checks the flag itself, so
    // the idle decision behind this branch was made by a caller several awaits
    // ago (history scoping, guardian routing, slash resolution all sit
    // between). A hold taken since belongs to a real turn, and this reports
    // busy the way that caller's own gate does rather than claiming it away.
    const cleanOwner = await conversation.acquireProcessingFenced();
    if (cleanOwner === null) {
      throw new Error(CONVERSATION_BUSY_MESSAGE);
    }
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
      conversation.releaseProcessing(cleanOwner);
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
      activeSurfaceId,
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
