/**
 * Route handlers for conversation messages and suggestions.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  createAssistantMessage,
  createUserMessage,
} from "../../agent/message-types.js";
import {
  CHANNEL_IDS,
  INTERFACE_IDS,
  parseChannelId,
  parseInterfaceId,
} from "../../channels/types.js";
import { renderHistoryContent } from "../../daemon/handlers/shared.js";
import type { ServerMessage } from "../../daemon/ipc-protocol.js";
import * as attachmentsStore from "../../memory/attachments-store.js";
import {
  createCanonicalGuardianRequest,
  generateCanonicalRequestCode,
  listPendingRequestsByConversationScope,
} from "../../memory/canonical-guardian-store.js";
import { addMessage, getMessages } from "../../memory/conversation-crud.js";
import {
  getConversationByKey,
  getOrCreateConversation,
} from "../../memory/conversation-key-store.js";
import { searchConversations } from "../../memory/conversation-queries.js";
import { getConfiguredProvider } from "../../providers/provider-send-message.js";
import type { Provider } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import type { AuthContext } from "../auth/types.js";
import { bridgeConfirmationRequestToGuardian } from "../confirmation-request-guardian-bridge.js";
import { routeGuardianReply } from "../guardian-reply-router.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import type {
  ApprovalConversationGenerator,
  RuntimeAttachmentMetadata,
  RuntimeMessagePayload,
  SendMessageDeps,
} from "../http-types.js";
import * as pendingInteractions from "../pending-interactions.js";
import {
  resolveTrustContext,
  withSourceChannel,
} from "../trust-context-resolver.js";

const log = getLogger("conversation-routes");

const SUGGESTION_CACHE_MAX = 100;

function collectCanonicalGuardianRequestHintIds(
  conversationId: string,
  sourceChannel: string,
  session: import("../../daemon/session.js").Session,
): string[] {
  const requests = listPendingRequestsByConversationScope(
    conversationId,
    sourceChannel,
  );

  return requests
    .filter(
      (req) =>
        req.kind !== "tool_approval" || session.hasPendingConfirmation(req.id),
    )
    .map((req) => req.id);
}

async function tryConsumeCanonicalGuardianReply(params: {
  conversationId: string;
  sourceChannel: string;
  sourceInterface: string;
  content: string;
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    data: string;
  }>;
  session: import("../../daemon/session.js").Session;
  onEvent: (msg: ServerMessage) => void;
  approvalConversationGenerator?: ApprovalConversationGenerator;
  /** Verified actor identity from actor-token middleware. */
  verifiedActorExternalUserId?: string;
  /** Verified actor principal ID for principal-based authorization. */
  verifiedActorPrincipalId?: string;
}): Promise<{ consumed: boolean; messageId?: string }> {
  const {
    conversationId,
    sourceChannel,
    sourceInterface,
    content,
    attachments,
    session,
    onEvent,
    approvalConversationGenerator,
    verifiedActorExternalUserId,
    verifiedActorPrincipalId,
  } = params;
  const trimmedContent = content.trim();

  if (trimmedContent.length === 0) {
    return { consumed: false };
  }

  const pendingRequestHintIds = collectCanonicalGuardianRequestHintIds(
    conversationId,
    sourceChannel,
    session,
  );
  const pendingRequestIds =
    pendingRequestHintIds.length > 0 ? pendingRequestHintIds : undefined;

  const routerResult = await routeGuardianReply({
    messageText: trimmedContent,
    channel: sourceChannel,
    actor: {
      actorPrincipalId: verifiedActorPrincipalId,
      actorExternalUserId: verifiedActorExternalUserId,
      channel: sourceChannel,
      guardianPrincipalId: verifiedActorPrincipalId,
    },
    conversationId,
    pendingRequestIds,
    approvalConversationGenerator,
    emissionContext: {
      source: "inline_nl",
      decisionText: trimmedContent,
    },
  });

  if (!routerResult.consumed || routerResult.type === "nl_keep_pending") {
    return { consumed: false };
  }

  // Success-path emissions (approved/denied) are handled centrally
  // by handleConfirmationResponse (called via the resolver chain).
  // However, stale/failed paths never reach handleConfirmationResponse,
  // so we emit resolved_stale here for those cases.
  if (routerResult.requestId && !routerResult.decisionApplied) {
    session.emitConfirmationStateChanged({
      sessionId: conversationId,
      requestId: routerResult.requestId,
      state: "resolved_stale",
      source: "inline_nl",
      decisionText: trimmedContent,
    });
  }

  // Decision has been applied — transcript persistence is best-effort.
  // If DB writes fail, we still return consumed: true so the approval text
  // is not re-processed as a new user turn.
  let messageId: string | undefined;
  try {
    const channelMeta = {
      userMessageChannel: sourceChannel,
      assistantMessageChannel: sourceChannel,
      userMessageInterface: sourceInterface,
      assistantMessageInterface: sourceInterface,
      provenanceTrustClass: "guardian" as const,
    };

    const userMessage = createUserMessage(content, attachments);
    const persistedUser = await addMessage(
      conversationId,
      "user",
      JSON.stringify(userMessage.content),
      channelMeta,
    );
    messageId = persistedUser.id;

    const replyText =
      routerResult.replyText?.trim() ||
      (routerResult.decisionApplied
        ? "Decision applied."
        : "Request already resolved.");
    const assistantMessage = createAssistantMessage(replyText);
    await addMessage(
      conversationId,
      "assistant",
      JSON.stringify(assistantMessage.content),
      channelMeta,
    );

    // Avoid mutating in-memory history / emitting stream deltas while a run is active.
    if (!session.isProcessing()) {
      session.getMessages().push(userMessage, assistantMessage);
      onEvent({
        type: "assistant_text_delta",
        text: replyText,
        sessionId: conversationId,
      });
      onEvent({ type: "message_complete", sessionId: conversationId });
    }
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Failed to persist inline approval transcript entries",
    );
  }

  return { consumed: true, messageId };
}

function resolveCanonicalRequestSourceType(
  sourceChannel: string | undefined,
): "desktop" | "channel" | "voice" {
  if (sourceChannel === "phone") {
    return "voice";
  }
  if (sourceChannel === "vellum") {
    return "desktop";
  }
  return "channel";
}

function getInterfaceFilesWithMtimes(
  interfacesDir: string | null,
): Array<{ path: string; mtimeMs: number }> {
  if (!interfacesDir || !existsSync(interfacesDir)) return [];
  const results: Array<{ path: string; mtimeMs: number }> = [];
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else {
        results.push({
          path: relative(interfacesDir, fullPath),
          mtimeMs: statSync(fullPath).mtimeMs,
        });
      }
    }
  };
  scan(interfacesDir);
  return results;
}

export function handleListMessages(
  url: URL,
  interfacesDir: string | null,
): Response {
  const conversationId = url.searchParams.get("conversationId");
  const conversationKey = url.searchParams.get("conversationKey");

  let resolvedConversationId: string | undefined;
  if (conversationId) {
    resolvedConversationId = conversationId;
  } else if (conversationKey) {
    const mapping = getConversationByKey(conversationKey);
    resolvedConversationId = mapping?.conversationId;
  } else {
    return httpError(
      "BAD_REQUEST",
      "conversationKey or conversationId query parameter is required",
      400,
    );
  }

  if (!resolvedConversationId) {
    return Response.json({ messages: [] });
  }
  const rawMessages = getMessages(resolvedConversationId);

  // Parse content blocks and extract text + tool calls
  const parsed = rawMessages.map((msg) => {
    let content: unknown;
    try {
      content = JSON.parse(msg.content);
    } catch {
      content = msg.content;
    }
    const rendered = renderHistoryContent(content);
    return {
      role: msg.role,
      text: rendered.text,
      timestamp: msg.createdAt,
      toolCalls: rendered.toolCalls,
      toolCallsBeforeText: rendered.toolCallsBeforeText,
      textSegments: rendered.textSegments,
      contentOrder: rendered.contentOrder,
      surfaces: rendered.surfaces,
      id: msg.id,
    };
  });

  const interfaceFiles = getInterfaceFilesWithMtimes(interfacesDir);

  let prevAssistantTimestamp = 0;
  const messages: RuntimeMessagePayload[] = parsed.map((m) => {
    let msgAttachments: RuntimeAttachmentMetadata[] = [];
    if (m.role === "assistant" && m.id) {
      const linked = attachmentsStore.getAttachmentMetadataForMessage(m.id);
      if (linked.length > 0) {
        msgAttachments = linked.map((a) => ({
          id: a.id,
          filename: a.originalFilename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          kind: a.kind,
        }));
      }
    }

    let interfaces: string[] | undefined;
    if (m.role === "assistant") {
      const msgTimestamp = new Date(m.timestamp).getTime();
      const dirtied = interfaceFiles
        .filter(
          (f) =>
            f.mtimeMs > prevAssistantTimestamp && f.mtimeMs <= msgTimestamp,
        )
        .map((f) => f.path);
      if (dirtied.length > 0) {
        interfaces = dirtied;
      }
      prevAssistantTimestamp = msgTimestamp;
    }

    return {
      id: m.id ?? "",
      role: m.role,
      content: m.text,
      timestamp: new Date(m.timestamp).toISOString(),
      attachments: msgAttachments,
      ...(m.toolCalls.length > 0 ? { toolCalls: m.toolCalls } : {}),
      ...(interfaces ? { interfaces } : {}),
    };
  });

  return Response.json({ messages });
}

/**
 * Build an `onEvent` callback that publishes every outbound event to the
 * assistant event hub, maintaining ordered delivery through a serial chain.
 *
 * Also registers pending interactions when confirmation_request or
 * secret_request events flow through, so standalone approval endpoints
 * can look up the session by requestId.
 */
function makeHubPublisher(
  deps: SendMessageDeps,
  conversationId: string,
  session: import("../../daemon/session.js").Session,
): (msg: ServerMessage) => void {
  let hubChain: Promise<void> = Promise.resolve();
  return (msg: ServerMessage) => {
    // Register pending interactions for approval events
    if (msg.type === "confirmation_request") {
      pendingInteractions.register(msg.requestId, {
        session,
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
          temporaryOptionsAvailable: msg.temporaryOptionsAvailable,
        },
      });

      // Create a canonical guardian request so IPC/HTTP handlers can find it
      // via applyCanonicalGuardianDecision.
      try {
        const trustContext = session.trustContext;
        const sourceChannel = trustContext?.sourceChannel ?? "vellum";
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
          status: "pending",
          requestCode: generateCanonicalRequestCode(),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });

        // For trusted-contact sessions, bridge to guardian.question so the
        // guardian gets notified and can approve via callback/request-code.
        if (trustContext) {
          bridgeConfirmationRequestToGuardian({
            canonicalRequest,
            trustContext,
            conversationId,
            toolName: msg.toolName,
            assistantId: session.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
          });
        }
      } catch (err) {
        log.debug(
          { err, requestId: msg.requestId, conversationId },
          "Failed to create canonical request from hub publisher",
        );
      }
    } else if (msg.type === "secret_request") {
      pendingInteractions.register(msg.requestId, {
        session,
        conversationId,
        kind: "secret",
      });
    }

    // ServerMessage is a large union; sessionId exists on most but not all variants.
    const msgSessionId =
      "sessionId" in msg &&
      typeof (msg as { sessionId?: unknown }).sessionId === "string"
        ? (msg as { sessionId: string }).sessionId
        : undefined;
    const resolvedSessionId = msgSessionId ?? conversationId;
    const event = buildAssistantEvent(
      DAEMON_INTERNAL_ASSISTANT_ID,
      msg,
      resolvedSessionId,
    );
    hubChain = (async () => {
      await hubChain;
      try {
        await deps.assistantEventHub.publish(event);
      } catch (err) {
        log.warn(
          { err },
          "assistant-events hub subscriber threw during POST /messages",
        );
      }
    })();
  };
}

export async function handleSendMessage(
  req: Request,
  deps: {
    sendMessageDeps?: SendMessageDeps;
    approvalConversationGenerator?: ApprovalConversationGenerator;
  },
  authContext: AuthContext,
): Promise<Response> {
  const body = (await req.json()) as {
    conversationKey?: string;
    content?: string;
    attachmentIds?: string[];
    sourceChannel?: string;
    interface?: string;
  };

  const { conversationKey, content, attachmentIds } = body;
  if (!body.sourceChannel || typeof body.sourceChannel !== "string") {
    return httpError("BAD_REQUEST", "sourceChannel is required", 400);
  }
  const sourceChannel = parseChannelId(body.sourceChannel);

  if (!sourceChannel) {
    return httpError(
      "BAD_REQUEST",
      `Invalid sourceChannel: ${
        body.sourceChannel
      }. Valid values: ${CHANNEL_IDS.join(", ")}`,
      400,
    );
  }

  if (!body.interface || typeof body.interface !== "string") {
    return httpError("BAD_REQUEST", "interface is required", 400);
  }
  const sourceInterface = parseInterfaceId(body.interface);
  if (!sourceInterface) {
    return httpError(
      "BAD_REQUEST",
      `Invalid interface: ${body.interface}. Valid values: ${INTERFACE_IDS.join(
        ", ",
      )}`,
      400,
    );
  }

  if (!conversationKey) {
    return httpError("BAD_REQUEST", "conversationKey is required", 400);
  }

  // Reject non-string content values (numbers, objects, etc.)
  if (content != null && typeof content !== "string") {
    return httpError("BAD_REQUEST", "content must be a string", 400);
  }

  const trimmedContent = typeof content === "string" ? content.trim() : "";
  const hasAttachments =
    Array.isArray(attachmentIds) && attachmentIds.length > 0;

  if (trimmedContent.length === 0 && !hasAttachments) {
    return httpError(
      "BAD_REQUEST",
      "content or attachmentIds is required",
      400,
    );
  }

  // Validate that all attachment IDs resolve
  if (hasAttachments) {
    const resolved = attachmentsStore.getAttachmentsByIds(attachmentIds);
    if (resolved.length !== attachmentIds.length) {
      const resolvedIds = new Set(resolved.map((a) => a.id));
      const missing = attachmentIds.filter((id) => !resolvedIds.has(id));
      return httpError(
        "BAD_REQUEST",
        `Attachment IDs not found: ${missing.join(", ")}`,
        400,
      );
    }
  }

  if (!deps.sendMessageDeps) {
    return httpError(
      "SERVICE_UNAVAILABLE",
      "Message processing is not available",
      503,
    );
  }

  const mapping = getOrCreateConversation(conversationKey);
  const smDeps = deps.sendMessageDeps;
  const session = await smDeps.getOrCreateSession(mapping.conversationId);

  // Resolve guardian context from the AuthContext's actorPrincipalId.
  // The JWT-verified principal is used as the sender identity through
  // the same trust resolution pipeline that channel ingress uses.
  if (authContext.actorPrincipalId) {
    const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
    const trustCtx = resolveTrustContext({
      assistantId,
      sourceChannel: "vellum",
      conversationExternalId: "local",
      actorExternalId: authContext.actorPrincipalId,
    });
    session.setTrustContext(withSourceChannel(sourceChannel, trustCtx));
  } else {
    // Service principals (svc_gateway) or tokens without an actor ID
    // get a minimal guardian context so downstream code has something.
    session.setTrustContext({ trustClass: "guardian", sourceChannel });
  }

  const onEvent = makeHubPublisher(smDeps, mapping.conversationId, session);
  // Route server-authoritative state signals (confirmation_state_changed,
  // assistant_activity_state) to the SSE hub. Without this, these signals
  // only travel through session.sendToClient, which is a no-op for
  // socketless HTTP sessions.
  session.setStateSignalListener(onEvent);

  const attachments = hasAttachments
    ? smDeps.resolveAttachments(attachmentIds)
    : [];

  // Resolve the verified actor's external user ID and principal for inline
  // approval routing from the session's guardian context.
  const verifiedActorExternalUserId =
    session.trustContext?.guardianExternalUserId;
  const verifiedActorPrincipalId =
    session.trustContext?.guardianPrincipalId ?? undefined;

  // Try to consume the message as a canonical guardian approval/rejection reply.
  // On failure, degrade to the existing queue/auto-deny path rather than
  // surfacing a 500 — mirrors the IPC handler's catch-and-fallback.
  try {
    const inlineReplyResult = await tryConsumeCanonicalGuardianReply({
      conversationId: mapping.conversationId,
      sourceChannel,
      sourceInterface,
      content: content ?? "",
      attachments,
      session,
      onEvent,
      approvalConversationGenerator: deps.approvalConversationGenerator,
      verifiedActorExternalUserId,
      verifiedActorPrincipalId,
    });
    if (inlineReplyResult.consumed) {
      return Response.json(
        {
          accepted: true,
          ...(inlineReplyResult.messageId
            ? { messageId: inlineReplyResult.messageId }
            : {}),
        },
        { status: 202 },
      );
    }
  } catch (err) {
    log.warn(
      { err, conversationId: mapping.conversationId },
      "Inline approval consumption failed, falling through to normal send path",
    );
  }

  if (session.isProcessing()) {
    // If a tool confirmation is pending, auto-deny it so the agent
    // can finish the current turn and process this queued message.
    if (session.hasAnyPendingConfirmation()) {
      // Emit authoritative denial state for each pending request.
      // The onStateSignal listener routes these to the SSE hub automatically.
      for (const interaction of pendingInteractions.getByConversation(
        mapping.conversationId,
      )) {
        if (
          interaction.session === session &&
          interaction.kind === "confirmation"
        ) {
          session.emitConfirmationStateChanged({
            sessionId: mapping.conversationId,
            requestId: interaction.requestId,
            state: "denied" as const,
            source: "auto_deny" as const,
          });
        }
      }
      session.denyAllPendingConfirmations();
      pendingInteractions.removeBySession(session);
    }

    // Queue the message so it's processed when the current turn completes
    const requestId = crypto.randomUUID();
    const result = session.enqueueMessage(
      content ?? "",
      attachments,
      onEvent,
      requestId,
      undefined, // activeSurfaceId
      undefined, // currentPage
      {
        userMessageChannel: sourceChannel,
        assistantMessageChannel: sourceChannel,
        userMessageInterface: sourceInterface,
        assistantMessageInterface: sourceInterface,
      },
      { isInteractive: false },
    );
    if (result.rejected) {
      return httpError(
        "RATE_LIMITED",
        "Message queue is full. Please retry later.",
        429,
      );
    }
    return Response.json({ accepted: true, queued: true }, { status: 202 });
  }

  // Session is idle — persist and fire agent loop immediately
  session.setTurnChannelContext({
    userMessageChannel: sourceChannel,
    assistantMessageChannel: sourceChannel,
  });
  session.setTurnInterfaceContext({
    userMessageInterface: sourceInterface,
    assistantMessageInterface: sourceInterface,
  });
  const requestId = crypto.randomUUID();
  const messageId = await session.persistUserMessage(
    content ?? "",
    attachments,
    requestId,
  );

  // Fire-and-forget the agent loop; events flow to the hub via onEvent.
  // Mark non-interactive so conflict clarification doesn't block the turn.
  session
    .runAgentLoop(content ?? "", messageId, onEvent, {
      isInteractive: false,
      isUserMessage: true,
    })
    .catch((err) => {
      log.error(
        { err, conversationId: mapping.conversationId },
        "Agent loop failed (POST /messages)",
      );
    });

  return Response.json({ accepted: true, messageId }, { status: 202 });
}

async function generateLlmSuggestion(
  provider: Provider,
  assistantText: string,
): Promise<string | null> {
  const truncated =
    assistantText.length > 2000 ? assistantText.slice(-2000) : assistantText;

  const prompt = `Given this assistant message, write a very short tab-complete suggestion (max 50 chars) the user could send next to keep the conversation going. Be casual, curious, or actionable — like a quick reply, not a formal request. Reply with ONLY the suggestion text.\n\nAssistant's message:\n${truncated}`;
  const response = await provider.sendMessage(
    [{ role: "user", content: [{ type: "text", text: prompt }] }],
    [], // no tools
    undefined, // no system prompt
    { config: { max_tokens: 30 } },
  );

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock && "text" in textBlock ? textBlock.text.trim() : "";

  if (!raw) return null;

  // Take first line only, then enforce the length cap
  const firstLine = raw.split("\n")[0].trim();
  if (!firstLine || firstLine.length > 50) return null;
  return firstLine;
}

export async function handleGetSuggestion(
  url: URL,
  deps: {
    suggestionCache: Map<string, string>;
    suggestionInFlight: Map<string, Promise<string | null>>;
  },
): Promise<Response> {
  const conversationKey = url.searchParams.get("conversationKey");
  if (!conversationKey) {
    return httpError(
      "BAD_REQUEST",
      "conversationKey query parameter is required",
      400,
    );
  }

  const mapping = getConversationByKey(conversationKey);
  if (!mapping) {
    return Response.json({
      suggestion: null,
      messageId: null,
      source: "none" as const,
    });
  }

  const rawMessages = getMessages(mapping.conversationId);
  if (rawMessages.length === 0) {
    return Response.json({
      suggestion: null,
      messageId: null,
      source: "none" as const,
    });
  }

  // Staleness check: compare requested messageId against the latest
  // assistant message BEFORE filtering by text content.  This ensures
  // that a newer tool-only assistant turn (empty text) still causes
  // older messageId requests to be correctly marked as stale.
  const requestedMessageId = url.searchParams.get("messageId");
  if (requestedMessageId) {
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      if (rawMessages[i].role === "assistant") {
        if (rawMessages[i].id !== requestedMessageId) {
          return Response.json({
            suggestion: null,
            messageId: null,
            source: "none" as const,
            stale: true,
          });
        }
        break;
      }
    }
  }

  const { suggestionCache, suggestionInFlight } = deps;
  const log = (await import("../../util/logger.js")).getLogger("runtime-http");

  // Walk backwards to find the last assistant message with text content
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i];
    if (msg.role !== "assistant") continue;

    let content: unknown;
    try {
      content = JSON.parse(msg.content);
    } catch {
      content = msg.content;
    }
    const rendered = renderHistoryContent(content);
    const text = rendered.text.trim();
    if (!text) continue;

    // If a messageId was requested and the first text-bearing assistant
    // message is a *different* message, the request is stale.
    if (requestedMessageId && msg.id !== requestedMessageId) {
      return Response.json({
        suggestion: null,
        messageId: null,
        source: "none" as const,
        stale: true,
      });
    }

    // Return cached suggestion if we already generated one for this message
    const cached = suggestionCache.get(msg.id);
    if (cached !== undefined) {
      return Response.json({
        suggestion: cached,
        messageId: msg.id,
        source: "llm" as const,
      });
    }

    // Try LLM suggestion using the configured provider
    const provider = getConfiguredProvider();
    if (provider) {
      try {
        // Deduplicate concurrent requests
        let promise = suggestionInFlight.get(msg.id);
        if (!promise) {
          promise = generateLlmSuggestion(provider, text);
          suggestionInFlight.set(msg.id, promise);
        }

        const llmSuggestion = await promise;
        suggestionInFlight.delete(msg.id);

        if (llmSuggestion) {
          // Evict oldest entries if cache is at capacity
          if (suggestionCache.size >= SUGGESTION_CACHE_MAX) {
            const oldest = suggestionCache.keys().next().value!;
            suggestionCache.delete(oldest);
          }
          suggestionCache.set(msg.id, llmSuggestion);

          return Response.json({
            suggestion: llmSuggestion,
            messageId: msg.id,
            source: "llm" as const,
          });
        }
      } catch (err) {
        suggestionInFlight.delete(msg.id);
        log.warn({ err }, "LLM suggestion failed");
      }
    }

    return Response.json({
      suggestion: null,
      messageId: null,
      source: "none" as const,
    });
  }

  return Response.json({
    suggestion: null,
    messageId: null,
    source: "none" as const,
  });
}

/**
 * GET /search?q=<query>[&limit=<n>][&maxMessagesPerConversation=<n>]
 *
 * Full-text search across all conversation threads (message content + titles).
 * Returns ranked results grouped by conversation, each with matching message excerpts.
 */
export function handleSearchConversations(url: URL): Response {
  const query = url.searchParams.get("q") ?? "";
  if (!query.trim()) {
    return httpError("BAD_REQUEST", "q query parameter is required", 400);
  }

  const limit = url.searchParams.has("limit")
    ? Number(url.searchParams.get("limit"))
    : undefined;
  const maxMessagesPerConversation = url.searchParams.has(
    "maxMessagesPerConversation",
  )
    ? Number(url.searchParams.get("maxMessagesPerConversation"))
    : undefined;

  const results = searchConversations(query, {
    ...(limit !== undefined && !isNaN(limit) ? { limit } : {}),
    ...(maxMessagesPerConversation !== undefined &&
    !isNaN(maxMessagesPerConversation)
      ? { maxMessagesPerConversation }
      : {}),
  });

  return Response.json({ query, results });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function conversationRouteDefinitions(deps: {
  interfacesDir: string | null;
  sendMessageDeps?: SendMessageDeps;
  approvalConversationGenerator?: ApprovalConversationGenerator;
  suggestionCache: Map<string, string>;
  suggestionInFlight: Map<string, Promise<string | null>>;
}): RouteDefinition[] {
  return [
    {
      endpoint: "messages",
      method: "GET",
      handler: ({ url }) => handleListMessages(url, deps.interfacesDir),
    },
    {
      endpoint: "messages",
      method: "POST",
      handler: async ({ req, authContext }) =>
        handleSendMessage(
          req,
          {
            sendMessageDeps: deps.sendMessageDeps,
            approvalConversationGenerator: deps.approvalConversationGenerator,
          },
          authContext,
        ),
    },
    {
      endpoint: "search",
      method: "GET",
      handler: ({ url }) => handleSearchConversations(url),
    },
    {
      endpoint: "suggestion",
      method: "GET",
      handler: async ({ url }) =>
        handleGetSuggestion(url, {
          suggestionCache: deps.suggestionCache,
          suggestionInFlight: deps.suggestionInFlight,
        }),
    },
  ];
}
