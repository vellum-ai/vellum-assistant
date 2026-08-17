/**
 * Bridge between voice relay and the daemon conversation pipeline.
 *
 * Provides a `startVoiceTurn()` function that manages a voice turn
 * directly through the conversation, translating agent-loop events into
 * simple callbacks suitable for real-time TTS streaming.
 */

import { v7 as uuidv7 } from "uuid";

import type {
  AssistantEvent,
  AssistantTextDeltaEvent,
  GenerationCancelledEvent,
  MessageCompleteEvent,
} from "../api/index.js";
import { consumeGrantForInvocation } from "../approvals/approval-primitive.js";
import type {
  ChannelId,
  ClientOs,
  InterfaceId,
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { ABORT_WATCHDOG_MS } from "../daemon/abort-watchdog.js";
import { CONVERSATION_BUSY_MESSAGE } from "../daemon/conversation-messaging.js";
import { resolveChannelCapabilities } from "../daemon/conversation-runtime-assembly.js";
import { getOrCreateConversation } from "../daemon/conversation-store.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import {
  deleteMessageById,
  getMessageById,
  recordConversationPersistedSeq,
  updateMessageContent,
} from "../persistence/conversation-crud.js";
import { pinnedListeningLanguage } from "../providers/speech-to-text/provider-catalog.js";
import type { ContentBlock } from "../providers/types.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getCurrentSeq } from "../runtime/assistant-stream-state.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import { getAllTools } from "../tools/registry.js";
import { sensitiveToolReach } from "../tools/tool-approval-handler.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import { truncate } from "../util/truncate.js";
import {
  CALL_OPENING_MARKER,
  CALL_VERIFICATION_COMPLETE_MARKER,
  ESCALATE_VERDICT_TOKEN,
  HOLD_VERDICT_TOKEN,
  MINIMIZE_ROOM_MARKER,
  stripInternalSpeechMarkers,
} from "./voice-control-protocol.js";
import {
  createFrontDoorStreamGate,
  escalatedContinuationRule,
  ESCALATION_CONTINUATION_CONTENT,
  frontDoorCapabilityDigest,
  frontDoorDecisionRule,
  spokenBridgeText,
  type VoiceRoutingLeg,
} from "./voice-triage-escalate.js";

const log = getLogger("voice-session-bridge");

/**
 * Front-door decision rule with the registry-derived capability digest. The
 * front-door leg runs toolless (see the `toolsDisabledDepth` bracket in
 * `startVoiceTurn`), so the digest is its only knowledge of what the
 * escalated leg can do. Registry unavailability degrades to the bare rule.
 * `includeHold` adds the mid-thought verdict branch (unified front-door
 * speculative legs only).
 */
function frontDoorRuleWithDigest(
  includeHold: boolean,
  callerUtterance?: string,
): string {
  let toolNames: string[] = [];
  try {
    toolNames = getAllTools().map((tool) => tool.name);
  } catch {
    // Tool registry not initialized (e.g. unit tests): digest-less rule.
  }
  return frontDoorDecisionRule({
    includeHold,
    capabilityDigest: frontDoorCapabilityDigest(toolNames),
    callerUtterance,
  });
}

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
export async function waitForPriorTurnTeardown(
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

/**
 * The pending teardown promise for a conversation's most recent turn, or
 * `undefined` when no turn is currently tearing down. The live-voice barge-in
 * path reads this synchronously at interrupt time — before the next utterance's
 * `startVoiceTurn` overwrites the per-conversation entry — to capture the
 * interrupted turn's teardown, then awaits it before forking a background
 * continuation. That guarantees the fork snapshots history only after the
 * interrupted turn's completed tool calls have settled into it, so a
 * side-effecting continuation cannot repeat a call the interrupted turn already
 * ran. It is turn-scoped: it resolves once THIS turn's teardown finishes, and
 * does not block on any later turn's work.
 */
export function getConversationTurnTeardown(
  conversationId: string,
): Promise<void> | undefined {
  return pendingTurnTeardowns.get(conversationId);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Max length of the tool-result preview forwarded to voice callbacks. The
 * single truncation point for tool results entering the voice layer.
 */
export const TOOL_RESULT_PREVIEW_MAX_CHARS = 200;

/**
 * A finished tool invocation as forwarded to the voice layer.
 * `toolName` is the name of the tool that produced the result; it is empty
 * only when the daemon loop never observed a tool_use event for the id
 * (e.g. a tool cancelled before it was proposed). `toolUseId` is optional
 * on the wire, so consumers correlate by id when present and fall back to
 * the name. `resultPreview` is the result truncated to
 * {@link TOOL_RESULT_PREVIEW_MAX_CHARS} at the bridge — the raw result can
 * be huge and must never travel further into the voice layer.
 */
export interface VoiceToolResultEvent {
  toolName: string;
  toolUseId?: string;
  isError?: boolean;
  resultPreview: string;
}

/**
 * Real-time event sink for voice TTS streaming. Agent-loop events are
 * forwarded here for real-time text-to-speech without modifying the
 * standard channel path.
 */
export interface VoiceRunEventSink {
  onTextDelta(msg: AssistantTextDeltaEvent): void;
  onMessageComplete(msg: MessageCompleteEvent | GenerationCancelledEvent): void;
  onError(message: string): void;
  onToolUse(
    toolName: string,
    input: Record<string, unknown>,
    toolUseId?: string,
  ): void;
  onToolResult(event: VoiceToolResultEvent): void;
}

export interface VoiceTurnCallbacks {
  assistant_text_delta?: (msg: AssistantTextDeltaEvent) => void;
  message_complete?: (
    msg: MessageCompleteEvent | GenerationCancelledEvent,
  ) => void;
  persisted_user_message_id?: (messageId: string) => void;
  persisted_assistant_message_id?: (messageId: string) => void;
  /** Fired when the agent run starts a definitive tool use this turn. */
  tool_use_start?: (
    toolName: string,
    detail?: { toolUseId?: string; input?: Record<string, unknown> },
  ) => void;
  /** Fired when a tool invocation finishes. */
  tool_result?: (event: VoiceToolResultEvent) => void;
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
  /**
   * Analytics attribution for a live-voice turn: which client opened the
   * session, and that session's id. Persisted into the user message's
   * `metadata.client` bag, which `turn-events-store` projects onto
   * `TurnTelemetryEvent.client`, so a live-voice turn is countable per client
   * and joinable to its session's start/end funnel rows.
   *
   * Deliberately separate from {@link userMessageInterface}: that field feeds
   * `resolveChannelCapabilities` and decides what the turn may do, so it is not
   * free to carry attribution. Absent for phone calls and for clients that send
   * no identity on the start frame.
   */
  voiceTelemetry?: {
    sessionId: string;
    client?: ClientOs;
  };
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
  /**
   * Called when this turn leaves a confirmation for the user to answer instead
   * of deciding it, so the client can put the prompt where they can see it.
   *
   * A voice client renders its call as something that covers the app (the
   * live-voice room is a full-screen overlay), which is fine while the call is
   * the only thing happening and wrong the moment the turn is waiting on a
   * decision: the card is on screen, behind the call. The bridge cannot reach
   * a client's own surfaces, so it says *that a decision is waiting* and the
   * client decides what to do about it.
   */
  onApprovalPending?: (requestId: string) => void;
  /**
   * Called when the last pending confirmation this turn was waiting on is
   * decided, however it was decided (the user answered, it timed out, a newer
   * message superseded it). Paired with {@link onApprovalPending} so a client
   * that changed its presentation for the wait can change it back.
   *
   * Fires on the *last* one, not each: a turn waiting on two decisions is
   * still waiting after the first is answered.
   */
  onApprovalsResolved?: () => void;
  /** Optional AbortSignal for external cancellation (e.g. barge-in). */
  signal?: AbortSignal;
  /**
   * Ad-hoc inference-profile override applied to every LLM call this turn
   * issues (forwarded to `runAgentLoop` with `forceOverrideProfile`). Used by
   * triage-and-escalate voice routing to run the front-door leg on the fast
   * profile and the escalated leg on the quality profile. Undefined = the
   * call-site default (today's behavior).
   */
  overrideProfile?: string;
  /**
   * Which leg of a triaged turn this is, so the auto-built phone control prompt
   * can add the front-door triage rule or the escalated continuation rule.
   * Undefined = routing off; no routing rules are added. Ignored when a caller
   * supplies its own `voiceControlPrompt`.
   */
  routingLeg?: VoiceRoutingLeg;
  /**
   * The holding phrase the caller actually heard before this leg started
   * (the front-door leg's own pre-marker text, or the canned fallback).
   * Quoted verbatim in the escalated continuation rule so the quality model
   * knows the exact words already spoken and does not re-announce them.
   * Only meaningful with `routingLeg: "escalated"`.
   */
  spokenEscalationBridge?: string;
  /**
   * Marks this turn's `content` as an internal instruction rather than user
   * speech: it persists `hidden` so `/messages` filters it after a reload,
   * its echo is suppressed, and prompt-as-user-speech consumers (title
   * generation) skip it. Set by callers whose synthetic prompt text is not a
   * fixed sentinel.
   */
  hiddenSyntheticPrompt?: boolean;
  /**
   * Unified front-door: this leg was dispatched speculatively at a silence
   * boundary, so its decision rule includes the hold branch (leading token
   * `[0]` = the caller is mid-thought). Only ever set on front-door legs —
   * a leg that doesn't know the hold token can't accidentally emit it, and
   * a leg that does must be one whose leading tokens are interpreted.
   */
  unifiedVerdict?: boolean;
  /**
   * Session-side dispatch timestamp (`Date.now()` at turn launch). When set,
   * the bridge's dispatch-timing log reports latency relative to it, so the
   * pre-bridge half (thinking frame, trust resolution) is attributable too.
   */
  launchedAtMs?: number;
}

export interface VoiceTurnHandle {
  /** Unique identifier for this turn. */
  turnId: string;
  /** Abort the in-flight turn (e.g. for barge-in). */
  abort: () => void;
  /**
   * Abort the turn AND roll back its persisted user message, restoring the
   * conversation to its pre-turn state (delete row + reload in-memory
   * history, then notify sync consumers). The leg's reserved assistant row
   * is removed too, by the teardown transcript-hygiene pass once the agent
   * loop settles. Used by the unified front-door hold verdict: a
   * mid-thought pause must leave no trace of the fragment
   * in history. Idempotent; safe to call after abort. Optional so that
   * test doubles and future non-bridge starters aren't forced to model
   * rollback — a missing discard degrades to abort-without-rollback.
   */
  discard?: () => Promise<void>;
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
/**
 * How long a live-voice call waits on an approval before deciding it itself.
 *
 * Long enough to pick the phone up and read the card, short enough that a turn
 * cannot sit blocked for the rest of the call. The fallback is the decision
 * this channel made before it prompted at all, so the worst case of nobody
 * answering is exactly the old behavior, arrived at late.
 */
const VOICE_APPROVAL_TIMEOUT_MS = 45_000;

/**
 * Telephony-only steering. A sign-in flow opens a browser window on a screen
 * the caller does not have in front of them, whether it is reached through a
 * ui-surface tool or through shell and CLI tools (e.g. `assistant oauth
 * connect`). Tell the model to speak the limitation and defer the flow to text
 * chat instead.
 *
 * Scoped to the phone because the screen is what decides it. A phone call has
 * no screen, so the `open_url` signal a CLI tool can reach lands somewhere the
 * caller will never see, and that signal bus carries no capability or
 * conversation context, so this rule is the only thing standing in front of it
 * here. A live-voice call is the opposite case: the user is holding the screen,
 * and the room minimizes itself to hand it back (see
 * LIVE_VOICE_SETUP_FLOW_TEACHING).
 */
const PHONE_NO_SETUP_FLOWS_RULE =
  "Never start account connections, OAuth or sign-in flows, or any other action that opens a browser window or needs the user's screen during this call, not even through shell or CLI tools. If the task needs one, say so briefly and offer to finish it in text chat after the call.";

/**
 * The pre-speech tail of the speak-the-caller's-language rule. A monolingual
 * `services.stt.language` pin is the strongest pre-speech signal of the
 * caller's language (the transcriber is already listening in it, see
 * media-stream-stt-session.ts and providers/speech-to-text/resolve.ts), so it
 * outranks the English default; "multi" and unset mean auto-detect, where
 * English remains the fallback. The pin only counts when the active provider
 * honors manual language selection (see pinnedListeningLanguage):
 * auto-detecting providers (gemini, whisper) ignore a persisted language
 * entirely, so greeting in it would contradict what the transcriber
 * actually hears. Exported for tests: the default test config exercises
 * only the auto-detect branch.
 */
export function preSpeechLanguageRuleFragment(
  sttLanguage: string | undefined,
  sttProvider?: string,
): string {
  const configuredListeningLanguage =
    sttProvider !== undefined
      ? pinnedListeningLanguage(sttProvider, sttLanguage)
      : undefined;
  return configuredListeningLanguage
    ? `use the language the Task context implies, if any; otherwise open in the assistant's configured listening language ("${configuredListeningLanguage}"), and default to English only when neither gives a language`
    : "use the language the Task context implies, if any; otherwise default to English";
}

function buildVoiceCallControlPrompt(opts: {
  isInbound: boolean;
  task?: string | null;
  isCallerGuardian?: boolean;
  skipDisclosure?: boolean;
  routingLeg?: VoiceRoutingLeg;
  spokenEscalationBridge?: string;
  unifiedVerdict?: boolean;
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
    `12. Speak the caller's language: reply in the language of the caller's most recent actual speech, and follow them if they switch languages mid-call. Synthetic user turns (parenthetical markers like the call-connected and verification-completed notices) are not caller speech and never set the language. Before the caller has spoken, such as on the opening greeting turn, ${preSpeechLanguageRuleFragment(config.services.stt.language, config.services.stt.provider)}.`,
    `13. ${PHONE_NO_SETUP_FLOWS_RULE}`,
  );

  // Triage-and-escalate routing rules. The front-door leg decides and may
  // hand off; the escalated leg continues the answer after a holding phrase
  // was already spoken.
  if (opts.routingLeg === "front-door") {
    lines.push(`14. ${frontDoorRuleWithDigest(opts.unifiedVerdict === true)}`);
  } else if (opts.routingLeg === "escalated") {
    lines.push(`14. ${escalatedContinuationRule(opts.spokenEscalationBridge)}`);
  }

  lines.push("</voice_call_control>");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Transcript hygiene
// ---------------------------------------------------------------------------

/** The concatenated text of a row's text blocks. */
function joinedTextOfBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

/**
 * Strip internal speech markers from every text block, dropping text blocks
 * the strip leaves empty; non-text blocks pass through untouched. Shared by
 * the front-door stray-token rewrite and the main-leg minimize-marker
 * rewrite.
 */
function stripMarkersFromBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const kept: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type !== "text") {
      kept.push(block);
      continue;
    }
    const cleaned = stripInternalSpeechMarkers(block.text);
    if (cleaned.trim().length > 0) {
      kept.push({ ...block, text: cleaned });
    }
  }
  return kept;
}

/**
 * Remove the terminal MINIMIZE_ROOM_MARKER from the end of a row's text,
 * walking text blocks from the last one backward so a marker split across
 * block boundaries (e.g. `"Done [-"` + `"1]"`) is removed whole — the
 * per-block strip in {@link stripMarkersFromBlocks} only sees fragments and
 * would leave both halves in place. Callers must have established that the
 * row's joined text ends with the marker after trimming trailing whitespace.
 */
function stripTerminalMinimizeMarker(blocks: ContentBlock[]): ContentBlock[] {
  const result = blocks.map((block) => ({ ...block }));
  const joined = joinedTextOfBlocks(result);
  const cutAt = joined.trimEnd().length - MINIMIZE_ROOM_MARKER.length;
  let blockEnd = joined.length;
  for (let i = result.length - 1; i >= 0 && blockEnd > cutAt; i--) {
    const block = result[i]!;
    if (block.type !== "text") {
      continue;
    }
    const blockStart = blockEnd - block.text.length;
    block.text = block.text.slice(0, Math.max(0, cutAt - blockStart));
    blockEnd = blockStart;
  }
  return result;
}

/**
 * Trim whitespace stranded at a rewritten row's outer edges by a stripped
 * edge marker (e.g. "Done, take a look [-1]"), leaving inter-block spacing
 * untouched.
 */
function trimOuterTextEdges(blocks: ContentBlock[]): ContentBlock[] {
  const result = blocks.map((block) => ({ ...block }));
  for (const block of result) {
    if (block.type === "text") {
      block.text = block.text.trimStart();
      break;
    }
  }
  for (let i = result.length - 1; i >= 0; i--) {
    const block = result[i]!;
    if (block.type === "text") {
      block.text = block.text.trimEnd();
      break;
    }
  }
  return result;
}

/**
 * Reduce a front-door leg's persisted content to what was actually spoken
 * under the verdict-first protocol.
 *
 * Returns null when the content carries no verdict token (a committed
 * front-door answer — nothing to do). A leg that led with
 * `ESCALATE_VERDICT_TOKEN` reduces to a single text block holding the
 * capped bridge; empty spoken text means the caller heard only the canned
 * fallback bridge, which is audio-only and never a transcript row, so the
 * caller should delete the row. Stray verdict tokens elsewhere in an
 * answer were never spoken (the live gate strips them) and are stripped
 * from the persisted text to match.
 */
export function cutFrontDoorContentAtVerdict(
  blocks: ContentBlock[],
): { blocks: ContentBlock[]; spokenText: string } | null {
  const joinedText = joinedTextOfBlocks(blocks);
  if (joinedText.trimStart().startsWith(ESCALATE_VERDICT_TOKEN)) {
    const spokenText = spokenBridgeText(joinedText);
    return {
      blocks: spokenText.length > 0 ? [{ type: "text", text: spokenText }] : [],
      spokenText,
    };
  }
  if (
    !joinedText.includes(ESCALATE_VERDICT_TOKEN) &&
    !joinedText.includes(HOLD_VERDICT_TOKEN)
  ) {
    return null;
  }
  const kept = stripMarkersFromBlocks(blocks);
  const spokenText = joinedTextOfBlocks(kept).trim();
  return { blocks: kept, spokenText };
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
  // Dispatch-latency stamps for the pre-loop half of a voice turn, logged
  // once at agent-loop entry so live sessions expose where pre-model time
  // goes (conversation resolve vs admission waits vs persist).
  const dispatch = {
    enteredAt: Date.now(),
    conversationReadyAt: 0,
    admissionClearAt: 0,
    persistDoneAt: 0,
  };
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
    onToolUse: (toolName, input, toolUseId) => {
      log.debug({ toolName, input }, "Voice turn tool_use event");
      opts.callbacks?.tool_use_start?.(toolName, { toolUseId, input });
    },
    onToolResult: (event) => {
      opts.callbacks?.tool_result?.(event);
    },
  };

  // Voice calls have no interactive permission/secret UI, so explicit
  // per-role policies apply. Side-effect double-defense
  // (forcePromptSideEffects) is wired inside the agent-loop IIFE so it
  // is always paired with cleanup() in the IIFE's finally.
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

  // Opener / verification / escalation-continuation prompts, plus any turn a
  // caller declares hidden, are internal scaffolding: they persist a row so the
  // model wakes, but they are not user speech and must not render as a live
  // user bubble. Their echo is suppressed below (parity with
  // `isEchoSuppressedUserMessage` on the text path).
  const isSyntheticVoicePrompt =
    opts.hiddenSyntheticPrompt === true ||
    opts.content === CALL_OPENING_MARKER ||
    opts.content === CALL_VERIFICATION_COMPLETE_MARKER ||
    opts.content === ESCALATION_CONTINUATION_CONTENT;

  // The escalation-continuation prompt is a pure internal instruction ("give
  // the full answer now"), not a real utterance and not the sort of scaffolding
  // an opener is — it must never surface as a user message. Unlike the
  // opener/verification rows (persisted un-hidden), persist it `hidden` so
  // `/messages` filters it out after a refetch/reload, and flag the turn as a
  // hidden prompt so prompt-as-user-speech consumers (e.g. title generation)
  // skip it. The escalated model still sees the row in context — `hidden` only
  // affects client display. A caller whose prompt text is not a fixed sentinel
  // opts into the same treatment with `hiddenSyntheticPrompt`.
  const isHiddenSyntheticPrompt =
    opts.hiddenSyntheticPrompt === true ||
    opts.content === ESCALATION_CONTINUATION_CONTENT;

  // Build the call-control protocol prompt so the model knows how to emit
  // control markers (ASK_GUARDIAN, END_CALL, etc.) and recognize opener turns.
  const isCallerGuardian = opts.trustContext?.trustClass === "guardian";

  let voiceCallControlPrompt: string | null;
  if (opts.voiceControlPrompt === undefined) {
    voiceCallControlPrompt = buildVoiceCallControlPrompt({
      isInbound: opts.isInbound,
      task: opts.task,
      isCallerGuardian,
      skipDisclosure: opts.skipDisclosure,
      routingLeg: opts.routingLeg,
      spokenEscalationBridge: opts.spokenEscalationBridge,
      unifiedVerdict: opts.unifiedVerdict,
    });
  } else {
    // A caller-supplied prompt (e.g. live-voice) bypasses
    // buildVoiceCallControlPrompt, which is where the triage-and-escalate rule
    // is normally injected from `routingLeg`. Append it here too — without it
    // the front-door leg would run on the fast profile but never learn the
    // verdict protocol, so it could not hold or hand off to the escalated leg.
    voiceCallControlPrompt = opts.voiceControlPrompt;
    const routingLegRule =
      opts.routingLeg === "front-door"
        ? frontDoorRuleWithDigest(opts.unifiedVerdict === true, opts.content)
        : opts.routingLeg === "escalated"
          ? escalatedContinuationRule(opts.spokenEscalationBridge)
          : null;
    if (voiceCallControlPrompt != null && routingLegRule) {
      voiceCallControlPrompt = `${voiceCallControlPrompt}\n\n${routingLegRule}`;
    }
  }

  // Get or create the conversation
  const conversation = await getOrCreateConversation(opts.conversationId);
  dispatch.conversationReadyAt = Date.now();

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
  dispatch.admissionClearAt = Date.now();

  // Releases the per-turn state of a voice turn that OWNED the conversation,
  // so `trustContext`, `callSessionId`, etc. don't leak into subsequent
  // non-voice turns. Runs on exactly two paths: the agent-loop `finally`
  // (the turn ran) and the first-persist non-busy failure below (the persist
  // failed while no concurrent turn held the lock). Paths where this turn
  // LOST the conversation to a concurrent winner must use `restoreTurnState`
  // instead — this reset-to-defaults would clobber the winner's live state.
  // The client callback is only reset when this turn actually installed it
  // (tracked via `clientCallbackInstalled`); otherwise cleanup would detach
  // an active sender installed by a prior turn.
  let clientCallbackInstalled = false;
  /**
   * Confirmations this voice turn left pending for the user to answer, and the
   * timers that stop them waiting forever.
   *
   * A call is a poor place to block: the user may have put the phone in a
   * pocket, and a turn that waits indefinitely is a session that looks wedged.
   * Each pending request therefore carries a deadline, after which it resolves
   * the way this channel resolved everything before it prompted at all.
   */
  const pendingVoiceApprovals = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const settleVoiceApproval = (requestId: string): void => {
    const timer = pendingVoiceApprovals.get(requestId);
    if (timer === undefined) {
      // Not one of ours: other interactions (secrets, host-proxy requests)
      // resolve through the same event.
      return;
    }
    clearTimeout(timer);
    pendingVoiceApprovals.delete(requestId);
    if (pendingVoiceApprovals.size === 0) {
      opts.onApprovalsResolved?.();
    }
  };
  const cleanup = () => {
    for (const timer of pendingVoiceApprovals.values()) {
      clearTimeout(timer);
    }
    pendingVoiceApprovals.clear();
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

  const requestId = uuidv7();
  const turnId = crypto.randomUUID();
  const persistTurnUserMessage = async (): Promise<string> => {
    const persistResult = await conversation.persistUserMessage({
      content: persistedContent,
      requestId,
      metadata: {
        // Durable "this turn came from an open voice session" marker; see
        // `isVoiceSessionUserMessage` for why the channel fields cannot carry it.
        voiceSessionTurn: true,
        ...(isHiddenSyntheticPrompt ? { hidden: true } : {}),
        ...(opts.voiceTelemetry
          ? {
              // Projected onto `TurnTelemetryEvent.client` by
              // `turn-events-store`. `voice_session_id` is what joins these
              // turn rows to the session's funnel rows, so a session's turn
              // count is a count of rows carrying its id, never a field
              // anyone has to keep correct.
              //
              // `os` is the standard per-platform dimension the HTTP send
              // path already fills from the same `detectClientOs()` value, so
              // a voice turn reports its platform in the column existing turn
              // analytics read rather than one only voice knows about.
              client: {
                voice: true,
                voice_session_id: opts.voiceTelemetry.sessionId,
                ...(opts.voiceTelemetry.client
                  ? { os: opts.voiceTelemetry.client }
                  : {}),
              },
            }
          : {}),
      },
    });
    return persistResult.id;
  };
  /**
   * Install this turn's per-conversation state (caller trust, call session
   * id, channel capabilities, voice control prompt, turn channel/interface
   * contexts). Runs before every persist attempt: the busy-retry path below
   * restores the prior owner's values via `restoreTurnState` for the
   * duration of its wait, then re-installs before retrying.
   */
  // The exact values this turn installs, computed once: `restoreTurnState`
  // recognizes by identity whether a field still holds THIS turn's value —
  // a field a concurrent winner overwrote is the winner's to keep.
  const voiceTurnValues = {
    assistantId: opts.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
    callSessionId: voiceSessionId,
    trustContext: opts.trustContext ?? null,
    turnChannelContext,
    turnInterfaceContext,
    // Resolved from the channel, with no voice-specific override.
    //
    // Whether a call can show a surface is a property of the call's channel,
    // not of calls in general. A phone call has no screen at all and resolves
    // to `supportsDynamicUi: false` on its own; a live-voice call is a screen
    // the user is holding, temporarily covered by the room overlay, and the
    // session minimizes that overlay when a surface is shown (see the ui-tool
    // branch of the live-voice session's `tool_use_start`).
    //
    // This one flag also drives the runtime-context `supports_dynamic_ui`
    // line, the secret-prompter's dynamic-UI branch, and the
    // task-progress-nudge hook, so a live-voice turn now reaches all of them.
    channelCapabilities: resolveChannelCapabilities(
      turnChannelContext.userMessageChannel,
      turnInterfaceContext.userMessageInterface,
    ),
    voiceCallControlPrompt,
  };
  const installVoiceTurnState = () => {
    conversation.setAssistantId(voiceTurnValues.assistantId);
    conversation.callSessionId = voiceTurnValues.callSessionId;
    conversation.setTrustContext(voiceTurnValues.trustContext);
    conversation.setCommandIntent(null);
    conversation.setTurnChannelContext(voiceTurnValues.turnChannelContext);
    conversation.setTurnInterfaceContext?.(
      voiceTurnValues.turnInterfaceContext,
    );
    conversation.setChannelCapabilities(voiceTurnValues.channelCapabilities);
    conversation.setVoiceCallControlPrompt(
      voiceTurnValues.voiceCallControlPrompt,
    );
  };
  /**
   * Capture every conversation value `installVoiceTurnState` overwrites
   * (plus `forcePromptSideEffects`, cleared by `cleanup`) so a turn that
   * never wins the conversation can put them back untouched.
   */
  const snapshotTurnState = () => ({
    assistantId: conversation.assistantId,
    callSessionId: conversation.callSessionId,
    trustContext: conversation.trustContext,
    commandIntent: conversation.commandIntent,
    turnChannelContext: conversation.getTurnChannelContext?.() ?? null,
    turnInterfaceContext: conversation.getTurnInterfaceContext?.() ?? null,
    channelCapabilities: conversation.channelCapabilities,
    voiceCallControlPrompt: conversation.voiceCallControlPrompt,
    forcePromptSideEffects: conversation.forcePromptSideEffects,
  });
  /**
   * Put back the values captured by `snapshotTurnState`. Used on every path
   * where this turn LOST the conversation to a concurrent winner (the busy
   * persist race and the retry's terminal failures): the winner is mid-run
   * with its own per-turn state, so `cleanup()`'s reset-to-defaults would
   * null its trust context and capabilities and leave it running as
   * assistantId "self". A lost race must leave the conversation exactly as
   * found. Setter order mirrors `cleanup` (trust released before the voice
   * prompt).
   */
  const restoreTurnState = (snap: ReturnType<typeof snapshotTurnState>) => {
    // Per-field compare-and-restore: `persistUserMessage` awaits actor-scoped
    // history BEFORE its busy check, so a concurrent winner can install its
    // own values between this turn's install and the busy throw. Revert a
    // field only while it still holds this turn's value (identity match
    // against `voiceTurnValues`) — anything the winner overwrote stays.
    // Reads are normalized with `?? null` on both sides: setters store null
    // vs undefined inconsistently for cleared values, and a normalization
    // miss here would either skip a restore (leaking this turn's value) or
    // clobber a winner.
    if (
      (conversation.channelCapabilities ?? null) ===
      (voiceTurnValues.channelCapabilities ?? null)
    ) {
      conversation.setChannelCapabilities(snap.channelCapabilities ?? null);
    }
    if (
      (conversation.trustContext ?? null) ===
      (voiceTurnValues.trustContext ?? null)
    ) {
      conversation.setTrustContext(snap.trustContext ?? null);
    }
    if ((conversation.commandIntent ?? null) === null) {
      conversation.setCommandIntent(snap.commandIntent ?? null);
    }
    if (
      (conversation.assistantId ?? null) ===
      (voiceTurnValues.assistantId ?? null)
    ) {
      conversation.setAssistantId(snap.assistantId ?? null);
    }
    if (
      (conversation.getTurnChannelContext?.() ?? null) ===
      voiceTurnValues.turnChannelContext
    ) {
      conversation.setTurnChannelContext(snap.turnChannelContext);
    }
    if (
      (conversation.getTurnInterfaceContext?.() ?? null) ===
      voiceTurnValues.turnInterfaceContext
    ) {
      conversation.setTurnInterfaceContext?.(snap.turnInterfaceContext);
    }
    if (
      (conversation.voiceCallControlPrompt ?? null) ===
      (voiceTurnValues.voiceCallControlPrompt ?? null)
    ) {
      conversation.setVoiceCallControlPrompt(
        snap.voiceCallControlPrompt ?? null,
      );
    }
    if (
      (conversation.callSessionId ?? null) ===
      (voiceTurnValues.callSessionId ?? null)
    ) {
      conversation.callSessionId = snap.callSessionId;
    }
    conversation.forcePromptSideEffects = snap.forcePromptSideEffects;
  };
  let messageId: string;
  // Captured before the install so a lost persist race can put the prior
  // owner's values back (see restoreTurnState).
  const preInstallState = snapshotTurnState();
  try {
    installVoiceTurnState();
  } catch (err) {
    // A partially-applied install never owned the conversation: undo it
    // value-for-value rather than resetting shared state to defaults.
    restoreTurnState(preInstallState);
    throw err;
  }
  try {
    messageId = await persistTurnUserMessage();
  } catch (err) {
    // A queued-message drain can take the lock between the wait loop
    // above and this persist — the drain reaches its own persist a few
    // microtasks after the idle transition that released this turn.
    // Within the remaining budget, wait the drained turn out and retry
    // the persist once instead of failing the barge-in.
    if (!(err instanceof Error) || err.message !== CONVERSATION_BUSY_MESSAGE) {
      // Non-busy persist failure: no concurrent turn took the lock, so
      // this turn still owns the state it installed. Release it to
      // defaults, matching the agent-loop finally of a turn that ran.
      cleanup();
      throw err;
    }
    // A busy failure ALWAYS means a live winner holds the lock — even with
    // the wait budget exhausted, its state must be restored rather than
    // reset to defaults; `waitOutProcessingLock` throws the byte-identical
    // busy error immediately when nothing remains of the budget.
    // The busy error means a concurrent turn won the lock race and is
    // running. It must not run with this turn's phone prompt, caller
    // trust, or turn channel/interface contexts, so the winner's values
    // are put back for the duration of the wait.
    restoreTurnState(preInstallState);
    // Throws the exact busy error on an exhausted budget and the exact
    // turn-aborted error on abort; the restore above already left the
    // conversation exactly as the winner had it.
    await waitOutProcessingLock();
    // Re-capture before re-installing: the winner may have changed the
    // conversation state while it held the lock.
    const preRetryState = snapshotTurnState();
    try {
      installVoiceTurnState();
      messageId = await persistTurnUserMessage();
    } catch (retryErr) {
      // The retry lost again (or failed outright) without this turn ever
      // running — leave the conversation exactly as the winner left it.
      restoreTurnState(preRetryState);
      throw retryErr;
    }
  }
  dispatch.persistDoneAt = Date.now();
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
  let lastError: string | null = null;
  conversation.updateClient(async (msg: AssistantEvent) => {
    // The user (or anything else) answered: stop the fallback from firing on a
    // request that is already decided.
    if (msg.type === "interaction_resolved") {
      settleVoiceApproval(msg.requestId);
    }
    if (msg.type === "confirmation_request") {
      // Broadcast the request BEFORE resolving it: resolution synchronously
      // broadcasts `interaction_resolved` (handleConfirmationResponse →
      // prompter → pending-interactions), and attached clients (e.g. the
      // web app behind a live-voice room) clear their approval card only on
      // that event — resolving first would put `interaction_resolved`
      // before `confirmation_request` on the wire, leaving an orphaned card
      // whose Allow/Deny buttons 404.
      broadcastMessage(msg);
      if (!isGuardian) {
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
        // A local live-voice session (vellum channel) belongs to the device
        // owner's own authenticated client, so a non-guardian turn there
        // means guardian trust could not be resolved (fresh install,
        // gateway unreachable) — tell the model verification failed rather
        // than implying the owner lacks guardian access.
        conversation.handleConfirmationResponse(msg.requestId, "deny", {
          decisionContext:
            turnChannelContext.userMessageChannel === "vellum"
              ? `Permission denied for "${msg.toolName}": the caller's permissions could not be verified for this voice session, so side-effect tools are unavailable. In your next assistant reply, briefly say you could not verify permissions for this action right now and suggest retrying or completing it in text chat.`
              : `Permission denied for "${msg.toolName}": this voice call does not have interactive approval capabilities. Side-effect tools are not available for non-guardian voice callers. In your next assistant reply, explain briefly that this action requires guardian-level access and cannot be performed during this call.`,
        });
        return;
      }
      // A live-voice call has a screen, so a consequential action can be put
      // to the user instead of decided for them.
      //
      // Everything used to be allowed here on the strength of the caller being
      // a guardian, which made a voice call the one surface where a tool that
      // writes to the workspace or reaches the host never had to ask. Only
      // *sensitive* reach prompts: gating every confirmation would interrupt a
      // conversation constantly, and the tools that read or render were never
      // the reason approval exists.
      //
      // Phone keeps the old behavior in full. There is no screen on that
      // channel, so a prompt there is a question nobody can answer.
      // The workspace root is what makes an escape visible. A sandbox file
      // tool pointed outside the workspace reaches the host filesystem on a
      // non-containerized install, and `sensitiveToolReach` can only see that
      // when it is given the boundary to compare against: without it,
      // `file_read { path: "/etc/hosts" }` classifies as `none` and would fall
      // through to the auto-allow this branch exists to prevent.
      const workspaceRoot = conversation.workingDir;
      const reach = sensitiveToolReach(
        msg.toolName,
        // Absent on requests that do not come from the tool pipeline (proxy
        // and network prompters). Unknown reads as the more consequential of
        // the two: the cost of being wrong is a prompt the user did not need,
        // against an unreviewed action on their machine.
        msg.executionTarget ?? "host",
        msg.input,
        workspaceRoot,
      );
      const canPrompt = turnChannelContext.userMessageChannel === "vellum";
      // Fail closed on a missing boundary for the same reason: with no
      // workspace root there is no way to tell an ordinary write from an
      // escape, and the safe reading of "cannot tell" is "ask". A real
      // conversation always has one, so this is a guard rather than a path.
      if (canPrompt && (reach !== "none" || !workspaceRoot)) {
        log.info(
          { turnId, toolName: msg.toolName, reach },
          "Prompting guardian voice caller for a sensitive tool",
        );
        // Left pending: the request is already broadcast, so the approval card
        // an attached client renders is now answerable rather than cleared a
        // moment later by this handler.
        //
        // Announced separately, because "a card exists" and "the user can see
        // it" are different things on a channel whose call covers the app.
        opts.onApprovalPending?.(msg.requestId);
        const timer = setTimeout(() => {
          pendingVoiceApprovals.delete(msg.requestId);
          if (pendingVoiceApprovals.size === 0) {
            opts.onApprovalsResolved?.();
          }
          log.info(
            { turnId, toolName: msg.toolName },
            "Voice approval timed out — falling back to the guardian allow",
          );
          conversation.handleConfirmationResponse(msg.requestId, "allow", {
            decisionContext: `Permission approved for "${msg.toolName}": this is a verified guardian voice call and the approval prompt went unanswered.`,
          });
        }, VOICE_APPROVAL_TIMEOUT_MS);
        // Never hold the process open for a prompt nobody is looking at.
        timer.unref?.();
        pendingVoiceApprovals.set(msg.requestId, timer);
        return;
      }

      log.info(
        { turnId, toolName: msg.toolName },
        "Auto-approving confirmation request for guardian voice turn",
      );
      conversation.handleConfirmationResponse(msg.requestId, "allow", {
        decisionContext: `Permission approved for "${msg.toolName}": this is a verified guardian voice call.`,
      });
      return;
    }
    if (msg.type === "secret_request") {
      // Auto-resolved rather than prompted, on every voice channel.
      //
      // A phone call cannot render a secret field at all. A live-voice call
      // now can (its channel resolves `supportsDynamicUi` true), so this is
      // where the prompt would surface, and it deliberately does not yet:
      // typing a credential into a screen you reached by minimizing a call is
      // a flow that needs designing, not a flag flip. Resolving with no secret
      // leaves the tool to fail the way it does today.
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

  // Pairs the front-door leg's toolsDisabledDepth increment with its
  // decrement in the IIFE's finally, even when runAgentLoop throws.
  let frontDoorToolsSuppressed = false;

  // The reserved assistant row of the leg's LLM call, captured from
  // `assistant_turn_start`. Voice legs are single-call in practice (the
  // front-door leg is toolless), so the last id observed is the leg's
  // transcript row — the target of the teardown transcript-hygiene pass.
  let reservedAssistantRowId: string | null = null;
  // Set by the handle's discard(): the whole leg must leave no trace.
  let discarded = false;

  // Verdict-first gate on the hub broadcast. A front-door leg's raw stream
  // carries its routing verdict, so hub subscribers (web, passive devices)
  // read it through the gate and see only the text the caller heard. Every
  // other leg, including the escalated continuation that answers for real,
  // broadcasts its deltas untouched.
  const frontDoorStreamGate =
    opts.routingLeg === "front-door"
      ? createFrontDoorStreamGate(opts.unifiedVerdict === true)
      : null;

  /**
   * Broadcast one agent-loop event to hub subscribers, holding a front-door
   * leg's control-plane text back at the boundary rather than emitting it and
   * repairing the transcript afterwards. Text released by the gate travels as
   * an ordinary delta on the leg's own reserved row, so a client that renders
   * the stream lands on the same text the teardown hygiene pass persists.
   */
  const broadcastLegEvent = (msg: AssistantEvent): void => {
    if (frontDoorStreamGate === null || msg.type !== "assistant_text_delta") {
      broadcastMessage(msg);
      return;
    }
    const released = frontDoorStreamGate.push(msg.text);
    if (released.length > 0) {
      broadcastMessage({ ...msg, text: released });
    }
  };

  /**
   * Teardown transcript hygiene. Runs after the agent loop has fully
   * settled — including the stranded-content fold that finalizes an aborted
   * leg's row with its raw partial output — and before `settleTurnTeardown`
   * releases the next leg:
   *
   * - A discarded leg (unified front-door hold verdict) deletes its
   *   reserved assistant row: `discard` already rolled back the user row,
   *   and without this the fold leaves a stray row holding the leg's
   *   unspoken partial output (typically the bare hold token).
   * - A front-door leg that escalated reduces to its capped spoken bridge —
   *   never the verdict token or the text streamed past the cap (issue
   *   #37850). A row with no spoken bridge (canned-fallback case — that
   *   bridge is audio-only) is deleted.
   * - Any leg whose row ENDS with the `[-1]` minimize marker (swallowed
   *   before TTS on the live path) has its text blocks rewritten through
   *   `stripInternalSpeechMarkers` so the marker never renders in the chat
   *   transcript. This covers front-door answers too: that leg is never
   *   taught the marker, but it can parrot one from visible conversation
   *   history, and the parroted marker is never spoken and never minimizes
   *   the room. Deliberately scoped to that marker: rows without it
   *   persist byte-identical.
   *
   * After a rewrite, in-memory history is reloaded from the clean DB before
   * the escalated leg — blocked on this turn's teardown — snapshots it, so
   * the quality model never sees the marker text either. Best-effort: a
   * hiccup here must not escalate into a turn-level failure.
   *
   * This pass owns the PERSISTED row, which the agent loop writes from the
   * model's raw output regardless of what was broadcast. The live hub stream
   * is gated separately by `broadcastLegEvent`, so the refetch this pass
   * publishes confirms text a subscriber already holds instead of correcting
   * it.
   */
  const finalizeVoiceLegTranscript = async (): Promise<void> => {
    if (reservedAssistantRowId == null) {
      if (discarded || opts.routingLeg === "front-door") {
        // A leg the pass should cover never announced a reserved row: either
        // the leg died before its LLM call, or `assistant_turn_start` did not
        // reach this bridge — the latter would leave raw verdict tokens in
        // the transcript, so make the skip loud.
        log.warn(
          { turnId, routingLeg: opts.routingLeg ?? null, discarded },
          "Voice leg transcript hygiene skipped: no reserved row observed",
        );
      }
      return;
    }
    try {
      let action = "none";
      if (discarded) {
        deleteMessageById(reservedAssistantRowId);
        action = "delete_discarded";
      } else {
        const row = getMessageById(reservedAssistantRowId, opts.conversationId);
        const cut =
          row && opts.routingLeg === "front-door"
            ? cutFrontDoorContentAtVerdict(row.content)
            : null;
        if (!row) {
          action = "row_missing";
        } else if (cut) {
          if (cut.spokenText.length > 0) {
            updateMessageContent(
              reservedAssistantRowId,
              JSON.stringify(cut.blocks),
            );
            action = "rewrite_spoken";
          } else {
            deleteMessageById(reservedAssistantRowId);
            action = "delete_empty";
          }
        } else if (
          // Terminal position only — mirrors the live latch in
          // createControlMarkerHoldback: a reply whose CONTENT contains
          // "[-1]" mid-text never minimized the room, so its transcript
          // keeps that content untouched too. Front-door answer rows (no
          // verdict token to cut) take this branch as well.
          joinedTextOfBlocks(row.content)
            .trimEnd()
            .endsWith(MINIMIZE_ROOM_MARKER)
        ) {
          // Terminal marker first (boundary-aware — it may span text blocks),
          // then the per-block strip for any interior complete markers.
          const cleaned = trimOuterTextEdges(
            stripMarkersFromBlocks(stripTerminalMinimizeMarker(row.content)),
          );
          // A marker-only reply (the model said nothing beyond "[-1]") strips
          // to nothing at all; keeping the row would render a blank assistant
          // bubble, so delete it like the front-door empty case. Any surviving
          // block — including non-text blocks like tool_use — keeps the row.
          if (cleaned.length === 0) {
            deleteMessageById(reservedAssistantRowId);
            action = "delete_empty";
          } else {
            updateMessageContent(
              reservedAssistantRowId,
              JSON.stringify(cleaned),
            );
            action = "strip_minimize_marker";
          }
        }
      }
      // Main legs run the pass on every voice turn; keep the no-op case
      // out of the logs.
      const isMainLegNoOp =
        action === "none" && !discarded && opts.routingLeg !== "front-door";
      if (!isMainLegNoOp) {
        log.info(
          {
            turnId,
            messageId: reservedAssistantRowId,
            routingLeg: opts.routingLeg ?? null,
            discarded,
            action,
          },
          "Voice leg transcript hygiene",
        );
      }
      if (action !== "none" && action !== "row_missing") {
        await conversation.loadFromDb();
        publishConversationMessagesChanged(opts.conversationId);
      }
    } catch (err) {
      log.warn(
        { err, turnId, messageId: reservedAssistantRowId },
        "Voice leg transcript hygiene failed",
      );
    }
  };

  // Fire-and-forget the agent loop
  void (async () => {
    const loopEnterAt = Date.now();
    log.info(
      {
        turnId,
        conversationId: opts.conversationId,
        routingLeg: opts.routingLeg ?? null,
        sinceLaunchMs:
          opts.launchedAtMs != null ? loopEnterAt - opts.launchedAtMs : null,
        bridgeMs: loopEnterAt - dispatch.enteredAt,
        conversationMs: dispatch.conversationReadyAt - dispatch.enteredAt,
        admissionWaitMs:
          dispatch.admissionClearAt - dispatch.conversationReadyAt,
        persistMs: dispatch.persistDoneAt - dispatch.admissionClearAt,
        preLoopMs: loopEnterAt - dispatch.persistDoneAt,
      },
      "Voice turn dispatch timing",
    );
    try {
      // Non-guardian voice callers force side-effect tools to prompt so the
      // auto-deny handler above reliably sees a confirmation_request. Without
      // this, a broad allow trust rule (e.g. wildcard bash) would let
      // side-effect tools execute without ever emitting an event for the
      // auto-deny / scoped-grant handler to intercept. Set inside the
      // try/finally so a failed setup before this point cannot leak the
      // flag into subsequent non-voice turns on the same conversation.
      conversation.forcePromptSideEffects = !isGuardian;
      // The front-door leg runs toolless: no schemas on the wire and the
      // executor gate closed (same depth-counter bracket the pointer-turn
      // runner uses). Anything needing a tool must escalate — the capability
      // digest in its control prompt tells it what the escalated leg can do.
      if (opts.routingLeg === "front-door") {
        conversation.toolsDisabledDepth++;
        frontDoorToolsSuppressed = true;
      }
      await conversation.runAgentLoop(persistedContent, messageId, {
        onEvent: (msg: AssistantEvent) => {
          if (msg.type === "assistant_turn_start") {
            reservedAssistantRowId = msg.messageId;
          } else if (msg.type === "error") {
            lastError = msg.message;
          } else if (msg.type === "conversation_error") {
            lastError = msg.userMessage;
          }
          if (frontDoorStreamGate !== null && msg.type === "message_complete") {
            // A leg that completed mid-bridge (a holding phrase with no
            // sentence terminator) still hands off and speaks what arrived,
            // so release it ahead of the completion frame. A cancelled leg
            // never hands off, and correspondingly never flushes.
            const trailing = frontDoorStreamGate.finish();
            if (trailing.length > 0) {
              broadcastMessage({
                type: "assistant_text_delta",
                text: trailing,
                ...(reservedAssistantRowId !== null
                  ? { messageId: reservedAssistantRowId }
                  : {}),
                conversationId: opts.conversationId,
              });
            }
          }
          broadcastLegEvent(msg);

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
            eventSink.onToolUse(msg.toolName, msg.input, msg.toolUseId);
          } else if (msg.type === "tool_result") {
            eventSink.onToolResult({
              toolName: msg.toolName,
              toolUseId: msg.toolUseId,
              isError: msg.isError,
              resultPreview: truncate(
                msg.result,
                TOOL_RESULT_PREVIEW_MAX_CHARS,
              ),
            });
          }
          // Note: tool_use_preview_start is intentionally not handled here.
          // Voice only reacts to the definitive tool_use_start event.
        },
        // Front-door legs resolve through their own call site, whose shipped
        // default pins the latency-class verdict model (see
        // call-site-defaults.ts `voiceFrontDoor`); every other leg keeps the
        // ordinary call-agent resolution.
        callSite:
          opts.routingLeg === "front-door" ? "voiceFrontDoor" : "callAgent",
        // The escalation-continuation prompt is a transcript-suppressed machine
        // signal (persisted `hidden`), so flag the turn to match — keeps
        // prompt-as-user-speech consumers (e.g. title generation) from treating
        // it as user speech.
        ...(isHiddenSyntheticPrompt ? { isHiddenPrompt: true } : {}),
        // Triage-and-escalate routing pins this turn to the fast front-door or
        // strong escalation profile. `forceOverrideProfile` floats it above the
        // callAgent call-site layers (callAgent is not `mainAgent`, so the
        // override would otherwise sit below the call-site profile).
        ...(opts.overrideProfile != null
          ? {
              overrideProfile: opts.overrideProfile,
              forceOverrideProfile: true,
            }
          : {}),
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
      if (frontDoorToolsSuppressed) {
        conversation.toolsDisabledDepth--;
      }
      cleanup();
      await finalizeVoiceLegTranscript();
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

  const discardFn = async () => {
    if (discarded) {
      return;
    }
    discarded = true;
    abortFn();
    try {
      // Same rollback pattern as the pointer-turn runner: delete the row,
      // then rebuild in-memory history from the clean DB (a plain pop is
      // fragile against concurrent compaction reassigning the array).
      deleteMessageById(messageId);
      await conversation.loadFromDb();
      publishConversationMessagesChanged(opts.conversationId);
    } catch (err) {
      log.warn(
        { err, turnId, messageId },
        "Voice turn discard could not roll back the persisted user message",
      );
    }
  };

  return {
    turnId,
    abort: abortFn,
    discard: discardFn,
  };
}
