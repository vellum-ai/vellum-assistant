import { v4 as uuid } from "uuid";

import {
  createAssistantMessage,
  createUserMessage,
} from "../../agent/message-types.js";
import {
  type ChannelId,
  type InterfaceId,
  parseChannelId,
  parseInterfaceId,
} from "../../channels/types.js";
import { getConfig } from "../../config/loader.js";
import {
  listCanonicalGuardianRequests,
  listPendingCanonicalGuardianRequestsByDestinationConversation,
} from "../../memory/canonical-guardian-store.js";
import { addMessage } from "../../memory/conversation-crud.js";
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
import { createApprovalConversationGenerator } from "../approval-generators.js";
import { getAssistantName } from "../identity-helpers.js";
import type {
  ServerMessage,
  UserMessage,
  UserMessageAttachment,
} from "../message-protocol.js";
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
import {
  handleRecordingPause,
  handleRecordingRestart,
  handleRecordingResume,
  handleRecordingStart,
  handleRecordingStop,
} from "./recording.js";
import {
  makeIpcEventSender,
  syncCanonicalStatusFromIpcConfirmationDecision,
} from "./sessions.js";
import { type HandlerContext, log, wireEscalationHandler } from "./shared.js";

const desktopApprovalConversationGenerator =
  createApprovalConversationGenerator();

// ── Recording command persistence helper ─────────────────────────────
// Several recording command actions share identical logic: send a response
// delta + complete, persist user/assistant messages, and sync in-memory
// session history. This helper consolidates that pattern.
async function persistRecordingExchange(
  sessionId: string,
  messageText: string,
  responseText: string,
  session: Session,
  ctx: HandlerContext,
): Promise<void> {
  ctx.send({
    type: "assistant_text_delta",
    text: responseText,
    sessionId,
  });
  ctx.send({
    type: "message_complete",
    sessionId,
  });
  await addMessage(
    sessionId,
    "user",
    JSON.stringify([{ type: "text", text: messageText }]),
  );
  await addMessage(
    sessionId,
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
}

// ── Secret ingress check and redirect ────────────────────────────────
// Returns true if the message was blocked (caller should return early).
function handleSecretIngress(
  msg: UserMessage,
  messageText: string,
  ctx: HandlerContext,
  session: Session,
  rlog: typeof log,
  dispatchUserMessage: DispatchUserMessageFn,
): boolean {
  if (msg.bypassSecretCheck) return false;

  const ingressCheck = checkIngressForSecrets(messageText);
  if (!ingressCheck.blocked) return false;

  rlog.warn(
    { detectedTypes: ingressCheck.detectedTypes },
    "Blocked user message containing secrets",
  );
  ctx.send({
    type: "error",
    message: ingressCheck.userNotice!,
    category: "secret_blocked",
  });

  const config = getConfig();
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

  session.redirectToSecurePrompt(ingressCheck.detectedTypes, {
    onStored: (record) => {
      ctx.send({
        type: "assistant_text_delta",
        sessionId: msg.sessionId,
        text: "Saved your secret securely. Continuing with your request.",
      });
      ctx.send({
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

  return true;
}

// ── Structured recording command intent ──────────────────────────────
// Returns true if the command was fully handled (caller should return early).
async function handleStructuredRecordingIntent(
  msg: UserMessage,
  messageText: string,
  session: Session,
  ctx: HandlerContext,
  rlog: typeof log,
): Promise<boolean> {
  const config = getConfig();
  if (
    !config.daemon.standaloneRecording ||
    msg.commandIntent?.domain !== "screen_recording"
  ) {
    return false;
  }

  const action = msg.commandIntent.action;
  rlog.info(
    { action, source: "commandIntent" },
    "Recording command intent received in user_message",
  );

  if (action === "start") {
    const recordingId = handleRecordingStart(
      msg.sessionId,
      { promptForSource: true },
      ctx,
    );
    const responseText = recordingId
      ? "Starting screen recording."
      : "A recording is already active.";
    await persistRecordingExchange(
      msg.sessionId,
      messageText,
      responseText,
      session,
      ctx,
    );
    return true;
  } else if (action === "stop") {
    const stopped = handleRecordingStop(msg.sessionId, ctx) !== undefined;
    const responseText = stopped
      ? "Stopping the recording."
      : "No active recording to stop.";
    await persistRecordingExchange(
      msg.sessionId,
      messageText,
      responseText,
      session,
      ctx,
    );
    return true;
  } else if (action === "restart") {
    const restartResult = handleRecordingRestart(msg.sessionId, ctx);
    await persistRecordingExchange(
      msg.sessionId,
      messageText,
      restartResult.responseText,
      session,
      ctx,
    );
    return true;
  } else if (action === "pause") {
    const paused = handleRecordingPause(msg.sessionId, ctx) !== undefined;
    const responseText = paused
      ? "Pausing the recording."
      : "No active recording to pause.";
    await persistRecordingExchange(
      msg.sessionId,
      messageText,
      responseText,
      session,
      ctx,
    );
    return true;
  } else if (action === "resume") {
    const resumed = handleRecordingResume(msg.sessionId, ctx) !== undefined;
    const responseText = resumed
      ? "Resuming the recording."
      : "No active recording to resume.";
    await persistRecordingExchange(
      msg.sessionId,
      messageText,
      responseText,
      session,
      ctx,
    );
    return true;
  }

  // Unrecognized action — fall through to normal text handling
  rlog.warn(
    { action, source: "commandIntent" },
    "Unrecognized screen_recording action, falling through to text handling",
  );
  return false;
}

// ── Standalone recording intent interception ─────────────────────────
// Returns the original content before strip (if recording keywords were
// stripped from the message), or undefined if the message was fully handled
// or no recording intent was detected.
async function handleStandaloneRecordingIntent(
  msg: UserMessage,
  messageText: string,
  session: Session,
  ctx: HandlerContext,
  rlog: typeof log,
): Promise<{
  handled: boolean;
  originalContentBeforeStrip?: string;
  updatedMessageText: string;
}> {
  const config = getConfig();
  if (!config.daemon.standaloneRecording || !messageText) {
    return { handled: false, updatedMessageText: messageText };
  }

  const name = getAssistantName();
  const dynamicNames = [name].filter(Boolean) as string[];
  const intentResult = resolveRecordingIntent(messageText, dynamicNames);

  // Pure recording-only intents
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
      ctx,
    });

    if (execResult.handled) {
      rlog.info(
        { kind: intentResult.kind },
        "Recording intent intercepted in user_message",
      );
      await persistRecordingExchange(
        msg.sessionId,
        messageText,
        execResult.responseText!,
        session,
        ctx,
      );
      return { handled: true, updatedMessageText: messageText };
    }
  }

  // Recording intent with remainder text
  if (
    intentResult.kind === "start_with_remainder" ||
    intentResult.kind === "stop_with_remainder" ||
    intentResult.kind === "start_and_stop_with_remainder" ||
    intentResult.kind === "restart_with_remainder"
  ) {
    const execResult = executeRecordingIntent(intentResult, {
      conversationId: msg.sessionId,
      ctx,
    });

    const originalContentBeforeStrip = messageText;
    const updatedText = execResult.remainderText ?? messageText;
    msg.content = updatedText;

    if (intentResult.kind === "stop_with_remainder") {
      handleRecordingStop(msg.sessionId, ctx);
    }
    if (intentResult.kind === "start_with_remainder") {
      handleRecordingStart(
        msg.sessionId,
        { promptForSource: true },
        ctx,
      );
    }
    if (
      intentResult.kind === "restart_with_remainder" ||
      intentResult.kind === "start_and_stop_with_remainder"
    ) {
      const restartResult = handleRecordingRestart(msg.sessionId, ctx);
      if (
        !restartResult.initiated &&
        restartResult.reason === "no_active_recording" &&
        intentResult.kind === "start_and_stop_with_remainder"
      ) {
        handleRecordingStart(
          msg.sessionId,
          { promptForSource: true },
          ctx,
        );
      }
    }

    rlog.info(
      { remaining: updatedText, kind: intentResult.kind },
      "Recording intent with remainder — continuing with remaining text",
    );

    return {
      handled: false,
      originalContentBeforeStrip,
      updatedMessageText: updatedText,
    };
  }

  // 'none' — deterministic resolver found nothing; try LLM fallback
  // if the text contains recording-related keywords.
  if (intentResult.kind === "none" && containsRecordingKeywords(messageText)) {
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
          ctx,
        });

        if (execResult.handled) {
          rlog.info(
            { kind: mapped.kind, source: "llm_fallback" },
            "Recording intent intercepted via LLM fallback",
          );
          await persistRecordingExchange(
            msg.sessionId,
            messageText,
            execResult.responseText!,
            session,
            ctx,
          );
          return { handled: true, updatedMessageText: messageText };
        }
      }
    }
  }

  return { handled: false, updatedMessageText: messageText };
}

// ── Pending confirmation reply interception ──────────────────────────
// Returns true if the message was consumed as an inline approval reply.
async function handlePendingConfirmationReply(
  msg: UserMessage,
  messageText: string,
  requestId: string,
  session: Session,
  ipcChannel: ChannelId,
  ipcInterface: InterfaceId,
  ctx: HandlerContext,
  rlog: typeof log,
): Promise<boolean> {
  if (!session.hasAnyPendingConfirmation() || messageText.trim().length === 0) {
    return false;
  }

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

    if (pendingRequestIdsForConversation.length === 0) {
      return false;
    }

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

    if (routerResult.consumed && routerResult.type !== "nl_keep_pending") {
      if (routerResult.requestId && !routerResult.decisionApplied) {
        session.emitConfirmationStateChanged({
          sessionId: msg.sessionId,
          requestId: routerResult.requestId,
          state: "resolved_stale",
          source: "inline_nl",
          causedByRequestId: requestId,
          decisionText: messageText.trim(),
        });
        // Notify agent loop so the outcome is persisted on the tool_use block
        session.onConfirmationOutcome?.(
          routerResult.requestId,
          "resolved_stale",
        );
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
      await addMessage(
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
      await addMessage(
        msg.sessionId,
        "assistant",
        JSON.stringify(consumedAssistantMessage.content),
        consumedChannelMeta,
      );
      if (!session.isProcessing()) {
        session.messages.push(consumedUserMessage, consumedAssistantMessage);
      }

      ctx.send({
        type: "message_queued",
        sessionId: msg.sessionId,
        requestId,
        position: 0,
      });
      ctx.send({
        type: "message_dequeued",
        sessionId: msg.sessionId,
        requestId,
      });

      if (!session.isProcessing()) {
        ctx.send({
          type: "assistant_text_delta",
          text: replyText,
          sessionId: msg.sessionId,
        });
      }
      ctx.send({
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
      return true;
    }
  } catch (err) {
    rlog.warn(
      { err },
      "Failed to process pending-confirmation reply; falling back to auto-deny behavior",
    );
  }

  return false;
}

// ── Auto-deny pending confirmations ──────────────────────────────────
function autoDenyPendingConfirmations(
  msg: UserMessage,
  requestId: string,
  session: Session,
  rlog: typeof log,
): void {
  if (!session.hasAnyPendingConfirmation()) return;

  rlog.info("Auto-denying pending confirmation(s) due to new user message");
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
      // Notify agent loop so the outcome is persisted on the tool_use block
      session.onConfirmationOutcome?.(interaction.requestId, "denied");
    }
  }
  session.denyAllPendingConfirmations();
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

// ── Dispatch user message function type ──────────────────────────────
type DispatchUserMessageFn = (
  content: string,
  attachments: UserMessageAttachment[],
  dispatchRequestId: string,
  source: "user_message" | "secure_redirect_resume",
  activeSurfaceId?: string,
  currentPage?: string,
  displayContent?: string,
) => void;

// ── Build dispatch function ──────────────────────────────────────────
// Creates the dispatchUserMessage closure used to enqueue or immediately
// process a user message through the session.
function buildDispatchUserMessage(params: {
  msg: UserMessage;
  session: Session;
  sendEvent: (event: ServerMessage) => void;
  ipcChannel: ChannelId;
  ipcInterface: InterfaceId;
  ctx: HandlerContext;
  rlog: typeof log;
}): DispatchUserMessageFn {
  const {
    msg,
    session,
    sendEvent,
    ipcChannel,
    ipcInterface,
    ctx,
    rlog,
  } = params;

  const queuedChannelMetadata = {
    userMessageChannel: ipcChannel,
    assistantMessageChannel: ipcChannel,
    userMessageInterface: ipcInterface,
    assistantMessageInterface: ipcInterface,
  };

  return (
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
      ctx.send({
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
    session.setTrustContext(resolveLocalIpcTrustContext(ipcChannel));
    session.setAuthContext(resolveLocalIpcAuthContext(msg.sessionId));
    session.setCommandIntent(null);
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
        ctx.send({
          type: "error",
          message: `Failed to process message: ${message}`,
        });
        const classified = classifySessionError(err, { phase: "agent_loop" });
        ctx.send( buildSessionErrorMessage(msg.sessionId, classified));
      });
  };
}

export async function handleUserMessage(
  msg: UserMessage,
  ctx: HandlerContext,
): Promise<void> {
  const requestId = uuid();
  const rlog = log.child({ sessionId: msg.sessionId, requestId });
  try {
    const session = await ctx.getOrCreateSession(msg.sessionId);
    // Only wire the escalation handler if one isn't already set — handleTaskSubmit
    // sets a handler with the client's actual screen dimensions, and overwriting it
    // here would replace those dimensions with the daemon's defaults.
    if (!session.hasEscalationHandler()) {
      wireEscalationHandler(session, ctx);
    }

    const ipcChannel = parseChannelId(msg.channel) ?? "vellum";
    const sendEvent = makeIpcEventSender({
      ctx,
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
      ctx.send({
        type: "error",
        message:
          "Invalid user_message: interface is required and must be valid",
      });
      return;
    }

    // Update channel capabilities eagerly so both immediate and queued paths
    // reflect the latest PTT / microphone state from the client.
    session.setChannelCapabilities(
      resolveChannelCapabilities(ipcChannel, ipcInterface, {
        pttActivationKey: msg.pttActivationKey,
        microphonePermissionGranted: msg.microphonePermissionGranted,
      }),
    );

    const dispatchUserMessage = buildDispatchUserMessage({
      msg,
      session,
      sendEvent,
      ipcChannel,
      ipcInterface,
      ctx,
      rlog,
    });

    let messageText = msg.content ?? "";

    // Block inbound messages that contain secrets and redirect to secure prompt
    if (
      handleSecretIngress(
        msg,
        messageText,
        ctx,
        session,
        rlog,
        dispatchUserMessage,
      )
    ) {
      return;
    }

    // ── Structured command intent (bypasses text parsing) ──────────────────
    if (
      await handleStructuredRecordingIntent(
        msg,
        messageText,
        session,
        ctx,
        rlog,
      )
    ) {
      return;
    }

    // ── Standalone recording intent interception ──────────────────────────
    const recordingResult = await handleStandaloneRecordingIntent(
      msg,
      messageText,
      session,
      ctx,
      rlog,
    );
    if (recordingResult.handled) return;
    messageText = recordingResult.updatedMessageText;
    const originalContentBeforeStrip =
      recordingResult.originalContentBeforeStrip;

    // ── Pending confirmation reply interception ───────────────────────────
    if (
      await handlePendingConfirmationReply(
        msg,
        messageText,
        requestId,
        session,
        ipcChannel,
        ipcInterface,
        ctx,
        rlog,
      )
    ) {
      return;
    }

    // ── Auto-deny pending confirmations ───────────────────────────────────
    autoDenyPendingConfirmations(msg, requestId, session, rlog);

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
    ctx.send( {
      type: "error",
      message: `Failed to process message: ${message}`,
    });
    const classified = classifySessionError(err, { phase: "handler" });
    ctx.send( buildSessionErrorMessage(msg.sessionId, classified));
  }
}
