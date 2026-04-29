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
import { getConfig } from "../config/loader.js";
import {
  getAttachmentsByIds,
  getSourcePathsForAttachments,
} from "../memory/attachments-store.js";
import {
  createCanonicalGuardianRequest,
  generateCanonicalRequestCode,
} from "../memory/canonical-guardian-store.js";
import {
  addMessage,
  getConversation,
  provenanceFromTrustContext,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
} from "../memory/conversation-crud.js";
import { updateMetaFile } from "../memory/conversation-disk-view.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { bridgeConfirmationRequestToGuardian } from "../runtime/confirmation-request-guardian-bridge.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { summarizeToolInput } from "../tools/tool-input-summary.js";
import { getLogger } from "../util/logger.js";
import type { Conversation } from "./conversation.js";
import { buildSlackMetaForPersistence } from "./conversation-messaging.js";
import { formatCompactResult } from "./conversation-process.js";
import { resolveChannelCapabilities } from "./conversation-runtime-assembly.js";
import { resolveSlash, type SlashContext } from "./conversation-slash.js";
import {
  getOrCreateConversation as getOrCreateActiveConversation,
  mergeConversationOptions,
} from "./conversation-store.js";
import type { ConversationCreateOptions } from "./handlers/shared.js";
import { HostBashProxy } from "./host-bash-proxy.js";
import { HostCuProxy } from "./host-cu-proxy.js";
import { HostFileProxy } from "./host-file-proxy.js";
import { HostTransferProxy } from "./host-transfer-proxy.js";
import type { ServerMessage } from "./message-protocol.js";

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

function resolveCanonicalRequestSourceType(
  sourceChannel: string | undefined,
): "desktop" | "channel" | "voice" {
  if (sourceChannel === "phone") return "voice";
  if (sourceChannel === "vellum") return "desktop";
  return "channel";
}

// ---------------------------------------------------------------------------
// Pending-interaction registrar
// ---------------------------------------------------------------------------

function makePendingInteractionRegistrar(
  conversation: Conversation,
  conversationId: string,
): (msg: ServerMessage) => void {
  return (msg: ServerMessage) => {
    if (msg.type === "confirmation_request") {
      pendingInteractions.register(msg.requestId, {
        conversationId,
        kind: "confirmation",
        confirmationDetails: {
          toolName: msg.toolName,
          input: msg.input,
          riskLevel: msg.riskLevel,
          executionTarget: msg.executionTarget,
          allowlistOptions: msg.allowlistOptions,
          scopeOptions: msg.scopeOptions,
          persistentDecisionsAllowed: msg.persistentDecisionsAllowed,
        },
      });

      try {
        const trustContext = conversation.trustContext;
        const sourceChannel = trustContext?.sourceChannel ?? "vellum";
        const inputRecord = msg.input as Record<string, unknown>;
        const activityRaw =
          (typeof inputRecord.activity === "string"
            ? inputRecord.activity
            : undefined) ??
          (typeof inputRecord.reason === "string"
            ? inputRecord.reason
            : undefined);
        const canonicalRequest = createCanonicalGuardianRequest({
          id: msg.requestId,
          kind: "tool_approval",
          sourceType: resolveCanonicalRequestSourceType(sourceChannel),
          sourceChannel,
          conversationId,
          requesterExternalUserId: trustContext?.requesterExternalUserId,
          requesterChatId: trustContext?.requesterChatId,
          guardianExternalUserId: trustContext?.guardianExternalUserId,
          guardianPrincipalId: trustContext?.guardianPrincipalId ?? undefined,
          toolName: msg.toolName,
          commandPreview:
            redactSecrets(summarizeToolInput(msg.toolName, inputRecord)) ||
            undefined,
          riskLevel: msg.riskLevel,
          activityText: activityRaw ? redactSecrets(activityRaw) : undefined,
          executionTarget: msg.executionTarget,
          status: "pending",
          requestCode: generateCanonicalRequestCode(),
          expiresAt: Date.now() + 5 * 60 * 1000,
        });

        if (trustContext) {
          bridgeConfirmationRequestToGuardian({
            canonicalRequest,
            trustContext,
            conversationId,
            toolName: msg.toolName,
            assistantId:
              conversation.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
          });
        }
      } catch (err) {
        log.debug(
          { err, requestId: msg.requestId, conversationId },
          "Failed to create canonical request from pending interaction registrar",
        );
      }
    } else if (msg.type === "secret_request") {
      // SecretPrompter.prompt() registers in pendingInteractions directly;
      // no duplicate registration needed here.
    } else if (msg.type === "host_bash_request") {
      pendingInteractions.register(msg.requestId, {
        conversationId,
        kind: "host_bash",
      });
    } else if (msg.type === "host_browser_request") {
      pendingInteractions.register(msg.requestId, {
        conversationId,
        kind: "host_browser",
      });
    } else if (msg.type === "host_file_request") {
      pendingInteractions.register(msg.requestId, {
        conversationId,
        kind: "host_file",
      });
    } else if (msg.type === "host_cu_request") {
      pendingInteractions.register(msg.requestId, {
        conversationId,
        kind: "host_cu",
      });
    } else if (msg.type === "host_transfer_request") {
      pendingInteractions.register(msg.requestId, {
        conversationId,
        kind: "host_transfer",
      });
    }
  };
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
  if (supportsHostProxy(resolvedInterface, "host_bash")) {
    if (!conversation.isProcessing() || !conversation.hostBashProxy) {
      conversation.setHostBashProxy(
        new HostBashProxy(conversation.getCurrentSender(), (requestId) => {
          pendingInteractions.resolve(requestId);
        }),
      );
    }
  } else if (!conversation.isProcessing()) {
    conversation.setHostBashProxy(undefined);
  }
  if (supportsHostProxy(resolvedInterface, "host_file")) {
    if (!conversation.isProcessing() || !conversation.hostFileProxy) {
      conversation.setHostFileProxy(
        new HostFileProxy(conversation.getCurrentSender(), (requestId) => {
          pendingInteractions.resolve(requestId);
        }),
      );
    }
    if (!conversation.isProcessing() || !conversation.getHostTransferProxy()) {
      conversation.setHostTransferProxy(
        new HostTransferProxy(conversation.getCurrentSender(), (requestId) => {
          pendingInteractions.resolve(requestId);
        }),
      );
    }
  } else if (!conversation.isProcessing()) {
    conversation.setHostFileProxy(undefined);
    conversation.setHostTransferProxy(undefined);
  }
  if (supportsHostProxy(resolvedInterface, "host_cu")) {
    if (!conversation.isProcessing() || !conversation.hostCuProxy) {
      conversation.setHostCuProxy(
        new HostCuProxy(conversation.getCurrentSender(), (requestId) => {
          pendingInteractions.resolve(requestId);
        }),
      );
    }
    conversation.addPreactivatedSkillId("computer-use");
  } else if (!conversation.isProcessing()) {
    conversation.setHostCuProxy(undefined);
  }
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

  const config = getConfig();
  const serverInterfaceCtx = conversation.getTurnInterfaceContext();
  const slashContext: SlashContext = {
    messageCount: conversation.getMessages().length,
    inputTokens: conversation.usageStats.inputTokens,
    outputTokens: conversation.usageStats.outputTokens,
    maxInputTokens: config.llm.default.contextWindow.maxInputTokens,
    model: config.llm.default.model,
    provider: config.llm.default.provider,
    estimatedCost: conversation.usageStats.estimatedCost,
    userMessageInterface: serverInterfaceCtx?.userMessageInterface,
  };
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

  const registrar = makePendingInteractionRegistrar(
    conversation,
    conversationId,
  );
  const onEvent = options?.onEvent
    ? (msg: ServerMessage) => {
        registrar(msg);
        try {
          options.onEvent!(msg);
        } catch (err) {
          log.error(
            { err, conversationId },
            "onEvent callback failed; continuing agent loop",
          );
        }
      }
    : registrar;
  if (options?.isInteractive === true) {
    conversation.updateClient(onEvent, false);
  }

  try {
    conversation.setSlackRuntimeContextNotice(
      options?.slackRuntimeContextNotice,
    );
    await conversation.runAgentLoop(resolvedContent, messageId, onEvent, {
      isInteractive: options?.isInteractive ?? false,
      isUserMessage: true,
      ...(options?.callSite ? { callSite: options.callSite } : {}),
    });
  } finally {
    conversation.setSlackRuntimeContextNotice(undefined);
    if (
      options?.isInteractive === true &&
      conversation.getCurrentSender() === onEvent
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

  const registrar = makePendingInteractionRegistrar(
    conversation,
    conversationId,
  );
  const onEvent = options?.onEvent
    ? (msg: ServerMessage) => {
        registrar(msg);
        try {
          options.onEvent!(msg);
        } catch (err) {
          log.error(
            { err, conversationId },
            "onEvent callback failed; continuing agent loop",
          );
        }
      }
    : registrar;
  if (options?.isInteractive === true) {
    conversation.updateClient(onEvent, false);
  }

  conversation.setSlackRuntimeContextNotice(options?.slackRuntimeContextNotice);
  conversation
    .runAgentLoop(content, messageId, onEvent, {
      isInteractive: options?.isInteractive ?? false,
      isUserMessage: true,
      ...(options?.callSite ? { callSite: options.callSite } : {}),
    })
    .finally(() => {
      conversation.setSlackRuntimeContextNotice(undefined);
      if (
        options?.isInteractive === true &&
        conversation.getCurrentSender() === onEvent
      ) {
        conversation.updateClient(() => {}, true);
      }
    })
    .catch((err) => {
      log.error({ err, conversationId }, "Background agent loop failed");
    });

  return { messageId };
}
