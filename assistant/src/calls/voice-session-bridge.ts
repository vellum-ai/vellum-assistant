/**
 * Bridge between voice relay and the daemon conversation pipeline.
 *
 * Provides a `startVoiceTurn()` function that manages a voice turn
 * directly through the conversation, translating agent-loop events into
 * simple callbacks suitable for real-time TTS streaming.
 */

import { consumeGrantForInvocation } from "../approvals/approval-primitive.js";
import type {
  ChannelId,
  InterfaceId,
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { ABORT_WATCHDOG_MS } from "../daemon/abort-watchdog.js";
import { CONVERSATION_BUSY_MESSAGE } from "../daemon/conversation-messaging.js";
import { resolveChannelCapabilities } from "../daemon/conversation-runtime-assembly.js";
import { getOrCreateConversation } from "../daemon/conversation-store.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { recordConversationPersistedSeq } from "../persistence/conversation-crud.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getCurrentSeq } from "../runtime/assistant-stream-state.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import {
  CALL_OPENING_MARKER,
  CALL_VERIFICATION_COMPLETE_MARKER,
} from "./voice-control-protocol.js";

const log = getLogger("voice-session-bridge");

/**
 * Exact message thrown when `opts.signal` aborts while the turn is waiting
 * for the conversation to become available. The call controller's abort
 * handling relies on this turn failing with a recognizable error — keep the
 * value byte-identical across every throw site.
 */
export const TURN_ABORTED_WAITING_MESSAGE =
  "Turn aborted while waiting for conversation";

/**
 * Exact message thrown when the processing-wait budget elapses without the
 * conversation becoming available. Shared with the daemon's persist-time
 * throw site (`conversation-messaging.ts`); the call controller's
 * lock-contention re-prompt matches on this string.
 */
export { CONVERSATION_BUSY_MESSAGE };

const PROCESSING_WAIT_MARGIN_MS = 1000;
/**
 * How long startVoiceTurn waits for a prior turn to release the processing
 * lock before giving up. The prior turn can hold the lock for the abort
 * unwind budget PLUS the awaited turn-boundary commit window, so the wait
 * must cover both (+ margin) or a barge-in can still fail with
 * CONVERSATION_BUSY_MESSAGE.
 */
export function resolveProcessingWaitMs(
  turnCommitMaxWaitMs: number,
  abortUnwindMs: number,
): number {
  return turnCommitMaxWaitMs + abortUnwindMs + PROCESSING_WAIT_MARGIN_MS;
}

/**
 * Pending teardown of the most recent voice turn, per conversation id.
 *
 * `waitForIdle` releases on the `setProcessing(false)` transition, which the
 * prior turn reaches BEFORE its agent-loop continuation runs
 * `finally { cleanup() }`. A turn that starts on the idle transition alone
 * could install its per-turn conversation state (trust context, call session
 * id, client callback) and then have the prior turn's cleanup null that
 * state mid-turn. The next turn awaits this promise — bounded by the same
 * processing-wait budget — so cleanup always completes first.
 */
const pendingTurnTeardowns = new Map<string, Promise<void>>();

/**
 * Await a prior turn's teardown, bounded by `timeoutMs` and `signal`.
 * Resolves `true` when the teardown settles, `false` on timeout; rejects
 * when the signal aborts mid-wait. Timer and abort listener are removed on
 * every exit path.
 */
async function waitForPriorTurnTeardown(
  teardown: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    throw new Error(TURN_ABORTED_WAITING_MESSAGE);
  }
  return await new Promise<boolean>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settleWait = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      settleWait();
      reject(new Error(TURN_ABORTED_WAITING_MESSAGE));
    };
    timer = setTimeout(() => {
      settleWait();
      resolve(false);
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    void teardown.then(() => {
      settleWait();
      resolve(true);
    });
  });
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
  persisted_assistant_message_id?: (messageId: string) => void;
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
  /** Permission handling mode. Defaults to phone-call auto policy. */
  approvalMode?: "phone-call" | "local-live-voice";
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
        '7. If the latest user turn is "(call connected — deliver opening greeting)", this is an inbound call you are answering (not a call you initiated). Greet the caller warmly and ask how you can help. Introduce yourself once at the start using your assistant name if you know it (for example: "Hey there, this is Ava, Sam\'s assistant. How can I help?"). If your assistant name is not known, skip the name and just identify yourself as the guardian\'s assistant. Never use a UUID-shaped internal assistant ID as your spoken name. Do NOT say "I\'m calling" or "I\'m calling on behalf of". Vary the wording; do not use a fixed template.',
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
 * The caller (CallController) can use the returned handle to cancel the
 * turn on barge-in.
 */
export async function startVoiceTurn(
  opts: VoiceTurnOptions,
): Promise<VoiceTurnHandle> {
  const eventSink: VoiceRunEventSink = {
    onTextDelta: (msg) => {
      opts.onTextDelta?.(msg.text);
      opts.callbacks?.assistant_text_delta?.(msg);
    },
    onMessageComplete: (msg) => {
      opts.onComplete?.();
      opts.callbacks?.message_complete?.(msg);
      if (
        msg.type === "message_complete" &&
        msg.messageId &&
        msg.source !== "aux"
      ) {
        try {
          opts.callbacks?.persisted_assistant_message_id?.(msg.messageId);
        } catch (err) {
          log.warn(
            { err, messageId: msg.messageId },
            "Voice turn assistant-message callback threw",
          );
        }
      }
    },
    onError: (message) => {
      opts.onError?.(message);
    },
    onToolUse: (toolName, input) => {
      log.debug({ toolName, input }, "Voice turn tool_use event");
    },
  };

  // Phone voice has no interactive permission/secret UI, so apply explicit
  // per-role policies by default. Local live voice opts into the normal
  // client approval path instead. Side-effect double-defense
  // (forcePromptSideEffects) is wired inside the agent-loop IIFE so it
  // is always paired with cleanup() in the IIFE's finally.
  const trustClass = opts.trustContext?.trustClass;
  const isGuardian = trustClass === "guardian";
  const approvalMode = opts.approvalMode ?? "phone-call";
  const usesLocalInteractiveApprovals = approvalMode === "local-live-voice";
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

  // Opener / verification prompts are internal scaffolding: they persist a row
  // so the model wakes, but they are not user speech and must not render as a
  // live user bubble. Their echo is suppressed below (parity with
  // `isEchoSuppressedUserMessage` on the text path).
  const isSyntheticVoicePrompt =
    opts.content === CALL_OPENING_MARKER ||
    opts.content === CALL_VERIFICATION_COMPLETE_MARKER;

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
  const conversation = await getOrCreateConversation(opts.conversationId);

  const config = getConfig();
  const maxWaitMs = resolveProcessingWaitMs(
    config.workspaceGit?.turnCommitMaxWaitMs ?? 4000,
    ABORT_WATCHDOG_MS,
  );
  const waitStartedAt = Date.now();

  // Three conditions must all clear before this turn may install its
  // per-turn conversation state, and clearing one can re-raise another:
  //
  // - The processing lock. `waitForIdle` resolves from the
  //   `setProcessing(false)` transition, so the turn starts on the same
  //   tick the lock releases instead of paying up to a 50 ms poll interval
  //   after every barge-in.
  // - The prior turn's teardown. Its `finally { cleanup() }` runs after
  //   `setProcessing(false)` (see `pendingTurnTeardowns`).
  // - A queued-message drain. The `finally` that releases the lock (waking
  //   this turn) then calls `drainQueue`, which retakes the lock for any
  //   queued messages. When queued work is visible after a successful idle
  //   wait, loop back and wait the drained turn out instead of racing its
  //   persist; a drain that takes the lock without visible queued work is
  //   covered by the persist retry below.
  //
  // Hence the re-check loop, bounded by one shared budget. In practice
  // each leg settles within a few microtasks; the bound only guards a
  // wedged prior turn.
  // Abort is only honored inside the wait legs: a pre-aborted signal on an
  // idle conversation still starts the turn, which the signal wiring below
  // then aborts immediately (pinned by the pre-aborted-signal test).
  let remainingWaitMs = maxWaitMs;
  const consumeWaitBudget = () => {
    remainingWaitMs = Math.max(0, maxWaitMs - (Date.now() - waitStartedAt));
  };
  /**
   * Wait for the processing lock to release within the remaining budget.
   * Maps every exit to the turn's terminal errors: signal abort → the exact
   * turn-aborted error; timeout or exhausted budget → the exact busy error.
   */
  const waitOutProcessingLock = async (): Promise<void> => {
    if (remainingWaitMs <= 0) {
      throw new Error(CONVERSATION_BUSY_MESSAGE);
    }
    let idle: boolean;
    try {
      idle = await conversation.waitForIdle({
        timeoutMs: remainingWaitMs,
        signal: opts.signal,
      });
    } catch {
      // waitForIdle rejects only when opts.signal aborted mid-wait.
      throw new Error(TURN_ABORTED_WAITING_MESSAGE);
    }
    if (opts.signal?.aborted) {
      throw new Error(TURN_ABORTED_WAITING_MESSAGE);
    }
    if (!idle) {
      // Waited the full budget (see resolveProcessingWaitMs) without the
      // lock releasing, so the prior turn is genuinely wedged. The
      // controller catches this terminal error and speaks a brief
      // non-technical re-prompt rather than staying silent.
      throw new Error(CONVERSATION_BUSY_MESSAGE);
    }
    consumeWaitBudget();
  };
  for (;;) {
    if (conversation.isProcessing()) {
      await waitOutProcessingLock();
      if (conversation.hasQueuedMessages?.()) {
        continue;
      }
    }
    const priorTeardown = pendingTurnTeardowns.get(opts.conversationId);
    if (priorTeardown) {
      const torndown = await waitForPriorTurnTeardown(
        priorTeardown,
        remainingWaitMs,
        opts.signal,
      );
      if (!torndown) {
        throw new Error(CONVERSATION_BUSY_MESSAGE);
      }
      consumeWaitBudget();
      continue;
    }
    break;
  }

  // Hoisted so the catch below can clear partially-applied turn state
  // when a setter or `persistUserMessage` throws — otherwise `trustContext`,
  // `callSessionId`, etc. leak into subsequent non-voice turns on the same
  // conversation. The client callback is only reset when this turn actually
  // installed it (tracked via `clientCallbackInstalled`); otherwise cleanup
  // would detach an active sender installed by a prior turn.
  let clientCallbackInstalled = false;
  const cleanup = () => {
    conversation.setChannelCapabilities(null);
    conversation.setTrustContext(null);
    conversation.setCommandIntent(null);
    conversation.setAssistantId("self");
    conversation.setVoiceCallControlPrompt(null);
    conversation.callSessionId = undefined;
    conversation.forcePromptSideEffects = false;
    if (clientCallbackInstalled) {
      // Reset the client callback to a no-op so the stale closure doesn't
      // intercept events from future turns on the same conversation.
      conversation.updateClient(() => {}, true);
    }
  };

  const requestId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const persistTurnUserMessage = async (): Promise<string> => {
    const persistResult = await conversation.persistUserMessage({
      content: persistedContent,
      requestId,
    });
    return persistResult.id;
  };
  /**
   * Install this turn's per-conversation state (caller trust, call session
   * id, channel capabilities, voice control prompt). Runs before every
   * persist attempt: the busy-retry path below uninstalls via `cleanup()`
   * for the duration of its wait, then re-installs before retrying.
   */
  const installVoiceTurnState = () => {
    conversation.setAssistantId(
      opts.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
    );
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
  };
  let messageId: string;
  try {
    installVoiceTurnState();

    try {
      messageId = await persistTurnUserMessage();
    } catch (err) {
      // A queued-message drain can take the lock between the wait loop
      // above and this persist — the drain reaches its own persist a few
      // microtasks after the idle transition that released this turn.
      // Within the remaining budget, wait the drained turn out and retry
      // the persist once instead of failing the barge-in. The drained turn
      // must not run with this turn's phone prompt or caller trust, so the
      // voice state is uninstalled while it holds the lock and re-installed
      // before the retry.
      if (
        !(err instanceof Error) ||
        err.message !== CONVERSATION_BUSY_MESSAGE ||
        remainingWaitMs <= 0
      ) {
        throw err;
      }
      cleanup();
      await waitOutProcessingLock();
      installVoiceTurnState();
      messageId = await persistTurnUserMessage();
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  try {
    opts.callbacks?.persisted_user_message_id?.(messageId);
  } catch (err) {
    log.warn(
      { err, turnId, messageId },
      "Voice turn persisted-message callback threw",
    );
  }

  // Broadcast the user turn to hub subscribers (web / passive devices) BEFORE
  // the assistant reply streams, mirroring the text path
  // (`conversation-process.ts`). Without this the web client receives the
  // assistant deltas with no preceding user-turn boundary and folds them into
  // the previous assistant bubble until a `/messages` reconcile splits them
  // (JARVIS-1258). Synthetic opener/verification prompts persist a row but are
  // not user speech, so their echo is suppressed.
  if (!isSyntheticVoicePrompt) {
    broadcastMessage({
      type: "user_message_echo",
      text: persistedContent,
      conversationId: opts.conversationId,
      messageId,
      requestId,
    });
    // The echoed row is already durably persisted and the agent loop hasn't
    // started, so advance the snapshot↔stream anchor to the echo's seq — else
    // `/messages` returns the row while advertising the previous flush's anchor
    // (under-claiming). Safe to claim here for the same reason as the text path.
    recordConversationPersistedSeq(opts.conversationId, getCurrentSeq());
    // Nudge subscribers to refetch `/messages`. Gated to real user turns:
    // synthetic opener/verification rows are persisted un-hidden (unlike the
    // text path's echo-suppressed rows, which are `hidden` and safe to
    // announce), so an early invalidation here would surface the internal
    // "(call connected …)" prompt as a user bubble before the assistant reply
    // streams. Synthetic prompts still reach the transcript via the normal
    // turn-end resync.
    publishConversationMessagesChanged(opts.conversationId);
  }

  // Hook into conversation to intercept confirmation_request and secret_request events.
  // Voice auto-denies/auto-allows/auto-resolves these since there's no interactive UI.
  const autoDeny = !isGuardian;
  const autoAllow = isGuardian;
  let lastError: string | null = null;
  conversation.updateClient(async (msg: ServerMessage) => {
    if (msg.type === "confirmation_request") {
      if (usesLocalInteractiveApprovals) {
        pendingInteractions.register(msg.requestId, {
          conversationId: opts.conversationId,
          kind: "confirmation",
          confirmationDetails: {
            toolName: msg.toolName,
            input: msg.input,
            riskLevel: msg.riskLevel,
            executionTarget: msg.executionTarget,
            allowlistOptions: msg.allowlistOptions,
            scopeOptions: msg.scopeOptions,
            persistentDecisionsAllowed: msg.persistentDecisionsAllowed,
            acpToolKind: msg.acpToolKind,
            acpOptions: msg.acpOptions,
          },
        });
        broadcastMessage(msg);
        return;
      }
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
            conversation.handleConfirmationResponse(msg.requestId, "allow", {
              decisionContext: `Permission approved for "${msg.toolName}": guardian pre-approved via scoped grant.`,
            });
            broadcastMessage(msg);
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
        conversation.handleConfirmationResponse(msg.requestId, "deny", {
          decisionContext: `Permission denied for "${msg.toolName}": this voice call does not have interactive approval capabilities. Side-effect tools are not available for non-guardian voice callers. In your next assistant reply, explain briefly that this action requires guardian-level access and cannot be performed during this call.`,
        });
        broadcastMessage(msg);
        return;
      }
      if (autoAllow) {
        log.info(
          { turnId, toolName: msg.toolName },
          "Auto-approving confirmation request for guardian voice turn",
        );
        conversation.handleConfirmationResponse(msg.requestId, "allow", {
          decisionContext: `Permission approved for "${msg.toolName}": this is a verified guardian voice call.`,
        });
        broadcastMessage(msg);
        return;
      }
    } else if (msg.type === "secret_request") {
      if (usesLocalInteractiveApprovals) {
        // Local live voice runs alongside the desktop client, which has a
        // secret-entry UI. Forward the broadcast and let the prompter's
        // existing registration handle the response.
        broadcastMessage(msg);
        return;
      }
      // Phone voice has no secret-entry UI, so resolve immediately.
      log.info(
        { turnId, service: msg.service, field: msg.field },
        "Auto-resolving secret request for voice turn (no secret-entry UI)",
      );
      conversation.handleSecretResponse(msg.requestId, undefined, "store");
      return;
    }
    broadcastMessage(msg);
  });
  clientCallbackInstalled = true;

  // Registered before the agent loop starts so the NEXT turn on this
  // conversation waits for this turn's `finally { cleanup() }` — not just
  // the processing-flag release — before installing its own per-turn state.
  let resolveTeardown!: () => void;
  const teardownSettled = new Promise<void>((resolve) => {
    resolveTeardown = resolve;
  });
  pendingTurnTeardowns.set(opts.conversationId, teardownSettled);
  const settleTurnTeardown = () => {
    if (pendingTurnTeardowns.get(opts.conversationId) === teardownSettled) {
      pendingTurnTeardowns.delete(opts.conversationId);
    }
    resolveTeardown();
  };

  // Fire-and-forget the agent loop
  void (async () => {
    try {
      // Non-guardian phone voice forces side-effect tools to prompt so the
      // auto-deny handler above reliably sees a confirmation_request. Without
      // this, a broad allow trust rule (e.g. wildcard bash) would let
      // side-effect tools execute without ever emitting an event for the
      // auto-deny / scoped-grant handler to intercept. Set inside the
      // try/finally so a failed setup before this point cannot leak the
      // flag into subsequent non-voice turns on the same conversation.
      conversation.forcePromptSideEffects =
        !isGuardian && !usesLocalInteractiveApprovals;
      await conversation.runAgentLoop(persistedContent, messageId, {
        onEvent: (msg: ServerMessage) => {
          if (msg.type === "error") {
            lastError = msg.message;
          } else if (msg.type === "conversation_error") {
            lastError = msg.userMessage;
          }
          broadcastMessage(msg);

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
        callSite: "callAgent",
      });
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
      settleTurnTeardown();
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

  // If the caller provided an external AbortSignal (e.g. from the call
  // controller's AbortController), wire it to the turn's abort.
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
