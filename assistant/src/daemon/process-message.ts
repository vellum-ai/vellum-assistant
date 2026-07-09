/**
 * Extracted free-function form of DaemonServer.processMessage and its helpers.
 *
 * Route handlers import {@link processMessage} directly instead of receiving
 * it through DI. The DaemonServer methods delegate here.
 */

import { enrichMessageWithSourcePaths } from "../agent/attachments.js";
import {
  createAssistantMessage,
  createUserMessage,
} from "../agent/message-types.js";
import {
  type ChannelId,
  type InterfaceId,
  parseChannelId,
  parseInterfaceId,
} from "../channels/types.js";
import {
  getAttachmentsByIds,
  getSourcePathsForAttachments,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  getConversation,
  provenanceFromTrustContext,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
} from "../persistence/conversation-crud.js";
import { updateMetaFile } from "../persistence/conversation-disk-view.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import { getSubagentManager } from "../subagent/index.js";
import {
  readTurnFailure,
  type TurnFailure,
} from "../telemetry/turn-outcome.js";
import { getLogger } from "../util/logger.js";
import type { Conversation } from "./conversation.js";
import {
  buildSlackMetaForPersistence,
  serializePersistedUserMessageContent,
} from "./conversation-messaging.js";
import {
  formatCleanResult,
  formatCompactResult,
} from "./conversation-process.js";
import { resolveChannelCapabilities } from "./conversation-runtime-assembly.js";
import {
  buildSlashContextForContent,
  resolveSlash,
} from "./conversation-slash.js";
import {
  getOrCreateConversation as getOrCreateActiveConversation,
  mergeConversationOptions,
} from "./conversation-store.js";
import { getDbMigrationReadiness } from "./daemon-readiness.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";
import { HostAppControlProxy } from "./host-app-control-proxy.js";
import { HostCuProxy } from "./host-cu-proxy.js";
import {
  preactivateHostProxySkills,
  shouldAttachHostProxyForCapability,
} from "./host-proxy-preactivation.js";
import type { ServerMessage } from "./message-protocol.js";

const log = getLogger("process-message");

type ProcessMessageOptions = ConversationCreateOptions & {
  /** Per-turn observer for live agent-loop events. Does not replace SSE broadcast. */
  onEvent?: (msg: ServerMessage) => void;
  /** IDs of user-uploaded attachments to resolve and include in the turn. */
  attachmentIds?: string[];
  /** Originating channel (e.g. "slack", "telegram"). Defaults to "vellum". */
  sourceChannel?: string;
  /** Originating interface (e.g. "cli", "web"). Defaults to "web". */
  sourceInterface?: string;
  /**
   * Origin tag of the turn (the conversation's `TitleOrigin`, e.g.
   * "memory_consolidation"), threaded from `runBackgroundJob`. Propagated
   * into the agent loop and tool context so the permission checker can scope
   * narrow non-interactive auto-grants to a specific internal background
   * origin. Unset for normal user-initiated turns.
   */
  requestOrigin?: string;
  /**
   * Firing's `cron_runs.id`, threaded through to the turn's usage rows so a
   * scheduled execute turn attributes its LLM spend to that firing. Per-turn:
   * not stored on the long-lived conversation.
   */
  cronRunId?: string | null;
};

function buildEventEmitter(
  observer?: (msg: ServerMessage) => void,
): (msg: ServerMessage) => void {
  if (!observer) return broadcastMessage;
  return (msg) => {
    broadcastMessage(msg);
    try {
      observer(msg);
    } catch (err) {
      log.warn({ err, messageType: msg.type }, "Agent event observer failed");
    }
  };
}

// ---------------------------------------------------------------------------
// Turn-context resolution helpers
// ---------------------------------------------------------------------------

export function resolveTurnChannel(
  sourceChannel?: string,
  transportChannelId?: string,
): ChannelId {
  if (sourceChannel != null) {
    const parsed = parseChannelId(sourceChannel);
    if (!parsed) {
      throw new Error(`Invalid sourceChannel: ${sourceChannel}`);
    }
    return parsed;
  }
  if (transportChannelId != null) {
    const parsed = parseChannelId(transportChannelId);
    if (!parsed) {
      throw new Error(`Invalid transport.channelId: ${transportChannelId}`);
    }
    return parsed;
  }
  return "vellum";
}

export function resolveTurnInterface(sourceInterface?: string): InterfaceId {
  if (sourceInterface != null) {
    const parsed = parseInterfaceId(sourceInterface);
    if (!parsed) {
      throw new Error(`Invalid sourceInterface: ${sourceInterface}`);
    }
    return parsed;
  }
  return "web";
}

// ---------------------------------------------------------------------------
// prepareConversationForMessage
// ---------------------------------------------------------------------------

async function prepareConversationForMessage(
  conversationId: string,
  content: string,
  options?: ProcessMessageOptions,
): Promise<{
  conversation: Conversation;
  attachments: {
    id: string;
    filename: string;
    mimeType: string;
    data: string;
    filePath?: string;
  }[];
}> {
  const {
    attachmentIds,
    sourceChannel,
    sourceInterface,
    onEvent: _onEvent,
    cronRunId: _cronRunId,
    requestOrigin: _requestOrigin,
    ...conversationOptions
  } = options ?? {};
  const conversation = await getOrCreateActiveConversation(
    conversationId,
    Object.keys(conversationOptions).length > 0
      ? conversationOptions
      : undefined,
  );

  if (conversation.isProcessing()) {
    throw new Error("Conversation is already processing a message");
  }

  const resolvedChannel = resolveTurnChannel(
    sourceChannel,
    conversationOptions.transport?.channelId,
  );
  const resolvedInterface = resolveTurnInterface(sourceInterface);
  conversation.setAssistantId(
    options?.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
  );
  conversation.taskRunId = options?.taskRunId;
  if (options?.trustContext !== undefined) {
    conversation.setTrustContext(options.trustContext);
  }
  if (options?.authContext !== undefined) {
    conversation.setAuthContext(options.authContext);
  }
  await conversation.ensureActorScopedHistory();

  mergeConversationOptions(conversationId, {
    trustContext: conversation.trustContext,
    authContext: conversation.authContext,
  });
  conversation.setChannelCapabilities(
    resolveChannelCapabilities(
      sourceChannel,
      sourceInterface,
      options?.transport?.chatType,
    ),
  );
  if (resolvedInterface === "chrome-extension") {
    throw new Error(
      "prepareConversationForMessage does not yet support chrome-extension transport — " +
        "use the conversation-routes.ts /v1/messages flow which routes host_browser through " +
        "the assistant event hub. If you need chrome-extension here, factor out the " +
        "wiring in conversation-routes.ts into a shared helper.",
    );
  }
  const sourceActorPrincipalId = conversation.authContext?.actorPrincipalId;
  // CU is per-conversation (owns step count, AX tree history, loop detection).
  if (
    shouldAttachHostProxyForCapability(
      "host_cu",
      resolvedInterface,
      sourceActorPrincipalId,
    )
  ) {
    if (!conversation.isProcessing() || !conversation.hostCuProxy) {
      conversation.setHostCuProxy(new HostCuProxy());
    }
  } else if (!conversation.isProcessing()) {
    conversation.setHostCuProxy(undefined);
  }
  // App-control mirrors CU's per-conversation lifecycle. The proxy attaches
  // unconditionally when the capability is reachable — feature-flag gating
  // is enforced by the skill-projection layer via SKILL.md frontmatter, so
  // an attached proxy is harmless when the flag is off.
  if (
    shouldAttachHostProxyForCapability(
      "host_app_control",
      resolvedInterface,
      sourceActorPrincipalId,
    )
  ) {
    if (!conversation.isProcessing() || !conversation.hostAppControlProxy) {
      conversation.setHostAppControlProxy(
        new HostAppControlProxy(conversationId),
      );
    }
  } else if (!conversation.isProcessing()) {
    conversation.setHostAppControlProxy(undefined);
  }
  // The early `isProcessing()` throw above guarantees the conversation is
  // idle here, so preactivation is unconditional once the proxies are wired.
  preactivateHostProxySkills(
    conversation,
    resolvedInterface,
    sourceActorPrincipalId,
  );
  conversation.setCommandIntent(options?.commandIntent ?? null);
  conversation.setTurnChannelContext({
    userMessageChannel: resolvedChannel,
    assistantMessageChannel: resolvedChannel,
  });
  conversation.setTurnInterfaceContext({
    userMessageInterface: resolvedInterface,
    assistantMessageInterface: resolvedInterface,
  });

  const attachments = attachmentIds
    ? (() => {
        const resolved = getAttachmentsByIds(attachmentIds, {
          hydrateFileData: true,
        });
        const sourcePaths = getSourcePathsForAttachments(attachmentIds);
        return resolved.map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          data: a.dataBase64,
          ...(sourcePaths.has(a.id) ? { filePath: sourcePaths.get(a.id) } : {}),
        }));
      })()
    : [];

  return { conversation, attachments };
}

// ---------------------------------------------------------------------------
// processMessage — main entry point for channel inbound + daemon callers
// ---------------------------------------------------------------------------

/**
 * Defense-in-depth: never run a turn against a not-yet-migrated schema.
 * The HTTP send path is already gated by dbMigrationUnavailableForPath, the
 * IPC transport by dbMigrationGateResponse, and the background sweeps are
 * deferred until migrations settle — but {@link processMessage} and
 * {@link processMessageInBackground} are the two sinks every message caller
 * funnels through (sweeps, scheduler, pointer, signal handlers, the
 * conversation launcher), and the signal-file transport reaches them without
 * passing either transport gate. Migrations run async during startup, so a
 * caller can get here before the tables exist.
 */
function assertDbMigrationsReadyForTurn(): void {
  const migrationReadiness = getDbMigrationReadiness();
  if (!migrationReadiness.ready) {
    throw new Error(
      `Cannot process message: database migrations ${migrationReadiness.state}`,
    );
  }
}

export async function processMessage(
  conversationId: string,
  content: string,
  options?: ProcessMessageOptions,
): Promise<{
  messageId: string;
  assistantMessageId?: string;
  /**
   * The agent turn's failure outcome, or `null` when it replied normally. Set
   * when the turn failed (e.g. its LLM call failed with an invalid provider) —
   * that path persists a synthetic error message and returns normally rather
   * than throwing, so this is the only way an awaiting caller can tell. Omitted
   * by the slash-command branches, which never run the agent loop.
   */
  turnFailure?: TurnFailure | null;
}> {
  assertDbMigrationsReadyForTurn();

  const { conversation, attachments } = await prepareConversationForMessage(
    conversationId,
    content,
    options,
  );
  const emitEvent = buildEventEmitter(options?.onEvent);

  const serverInterfaceCtx = conversation.getTurnInterfaceContext();
  const slashContext = buildSlashContextForContent(content, {
    conversationId,
    messageCount: conversation.getMessages().length,
    inputTokens: conversation.usageStats.inputTokens,
    outputTokens: conversation.usageStats.outputTokens,
    estimatedCost: conversation.usageStats.estimatedCost,
    userMessageInterface: serverInterfaceCtx?.userMessageInterface,
  });
  const slashResult = await resolveSlash(content, slashContext);

  const slackMeta = buildSlackMetaForPersistence({
    slackInbound: options?.slackInbound,
    turnChannel: conversation.getTurnChannelContext()?.userMessageChannel,
  });

  if (slashResult.kind === "unknown") {
    const serverTurnCtx = conversation.getTurnChannelContext();
    const serverProvenance = provenanceFromTrustContext(
      conversation.trustContext,
    );
    const imageSourcePaths: Record<string, string> = {};
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i];
      if (a.filePath && a.mimeType.toLowerCase().startsWith("image/")) {
        imageSourcePaths[`${i}:${a.filename}`] = a.filePath;
      }
    }
    const serverChannelMeta = {
      ...serverProvenance,
      ...(serverTurnCtx
        ? {
            userMessageChannel: serverTurnCtx.userMessageChannel,
            assistantMessageChannel: serverTurnCtx.assistantMessageChannel,
          }
        : {}),
      ...(serverInterfaceCtx
        ? {
            userMessageInterface: serverInterfaceCtx.userMessageInterface,
            assistantMessageInterface:
              serverInterfaceCtx.assistantMessageInterface,
          }
        : {}),
      ...(Object.keys(imageSourcePaths).length > 0 ? { imageSourcePaths } : {}),
    };
    const userMetaWithSlack = slackMeta
      ? { ...serverChannelMeta, slackMeta }
      : serverChannelMeta;
    const cleanMsg = createUserMessage(content, attachments);
    const llmMsg = enrichMessageWithSourcePaths(cleanMsg, attachments);
    const persisted = await addMessage(
      conversationId,
      "user",
      serializePersistedUserMessageContent(
        content,
        attachments,
        options?.displayContent,
      ),
      { metadata: userMetaWithSlack },
    );
    conversation.getMessages().push(llmMsg);

    if (serverTurnCtx) {
      try {
        setConversationOriginChannelIfUnset(
          conversationId,
          serverTurnCtx.userMessageChannel,
        );
      } catch (err) {
        log.warn(
          { err, conversationId },
          "Failed to set origin channel (best-effort)",
        );
      }
    }
    if (serverInterfaceCtx) {
      try {
        setConversationOriginInterfaceIfUnset(
          conversationId,
          serverInterfaceCtx.userMessageInterface,
        );
      } catch (err) {
        log.warn(
          { err, conversationId },
          "Failed to set origin interface (best-effort)",
        );
      }
    }

    if (serverTurnCtx || serverInterfaceCtx) {
      try {
        const convForMeta = getConversation(conversationId);
        if (convForMeta) {
          updateMetaFile(convForMeta);
        }
      } catch (err) {
        log.warn(
          { err, conversationId },
          "Failed to update disk meta (best-effort)",
        );
      }
    }

    const assistantMsg = createAssistantMessage(slashResult.message);
    const persistedAssistant = await addMessage(
      conversationId,
      "assistant",
      JSON.stringify(assistantMsg.content),
      { metadata: serverChannelMeta },
    );
    conversation.getMessages().push(assistantMsg);
    publishConversationMessagesChanged(conversationId);
    return {
      messageId: persisted.id,
      assistantMessageId: persistedAssistant.id,
    };
  }

  if (slashResult.kind === "compact") {
    const serverTurnCtx = conversation.getTurnChannelContext();
    const serverProvenance = provenanceFromTrustContext(
      conversation.trustContext,
    );
    const compactChannelMeta = {
      ...serverProvenance,
      ...(serverTurnCtx
        ? {
            userMessageChannel: serverTurnCtx.userMessageChannel,
            assistantMessageChannel: serverTurnCtx.assistantMessageChannel,
          }
        : {}),
      ...(serverInterfaceCtx
        ? {
            userMessageInterface: serverInterfaceCtx.userMessageInterface,
            assistantMessageInterface:
              serverInterfaceCtx.assistantMessageInterface,
          }
        : {}),
    };
    const compactUserMeta = slackMeta
      ? { ...compactChannelMeta, slackMeta }
      : compactChannelMeta;
    const cleanMsg = createUserMessage(content, attachments);
    const persisted = await addMessage(
      conversationId,
      "user",
      serializePersistedUserMessageContent(
        content,
        attachments,
        options?.displayContent,
      ),
      { metadata: compactUserMeta },
    );
    conversation.getMessages().push(cleanMsg);

    conversation.emitActivityState("thinking", "context_compacting");
    const result = await conversation.forceCompact();
    const responseText = formatCompactResult(result);
    const assistantMsg = createAssistantMessage(responseText);
    const persistedAssistant = await addMessage(
      conversationId,
      "assistant",
      JSON.stringify(assistantMsg.content),
      { metadata: compactChannelMeta },
    );
    conversation.getMessages().push(assistantMsg);
    publishConversationMessagesChanged(conversationId);
    return {
      messageId: persisted.id,
      assistantMessageId: persistedAssistant.id,
    };
  }

  if (slashResult.kind === "clean") {
    const serverTurnCtx = conversation.getTurnChannelContext();
    const serverProvenance = provenanceFromTrustContext(
      conversation.trustContext,
    );
    const cleanChannelMeta = {
      ...serverProvenance,
      ...(serverTurnCtx
        ? {
            userMessageChannel: serverTurnCtx.userMessageChannel,
            assistantMessageChannel: serverTurnCtx.assistantMessageChannel,
          }
        : {}),
      ...(serverInterfaceCtx
        ? {
            userMessageInterface: serverInterfaceCtx.userMessageInterface,
            assistantMessageInterface:
              serverInterfaceCtx.assistantMessageInterface,
          }
        : {}),
    };
    const cleanUserMeta = slackMeta
      ? { ...cleanChannelMeta, slackMeta }
      : cleanChannelMeta;
    const cleanMsg = createUserMessage(content, attachments);
    const persisted = await addMessage(
      conversationId,
      "user",
      serializePersistedUserMessageContent(
        content,
        attachments,
        options?.displayContent,
      ),
      { metadata: cleanUserMeta },
    );
    conversation.getMessages().push(cleanMsg);

    const result = await conversation.forceClean();
    const responseText = formatCleanResult(result);
    const assistantMsg = createAssistantMessage(responseText);
    const persistedAssistant = await addMessage(
      conversationId,
      "assistant",
      JSON.stringify(assistantMsg.content),
      { metadata: cleanChannelMeta },
    );
    conversation.getMessages().push(assistantMsg);
    publishConversationMessagesChanged(conversationId);
    return {
      messageId: persisted.id,
      assistantMessageId: persistedAssistant.id,
    };
  }

  const resolvedContent = slashResult.content;

  const requestId = crypto.randomUUID();
  const persistMetadata = options?.slackInbound
    ? { slackInbound: options.slackInbound }
    : undefined;
  const { id: messageId } = await conversation.persistUserMessage({
    content: resolvedContent,
    attachments,
    requestId,
    metadata: persistMetadata,
    displayContent: options?.displayContent,
  });
  publishConversationMessagesChanged(conversationId);

  if (options?.isInteractive === true) {
    conversation.updateClient(broadcastMessage, false);
    getSubagentManager().updateParentSender(conversationId, broadcastMessage);
  }

  try {
    await conversation.runAgentLoop(resolvedContent, messageId, {
      onEvent: emitEvent,
      isInteractive: options?.isInteractive ?? false,
      isUserMessage: true,
      ...(options?.callSite ? { callSite: options.callSite } : {}),
      ...(options?.overrideProfile
        ? { overrideProfile: options.overrideProfile }
        : {}),
      ...(options?.requestOrigin
        ? { requestOrigin: options.requestOrigin }
        : {}),
      ...(options?.cronRunId ? { cronRunId: options.cronRunId } : {}),
    });
  } finally {
    if (
      options?.isInteractive === true &&
      conversation.getCurrentSender() === broadcastMessage
    ) {
      conversation.updateClient(() => {}, true);
    }
  }

  // Read the just-finished turn's outcome from the stamp `runAgentLoop`'s
  // `finally` wrote onto this user-message row. A failed turn (e.g. an LLM
  // call that failed with an invalid provider) ends without throwing, so this
  // is the only signal an awaiting caller gets.
  const turnFailure = readTurnFailure(messageId);
  return { messageId, turnFailure };
}

/**
 * Fire-and-forget variant of {@link processMessage}. Persists the user
 * message and kicks off the agent loop in the background, returning the
 * `messageId` immediately without waiting for completion.
 *
 * Used by signal handlers and the conversation-launcher where the caller
 * does not await the full agent turn.
 */
export async function processMessageInBackground(
  conversationId: string,
  content: string,
  options?: ProcessMessageOptions,
): Promise<{ messageId: string }> {
  assertDbMigrationsReadyForTurn();

  const { conversation, attachments } = await prepareConversationForMessage(
    conversationId,
    content,
    options,
  );
  const emitEvent = buildEventEmitter(options?.onEvent);

  const requestId = crypto.randomUUID();
  const persistMetadata = options?.slackInbound
    ? { slackInbound: options.slackInbound }
    : undefined;
  const { id: messageId } = await conversation.persistUserMessage({
    content,
    attachments,
    requestId,
    metadata: persistMetadata,
    displayContent: options?.displayContent,
  });
  publishConversationMessagesChanged(conversationId);

  if (options?.isInteractive === true) {
    conversation.updateClient(broadcastMessage, false);
    getSubagentManager().updateParentSender(conversationId, broadcastMessage);
  }

  conversation
    .runAgentLoop(content, messageId, {
      onEvent: emitEvent,
      isInteractive: options?.isInteractive ?? false,
      isUserMessage: true,
      ...(options?.callSite ? { callSite: options.callSite } : {}),
      ...(options?.overrideProfile
        ? { overrideProfile: options.overrideProfile }
        : {}),
      ...(options?.cronRunId ? { cronRunId: options.cronRunId } : {}),
    })
    .finally(() => {
      if (
        options?.isInteractive === true &&
        conversation.getCurrentSender() === broadcastMessage
      ) {
        conversation.updateClient(() => {}, true);
      }
    })
    .catch((err) => {
      log.error({ err, conversationId }, "Background agent loop failed");
    });

  return { messageId };
}
