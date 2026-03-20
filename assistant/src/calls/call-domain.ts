/**
 * Shared domain functions for call operations.
 *
 * Both the tool implementations and the HTTP route handlers delegate
 * to these functions so business logic lives in one place.
 */

import { loadConfig } from "../config/loader.js";
import { VALID_CALLER_IDENTITY_MODES } from "../config/schema.js";
import type { AssistantConfig } from "../config/types.js";
import { resolveCallbackUrl } from "../inbound/platform-callback-registration.js";
import {
  getTwilioStatusCallbackUrl,
  getTwilioVoiceWebhookUrl,
} from "../inbound/public-ingress-urls.js";
import { getConversation } from "../memory/conversation-crud.js";
import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import { queueGenerateConversationTitle } from "../memory/conversation-title-service.js";
import { upsertBinding } from "../memory/external-conversation-store.js";
import { revokeScopedApprovalGrantsForContext } from "../memory/scoped-approval-grants.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { isGuardian } from "../runtime/channel-verification-service.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { upsertActiveCallLease } from "./active-call-lease.js";
import { isDeniedNumber } from "./call-constants.js";
import { addPointerMessage } from "./call-pointer-messages.js";
import { getCallController, unregisterCallController } from "./call-state.js";
import { isTerminalState } from "./call-state-machine.js";
import {
  answerPendingQuestion,
  createCallSession,
  expirePendingQuestions,
  getActiveCallSessionForConversation,
  getCallSession,
  getCallSessionByCallSid,
  getPendingQuestion,
  updateCallSession,
} from "./call-store.js";
import { activeRelayConnections } from "./relay-server.js";
import { getTwilioConfig } from "./twilio-config.js";
import { TwilioConversationRelayProvider } from "./twilio-provider.js";
import type { CallSession } from "./types.js";
import { preflightVoiceIngress } from "./voice-ingress-preflight.js";

const log = getLogger("call-domain");

const E164_REGEX = /^\+\d+$/;

function postFailedCallPointer(
  conversationId: string,
  phoneNumber: string,
  reason: string,
): void {
  addPointerMessage(conversationId, "failed", phoneNumber, {
    reason,
  }).catch((pointerErr) => {
    log.warn(
      { conversationId, err: pointerErr },
      "Failed to post call-failed pointer message",
    );
  });
}

// ── Result types ─────────────────────────────────────────────────────

export interface StartCallResult {
  ok: true;
  session: CallSession;
  callSid: string;
  callerIdentityMode: "assistant_number" | "user_number";
}

export interface CallError {
  ok: false;
  error: string;
  status?: number;
}

export type StartCallInput = {
  phoneNumber: string;
  task: string;
  context?: string;
  conversationId: string;
  assistantId?: string;
  callerIdentityMode?: "assistant_number" | "user_number";
  skipDisclosure?: boolean;
};

export type CancelCallInput = {
  callSessionId: string;
  reason?: string;
};

export type AnswerCallInput = {
  callSessionId: string;
  answer: string;
  /** When provided, the answer is matched to this specific pending question/consultation. */
  pendingQuestionId?: string;
};

export type RelayInstructionInput = {
  callSessionId: string;
  instructionText: string;
};

// ── Caller identity resolution ───────────────────────────────────────

export type CallerIdentitySource =
  | "per_call_override"
  | "implicit_default"
  | "user_config"
  | "secure_key";

export type CallerIdentityResult =
  | {
      ok: true;
      mode: "assistant_number" | "user_number";
      fromNumber: string;
      source: CallerIdentitySource;
    }
  | { ok: false; error: string };

/**
 * Resolve which phone number to use as the caller ID for an outbound call.
 *
 * Policy: implicit calls (no explicit mode) always use `assistant_number`.
 * `user_number` is only used when explicitly requested per call.
 *
 * - If `requestedMode` is provided and per-call overrides are allowed, use it.
 * - If `requestedMode` is provided but overrides are disabled, return an error.
 * - Otherwise, always use `assistant_number` (implicit default).
 *
 * For `assistant_number`: uses the Twilio phone number from
 *   `getTwilioConfig()`. No eligibility check is performed — this is a fast path.
 * For `user_number`: uses `config.calls.callerIdentity.userNumber` or the
 *   secure key `credential/twilio/user_phone_number`, then validates that the
 *   number is usable as an outbound caller ID via the Twilio API.
 */
export async function resolveCallerIdentity(
  config: AssistantConfig,
  requestedMode?: "assistant_number" | "user_number",
): Promise<CallerIdentityResult> {
  const identityConfig = config.calls.callerIdentity;
  let mode: "assistant_number" | "user_number";
  let source: CallerIdentitySource;

  if (requestedMode != null) {
    if (
      !(VALID_CALLER_IDENTITY_MODES as readonly string[]).includes(
        requestedMode,
      )
    ) {
      return {
        ok: false,
        error: `Invalid callerIdentityMode: "${requestedMode}". Must be one of: ${VALID_CALLER_IDENTITY_MODES.join(
          ", ",
        )}`,
      };
    }
    if (!identityConfig.allowPerCallOverride) {
      log.warn(
        { requestedMode },
        "Caller identity override rejected — per-call override is disabled in configuration",
      );
      return {
        ok: false,
        error: "Per-call caller identity override is disabled in configuration",
      };
    }
    mode = requestedMode;
    source = "per_call_override";
  } else {
    // Implicit calls always use assistant_number regardless of config
    mode = "assistant_number";
    source = "implicit_default";
  }

  if (mode === "assistant_number") {
    const twilioConfig = await getTwilioConfig();
    log.info(
      { mode, source, fromNumber: twilioConfig.phoneNumber },
      "Resolved caller identity",
    );
    return { ok: true, mode, fromNumber: twilioConfig.phoneNumber, source };
  }

  // user_number mode: resolve from config or secure key, tracking where the number came from
  let userNumber = "";
  let numberSource: CallerIdentitySource = source;

  if (identityConfig.userNumber) {
    userNumber = identityConfig.userNumber;
    numberSource = "user_config";
  } else {
    const secureKeyValue = await getSecureKeyAsync(
      credentialKey("twilio", "user_phone_number"),
    );
    if (secureKeyValue) {
      userNumber = secureKeyValue;
      numberSource = "secure_key";
    }
  }

  if (!userNumber) {
    log.warn(
      { mode, source },
      "Caller identity resolution failed — no user phone number configured",
    );
    return {
      ok: false,
      error:
        "user_number mode requires a user phone number. Set calls.callerIdentity.userNumber in config or store credential/twilio/user_phone_number via the credential_store tool.",
    };
  }

  if (!E164_REGEX.test(userNumber)) {
    log.warn(
      { mode, source: numberSource, userNumber },
      "User phone number is not in E.164 format",
    );
    return {
      ok: false,
      error: `User phone number "${userNumber}" is not in E.164 format (must start with + followed by digits, e.g. +14155551234). Check calls.callerIdentity.userNumber in config or credential/twilio/user_phone_number.`,
    };
  }

  // Verify the user number is eligible as a caller ID with Twilio
  const provider = new TwilioConversationRelayProvider();
  const eligibility = await provider.checkCallerIdEligibility(userNumber);
  if (!eligibility.eligible) {
    log.warn(
      { mode, source: numberSource, userNumber, reason: eligibility.reason },
      "Caller ID eligibility check failed",
    );
    return { ok: false, error: eligibility.reason! };
  }

  log.info(
    { mode, source: numberSource, fromNumber: userNumber },
    "Resolved caller identity",
  );
  return { ok: true, mode, fromNumber: userNumber, source: numberSource };
}

// ── Inbound voice session bootstrap ──────────────────────────────────

export type CreateInboundVoiceSessionInput = {
  callSid: string;
  fromNumber: string;
  toNumber: string;
  assistantId?: string;
};

export type CreateInboundVoiceSessionResult = {
  session: CallSession;
  created: boolean;
};

/**
 * Create (or reuse) a voice call session for an inbound call identified
 * by its Twilio CallSid.
 *
 * Idempotent: if a session already exists for the given CallSid, it is
 * returned without creating a duplicate. This handles Twilio webhook
 * replays gracefully.
 */
export function createInboundVoiceSession(
  input: CreateInboundVoiceSessionInput,
): CreateInboundVoiceSessionResult {
  const {
    callSid,
    fromNumber,
    toNumber,
    assistantId = DAEMON_INTERNAL_ASSISTANT_ID,
  } = input;

  // Check if a session already exists for this CallSid (replay protection)
  const existing = getCallSessionByCallSid(callSid);
  if (existing) {
    log.info(
      { callSid, callSessionId: existing.id },
      "Reusing existing session for inbound CallSid",
    );
    return { session: existing, created: false };
  }

  // Create a dedicated voice conversation keyed by CallSid so inbound calls
  // get their own conversation.
  const voiceConvKey =
    assistantId && assistantId !== DAEMON_INTERNAL_ASSISTANT_ID
      ? `asst:${assistantId}:voice:inbound:${callSid}`
      : `voice:inbound:${callSid}`;
  const { conversationId: voiceConversationId } =
    getOrCreateConversation(voiceConvKey);

  upsertBinding({
    conversationId: voiceConversationId,
    sourceChannel: "phone",
    externalChatId: callSid,
  });

  const session = createCallSession({
    conversationId: voiceConversationId,
    provider: "twilio",
    fromNumber,
    toNumber,
  });

  updateCallSession(session.id, { providerCallSid: callSid });
  session.providerCallSid = callSid;

  const callerIsGuardian = isGuardian(assistantId, "phone", fromNumber);
  const metadataHints: string[] = [
    callerIsGuardian
      ? "Caller is the guardian"
      : "Caller is not the guardian (external caller)",
    `Timestamp: ${new Date().toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`,
  ];

  queueGenerateConversationTitle({
    conversationId: voiceConversationId,
    context: {
      origin: "voice_inbound",
      sourceChannel: "phone",
      assistantId,
      systemHint: `Inbound call from ${fromNumber}`,
      metadataHints,
    },
  });

  log.info(
    {
      callSessionId: session.id,
      callSid,
      voiceConversationId,
      from: fromNumber,
      to: toNumber,
      assistantId,
    },
    "Created new inbound voice session",
  );

  return { session, created: true };
}

// ── Domain operations ────────────────────────────────────────────────

/**
 * Initiate a new outbound call.
 */
export async function startCall(
  input: StartCallInput,
): Promise<StartCallResult | CallError> {
  const {
    phoneNumber,
    task,
    context: callContext,
    conversationId,
    callerIdentityMode,
    skipDisclosure,
    assistantId = DAEMON_INTERNAL_ASSISTANT_ID,
  } = input;

  if (!phoneNumber || typeof phoneNumber !== "string") {
    return {
      ok: false,
      error: "phone_number is required and must be a string",
      status: 400,
    };
  }

  if (!E164_REGEX.test(phoneNumber)) {
    return {
      ok: false,
      error:
        "phone_number must be in E.164 format (starts with + followed by digits, e.g. +14155551234)",
      status: 400,
    };
  }

  if (!task || typeof task !== "string" || task.trim().length === 0) {
    return {
      ok: false,
      error: "task is required and must be a non-empty string",
      status: 400,
    };
  }

  if (isDeniedNumber(phoneNumber)) {
    return {
      ok: false,
      error: "This phone number is not allowed to be called",
      status: 403,
    };
  }

  let sessionId: string | null = null;

  try {
    const config = loadConfig();

    // Resolve which phone number to use as caller ID
    const identityResult = await resolveCallerIdentity(
      config,
      callerIdentityMode,
    );
    if (!identityResult.ok) {
      return { ok: false, error: identityResult.error, status: 400 };
    }
    const fromNumber = identityResult.fromNumber;

    if (!getConversation(conversationId)) {
      return {
        ok: false,
        error: `Invalid conversationId: no conversation found with ID ${conversationId}`,
        status: 400,
      };
    }

    const preflightResult = await preflightVoiceIngress();
    if (!preflightResult.ok) {
      postFailedCallPointer(conversationId, phoneNumber, preflightResult.error);
      return preflightResult;
    }

    const ingressConfig = preflightResult.ingressConfig;
    const provider = new TwilioConversationRelayProvider();

    const session = createCallSession({
      conversationId,
      provider: "twilio",
      fromNumber,
      toNumber: phoneNumber,
      task: callContext ? `${task}\n\nContext: ${callContext}` : task,
      callerIdentityMode: identityResult.mode,
      callerIdentitySource: identityResult.source,
      skipDisclosure,
      initiatedFromConversationId: conversationId,
    });
    sessionId = session.id;

    // Create a dedicated voice conversation for this call so that voice
    // transcripts live in their own conversation, separate from the chat that
    // triggered the call.
    const voiceConvKey = assistantId
      ? `asst:${assistantId}:voice:call:${session.id}`
      : `voice:call:${session.id}`;
    const { conversationId: voiceConversationId } =
      getOrCreateConversation(voiceConvKey);

    upsertBinding({
      conversationId: voiceConversationId,
      sourceChannel: "phone",
      externalChatId: session.id,
    });

    // Point the call session at the new voice conversation; the original
    // chat is preserved in initiatedFromConversationId.
    updateCallSession(session.id, {
      conversationId: voiceConversationId,
    });
    session.conversationId = voiceConversationId;

    queueGenerateConversationTitle({
      conversationId: voiceConversationId,
      context: {
        origin: "voice_outbound",
        sourceChannel: "phone",
        assistantId,
        systemHint: `Outbound call to ${phoneNumber}`,
        triggerTextSnippet: task,
        metadataHints: [
          `Timestamp: ${new Date().toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}`,
        ],
      },
    });

    log.info(
      {
        callSessionId: session.id,
        voiceConversationId,
        initiatedFrom: conversationId,
        to: phoneNumber,
        from: fromNumber,
        task,
      },
      "Initiating outbound call",
    );

    const webhookUrl = await resolveCallbackUrl(
      () => getTwilioVoiceWebhookUrl(ingressConfig, session.id),
      "webhooks/twilio/voice",
      "twilio_voice",
      { callSessionId: session.id },
    );
    const statusCallbackUrl = await resolveCallbackUrl(
      () => getTwilioStatusCallbackUrl(ingressConfig),
      "webhooks/twilio/status",
      "twilio_status",
    );

    upsertActiveCallLease({ callSessionId: session.id });

    const { callSid } = await provider.initiateCall({
      from: fromNumber,
      to: phoneNumber,
      webhookUrl,
      statusCallbackUrl,
    });

    updateCallSession(session.id, { providerCallSid: callSid });

    log.info(
      { callSessionId: session.id, callSid },
      "Call initiated successfully",
    );

    // Post a concise pointer message in the initiating conversation
    addPointerMessage(conversationId, "started", phoneNumber).catch((err) => {
      log.warn(
        { conversationId, err },
        "Failed to post call-started pointer message",
      );
    });

    return {
      ok: true,
      session: { ...session, providerCallSid: callSid },
      callSid,
      callerIdentityMode: identityResult.mode,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, phoneNumber }, "Failed to initiate call");

    // FK constraint failure on conversation_id means the conversationId is invalid
    if (
      err instanceof Error &&
      msg.includes("FOREIGN KEY constraint failed") &&
      !sessionId
    ) {
      return {
        ok: false,
        error: `Invalid conversationId: no conversation found with ID ${conversationId}`,
        status: 400,
      };
    }

    if (sessionId) {
      updateCallSession(sessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: msg,
      });
    }

    postFailedCallPointer(conversationId, phoneNumber, msg);

    return { ok: false, error: `Error initiating call: ${msg}`, status: 500 };
  }
}

/**
 * Get the status of a call session. If no callSessionId is provided,
 * looks up the active call for the given conversationId.
 */
export function getCallStatus(
  callSessionId?: string,
  conversationId?: string,
):
  | {
      ok: true;
      session: CallSession;
      pendingQuestion?: { id: string; questionText: string };
    }
  | CallError {
  let session: CallSession | null = null;

  if (callSessionId) {
    session = getCallSession(callSessionId);
    if (!session) {
      return {
        ok: false,
        error: `No call session found with ID ${callSessionId}`,
        status: 404,
      };
    }
  } else if (conversationId) {
    session = getActiveCallSessionForConversation(conversationId);
    if (!session) {
      return {
        ok: false,
        error: "No active call found in the current conversation",
        status: 404,
      };
    }
  } else {
    return {
      ok: false,
      error: "Either callSessionId or conversationId is required",
      status: 400,
    };
  }

  log.info(
    { callSessionId: session.id, status: session.status },
    "Checking call status",
  );

  const pendingQuestion = getPendingQuestion(session.id);
  return {
    ok: true,
    session,
    pendingQuestion: pendingQuestion
      ? { id: pendingQuestion.id, questionText: pendingQuestion.questionText }
      : undefined,
  };
}

/**
 * Cancel an active call. Cleans up relay connections and controllers.
 */
export async function cancelCall(
  input: CancelCallInput,
): Promise<{ ok: true; session: CallSession } | CallError> {
  const { callSessionId, reason } = input;

  const session = getCallSession(callSessionId);
  if (!session) {
    return {
      ok: false,
      error: `No call session found with ID ${callSessionId}`,
      status: 404,
    };
  }

  if (isTerminalState(session.status)) {
    return {
      ok: false,
      error: `Call session ${callSessionId} has already ended with status: ${session.status}`,
      status: 409,
    };
  }

  log.info({ callSessionId, reason }, "Cancelling call");

  // Terminate the call via the provider API
  if (session.providerCallSid) {
    try {
      const provider = new TwilioConversationRelayProvider();
      await provider.endCall(session.providerCallSid);
    } catch (endErr) {
      log.warn(
        { err: endErr, callSessionId, callSid: session.providerCallSid },
        "Failed to terminate call via provider API — proceeding with cleanup",
      );
    }
  }

  // End the relay connection if active
  const relayConnection = activeRelayConnections.get(callSessionId);
  if (relayConnection) {
    relayConnection.endSession(reason);
    relayConnection.destroy();
    activeRelayConnections.delete(callSessionId);
  }

  // Clean up controller
  const controller = getCallController(callSessionId);
  if (controller) {
    controller.destroy();
    unregisterCallController(callSessionId);
  }

  // Update session status
  updateCallSession(callSessionId, {
    status: "cancelled",
    endedAt: Date.now(),
  });

  // Expire any pending questions so they don't linger
  expirePendingQuestions(callSessionId);

  // Revoke any scoped approval grants bound to this call session.
  // Revoke by both callSessionId and conversationId because the
  // guardian-approval-interception minting path sets callSessionId: null
  // but always sets conversationId.
  try {
    revokeScopedApprovalGrantsForContext({ callSessionId });
    revokeScopedApprovalGrantsForContext({
      conversationId: session.conversationId,
    });
  } catch (err) {
    log.warn(
      { err, callSessionId },
      "Failed to revoke scoped grants on call cancel",
    );
  }

  // Re-check final status: a concurrent transition (e.g. Twilio callback) may have
  // moved the session to a terminal state before our update, causing it to be skipped.
  const updated = getCallSession(callSessionId);
  if (updated && updated.status !== "cancelled") {
    log.warn(
      { callSessionId, finalStatus: updated.status },
      "Cancel lost race — session already transitioned to terminal state",
    );
    return {
      ok: false,
      error: `Call session ${callSessionId} transitioned to ${updated.status} before cancellation could be applied`,
      status: 409,
    };
  }

  log.info({ callSessionId }, "Call cancelled successfully");

  return {
    ok: true,
    session: updated ?? {
      ...session,
      status: "cancelled",
      endedAt: Date.now(),
    },
  };
}

/**
 * Answer a pending question for an active call.
 *
 * When `pendingQuestionId` is provided, the answer is matched to that specific
 * pending question/consultation rather than relying on transient controller
 * state. This allows answers to arrive while the call is active and not paused,
 * as long as the referenced question is still pending.
 */
export async function answerCall(
  input: AnswerCallInput,
): Promise<{ ok: true; questionId: string } | CallError> {
  const { callSessionId, answer, pendingQuestionId } = input;

  if (!answer || typeof answer !== "string") {
    return { ok: false, error: "Missing answer", status: 400 };
  }

  const controller = getCallController(callSessionId);
  if (!controller) {
    log.warn(
      { callSessionId },
      "answerCall: no active controller for call session",
    );
    return {
      ok: false,
      error: "No active controller for this call",
      status: 409,
    };
  }

  // When a specific question is targeted, validate it matches the active
  // consultation. This prevents stale or duplicate answers from being
  // applied to the wrong consultation.
  if (pendingQuestionId) {
    const activeQuestionId = controller.getPendingConsultationQuestionId();
    if (!activeQuestionId) {
      log.warn(
        { callSessionId, pendingQuestionId },
        "answerCall: pendingQuestionId provided but no consultation is active",
      );
      return {
        ok: false,
        error: "Referenced question is no longer pending",
        status: 409,
      };
    }
    if (activeQuestionId !== pendingQuestionId) {
      log.warn(
        { callSessionId, pendingQuestionId, activeQuestionId },
        "answerCall: pendingQuestionId does not match active consultation",
      );
      return {
        ok: false,
        error:
          "Referenced question is stale — a newer consultation has superseded it",
        status: 409,
      };
    }
  }

  // Look up the pending question in the store for record-keeping
  const question = getPendingQuestion(callSessionId);
  if (!question) {
    return { ok: false, error: "No pending question found", status: 404 };
  }

  // When pendingQuestionId is given, double-check it matches the store record
  if (pendingQuestionId && question.id !== pendingQuestionId) {
    log.warn(
      { callSessionId, pendingQuestionId, storeQuestionId: question.id },
      "answerCall: store pending question does not match requested pendingQuestionId",
    );
    return { ok: false, error: "Referenced question is stale", status: 409 };
  }

  const accepted = await controller.handleUserAnswer(answer);
  if (!accepted) {
    log.warn(
      { callSessionId },
      "answerCall: controller rejected the answer (no pending consultation)",
    );
    return {
      ok: false,
      error: "Controller is not waiting for an answer",
      status: 409,
    };
  }

  answerPendingQuestion(question.id, answer);

  return { ok: true, questionId: question.id };
}

/**
 * Relay a user instruction to an active call's controller.
 * Validates that the call is active and the instruction is non-empty
 * before injecting it into the controller's conversation.
 */
export async function relayInstruction(
  input: RelayInstructionInput,
): Promise<{ ok: true } | CallError> {
  const { callSessionId, instructionText } = input;

  if (
    !instructionText ||
    typeof instructionText !== "string" ||
    instructionText.trim().length === 0
  ) {
    return {
      ok: false,
      error: "instructionText is required and must be a non-empty string",
      status: 400,
    };
  }

  const session = getCallSession(callSessionId);
  if (!session) {
    return {
      ok: false,
      error: `No call session found with ID ${callSessionId}`,
      status: 404,
    };
  }

  if (isTerminalState(session.status)) {
    return {
      ok: false,
      error: `Call session ${callSessionId} is not active (status: ${session.status})`,
      status: 409,
    };
  }

  const controller = getCallController(callSessionId);
  if (!controller) {
    return {
      ok: false,
      error: "No active controller for this call",
      status: 409,
    };
  }

  await controller.handleUserInstruction(instructionText);

  log.info({ callSessionId }, "User instruction relayed to controller");

  return { ok: true };
}

// ── Verification call ─────────────────────────────────────────────────

export type StartVerificationCallInput = {
  phoneNumber: string;
  verificationSessionId: string;
  assistantId?: string;
  /** Origin conversation ID so completion/failure pointers can route back. */
  originConversationId?: string;
};

export type StartVerificationCallResult =
  | { ok: true; callSessionId: string; callSid: string }
  | CallError;

/**
 * Initiate an outbound call to the guardian's phone for verification.
 *
 * Creates a minimal call session with a voice channel binding and
 * passes `verificationSessionId` as a custom parameter so the
 * relay server can detect this is a guardian verification call.
 */
export async function startVerificationCall(
  input: StartVerificationCallInput,
): Promise<StartVerificationCallResult> {
  const { phoneNumber, verificationSessionId, originConversationId } = input;

  if (!phoneNumber || !E164_REGEX.test(phoneNumber)) {
    return {
      ok: false,
      error: "phone_number must be in E.164 format",
      status: 400,
    };
  }

  let sessionId: string | null = null;

  try {
    const config = loadConfig();
    const provider = new TwilioConversationRelayProvider();

    // Resolve the assistant's Twilio number as the caller ID
    const identityResult = await resolveCallerIdentity(config);
    if (!identityResult.ok) {
      return { ok: false, error: identityResult.error, status: 400 };
    }

    const preflightResult = await preflightVoiceIngress();
    if (!preflightResult.ok) {
      return preflightResult;
    }
    const ingressConfig = preflightResult.ingressConfig;

    // Create a minimal conversation so the call session has a valid FK,
    // and bind it to the voice channel so it never appears as an unbound
    // desktop conversation.
    const convKey = `guardian-verify:${verificationSessionId}`;
    const { conversationId } = getOrCreateConversation(convKey);

    upsertBinding({
      conversationId,
      sourceChannel: "phone",
      externalChatId: `guardian-verify:${verificationSessionId}`,
    });

    const session = createCallSession({
      conversationId,
      provider: "twilio",
      fromNumber: identityResult.fromNumber,
      toNumber: phoneNumber,
      callMode: "verification",
      verificationSessionId,
      initiatedFromConversationId: originConversationId,
    });
    sessionId = session.id;

    const webhookUrl = await resolveCallbackUrl(
      () => getTwilioVoiceWebhookUrl(ingressConfig, session.id),
      "webhooks/twilio/voice",
      "twilio_voice",
      { callSessionId: session.id },
    );
    const statusCallbackUrl = await resolveCallbackUrl(
      () => getTwilioStatusCallbackUrl(ingressConfig),
      "webhooks/twilio/status",
      "twilio_status",
    );

    upsertActiveCallLease({ callSessionId: session.id });

    const { callSid } = await provider.initiateCall({
      from: identityResult.fromNumber,
      to: phoneNumber,
      webhookUrl,
      statusCallbackUrl,
      customParams: {
        verificationSessionId,
      },
    });

    updateCallSession(session.id, { providerCallSid: callSid });

    log.info(
      {
        callSessionId: session.id,
        callSid,
        verificationSessionId,
        to: phoneNumber,
      },
      "Guardian verification call initiated",
    );

    return { ok: true, callSessionId: session.id, callSid };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { err, phoneNumber, verificationSessionId },
      "Failed to initiate guardian verification call",
    );

    if (sessionId) {
      updateCallSession(sessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: msg,
      });
    }

    return {
      ok: false,
      error: `Error initiating guardian verification call: ${msg}`,
      status: 500,
    };
  }
}

// ── Invite call ───────────────────────────────────────────────────────

export type StartInviteCallInput = {
  phoneNumber: string;
  friendName: string;
  guardianName: string;
  assistantId?: string;
};

export type StartInviteCallResult = { ok: true; callSid: string } | CallError;

/**
 * Initiate an outbound call to deliver a voice invite to a contact.
 *
 * Creates a minimal call session with a voice channel binding and
 * passes invite-specific custom parameters so the relay server can
 * detect this is an invite redemption call.
 */
export async function startInviteCall(
  input: StartInviteCallInput,
): Promise<StartInviteCallResult> {
  const { phoneNumber, friendName, guardianName } = input;

  if (!phoneNumber || !E164_REGEX.test(phoneNumber)) {
    return {
      ok: false,
      error: "phone_number must be in E.164 format",
      status: 400,
    };
  }

  let sessionId: string | null = null;

  try {
    const config = loadConfig();
    const provider = new TwilioConversationRelayProvider();

    // Resolve the assistant's Twilio number as the caller ID
    const identityResult = await resolveCallerIdentity(config);
    if (!identityResult.ok) {
      return { ok: false, error: identityResult.error, status: 400 };
    }

    const preflightResult = await preflightVoiceIngress();
    if (!preflightResult.ok) {
      return preflightResult;
    }
    const ingressConfig = preflightResult.ingressConfig;

    // Create a minimal conversation so the call session has a valid FK,
    // and bind it to the voice channel so it never appears as an unbound
    // desktop conversation.
    const timestamp = Date.now();
    const convKey = `invite-call:${phoneNumber}:${timestamp}`;
    const { conversationId } = getOrCreateConversation(convKey);

    upsertBinding({
      conversationId,
      sourceChannel: "phone",
      externalChatId: `invite-call:${phoneNumber}:${timestamp}`,
    });

    const session = createCallSession({
      conversationId,
      provider: "twilio",
      fromNumber: identityResult.fromNumber,
      toNumber: phoneNumber,
      callMode: "invite",
      inviteFriendName: friendName,
      inviteGuardianName: guardianName,
      initiatedFromConversationId: conversationId,
    });
    sessionId = session.id;

    const webhookUrl = await resolveCallbackUrl(
      () => getTwilioVoiceWebhookUrl(ingressConfig, session.id),
      "webhooks/twilio/voice",
      "twilio_voice",
      { callSessionId: session.id },
    );
    const statusCallbackUrl = await resolveCallbackUrl(
      () => getTwilioStatusCallbackUrl(ingressConfig),
      "webhooks/twilio/status",
      "twilio_status",
    );

    upsertActiveCallLease({ callSessionId: session.id });

    const { callSid } = await provider.initiateCall({
      from: identityResult.fromNumber,
      to: phoneNumber,
      webhookUrl,
      statusCallbackUrl,
    });

    updateCallSession(session.id, { providerCallSid: callSid });

    log.info(
      {
        callSessionId: session.id,
        callSid,
        to: phoneNumber,
        friendName,
        guardianName,
      },
      "Invite call initiated",
    );

    return { ok: true, callSid };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { err, phoneNumber, friendName, guardianName },
      "Failed to initiate invite call",
    );

    if (sessionId) {
      updateCallSession(sessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: msg,
      });
    }

    return {
      ok: false,
      error: `Error initiating invite call: ${msg}`,
      status: 500,
    };
  }
}
