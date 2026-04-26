/**
 * Bridge between voice relay and the daemon conversation pipeline.
 *
 * Provides a `startVoiceTurn()` function that manages a voice turn
 * directly through the conversation, translating agent-loop events into
 * simple callbacks suitable for real-time TTS streaming.
 *
 * Dependency injection follows the same module-level setter pattern used by
 * setRelayBroadcast in relay-server.ts: the daemon lifecycle injects
 * dependencies at startup via `setVoiceBridgeDeps()`.
 */

import { consumeGrantForInvocation } from "../approvals/approval-primitive.js";
import type {
  ChannelId,
  InterfaceId,
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import type { Conversation } from "../daemon/conversation.js";
import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import { resolveChannelCapabilities } from "../daemon/conversation-runtime-assembly.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import {
  CALL_OPENING_MARKER,
  CALL_VERIFICATION_COMPLETE_MARKER,
} from "./voice-control-protocol.js";

const log = getLogger("voice-session-bridge");

// ---------------------------------------------------------------------------
// Module-level dependency injection
// ---------------------------------------------------------------------------

export interface VoiceBridgeDeps {
  getOrCreateConversation: (
    conversationId: string,
    transport?: {
      channelId: ChannelId;
      hints?: string[];
      uxBrief?: string;
    },
  ) => Promise<Conversation>;
  resolveAttachments: (attachmentIds: string[]) => Array<{
    id: string;
    filename: string;
    mimeType: string;
    data: string;
    filePath?: string;
  }>;
}

let deps: VoiceBridgeDeps | undefined;

/**
 * Inject dependencies from daemon lifecycle.
 * Must be called during daemon startup before any voice turns are executed.
 */
export function setVoiceBridgeDeps(d: VoiceBridgeDeps): void {
  deps = d;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Real-time event sink for voice TTS streaming. Agent-loop events are
 * forwarded here for real-time text-to-speech without modifying the
 * standard channel path.
 */
export interface VoiceRunEventSink {
  onTextDelta(
    msg: Extract<ServerMessage, { type: "assistant_text_delta" }>,
  ): void;
  onMessageComplete(
    msg: Extract<
      ServerMessage,
      { type: "message_complete" } | { type: "generation_cancelled" }
    >,
  ): void;
  onError(message: string): void;
  onToolUse(toolName: string, input: Record<string, unknown>): void;
}

export interface VoiceTurnCallbacks {
  assistant_text_delta?: (
    msg: Extract<ServerMessage, { type: "assistant_text_delta" }>,
  ) => void;
  message_complete?: (
    msg: Extract<
      ServerMessage,
      { type: "message_complete" } | { type: "generation_cancelled" }
    >,
  ) => void;
  persisted_user_message_id?: (messageId: string) => void;
}

export interface VoiceTurnOptions {
  /** The conversation ID for this voice call's session. */
  conversationId: string;
  /** Voice session ID for scoped grant matching. Defaults to callSessionId. */
  voiceSessionId?: string;
  /** The call session ID for scoped grant matching. */
  callSessionId?: string;
  /** Source channel for persisted user messages. Defaults to phone. */
  userMessageChannel?: ChannelId;
  /** Source channel for persisted assistant messages. Defaults to userMessageChannel. */
  assistantMessageChannel?: ChannelId;
  /** Source interface for persisted user messages. Defaults to phone. */
  userMessageInterface?: InterfaceId;
  /** Source interface for persisted assistant messages. Defaults to userMessageInterface. */
  assistantMessageInterface?: InterfaceId;
  /** Per-turn control prompt. Undefined uses the phone prompt; null disables it. */
  voiceControlPrompt?: string | null;
  /** The transcribed caller utterance or synthetic marker. */
  content: string;
  /** Assistant scope for multi-assistant channels. */
  assistantId?: string;
  /** Guardian trust context for the caller. */
  trustContext?: TrustContext;
  /** Whether this is an inbound call (no outbound task). */
  isInbound: boolean;
  /** The outbound call task, if any. */
  task?: string | null;
  /** When true, skip the disclosure announcement for this call. */
  skipDisclosure?: boolean;
  /** Called for each streaming text token from the agent loop. */
  onTextDelta?: (text: string) => void;
  /** Called when the agent loop completes a full response. */
  onComplete?: () => void;
  /** Called when the agent loop encounters an error. */
  onError?: (message: string) => void;
  /** Event-name callbacks used by non-phone voice clients. */
  callbacks?: VoiceTurnCallbacks;
  /** Optional AbortSignal for external cancellation (e.g. barge-in). */
  signal?: AbortSignal;
}

export interface VoiceTurnHandle {
  /** Unique identifier for this turn. */
  turnId: string;
  /** Abort the in-flight turn (e.g. for barge-in). */
  abort: () => void;
}

// ---------------------------------------------------------------------------
// Call-control protocol prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the call-control protocol prompt injected into each voice turn.
 *
 * This contains the marker protocol rules that the model needs to emit
 * control markers during voice calls. It intentionally omits the "You are
 * on a live phone call" framing (the session system prompt already
 * provides assistant identity) and guardian context (injected separately).
 */
function buildVoiceCallControlPrompt(opts: {
  isInbound: boolean;
  task?: string | null;
  isCallerGuardian?: boolean;
  skipDisclosure?: boolean;
}): string {
  const config = getConfig();
  const disclosureEnabled =
    config.calls?.disclosure?.enabled === true && !opts.skipDisclosure;
  const disclosureText = config.calls?.disclosure?.text?.trim();
  const disclosureRule =
    disclosureEnabled && disclosureText
      ? opts.isInbound
        ? `0. ${disclosureText} This is an inbound call you are answering, so rewrite any disclosure naturally for pickup context. Do NOT say "I'm calling", "I called you", or "I'm calling on behalf of".`
        : `0. ${disclosureText}`
      : "0. Begin the conversation naturally.";

  const lines: string[] = ["<voice_call_control>"];

  if (!opts.isInbound && opts.task) {
    lines.push(`Task: ${opts.task}`);
    lines.push("");
  }

  lines.push(
    "CALL PROTOCOL RULES:",
    disclosureRule,
    "1. Be concise — keep responses to 1-3 sentences. Phone conversations should be brief and natural.",
    ...(opts.isCallerGuardian
      ? [
          "2. You are speaking directly with your guardian (your user). Do NOT use [ASK_GUARDIAN:]. If you need permission, information, or confirmation, ask them directly in the conversation. They can answer you right now.",
        ]
      : [
          [
            "2. You can consult your guardian in two ways:",
            "   - For general questions or information: [ASK_GUARDIAN: your question here]",
            '   - For tool/action permission requests: [ASK_GUARDIAN_APPROVAL: {"question":"Describe what you need permission for","toolName":"the_tool_name","input":{...tool input object...}}]',
            '   Use ASK_GUARDIAN_APPROVAL when you need permission to execute a specific tool or action. Use ASK_GUARDIAN for everything else (general questions, advice, information). When you use either marker, add a natural hold message like "Let me check on that for you."',
          ].join("\n"),
        ]),
  );

  if (opts.isInbound) {
    lines.push(
      "3. If information is provided preceded by [USER_ANSWERED: ...], use that answer naturally in the conversation.",
      "4. If you see [USER_INSTRUCTION: ...], treat it as a high-priority steering directive from your user. Follow the instruction immediately, adjusting your approach or response accordingly.",
      "5. When the caller indicates they are done or the conversation reaches a natural conclusion, include [END_CALL] in your response along with a polite goodbye.",
    );
  } else {
    lines.push(
      "3. If the callee provides information preceded by [USER_ANSWERED: ...], use that answer naturally in the conversation.",
      "4. If you see [USER_INSTRUCTION: ...], treat it as a high-priority steering directive from your user. Follow the instruction immediately, adjusting your approach or response accordingly.",
      "5. When the call's purpose is fulfilled, include [END_CALL] in your response along with a polite goodbye.",
    );
  }

  lines.push(
    '6. When caller text includes [SPEAKER id="..." label="..."], treat each speaker as a distinct person and personalize responses using that speaker\'s prior context in this call.',
  );

  if (opts.isInbound) {
    if (opts.isCallerGuardian) {
      lines.push(
        '7. If the latest user turn is "(call connected — deliver opening greeting)", this is your user calling you. Answer casually and briefly, like picking up a call from someone you know well. For example: "Hey!" or "What\'s up?" Do NOT introduce yourself, do NOT say you are calling on behalf of anyone, and do NOT ask how you can help in a formal way. Keep it short and natural.',
      );
    } else {
      lines.push(
        '7. If the latest user turn is "(call connected — deliver opening greeting)", this is an inbound call you are answering (not a call you initiated). Greet the caller warmly and ask how you can help. Introduce yourself once at the start using your assistant name if you know it (for example: "Hey there, this is Ava, Sam\'s assistant. How can I help?"). If your assistant name is not known, skip the name and just identify yourself as the guardian\'s assistant. Do NOT say "I\'m calling" or "I\'m calling on behalf of". Vary the wording; do not use a fixed template.',
      );
    }
    lines.push(
      "8. If the latest user turn includes [CALL_OPENING_ACK], treat it as the caller acknowledging your greeting and continue the conversation naturally.",
    );
  } else {
    const disclosureReminder =
      disclosureEnabled && disclosureText
        ? " However, the disclosure text from rule 0 is separate from self-introduction and must always be included in your opening greeting, even if the Task does not mention introducing yourself."
        : "";
    lines.push(
      '7. If the latest user turn is "(verification completed — transitioning into conversation)", the caller just completed a phone verification code challenge on this call. Greet them naturally and ask if there is anything you can help with. Keep it casual and brief.',
      `If the latest user turn is "(call connected — deliver opening greeting)", deliver your opening greeting based solely on the Task context above. The Task already describes how to open the call — follow it directly without adding any extra introduction on top. If the Task says to introduce yourself, do so once. If the Task does not mention introducing yourself, skip the introduction.${disclosureReminder} Vary the wording naturally; do not use a fixed template.`,
      "8. If the latest user turn includes [CALL_OPENING_ACK], treat it as the callee acknowledging your opener and continue the conversation naturally without re-introducing yourself or repeating the initial check-in question.",
    );
  }

  lines.push(
    "9. After the opening greeting turn, treat the Task field as background context only — do not re-execute its instructions on subsequent turns.",
    '10. Do not make up information. If you are unsure, use [ASK_GUARDIAN: your question] to consult your guardian. For tool permission requests, use [ASK_GUARDIAN_APPROVAL: {"question":"...","toolName":"...","input":{...}}].',
    `11. Your text is sent directly to a text-to-speech engine. Never use markdown formatting (asterisks, headers, backticks, links) or emojis in your spoken responses. Write plain conversational text only. Protocol markers like ${opts.isCallerGuardian ? "[END_CALL]" : "[ASK_GUARDIAN: ...] and [END_CALL]"} are not spoken text and should still be used normally.`,
    "</voice_call_control>",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// startVoiceTurn
// ---------------------------------------------------------------------------

/**
 * Execute a single voice turn through the daemon conversation pipeline.
 *
 * Manages the conversation directly with voice-specific defaults:
 *   - sourceChannel: 'phone'
 *   - event sink wired to the provided callbacks
 *   - abort propagated from the returned handle
 *
 * The caller (CallController via relay-server) can use the returned handle
 * to cancel the turn on barge-in.
 */
export async function startVoiceTurn(
  opts: VoiceTurnOptions,
): Promise<VoiceTurnHandle> {
  if (!deps) {
    throw new Error(
      "Voice bridge not initialized — setVoiceBridgeDeps() was not called",
    );
  }

  const eventSink: VoiceRunEventSink = {
    onTextDelta: (msg) => {
      opts.onTextDelta?.(msg.text);
      opts.callbacks?.assistant_text_delta?.(msg);
    },
    onMessageComplete: (msg) => {
      opts.onComplete?.();
      opts.callbacks?.message_complete?.(msg);
    },
    onError: (message) => {
      opts.onError?.(message);
    },
    onToolUse: (toolName, input) => {
      log.debug({ toolName, input }, "Voice turn tool_use event");
    },
  };

  // Voice has no interactive permission/secret UI, so apply explicit
  // per-role policies:
  // - guardian: permission prompts auto-allow (parity with guardian chat)
  // - everyone else (including unknown): auto-deny confirmations.
  const trustClass = opts.trustContext?.trustClass;
  const isGuardian = trustClass === "guardian";
  const voiceSessionId = opts.voiceSessionId ?? opts.callSessionId;
  const turnChannelContext: TurnChannelContext = {
    userMessageChannel: opts.userMessageChannel ?? "phone",
    assistantMessageChannel:
      opts.assistantMessageChannel ?? opts.userMessageChannel ?? "phone",
  };
  const turnInterfaceContext: TurnInterfaceContext = {
    userMessageInterface: opts.userMessageInterface ?? "phone",
    assistantMessageInterface:
      opts.assistantMessageInterface ?? opts.userMessageInterface ?? "phone",
  };

  // Replace the [CALL_OPENING] marker with a neutral instruction before
  // persisting. The marker must not appear as a user message in conversation
  // history — after a barge-in interruption the next turn would replay
  // the stale marker and potentially retrigger opener behavior.
  const persistedContent =
    opts.content === CALL_OPENING_MARKER
      ? "(call connected — deliver opening greeting)"
      : opts.content === CALL_VERIFICATION_COMPLETE_MARKER
        ? "(verification completed — transitioning into conversation)"
        : opts.content;

  // Build the call-control protocol prompt so the model knows how to emit
  // control markers (ASK_GUARDIAN, END_CALL, etc.) and recognize opener turns.
  const isCallerGuardian = opts.trustContext?.trustClass === "guardian";

  const voiceCallControlPrompt =
    opts.voiceControlPrompt === undefined
      ? buildVoiceCallControlPrompt({
          isInbound: opts.isInbound,
          task: opts.task,
          isCallerGuardian,
          skipDisclosure: opts.skipDisclosure,
        })
      : opts.voiceControlPrompt;

  // Get or create the conversation
  const transport = {
    channelId: turnChannelContext.userMessageChannel,
  };
  const conversation = await deps.getOrCreateConversation(
    opts.conversationId,
    transport,
  );

  if (conversation.isProcessing()) {
    // Voice barge-in can race with turn teardown. Wait briefly for the
    // previous turn to finish aborting before giving up.
    const maxWaitMs = 3000;
    const pollIntervalMs = 50;
    let waited = 0;
    while (conversation.isProcessing() && waited < maxWaitMs) {
      if (opts.signal?.aborted) {
        throw new Error("Turn aborted while waiting for conversation");
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      waited += pollIntervalMs;
    }
    if (opts.signal?.aborted) {
      throw new Error("Turn aborted while waiting for conversation");
    }
    if (conversation.isProcessing()) {
      throw new Error("Conversation is already processing a message");
    }
  }

  // Configure conversation for this voice turn
  conversation.setAssistantId(opts.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID);
  conversation.callSessionId = voiceSessionId;
  conversation.setTrustContext(opts.trustContext ?? null);
  conversation.setCommandIntent(null);
  conversation.setTurnChannelContext(turnChannelContext);
  conversation.setTurnInterfaceContext?.(turnInterfaceContext);
  conversation.setChannelCapabilities(
    resolveChannelCapabilities(
      turnChannelContext.userMessageChannel,
      turnInterfaceContext.userMessageInterface,
    ),
  );
  conversation.setVoiceCallControlPrompt(voiceCallControlPrompt);

  const requestId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const messageId = await conversation.persistUserMessage(
    persistedContent,
    [],
    requestId,
  );
  try {
    opts.callbacks?.persisted_user_message_id?.(messageId);
  } catch (err) {
    log.warn(
      { err, turnId, messageId },
      "Voice turn persisted-message callback threw",
    );
  }

  // Serialized publish chain so hub subscribers observe events in order.
  let hubChain: Promise<void> = Promise.resolve();
  const publishToHub = (msg: ServerMessage): void => {
    // ServerMessage is a large union; conversationId exists on most but not all variants.
    const msgConversationId =
      "conversationId" in msg &&
      typeof (msg as { conversationId?: unknown }).conversationId === "string"
        ? (msg as { conversationId: string }).conversationId
        : undefined;
    const resolvedConversationId = msgConversationId ?? opts.conversationId;
    const event = buildAssistantEvent(
      DAEMON_INTERNAL_ASSISTANT_ID,
      msg,
      resolvedConversationId,
    );
    hubChain = (async () => {
      await hubChain;
      try {
        await assistantEventHub.publish(event);
      } catch (err) {
        log.warn(
          { err },
          "assistant-events hub subscriber threw during voice turn",
        );
      }
    })();
  };

  // Hook into conversation to intercept confirmation_request and secret_request events.
  // Voice auto-denies/auto-allows/auto-resolves these since there's no interactive UI.
  const autoDeny = !isGuardian;
  const autoAllow = isGuardian;
  let lastError: string | null = null;
  conversation.updateClient(async (msg: ServerMessage) => {
    if (msg.type === "confirmation_request") {
      if (autoDeny) {
        // Non-guardian voice callers have no interactive approval UI.
        // The pre-exec gate (tool-approval-handler.ts) handles grant
        // consumption with retry for tool execution confirmations, but
        // some confirmation_request events originate from proxy/network
        // paths (e.g. PermissionPrompter in createProxyApprovalCallback)
        // that bypass the pre-exec gate. We do a single sync lookup here
        // (maxWaitMs: 0) since the primary retry path is in the pre-exec
        // gate; this secondary path just needs a quick check.
        try {
          const inputDigest = computeToolApprovalDigest(
            msg.toolName,
            msg.input,
          );
          const consumeResult = await consumeGrantForInvocation(
            {
              requestId: msg.requestId,
              toolName: msg.toolName,
              inputDigest,
              consumingRequestId: msg.requestId,
              executionChannel: turnChannelContext.userMessageChannel,
              conversationId: opts.conversationId,
              callSessionId: voiceSessionId,
              requesterExternalUserId:
                opts.trustContext?.requesterExternalUserId,
            },
            { maxWaitMs: 0 },
          );

          if (consumeResult.ok) {
            log.info(
              {
                turnId,
                toolName: msg.toolName,
                grantId: consumeResult.grant.id,
              },
              "Consumed scoped grant — allowing non-guardian voice confirmation",
            );
            conversation.handleConfirmationResponse(
              msg.requestId,
              "allow",
              undefined,
              undefined,
              `Permission approved for "${msg.toolName}": guardian pre-approved via scoped grant.`,
            );
            publishToHub(msg);
            return;
          }
        } catch (err) {
          log.error(
            { err, turnId, toolName: msg.toolName },
            "Error consuming grant in voice confirmation handler — falling through to deny",
          );
        }

        log.info(
          { turnId, toolName: msg.toolName },
          "Auto-denying confirmation request for non-guardian voice turn (no matching scoped grant)",
        );
        conversation.handleConfirmationResponse(
          msg.requestId,
          "deny",
          undefined,
          undefined,
          `Permission denied for "${msg.toolName}": this voice call does not have interactive approval capabilities. Side-effect tools are not available for non-guardian voice callers. In your next assistant reply, explain briefly that this action requires guardian-level access and cannot be performed during this call.`,
        );
        publishToHub(msg);
        return;
      }
      if (autoAllow) {
        log.info(
          { turnId, toolName: msg.toolName },
          "Auto-approving confirmation request for guardian voice turn",
        );
        conversation.handleConfirmationResponse(
          msg.requestId,
          "allow",
          undefined,
          undefined,
          `Permission approved for "${msg.toolName}": this is a verified guardian voice call.`,
        );
        publishToHub(msg);
        return;
      }
    } else if (msg.type === "secret_request") {
      // Voice has no secret-entry UI, so resolve immediately
      log.info(
        { turnId, service: msg.service, field: msg.field },
        "Auto-resolving secret request for voice turn (no secret-entry UI)",
      );
      conversation.handleSecretResponse(msg.requestId, undefined, "store");
      publishToHub(msg);
      return;
    }
    publishToHub(msg);
  });

  // Fire-and-forget the agent loop
  const cleanup = () => {
    // Reset channel capabilities so a subsequent desktop session on the
    // same conversation is not incorrectly treated as a voice client.
    conversation.setChannelCapabilities(null);
    conversation.setTrustContext(null);
    conversation.setCommandIntent(null);
    conversation.setAssistantId("self");
    conversation.setVoiceCallControlPrompt(null);
    conversation.callSessionId = undefined;
    // Reset the conversation's client callback to a no-op so the stale
    // closure doesn't intercept events from future turns on the same conversation.
    conversation.updateClient(() => {}, true);
  };

  void (async () => {
    try {
      await conversation.runAgentLoop(
        persistedContent,
        messageId,
        (msg: ServerMessage) => {
          if (msg.type === "error") {
            lastError = msg.message;
          } else if (msg.type === "conversation_error") {
            lastError = msg.userMessage;
          }
          publishToHub(msg);

          // Forward voice-relevant events to the real-time event sink
          if (msg.type === "assistant_text_delta") {
            eventSink.onTextDelta(msg);
          } else if (msg.type === "message_complete") {
            eventSink.onMessageComplete(msg);
          } else if (msg.type === "generation_cancelled") {
            // Treat cancellation as a completed turn so the voice
            // turnComplete promise settles instead of hanging forever.
            eventSink.onMessageComplete(msg);
          } else if (msg.type === "error") {
            eventSink.onError(msg.message);
          } else if (msg.type === "conversation_error") {
            eventSink.onError(msg.userMessage);
          } else if (msg.type === "tool_use_start") {
            eventSink.onToolUse(msg.toolName, msg.input);
          }
          // Note: tool_use_preview_start is intentionally not handled here.
          // Voice only reacts to the definitive tool_use_start event.
        },
        { callSite: "callAgent" },
      );
      if (lastError) {
        log.error(
          { turnId, error: lastError },
          "Voice turn failed (error event from agent loop)",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, turnId }, "Voice turn failed");
      eventSink.onError(message);
    } finally {
      cleanup();
    }
  })();

  const abortFn = () => {
    if (conversation.currentRequestId === requestId) {
      conversation.abort(
        createAbortReason(
          "voice_session_aborted",
          "voice-session-bridge.abortFn",
          conversation.conversationId,
        ),
      );
    }
  };

  // If the caller provided an external AbortSignal (e.g. from a
  // RelayConnection's AbortController), wire it to the turn's abort.
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortFn();
    } else {
      opts.signal.addEventListener("abort", () => abortFn(), { once: true });
    }
  }

  return {
    turnId,
    abort: abortFn,
  };
}
