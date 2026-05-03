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
  supportsHostProxy,
} from "../channels/types.js";
import {
  getAttachmentsByIds,
  getSourcePathsForAttachments,
} from "../memory/attachments-store.js";
import {
  addMessage,
  getConversation,
  provenanceFromTrustContext,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
} from "../memory/conversation-crud.js";
import { updateMetaFile } from "../memory/conversation-disk-view.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getLogger } from "../util/logger.js";
import type { Conversation } from "./conversation.js";
import { buildSlackMetaForPersistence } from "./conversation-messaging.js";
import { formatCompactResult } from "./conversation-process.js";
import { resolveChannelCapabilities } from "./conversation-runtime-assembly.js";
import {
  buildSlashContextForContent,
  resolveSlash,
} from "./conversation-slash.js";
import {
  getOrCreateConversation as getOrCreateActiveConversation,
  mergeConversationOptions,
} from "./conversation-store.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";
import { HostAppControlProxy } from "./host-app-control-proxy.js";
import { HostCuProxy } from "./host-cu-proxy.js";
import { preactivateHostProxySkills } from "./host-proxy-preactivation.js";

const log = getLogger("process-message");

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
  attachmentIds: string[] | undefined,
  options: ConversationCreateOptions | undefined,
  sourceChannel: string | undefined,
  sourceInterface: string | undefined,
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
  const conversation = await getOrCreateActiveConversation(
    conversationId,
    options,
  );

  if (conversation.isProcessing()) {
    throw new Error("Conversation is already processing a message");
  }

  const resolvedChannel = resolveTurnChannel(
    sourceChannel,
    options?.transport?.channelId,
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
  // CU is per-conversation (owns step count, AX tree history, loop detection).
  if (supportsHostProxy(resolvedInterface, "host_cu")) {
    if (!conversation.isProcessing() || !conversation.hostCuProxy) {
      conversation.setHostCuProxy(new HostCuProxy());
    }
  } else if (!conversation.isProcessing()) {
    conversation.setHostCuProxy(undefined);
  }
  // App-control mirrors CU's per-conversation lifecycle. The proxy attaches
  // unconditionally when the client supports the capability — feature-flag
  // gating is enforced by the skill-projection layer via SKILL.md
  // frontmatter, so an attached proxy is harmless when the flag is off.
  if (supportsHostProxy(resolvedInterface, "host_app_control")) {
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
  preactivateHostProxySkills(conversation, resolvedInterface);
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

export async function processMessage(
  conversationId: string,
  content: string,
  attachmentIds?: string[],
  options?: ConversationCreateOptions,
  sourceChannel?: string,
  sourceInterface?: string,
): Promise<{ messageId: string }> {
  const { conversation, attachments } = await prepareConversationForMessage(
    conversationId,
    content,
    attachmentIds,
    options,
    sourceChannel,
    sourceInterface,
  );

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
      JSON.stringify(cleanMsg.content),
      userMetaWithSlack,
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
    await addMessage(
      conversationId,
      "assistant",
      JSON.stringify(assistantMsg.content),
      serverChannelMeta,
    );
    conversation.getMessages().push(assistantMsg);
    return { messageId: persisted.id };
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
      JSON.stringify(cleanMsg.content),
      compactUserMeta,
    );
    conversation.getMessages().push(cleanMsg);

    conversation.emitActivityState(
      "thinking",
      "context_compacting",
      "assistant_turn",
    );
    const result = await conversation.forceCompact();
    const responseText = formatCompactResult(result);
    const assistantMsg = createAssistantMessage(responseText);
    await addMessage(
      conversationId,
      "assistant",
      JSON.stringify(assistantMsg.content),
      compactChannelMeta,
    );
    conversation.getMessages().push(assistantMsg);
    return { messageId: persisted.id };
  }

  const resolvedContent = slashResult.content;

  const requestId = crypto.randomUUID();
  const persistMetadata = options?.slackInbound
    ? { slackInbound: options.slackInbound }
    : undefined;
  const messageId = await conversation.persistUserMessage(
    resolvedContent,
    attachments,
    requestId,
    persistMetadata,
  );

  if (options?.isInteractive === true) {
    conversation.updateClient(broadcastMessage, false);
  }

  try {
    conversation.setSlackRuntimeContextNotice(
      options?.slackRuntimeContextNotice,
    );
    await conversation.runAgentLoop(
      resolvedContent,
      messageId,
      broadcastMessage,
      {
        isInteractive: options?.isInteractive ?? false,
        isUserMessage: true,
        ...(options?.callSite ? { callSite: options.callSite } : {}),
      },
    );
  } finally {
    conversation.setSlackRuntimeContextNotice(undefined);
    if (
      options?.isInteractive === true &&
      conversation.getCurrentSender() === broadcastMessage
    ) {
      conversation.updateClient(() => {}, true);
    }
  }

  return { messageId };
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
  attachmentIds?: string[],
  options?: ConversationCreateOptions,
  sourceChannel?: string,
  sourceInterface?: string,
): Promise<{ messageId: string }> {
  const { conversation, attachments } = await prepareConversationForMessage(
    conversationId,
    content,
    attachmentIds,
    options,
    sourceChannel,
    sourceInterface,
  );

  const requestId = crypto.randomUUID();
  const persistMetadata = options?.slackInbound
    ? { slackInbound: options.slackInbound }
    : undefined;
  const messageId = await conversation.persistUserMessage(
    content,
    attachments,
    requestId,
    persistMetadata,
  );

  if (options?.isInteractive === true) {
    conversation.updateClient(broadcastMessage, false);
  }

  conversation.setSlackRuntimeContextNotice(options?.slackRuntimeContextNotice);
  conversation
    .runAgentLoop(content, messageId, broadcastMessage, {
      isInteractive: options?.isInteractive ?? false,
      isUserMessage: true,
      ...(options?.callSite ? { callSite: options.callSite } : {}),
    })
    .finally(() => {
      conversation.setSlackRuntimeContextNotice(undefined);
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
