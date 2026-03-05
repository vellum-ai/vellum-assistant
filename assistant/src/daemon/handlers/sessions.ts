import * as net from "node:net";

import { v4 as uuid } from "uuid";

import {
  createAssistantMessage,
  createUserMessage,
} from "../../agent/message-types.js";
import {
  type InterfaceId,
  isChannelId,
  parseChannelId,
  parseInterfaceId,
} from "../../channels/types.js";
import { getConfig } from "../../config/loader.js";
import {
  getAttachmentsForMessage,
  getFilePathForAttachment,
  setAttachmentThumbnail,
} from "../../memory/attachments-store.js";
import {
  createCanonicalGuardianRequest,
  generateCanonicalRequestCode,
  listCanonicalGuardianRequests,
  listPendingCanonicalGuardianRequestsByDestinationConversation,
  resolveCanonicalGuardianRequest,
} from "../../memory/canonical-guardian-store.js";
import { getAttentionStateByConversationIds } from "../../memory/conversation-attention-store.js";
import * as conversationStore from "../../memory/conversation-store.js";
import {
  GENERATING_TITLE,
  queueGenerateConversationTitle,
  UNTITLED_FALLBACK,
} from "../../memory/conversation-title-service.js";
import * as externalConversationStore from "../../memory/external-conversation-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";
import { routeGuardianReply } from "../../runtime/guardian-reply-router.js";
import {
  resolveLocalIpcAuthContext,
  resolveLocalIpcTrustContext,
} from "../../runtime/local-actor-identity.js";
import * as pendingInteractions from "../../runtime/pending-interactions.js";
import { checkIngressForSecrets } from "../../security/secret-ingress.js";
import {
  compileCustomPatterns,
  redactSecrets,
} from "../../security/secret-scanner.js";
import { getSubagentManager } from "../../subagent/index.js";
import { silentlyWithLog } from "../../util/silently.js";
import { truncate } from "../../util/truncate.js";
import { createApprovalConversationGenerator } from "../approval-generators.js";
import { getAssistantName } from "../identity-helpers.js";
import type { UserMessageAttachment } from "../ipc-contract.js";
import type {
  CancelRequest,
  ConfirmationResponse,
  ConversationSearchRequest,
  DeleteQueuedMessage,
  HistoryRequest,
  MessageContentRequest,
  RegenerateRequest,
  ReorderThreadsRequest,
  SecretResponse,
  ServerMessage,
  SessionCreateRequest,
  SessionRenameRequest,
  SessionSwitchRequest,
  UndoRequest,
  UsageRequest,
  UserMessage,
} from "../ipc-protocol.js";
import { normalizeThreadType } from "../ipc-protocol.js";
import { executeRecordingIntent } from "../recording-executor.js";
import { resolveRecordingIntent } from "../recording-intent.js";
import {
  classifyRecordingIntentFallback,
  containsRecordingKeywords,
} from "../recording-intent-fallback.js";
import type { Session } from "../session.js";
import {
  buildSessionErrorMessage,
  classifySessionError,
} from "../session-error.js";
import { resolveChannelCapabilities } from "../session-runtime-assembly.js";
import { generateVideoThumbnail } from "../video-thumbnail.js";
import {
  handleRecordingPause,
  handleRecordingRestart,
  handleRecordingResume,
  handleRecordingStart,
  handleRecordingStop,
} from "./recording.js";
import {
  defineHandlers,
  type HandlerContext,
  type HistorySurface,
  type HistoryToolCall,
  log,
  mergeToolResults,
  type ParsedHistoryMessage,
  pendingStandaloneSecrets,
  renderHistoryContent,
  wireEscalationHandler,
} from "./shared.js";

const desktopApprovalConversationGenerator =
  createApprovalConversationGenerator();

function syncCanonicalStatusFromIpcConfirmationDecision(
  requestId: string,
  decision: ConfirmationResponse["decision"],
): void {
  const targetStatus =
    decision === "deny" || decision === "always_deny"
      ? ("denied" as const)
      : ("approved" as const);

  try {
    resolveCanonicalGuardianRequest(requestId, "pending", {
      status: targetStatus,
    });
  } catch (err) {
    log.debug(
      { err, requestId, targetStatus },
      "Failed to resolve canonical request from IPC confirmation response",
    );
  }
}

function makeIpcEventSender(params: {
  ctx: HandlerContext;
  socket: net.Socket;
  session: Session;
  conversationId: string;
  sourceChannel: string;
}): (event: ServerMessage) => void {
  const { ctx, socket, session, conversationId, sourceChannel } = params;

  return (event: ServerMessage) => {
    if (event.type === "confirmation_request") {
      pendingInteractions.register(event.requestId, {
        session,
        conversationId,
        kind: "confirmation",
        confirmationDetails: {
          toolName: event.toolName,
          input: event.input,
          riskLevel: event.riskLevel,
          executionTarget: event.executionTarget,
          allowlistOptions: event.allowlistOptions,
          scopeOptions: event.scopeOptions,
          persistentDecisionsAllowed: event.persistentDecisionsAllowed,
          temporaryOptionsAvailable: event.temporaryOptionsAvailable,
        },
      });

      try {
        const trustContext = session.trustContext;
        createCanonicalGuardianRequest({
          id: event.requestId,
          kind: "tool_approval",
          sourceType: "desktop",
          sourceChannel,
          conversationId,
          guardianPrincipalId: trustContext?.guardianPrincipalId ?? undefined,
          toolName: event.toolName,
          status: "pending",
          requestCode: generateCanonicalRequestCode(),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });
      } catch (err) {
        log.debug(
          { err, requestId: event.requestId, conversationId },
          "Failed to create canonical request from IPC confirmation event",
        );
      }
    } else if (event.type === "secret_request") {
      pendingInteractions.register(event.requestId, {
        session,
        conversationId,
        kind: "secret",
      });
    }

    ctx.send(socket, event);
  };
}

export async function handleUserMessage(
  msg: UserMessage,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const requestId = uuid();
  const rlog = log.child({ sessionId: msg.sessionId, requestId });
  try {
    ctx.socketToSession.set(socket, msg.sessionId);
    const session = await ctx.getOrCreateSession(msg.sessionId, socket, true);
    // Only wire the escalation handler if one isn't already set — handleTaskSubmit
    // sets a handler with the client's actual screen dimensions, and overwriting it
    // here would replace those dimensions with the daemon's defaults.
    if (!session.hasEscalationHandler()) {
      wireEscalationHandler(session, socket, ctx);
    }

    const ipcChannel = parseChannelId(msg.channel) ?? "vellum";
    const sendEvent = makeIpcEventSender({
      ctx,
      socket,
      session,
      conversationId: msg.sessionId,
      sourceChannel: ipcChannel,
    });
    // Route prompter-originated events (confirmation_request/secret_request)
    // through the IPC wrapper so pending-interactions + canonical tracking
    // are updated before the message is sent to the client.
    session.updateClient(sendEvent, false);
    const ipcInterface = parseInterfaceId(msg.interface);
    if (!ipcInterface) {
      ctx.send(socket, {
        type: "error",
        message:
          "Invalid user_message: interface is required and must be valid",
      });
      return;
    }
    const queuedChannelMetadata = {
      userMessageChannel: ipcChannel,
      assistantMessageChannel: ipcChannel,
      userMessageInterface: ipcInterface,
      assistantMessageInterface: ipcInterface,
    };

    // Update channel capabilities eagerly so both immediate and queued paths
    // reflect the latest PTT / microphone state from the client.
    session.setChannelCapabilities(
      resolveChannelCapabilities(ipcChannel, ipcInterface, {
        pttActivationKey: msg.pttActivationKey,
        microphonePermissionGranted: msg.microphonePermissionGranted,
      }),
    );

    const dispatchUserMessage = (
      content: string,
      attachments: UserMessageAttachment[],
      dispatchRequestId: string,
      source: "user_message" | "secure_redirect_resume",
      activeSurfaceId?: string,
      currentPage?: string,
      displayContent?: string,
    ): void => {
      const receivedDescription =
        source === "user_message"
          ? "User message received"
          : "Resuming message after secure credential save";
      const queuedDescription =
        source === "user_message"
          ? "Message queued (session busy)"
          : "Resumed message queued (session busy)";

      session.traceEmitter.emit("request_received", receivedDescription, {
        requestId: dispatchRequestId,
        status: "info",
        attributes: { source },
      });

      const result = session.enqueueMessage(
        content,
        attachments,
        sendEvent,
        dispatchRequestId,
        activeSurfaceId,
        currentPage,
        queuedChannelMetadata,
        undefined,
        displayContent,
      );
      if (result.rejected) {
        rlog.warn({ source }, "Message rejected — queue is full");
        session.traceEmitter.emit(
          "request_error",
          "Message rejected — queue is full",
          {
            requestId: dispatchRequestId,
            status: "error",
            attributes: {
              reason: "queue_full",
              queueDepth: session.getQueueDepth(),
              source,
            },
          },
        );
        ctx.send(
          socket,
          buildSessionErrorMessage(msg.sessionId, {
            code: "QUEUE_FULL",
            userMessage:
              "Message queue is full (max depth: 10). Please wait for current messages to be processed.",
            retryable: true,
            debugDetails: "Message rejected — session queue is full",
          }),
        );
        return;
      }
      if (result.queued) {
        const position = session.getQueueDepth();
        rlog.info({ source, position }, queuedDescription);
        session.traceEmitter.emit(
          "request_queued",
          `Message queued at position ${position}`,
          {
            requestId: dispatchRequestId,
            status: "info",
            attributes: { position, source },
          },
        );
        ctx.send(socket, {
          type: "message_queued",
          sessionId: msg.sessionId,
          requestId: dispatchRequestId,
          position,
        });
        return;
      }

      rlog.info({ source }, "Processing user message");
      session.emitActivityState(
        "thinking",
        "message_dequeued",
        "assistant_turn",
        dispatchRequestId,
      );
      session.setTurnChannelContext({
        userMessageChannel: ipcChannel,
        assistantMessageChannel: ipcChannel,
      });
      session.setTurnInterfaceContext({
        userMessageInterface: ipcInterface,
        assistantMessageInterface: ipcInterface,
      });
      session.setAssistantId(DAEMON_INTERNAL_ASSISTANT_ID);
      // Resolve local IPC actor identity through the same trust pipeline
      // used by HTTP channel ingress. The vellum guardian binding provides
      // the guardianPrincipalId, and resolveTrustContext classifies the
      // local user as 'guardian' via binding match.
      session.setTrustContext(resolveLocalIpcTrustContext(ipcChannel));
      // Align IPC sessions with the same AuthContext shape as HTTP sessions.
      session.setAuthContext(resolveLocalIpcAuthContext(msg.sessionId));
      session.setCommandIntent(null);
      // Fire-and-forget: don't block the IPC handler so the connection can
      // continue receiving messages (e.g. cancel, confirmations, or
      // additional user_message that will be queued by the session).
      session
        .processMessage(
          content,
          attachments,
          sendEvent,
          dispatchRequestId,
          activeSurfaceId,
          currentPage,
          undefined,
          displayContent,
        )
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          rlog.error(
            { err, source },
            "Error processing user message (session or provider failure)",
          );
          ctx.send(socket, {
            type: "error",
            message: `Failed to process message: ${message}`,
          });
          const classified = classifySessionError(err, { phase: "agent_loop" });
          ctx.send(socket, buildSessionErrorMessage(msg.sessionId, classified));
        });
    };

    const config = getConfig();
    let messageText = msg.content ?? "";

    // Block inbound messages that contain secrets and redirect to secure prompt
    if (!msg.bypassSecretCheck) {
      const ingressCheck = checkIngressForSecrets(messageText);
      if (ingressCheck.blocked) {
        rlog.warn(
          { detectedTypes: ingressCheck.detectedTypes },
          "Blocked user message containing secrets",
        );
        ctx.send(socket, {
          type: "error",
          message: ingressCheck.userNotice!,
          category: "secret_blocked",
        });

        const compiledCustom = config.secretDetection.customPatterns?.length
          ? compileCustomPatterns(config.secretDetection.customPatterns)
          : undefined;
        const redactedMessageText = redactSecrets(
          messageText,
          {
            enabled: true,
            base64Threshold: config.secretDetection.entropyThreshold,
          },
          compiledCustom,
        ).trim();

        // Redirect: trigger a secure prompt so the user can enter the secret safely.
        // After save, continue the same request with redacted text so the model keeps
        // user intent without ever receiving the raw secret value.
        session.redirectToSecurePrompt(ingressCheck.detectedTypes, {
          onStored: (record) => {
            ctx.send(socket, {
              type: "assistant_text_delta",
              sessionId: msg.sessionId,
              text: "Saved your secret securely. Continuing with your request.",
            });
            ctx.send(socket, {
              type: "message_complete",
              sessionId: msg.sessionId,
            });

            const continuationParts: string[] = [];
            if (redactedMessageText.length > 0)
              continuationParts.push(redactedMessageText);
            continuationParts.push(
              `I entered the redacted secret via the Secure Credential UI and saved it as credential ${record.service}/${record.field}. ` +
                "Continue with my request using that stored credential and do not ask me to paste the secret again.",
            );
            const continuationMessage = continuationParts.join("\n\n");
            const continuationRequestId = uuid();
            dispatchUserMessage(
              continuationMessage,
              msg.attachments ?? [],
              continuationRequestId,
              "secure_redirect_resume",
              msg.activeSurfaceId,
              msg.currentPage,
            );
          },
        });
        return;
      }
    }

    // ── Structured command intent (bypasses text parsing) ──────────────────
    if (
      config.daemon.standaloneRecording &&
      msg.commandIntent?.domain === "screen_recording"
    ) {
      const action = msg.commandIntent.action;
      rlog.info(
        { action, source: "commandIntent" },
        "Recording command intent received in user_message",
      );
      if (action === "start") {
        const recordingId = handleRecordingStart(
          msg.sessionId,
          { promptForSource: true },
          socket,
          ctx,
        );
        const responseText = recordingId
          ? "Starting screen recording."
          : "A recording is already active.";
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: responseText,
          sessionId: msg.sessionId,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: msg.sessionId,
        });
        await conversationStore.addMessage(
          msg.sessionId,
          "user",
          JSON.stringify([{ type: "text", text: messageText }]),
        );
        await conversationStore.addMessage(
          msg.sessionId,
          "assistant",
          JSON.stringify([{ type: "text", text: responseText }]),
        );
        // Keep in-memory session history aligned with DB so regenerate() and
        // other history operations that rely on session.messages stay consistent.
        // Only push when agent loop is NOT active to avoid corrupting role alternation.
        if (!session.isProcessing()) {
          session.messages.push({
            role: "user",
            content: [{ type: "text", text: messageText }],
          });
          session.messages.push({
            role: "assistant",
            content: [{ type: "text", text: responseText }],
          });
        }
        return;
      } else if (action === "stop") {
        const stopped = handleRecordingStop(msg.sessionId, ctx) !== undefined;
        const responseText = stopped
          ? "Stopping the recording."
          : "No active recording to stop.";
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: responseText,
          sessionId: msg.sessionId,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: msg.sessionId,
        });
        await conversationStore.addMessage(
          msg.sessionId,
          "user",
          JSON.stringify([{ type: "text", text: messageText }]),
        );
        await conversationStore.addMessage(
          msg.sessionId,
          "assistant",
          JSON.stringify([{ type: "text", text: responseText }]),
        );
        if (!session.isProcessing()) {
          session.messages.push({
            role: "user",
            content: [{ type: "text", text: messageText }],
          });
          session.messages.push({
            role: "assistant",
            content: [{ type: "text", text: responseText }],
          });
        }
        return;
      } else if (action === "restart") {
        const restartResult = handleRecordingRestart(
          msg.sessionId,
          socket,
          ctx,
        );
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: restartResult.responseText,
          sessionId: msg.sessionId,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: msg.sessionId,
        });
        await conversationStore.addMessage(
          msg.sessionId,
          "user",
          JSON.stringify([{ type: "text", text: messageText }]),
        );
        await conversationStore.addMessage(
          msg.sessionId,
          "assistant",
          JSON.stringify([{ type: "text", text: restartResult.responseText }]),
        );
        if (!session.isProcessing()) {
          session.messages.push({
            role: "user",
            content: [{ type: "text", text: messageText }],
          });
          session.messages.push({
            role: "assistant",
            content: [{ type: "text", text: restartResult.responseText }],
          });
        }
        return;
      } else if (action === "pause") {
        const paused = handleRecordingPause(msg.sessionId, ctx) !== undefined;
        const responseText = paused
          ? "Pausing the recording."
          : "No active recording to pause.";
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: responseText,
          sessionId: msg.sessionId,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: msg.sessionId,
        });
        await conversationStore.addMessage(
          msg.sessionId,
          "user",
          JSON.stringify([{ type: "text", text: messageText }]),
        );
        await conversationStore.addMessage(
          msg.sessionId,
          "assistant",
          JSON.stringify([{ type: "text", text: responseText }]),
        );
        if (!session.isProcessing()) {
          session.messages.push({
            role: "user",
            content: [{ type: "text", text: messageText }],
          });
          session.messages.push({
            role: "assistant",
            content: [{ type: "text", text: responseText }],
          });
        }
        return;
      } else if (action === "resume") {
        const resumed = handleRecordingResume(msg.sessionId, ctx) !== undefined;
        const responseText = resumed
          ? "Resuming the recording."
          : "No active recording to resume.";
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: responseText,
          sessionId: msg.sessionId,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: msg.sessionId,
        });
        await conversationStore.addMessage(
          msg.sessionId,
          "user",
          JSON.stringify([{ type: "text", text: messageText }]),
        );
        await conversationStore.addMessage(
          msg.sessionId,
          "assistant",
          JSON.stringify([{ type: "text", text: responseText }]),
        );
        if (!session.isProcessing()) {
          session.messages.push({
            role: "user",
            content: [{ type: "text", text: messageText }],
          });
          session.messages.push({
            role: "assistant",
            content: [{ type: "text", text: responseText }],
          });
        }
        return;
      } else {
        // Unrecognized action — fall through to normal text handling
        rlog.warn(
          { action, source: "commandIntent" },
          "Unrecognized screen_recording action, falling through to text handling",
        );
      }
    }

    // ── Standalone recording intent interception ──────────────────────────
    let originalContentBeforeStrip: string | undefined;
    if (config.daemon.standaloneRecording && messageText) {
      const name = getAssistantName();
      const dynamicNames = [name].filter(Boolean) as string[];
      const intentResult = resolveRecordingIntent(messageText, dynamicNames);

      if (
        intentResult.kind === "start_only" ||
        intentResult.kind === "stop_only" ||
        intentResult.kind === "start_and_stop_only" ||
        intentResult.kind === "restart_only" ||
        intentResult.kind === "pause_only" ||
        intentResult.kind === "resume_only"
      ) {
        const execResult = executeRecordingIntent(intentResult, {
          conversationId: msg.sessionId,
          socket,
          ctx,
        });

        if (execResult.handled) {
          rlog.info(
            { kind: intentResult.kind },
            "Recording intent intercepted in user_message",
          );
          ctx.send(socket, {
            type: "assistant_text_delta",
            text: execResult.responseText!,
            sessionId: msg.sessionId,
          });
          ctx.send(socket, {
            type: "message_complete",
            sessionId: msg.sessionId,
          });
          await conversationStore.addMessage(
            msg.sessionId,
            "user",
            JSON.stringify([{ type: "text", text: messageText }]),
          );
          await conversationStore.addMessage(
            msg.sessionId,
            "assistant",
            JSON.stringify([{ type: "text", text: execResult.responseText! }]),
          );
          if (!session.isProcessing()) {
            session.messages.push({
              role: "user",
              content: [{ type: "text", text: messageText }],
            });
            session.messages.push({
              role: "assistant",
              content: [{ type: "text", text: execResult.responseText! }],
            });
          }
          return;
        }
      }

      if (
        intentResult.kind === "start_with_remainder" ||
        intentResult.kind === "stop_with_remainder" ||
        intentResult.kind === "start_and_stop_with_remainder" ||
        intentResult.kind === "restart_with_remainder"
      ) {
        const execResult = executeRecordingIntent(intentResult, {
          conversationId: msg.sessionId,
          socket,
          ctx,
        });

        // Preserve the original text so the DB stores the full message
        originalContentBeforeStrip = messageText;

        // Continue with stripped text for downstream processing
        msg.content = execResult.remainderText ?? messageText;
        messageText = msg.content;

        // Execute the recording side effects that executeRecordingIntent deferred
        if (intentResult.kind === "stop_with_remainder") {
          handleRecordingStop(msg.sessionId, ctx);
        }
        if (intentResult.kind === "start_with_remainder") {
          handleRecordingStart(
            msg.sessionId,
            { promptForSource: true },
            socket,
            ctx,
          );
        }
        // start_and_stop_with_remainder / restart_with_remainder — route through
        // handleRecordingRestart which properly cleans up maps between stop and start.
        if (
          intentResult.kind === "restart_with_remainder" ||
          intentResult.kind === "start_and_stop_with_remainder"
        ) {
          const restartResult = handleRecordingRestart(
            msg.sessionId,
            socket,
            ctx,
          );
          // Only fall back to plain start for start_and_stop_with_remainder.
          // restart_with_remainder should NOT silently start a new recording when idle.
          if (
            !restartResult.initiated &&
            restartResult.reason === "no_active_recording" &&
            intentResult.kind === "start_and_stop_with_remainder"
          ) {
            handleRecordingStart(
              msg.sessionId,
              { promptForSource: true },
              socket,
              ctx,
            );
          }
        }

        rlog.info(
          { remaining: msg.content, kind: intentResult.kind },
          "Recording intent with remainder — continuing with remaining text",
        );
      }

      // 'none' — deterministic resolver found nothing; try LLM fallback
      // if the text contains recording-related keywords.
      if (
        intentResult.kind === "none" &&
        containsRecordingKeywords(messageText)
      ) {
        const fallback = await classifyRecordingIntentFallback(messageText);
        rlog.info(
          {
            fallbackAction: fallback.action,
            fallbackConfidence: fallback.confidence,
          },
          "Recording intent LLM fallback result",
        );

        if (fallback.action !== "none" && fallback.confidence === "high") {
          const kindMap: Record<
            string,
            import("../recording-intent.js").RecordingIntentResult
          > = {
            start: { kind: "start_only" },
            stop: { kind: "stop_only" },
            restart: { kind: "restart_only" },
            pause: { kind: "pause_only" },
            resume: { kind: "resume_only" },
          };
          const mapped = kindMap[fallback.action];
          if (mapped) {
            const execResult = executeRecordingIntent(mapped, {
              conversationId: msg.sessionId,
              socket,
              ctx,
            });

            if (execResult.handled) {
              rlog.info(
                { kind: mapped.kind, source: "llm_fallback" },
                "Recording intent intercepted via LLM fallback",
              );
              ctx.send(socket, {
                type: "assistant_text_delta",
                text: execResult.responseText!,
                sessionId: msg.sessionId,
              });
              ctx.send(socket, {
                type: "message_complete",
                sessionId: msg.sessionId,
              });
              await conversationStore.addMessage(
                msg.sessionId,
                "user",
                JSON.stringify([{ type: "text", text: messageText }]),
              );
              await conversationStore.addMessage(
                msg.sessionId,
                "assistant",
                JSON.stringify([
                  { type: "text", text: execResult.responseText! },
                ]),
              );
              if (!session.isProcessing()) {
                session.messages.push({
                  role: "user",
                  content: [{ type: "text", text: messageText }],
                });
                session.messages.push({
                  role: "assistant",
                  content: [{ type: "text", text: execResult.responseText! }],
                });
              }
              return;
            }
          }
        }
      }
    }

    // If a live turn is waiting on confirmation, try to consume this text as
    // an inline approval decision before auto-deny. We intentionally do not
    // gate on queue depth: users often retry "approve"/"yes" while the queue
    // is draining after a prior denial, and requiring an empty queue causes a
    // deny/retry cascade where natural-language approvals never land.
    if (session.hasAnyPendingConfirmation() && messageText.trim().length > 0) {
      try {
        const pendingInteractionRequestIdsForConversation = pendingInteractions
          .getByConversation(msg.sessionId)
          .filter(
            (interaction) =>
              interaction.kind === "confirmation" &&
              interaction.session === session &&
              session.hasPendingConfirmation(interaction.requestId),
          )
          .map((interaction) => interaction.requestId);

        const pendingCanonicalRequestIdsForConversation = [
          ...listPendingCanonicalGuardianRequestsByDestinationConversation(
            msg.sessionId,
            ipcChannel,
          )
            .filter((request) => request.kind === "tool_approval")
            .map((request) => request.id),
          ...listCanonicalGuardianRequests({
            status: "pending",
            conversationId: msg.sessionId,
            kind: "tool_approval",
          }).map((request) => request.id),
        ].filter((pendingRequestId) =>
          session.hasPendingConfirmation(pendingRequestId),
        );

        const pendingRequestIdsForConversation = Array.from(
          new Set([
            ...pendingInteractionRequestIdsForConversation,
            ...pendingCanonicalRequestIdsForConversation,
          ]),
        );

        if (pendingRequestIdsForConversation.length > 0) {
          // Resolve the local IPC actor's principal via the vellum guardian binding
          // for principal-based authorization in the canonical decision primitive.
          const localCtx = resolveLocalIpcTrustContext(ipcChannel);
          const routerResult = await routeGuardianReply({
            messageText: messageText.trim(),
            channel: ipcChannel,
            actor: {
              actorPrincipalId: localCtx.guardianPrincipalId ?? undefined,
              actorExternalUserId: localCtx.guardianExternalUserId,
              channel: ipcChannel,
              guardianPrincipalId: localCtx.guardianPrincipalId ?? undefined,
            },
            conversationId: msg.sessionId,
            pendingRequestIds: pendingRequestIdsForConversation,
            approvalConversationGenerator: desktopApprovalConversationGenerator,
            emissionContext: {
              source: "inline_nl",
              causedByRequestId: requestId,
              decisionText: messageText.trim(),
            },
          });

          if (
            routerResult.consumed &&
            routerResult.type !== "nl_keep_pending"
          ) {
            // Success-path emissions (approved/denied) are handled centrally
            // by handleConfirmationResponse (called via the resolver chain).
            // However, stale/failed paths never reach handleConfirmationResponse,
            // so we emit resolved_stale here for those cases.
            if (routerResult.requestId && !routerResult.decisionApplied) {
              session.emitConfirmationStateChanged({
                sessionId: msg.sessionId,
                requestId: routerResult.requestId,
                state: "resolved_stale",
                source: "inline_nl",
                causedByRequestId: requestId,
                decisionText: messageText.trim(),
              });
            }

            const consumedChannelMeta = {
              userMessageChannel: ipcChannel,
              assistantMessageChannel: ipcChannel,
              userMessageInterface: ipcInterface,
              assistantMessageInterface: ipcInterface,
              provenanceTrustClass: "guardian" as const,
            };

            const consumedUserMessage = createUserMessage(
              messageText,
              msg.attachments ?? [],
            );
            await conversationStore.addMessage(
              msg.sessionId,
              "user",
              JSON.stringify(consumedUserMessage.content),
              consumedChannelMeta,
            );

            const replyText =
              routerResult.replyText?.trim() ||
              (routerResult.decisionApplied
                ? "Decision applied."
                : "Request already resolved.");
            const consumedAssistantMessage = createAssistantMessage(replyText);
            await conversationStore.addMessage(
              msg.sessionId,
              "assistant",
              JSON.stringify(consumedAssistantMessage.content),
              consumedChannelMeta,
            );
            // Avoid mutating in-memory history while an agent loop is active;
            // the loop owns history reconstruction for the in-flight turn.
            if (!session.isProcessing()) {
              // Keep in-memory history aligned with persisted transcript so
              // session-history operations (undo/regenerate) target the same turn.
              session.messages.push(
                consumedUserMessage,
                consumedAssistantMessage,
              );
            }

            // Mirror the normal queued/dequeued lifecycle so desktop clients can
            // reconcile queued bubble state for this just-sent user message.
            ctx.send(socket, {
              type: "message_queued",
              sessionId: msg.sessionId,
              requestId,
              position: 0,
            });
            ctx.send(socket, {
              type: "message_dequeued",
              sessionId: msg.sessionId,
              requestId,
            });

            // Only emit the reply delta when no agent turn is in-flight.
            // When the agent is active, currentAssistantMessageId on the client
            // points to the agent's streaming message and this delta would
            // contaminate it.  The reply is already persisted to the DB, so the
            // client will see it on the next transcript reload / session switch.
            if (!session.isProcessing()) {
              ctx.send(socket, {
                type: "assistant_text_delta",
                text: replyText,
                sessionId: msg.sessionId,
              });
            }
            ctx.send(socket, {
              type: "message_request_complete",
              sessionId: msg.sessionId,
              requestId,
              runStillActive: session.isProcessing(),
            });

            rlog.info(
              {
                routerType: routerResult.type,
                decisionApplied: routerResult.decisionApplied,
                routerRequestId: routerResult.requestId,
              },
              "Consumed pending-confirmation reply before auto-deny",
            );
            return;
          }
        }
      } catch (err) {
        rlog.warn(
          { err },
          "Failed to process pending-confirmation reply; falling back to auto-deny behavior",
        );
      }
    }

    // If the session has a pending tool confirmation, auto-deny it so the
    // agent can process the user's follow-up message instead. The agent
    // will see the denial and can re-request the tool if still needed.
    if (session.hasAnyPendingConfirmation()) {
      rlog.info("Auto-denying pending confirmation(s) due to new user message");
      // Emit authoritative confirmation state for each auto-denied request
      // before the prompter clears them.
      for (const interaction of pendingInteractions.getByConversation(
        msg.sessionId,
      )) {
        if (
          interaction.session === session &&
          interaction.kind === "confirmation"
        ) {
          session.emitConfirmationStateChanged({
            sessionId: msg.sessionId,
            requestId: interaction.requestId,
            state: "denied",
            source: "auto_deny",
            causedByRequestId: requestId,
          });
        }
      }
      session.denyAllPendingConfirmations();
      // Keep the pending-interaction tracker aligned with the prompter so
      // stale request IDs are not reused as routing candidates.
      for (const interaction of pendingInteractions.getByConversation(
        msg.sessionId,
      )) {
        if (
          interaction.session === session &&
          interaction.kind === "confirmation"
        ) {
          syncCanonicalStatusFromIpcConfirmationDecision(
            interaction.requestId,
            "deny",
          );
          pendingInteractions.resolve(interaction.requestId);
        }
      }
    }

    dispatchUserMessage(
      messageText,
      msg.attachments ?? [],
      requestId,
      "user_message",
      msg.activeSurfaceId,
      msg.currentPage,
      originalContentBeforeStrip,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rlog.error({ err }, "Error setting up user message processing");
    ctx.send(socket, {
      type: "error",
      message: `Failed to process message: ${message}`,
    });
    const classified = classifySessionError(err, { phase: "handler" });
    ctx.send(socket, buildSessionErrorMessage(msg.sessionId, classified));
  }
}

export function handleConfirmationResponse(
  msg: ConfirmationResponse,
  _socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Route by requestId to the session that originated the prompt, not by
  // the current socket-session binding which may have changed since the
  // request was issued (e.g. after a session switch).
  for (const [sessionId, session] of ctx.sessions) {
    if (session.hasPendingConfirmation(msg.requestId)) {
      ctx.touchSession(sessionId);
      session.handleConfirmationResponse(
        msg.requestId,
        msg.decision,
        msg.selectedPattern,
        msg.selectedScope,
        undefined,
        { source: "button" },
      );
      syncCanonicalStatusFromIpcConfirmationDecision(
        msg.requestId,
        msg.decision,
      );
      pendingInteractions.resolve(msg.requestId);
      return;
    }
  }

  // Also check computer-use sessions — they have their own PermissionPrompter
  for (const [, cuSession] of ctx.cuSessions) {
    if (cuSession.hasPendingConfirmation(msg.requestId)) {
      cuSession.handleConfirmationResponse(
        msg.requestId,
        msg.decision,
        msg.selectedPattern,
        msg.selectedScope,
      );
      syncCanonicalStatusFromIpcConfirmationDecision(
        msg.requestId,
        msg.decision,
      );
      pendingInteractions.resolve(msg.requestId);
      return;
    }
  }

  log.warn(
    { requestId: msg.requestId },
    "No session found with pending confirmation for requestId",
  );
}

export function handleSecretResponse(
  msg: SecretResponse,
  _socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Check standalone (non-session) prompts first, since they use a dedicated
  // requestId that won't collide with session prompts.
  const standalone = pendingStandaloneSecrets.get(msg.requestId);
  if (standalone) {
    clearTimeout(standalone.timer);
    pendingStandaloneSecrets.delete(msg.requestId);
    standalone.resolve({
      value: msg.value ?? null,
      delivery: msg.delivery ?? "store",
    });
    pendingInteractions.resolve(msg.requestId);
    return;
  }

  // Route by requestId to the session that originated the prompt, not by
  // the current socket-session binding which may have changed since the
  // request was issued (e.g. after a session switch).
  for (const [sessionId, session] of ctx.sessions) {
    if (session.hasPendingSecret(msg.requestId)) {
      ctx.touchSession(sessionId);
      session.handleSecretResponse(msg.requestId, msg.value, msg.delivery);
      pendingInteractions.resolve(msg.requestId);
      return;
    }
  }
  log.warn(
    { requestId: msg.requestId },
    "No session found with pending secret prompt for requestId",
  );
}

export function handleSessionList(
  socket: net.Socket,
  ctx: HandlerContext,
  offset = 0,
  limit = 50,
): void {
  const conversations = conversationStore.listConversations(
    limit,
    false,
    offset,
  );
  const totalCount = conversationStore.countConversations();
  const conversationIds = conversations.map((c) => c.id);
  const bindings =
    externalConversationStore.getBindingsForConversations(conversationIds);
  const attentionStates = getAttentionStateByConversationIds(conversationIds);
  const displayMetas =
    conversationStore.getDisplayMetaForConversations(conversationIds);
  ctx.send(socket, {
    type: "session_list_response",
    sessions: conversations.map((c) => {
      const binding = bindings.get(c.id);
      const originChannel = parseChannelId(c.originChannel);
      const originInterface = parseInterfaceId(c.originInterface);
      const attn = attentionStates.get(c.id);
      const displayMeta = displayMetas.get(c.id);
      const assistantAttention = attn
        ? {
            hasUnseenLatestAssistantMessage:
              attn.latestAssistantMessageAt != null &&
              (attn.lastSeenAssistantMessageAt == null ||
                attn.lastSeenAssistantMessageAt <
                  attn.latestAssistantMessageAt),
            ...(attn.latestAssistantMessageAt != null
              ? { latestAssistantMessageAt: attn.latestAssistantMessageAt }
              : {}),
            ...(attn.lastSeenAssistantMessageAt != null
              ? { lastSeenAssistantMessageAt: attn.lastSeenAssistantMessageAt }
              : {}),
            ...(attn.lastSeenConfidence != null
              ? { lastSeenConfidence: attn.lastSeenConfidence }
              : {}),
            ...(attn.lastSeenSignalType != null
              ? { lastSeenSignalType: attn.lastSeenSignalType }
              : {}),
          }
        : undefined;
      return {
        id: c.id,
        title: c.title ?? "Untitled",
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        threadType: normalizeThreadType(c.threadType),
        source: c.source ?? "user",
        ...(binding && isChannelId(binding.sourceChannel)
          ? {
              channelBinding: {
                sourceChannel: binding.sourceChannel,
                externalChatId: binding.externalChatId,
                externalUserId: binding.externalUserId,
                displayName: binding.displayName,
                username: binding.username,
              },
            }
          : {}),
        ...(c.scheduleJobId ? { scheduleJobId: c.scheduleJobId } : {}),
        ...(originChannel ? { conversationOriginChannel: originChannel } : {}),
        ...(originInterface
          ? { conversationOriginInterface: originInterface }
          : {}),
        ...(assistantAttention ? { assistantAttention } : {}),
        ...(displayMeta?.displayOrder != null
          ? { displayOrder: displayMeta.displayOrder }
          : {}),
        ...(displayMeta?.isPinned ? { isPinned: displayMeta.isPinned } : {}),
      };
    }),
    hasMore: offset + conversations.length < totalCount,
  });
}

export function handleSessionsClear(
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const cleared = ctx.clearAllSessions();
  // Also clear DB conversations. When a new IPC connection triggers
  // sendInitialSession, it auto-creates a conversation if none exist.
  // Without this DB clear, that auto-created row survives, contradicting
  // the "clear all conversations" intent.
  conversationStore.clearAll();
  ctx.send(socket, { type: "sessions_clear_response", cleared });
}

export async function handleSessionCreate(
  msg: SessionCreateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const threadType = normalizeThreadType(msg.threadType);
  const title =
    msg.title ?? (msg.initialMessage ? GENERATING_TITLE : "New Conversation");
  const conversation = conversationStore.createConversation({
    title,
    threadType,
  });
  const session = await ctx.getOrCreateSession(conversation.id, socket, true, {
    systemPromptOverride: msg.systemPromptOverride,
    maxResponseTokens: msg.maxResponseTokens,
    transport: msg.transport,
  });
  wireEscalationHandler(session, socket, ctx);

  // Pre-activate skills before sending session_info so they're available
  // for the initial message processing.
  if (msg.preactivatedSkillIds?.length) {
    session.setPreactivatedSkillIds(msg.preactivatedSkillIds);
  }

  ctx.send(socket, {
    type: "session_info",
    sessionId: conversation.id,
    title: conversation.title ?? "New Conversation",
    ...(msg.correlationId ? { correlationId: msg.correlationId } : {}),
    threadType: normalizeThreadType(conversation.threadType),
  });

  // Auto-send the initial message if provided, kick-starting the skill.
  if (msg.initialMessage) {
    // Queue title generation eagerly — some processMessage paths (guardian
    // replies, unknown slash commands) bypass the agent loop entirely, so
    // we can't rely on the agent loop's early title generation alone.
    // The agent loop also queues title generation, but isReplaceableTitle
    // prevents double-writes since the first to complete sets a real title.
    if (title === GENERATING_TITLE) {
      queueGenerateConversationTitle({
        conversationId: conversation.id,
        context: { origin: "ipc" },
        userMessage: msg.initialMessage,
        onTitleUpdated: (newTitle) => {
          ctx.send(socket, {
            type: "session_title_updated",
            sessionId: conversation.id,
            title: newTitle,
          });
        },
      });
    }

    ctx.socketToSession.set(socket, conversation.id);
    const requestId = uuid();
    const transportChannel =
      parseChannelId(msg.transport?.channelId) ?? "vellum";
    const sendEvent = makeIpcEventSender({
      ctx,
      socket,
      session,
      conversationId: conversation.id,
      sourceChannel: transportChannel,
    });
    session.updateClient(sendEvent, false);
    session.setTurnChannelContext({
      userMessageChannel: transportChannel,
      assistantMessageChannel: transportChannel,
    });
    const transportInterface: InterfaceId =
      parseInterfaceId(msg.transport?.interfaceId) ?? "vellum";
    session.setTurnInterfaceContext({
      userMessageInterface: transportInterface,
      assistantMessageInterface: transportInterface,
    });
    session
      .processMessage(msg.initialMessage, [], sendEvent, requestId)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err, sessionId: conversation.id },
          "Error processing initial message",
        );
        ctx.send(socket, {
          type: "error",
          message: `Failed to process initial message: ${message}`,
        });

        // Replace stuck loading placeholder with a stable fallback title
        // if title generation hasn't already completed or been renamed.
        try {
          const current = conversationStore.getConversation(conversation.id);
          if (current && current.title === GENERATING_TITLE) {
            const fallback = UNTITLED_FALLBACK;
            conversationStore.updateConversationTitle(
              conversation.id,
              fallback,
            );
            ctx.send(socket, {
              type: "session_title_updated",
              sessionId: conversation.id,
              title: fallback,
            });
          }
        } catch {
          // Best-effort fallback
        }
      });
  }
}

export async function handleSessionSwitch(
  msg: SessionSwitchRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const conversation = conversationStore.getConversation(msg.sessionId);
  if (!conversation) {
    ctx.send(socket, {
      type: "error",
      message: `Session ${msg.sessionId} not found`,
    });
    return;
  }

  // If the target session is headless-locked (actively executing a task run),
  // skip rebinding the socket so tool confirmations stay suppressed.
  const existingSession = ctx.sessions.get(msg.sessionId);
  const isHeadlessLocked = existingSession?.headlessLock;

  ctx.socketToSession.set(socket, msg.sessionId);

  if (isHeadlessLocked) {
    // Load the session without rebinding the client — the session stays headless
    await ctx.getOrCreateSession(msg.sessionId, socket, false);
  } else {
    const session = await ctx.getOrCreateSession(msg.sessionId, socket, true);
    // Only wire the escalation handler if one isn't already set — handleTaskSubmit
    // sets a handler with the client's actual screen dimensions, and overwriting it
    // here would replace those dimensions with the daemon's defaults.
    if (!session.hasEscalationHandler()) {
      wireEscalationHandler(session, socket, ctx);
    }
  }

  ctx.send(socket, {
    type: "session_info",
    sessionId: conversation.id,
    title: conversation.title ?? "Untitled",
    threadType: normalizeThreadType(conversation.threadType),
  });
}

export function handleSessionRename(
  msg: SessionRenameRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const conversation = conversationStore.getConversation(msg.sessionId);
  if (!conversation) {
    ctx.send(socket, {
      type: "error",
      message: `Session ${msg.sessionId} not found`,
    });
    return;
  }
  conversationStore.updateConversationTitle(msg.sessionId, msg.title, 0);
  ctx.send(socket, {
    type: "session_title_updated",
    sessionId: msg.sessionId,
    title: msg.title,
  });
}

export function handleCancel(
  msg: CancelRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const sessionId = msg.sessionId || ctx.socketToSession.get(socket);
  if (sessionId) {
    const session = ctx.sessions.get(sessionId);
    if (session) {
      ctx.touchSession(sessionId);
      session.abort();
      // Also abort any child subagents spawned by this session.
      // Omit sendToClient to suppress parent notifications — the parent is
      // being cancelled, so enqueuing synthetic messages would trigger
      // unwanted model activity after the user pressed stop.
      getSubagentManager().abortAllForParent(sessionId);
    }
  }
}

export function handleHistoryRequest(
  msg: HistoryRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  // Default to unlimited when callers don't specify a limit, preserving
  // backward-compatible behavior of returning full conversation history.
  const limit = msg.limit;

  // Resolve include flags: explicit flags override mode, mode provides defaults.
  // Default mode is 'light' when no mode and no include flags are specified.
  const isFullMode = msg.mode === "full";
  const includeAttachments = msg.includeAttachments ?? isFullMode;
  const includeToolImages = msg.includeToolImages ?? isFullMode;
  const includeSurfaceData = msg.includeSurfaceData ?? isFullMode;

  const { messages: dbMessages, hasMore } =
    conversationStore.getMessagesPaginated(
      msg.sessionId,
      limit,
      msg.beforeTimestamp,
      msg.beforeMessageId,
    );

  const parsed: ParsedHistoryMessage[] = dbMessages.map((m) => {
    let text = "";
    let toolCalls: HistoryToolCall[] = [];
    let toolCallsBeforeText = false;
    let textSegments: string[] = [];
    let contentOrder: string[] = [];
    let surfaces: HistorySurface[] = [];
    try {
      const content = JSON.parse(m.content);
      const rendered = renderHistoryContent(content);
      text = rendered.text;
      toolCalls = rendered.toolCalls;
      toolCallsBeforeText = rendered.toolCallsBeforeText;
      textSegments = rendered.textSegments;
      contentOrder = rendered.contentOrder;
      surfaces = rendered.surfaces;
      if (m.role === "assistant" && toolCalls.length > 0) {
        log.info(
          {
            messageId: m.id,
            toolCallCount: toolCalls.length,
            text: truncate(text, 100, ""),
          },
          "History message with tool calls",
        );
      }
    } catch (err) {
      log.debug(
        { err, messageId: m.id },
        "Failed to parse message content as JSON, using raw text",
      );
      text = m.content;
      textSegments = text ? [text] : [];
      contentOrder = text ? ["text:0"] : [];
      surfaces = [];
    }
    let subagentNotification: ParsedHistoryMessage["subagentNotification"];
    if (m.metadata) {
      try {
        subagentNotification = (
          JSON.parse(m.metadata) as {
            subagentNotification?: ParsedHistoryMessage["subagentNotification"];
          }
        ).subagentNotification;
      } catch (err) {
        log.debug(
          { err, messageId: m.id },
          "Failed to parse message metadata as JSON, ignoring",
        );
      }
    }
    return {
      id: m.id,
      role: m.role,
      text,
      timestamp: m.createdAt,
      toolCalls,
      toolCallsBeforeText,
      textSegments,
      contentOrder,
      surfaces,
      ...(subagentNotification ? { subagentNotification } : {}),
    };
  });

  // Merge tool_result data from user messages into the preceding assistant
  // message's toolCalls, and suppress user messages that only contain
  // tool_result blocks (internal agent-loop turns).
  const merged = mergeToolResults(parsed);

  const historyMessages = merged.map((m) => {
    let attachments: UserMessageAttachment[] | undefined;
    if (m.role === "assistant" && m.id) {
      const linked = getAttachmentsForMessage(m.id);
      if (linked.length > 0) {
        if (includeAttachments) {
          // Full attachment data: same behavior as before
          const MAX_INLINE_B64_SIZE = 512 * 1024;
          attachments = linked.map((a) => {
            const isFileBacked = !a.dataBase64;
            const omit =
              isFileBacked ||
              (a.mimeType.startsWith("video/") &&
                a.dataBase64.length > MAX_INLINE_B64_SIZE);

            if (
              a.mimeType.startsWith("video/") &&
              !a.thumbnailBase64 &&
              a.dataBase64
            ) {
              const attachmentId = a.id;
              const base64 = a.dataBase64;
              silentlyWithLog(
                generateVideoThumbnail(base64).then((thumb) => {
                  if (thumb) setAttachmentThumbnail(attachmentId, thumb);
                }),
                "video thumbnail generation",
              );
            }

            const fp = getFilePathForAttachment(a.id);
            return {
              id: a.id,
              filename: a.originalFilename,
              mimeType: a.mimeType,
              data: omit ? "" : a.dataBase64,
              ...(omit ? { sizeBytes: a.sizeBytes } : {}),
              ...(a.thumbnailBase64
                ? { thumbnailData: a.thumbnailBase64 }
                : {}),
              ...(fp ? { filePath: fp } : {}),
            };
          });
        } else {
          // Light mode: metadata only, strip base64 data
          attachments = linked.map((a) => {
            const fp = getFilePathForAttachment(a.id);
            return {
              id: a.id,
              filename: a.originalFilename,
              mimeType: a.mimeType,
              data: "",
              sizeBytes: a.sizeBytes,
              ...(a.thumbnailBase64
                ? { thumbnailData: a.thumbnailBase64 }
                : {}),
              ...(fp ? { filePath: fp } : {}),
            };
          });
        }
      }
    }

    // In light mode, strip imageData from tool calls
    const filteredToolCalls =
      m.toolCalls.length > 0
        ? includeToolImages
          ? m.toolCalls
          : m.toolCalls.map((tc) => {
              if (tc.imageData) {
                const { imageData: _, ...rest } = tc;
                return rest;
              }
              return tc;
            })
        : m.toolCalls;

    // In light mode, strip full data from surfaces (keep metadata)
    const filteredSurfaces =
      m.surfaces.length > 0
        ? includeSurfaceData
          ? m.surfaces
          : m.surfaces.map((s) => ({
              surfaceId: s.surfaceId,
              surfaceType: s.surfaceType,
              title: s.title,
              data: {
                ...(s.surfaceType === "dynamic_page"
                  ? {
                      ...(s.data.preview ? { preview: s.data.preview } : {}),
                      ...(s.data.appId ? { appId: s.data.appId } : {}),
                    }
                  : {}),
              } as Record<string, unknown>,
              ...(s.actions ? { actions: s.actions } : {}),
              ...(s.display ? { display: s.display } : {}),
            }))
        : m.surfaces;

    // Apply text truncation when maxTextChars is set
    let wasTruncated = false;
    let textWasTruncated = false;
    let text = m.text;
    if (msg.maxTextChars !== undefined && text.length > msg.maxTextChars) {
      text = text.slice(0, msg.maxTextChars) + " \u2026 [truncated]";
      wasTruncated = true;
      textWasTruncated = true;
    }

    // Apply tool result truncation when maxToolResultChars is set
    const truncatedToolCalls =
      msg.maxToolResultChars !== undefined && filteredToolCalls.length > 0
        ? filteredToolCalls.map((tc) => {
            if (
              tc.result !== undefined &&
              tc.result.length > msg.maxToolResultChars!
            ) {
              wasTruncated = true;
              return {
                ...tc,
                result:
                  tc.result.slice(0, msg.maxToolResultChars!) +
                  " \u2026 [truncated]",
              };
            }
            return tc;
          })
        : filteredToolCalls;

    return {
      ...(m.id ? { id: m.id } : {}),
      role: m.role,
      text,
      timestamp: m.timestamp,
      ...(truncatedToolCalls.length > 0
        ? {
            toolCalls: truncatedToolCalls,
            toolCallsBeforeText: m.toolCallsBeforeText,
          }
        : {}),
      ...(attachments ? { attachments } : {}),
      ...(!textWasTruncated && m.textSegments.length > 0
        ? { textSegments: m.textSegments }
        : {}),
      ...(!textWasTruncated && m.contentOrder.length > 0
        ? { contentOrder: m.contentOrder }
        : {}),
      ...(filteredSurfaces.length > 0 ? { surfaces: filteredSurfaces } : {}),
      ...(m.subagentNotification
        ? { subagentNotification: m.subagentNotification }
        : {}),
      ...(wasTruncated ? { wasTruncated: true } : {}),
    };
  });

  const oldestTimestamp =
    historyMessages.length > 0 ? historyMessages[0].timestamp : undefined;
  // Provide the oldest message ID as a tie-breaker cursor so clients can
  // paginate without skipping same-millisecond messages at page boundaries.
  const oldestMessageId =
    historyMessages.length > 0 ? historyMessages[0].id : undefined;

  ctx.send(socket, {
    type: "history_response",
    sessionId: msg.sessionId,
    messages: historyMessages,
    hasMore,
    ...(oldestTimestamp !== undefined ? { oldestTimestamp } : {}),
    ...(oldestMessageId ? { oldestMessageId } : {}),
  });

  // Surfaces are now included directly in the history_response message (in the surfaces array),
  // so we no longer emit separate ui_surface_show messages during history loading.
}

export function handleUndo(
  msg: UndoRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const session = ctx.sessions.get(msg.sessionId);
  if (!session) {
    ctx.send(socket, { type: "error", message: "No active session" });
    return;
  }
  ctx.touchSession(msg.sessionId);
  const removedCount = session.undo();
  ctx.send(socket, {
    type: "undo_complete",
    removedCount,
    sessionId: msg.sessionId,
  });
}

export async function handleRegenerate(
  msg: RegenerateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const session = ctx.sessions.get(msg.sessionId);
  if (!session) {
    ctx.send(socket, { type: "error", message: "No active session" });
    return;
  }
  ctx.touchSession(msg.sessionId);

  const regenerateChannel =
    parseChannelId(session.getTurnChannelContext()?.assistantMessageChannel) ??
    "vellum";
  const sendEvent = makeIpcEventSender({
    ctx,
    socket,
    session,
    conversationId: msg.sessionId,
    sourceChannel: regenerateChannel,
  });
  session.updateClient(sendEvent, false);
  const requestId = uuid();
  session.traceEmitter.emit("request_received", "Regenerate requested", {
    requestId,
    status: "info",
    attributes: { source: "regenerate" },
  });
  try {
    await session.regenerate(sendEvent, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, sessionId: msg.sessionId }, "Error regenerating message");
    session.traceEmitter.emit("request_error", truncate(message, 200, ""), {
      requestId,
      status: "error",
      attributes: {
        errorClass: err instanceof Error ? err.constructor.name : "Error",
        message: truncate(message, 500, ""),
      },
    });
    ctx.send(socket, {
      type: "error",
      message: `Failed to regenerate: ${message}`,
    });
    const classified = classifySessionError(err, { phase: "regenerate" });
    ctx.send(socket, buildSessionErrorMessage(msg.sessionId, classified));
  }
}

export function handleUsageRequest(
  msg: UsageRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const conversation = conversationStore.getConversation(msg.sessionId);
  if (!conversation) {
    ctx.send(socket, { type: "error", message: "No active session" });
    return;
  }
  const config = getConfig();
  ctx.send(socket, {
    type: "usage_response",
    totalInputTokens: conversation.totalInputTokens,
    totalOutputTokens: conversation.totalOutputTokens,
    estimatedCost: conversation.totalEstimatedCost,
    model: config.model,
  });
}

export function handleDeleteQueuedMessage(
  msg: DeleteQueuedMessage,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const session = ctx.sessions.get(msg.sessionId);
  if (!session) {
    log.warn(
      { sessionId: msg.sessionId, requestId: msg.requestId },
      "No session found for delete_queued_message",
    );
    return;
  }
  const removed = session.removeQueuedMessage(msg.requestId);
  if (removed) {
    ctx.send(socket, {
      type: "message_queued_deleted",
      sessionId: msg.sessionId,
      requestId: msg.requestId,
    });
  } else {
    log.warn(
      { sessionId: msg.sessionId, requestId: msg.requestId },
      "Queued message not found for deletion",
    );
  }
}

export function handleConversationSearch(
  msg: ConversationSearchRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const results = conversationStore.searchConversations(msg.query, {
    limit: msg.limit,
    maxMessagesPerConversation: msg.maxMessagesPerConversation,
  });
  ctx.send(socket, {
    type: "conversation_search_response",
    query: msg.query,
    results,
  });
}

export function handleMessageContentRequest(
  msg: MessageContentRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const dbMessage = conversationStore.getMessageById(
    msg.messageId,
    msg.sessionId,
  );
  if (!dbMessage) {
    ctx.send(socket, {
      type: "error",
      message: `Message ${msg.messageId} not found in session ${msg.sessionId}`,
    });
    return;
  }

  let text: string | undefined;
  let toolCalls:
    | Array<{ name: string; result?: string; input?: Record<string, unknown> }>
    | undefined;

  try {
    const content = JSON.parse(dbMessage.content);
    const rendered = renderHistoryContent(content);
    text = rendered.text || undefined;
    const mergedToolCalls = rendered.toolCalls;

    // Handle legacy conversations where tool_result blocks are stored in the
    // following user message rather than inline with the assistant message.
    // This mirrors the mergeToolResults logic used by handleHistoryRequest.
    if (
      dbMessage.role === "assistant" &&
      mergedToolCalls.some((tc) => tc.result === undefined)
    ) {
      const nextMsg = conversationStore.getNextMessage(
        msg.sessionId,
        dbMessage.createdAt,
        dbMessage.id,
      );
      if (nextMsg && nextMsg.role === "user") {
        try {
          const nextContent = JSON.parse(nextMsg.content);
          const nextRendered = renderHistoryContent(nextContent);
          if (
            nextRendered.text.trim() === "" &&
            nextRendered.toolCalls.length > 0
          ) {
            for (const resultEntry of nextRendered.toolCalls) {
              const unresolved = mergedToolCalls.find(
                (tc) => tc.result === undefined,
              );
              if (unresolved) {
                unresolved.result = resultEntry.result;
                unresolved.isError = resultEntry.isError;
                if (resultEntry.imageData)
                  unresolved.imageData = resultEntry.imageData;
              }
            }
          }
        } catch {
          // Next message isn't valid JSON — skip merging
        }
      }
    }

    if (mergedToolCalls.length > 0) {
      toolCalls = mergedToolCalls.map((tc) => ({
        name: tc.name,
        input: tc.input,
        ...(tc.result !== undefined ? { result: tc.result } : {}),
      }));
    }
  } catch {
    // Raw text content (not JSON)
    text = dbMessage.content || undefined;
  }

  ctx.send(socket, {
    type: "message_content_response",
    sessionId: msg.sessionId,
    messageId: msg.messageId,
    ...(text !== undefined ? { text } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  });
}

export function handleReorderThreads(
  msg: ReorderThreadsRequest,
  _socket: net.Socket,
  _ctx: HandlerContext,
): void {
  if (!Array.isArray(msg.updates)) {
    return;
  }
  conversationStore.batchSetDisplayOrders(
    msg.updates.map((u) => ({
      id: u.sessionId,
      displayOrder: u.displayOrder ?? null,
      isPinned: u.isPinned ?? false,
    })),
  );
}

export const sessionHandlers = defineHandlers({
  user_message: handleUserMessage,
  confirmation_response: handleConfirmationResponse,
  secret_response: handleSecretResponse,
  session_list: (msg, socket, ctx) =>
    handleSessionList(socket, ctx, msg.offset ?? 0, msg.limit ?? 50),
  session_create: handleSessionCreate,
  sessions_clear: (_msg, socket, ctx) => handleSessionsClear(socket, ctx),
  session_switch: handleSessionSwitch,
  session_rename: handleSessionRename,
  cancel: handleCancel,
  delete_queued_message: handleDeleteQueuedMessage,
  history_request: handleHistoryRequest,
  message_content_request: handleMessageContentRequest,
  undo: handleUndo,
  regenerate: handleRegenerate,
  usage_request: handleUsageRequest,
  conversation_search: handleConversationSearch,
  reorder_threads: handleReorderThreads,
});
