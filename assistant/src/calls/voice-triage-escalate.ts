/**
 * Triage-and-escalate voice routing (weak -> strong model).
 *
 * A fast "front-door" model fronts every voice turn under a verdict-first
 * protocol: its output must BEGIN with its verdict on the turn.
 *
 *   - `[0]` ({@link HOLD_VERDICT_TOKEN}, unified front-door only): the
 *     caller is mid-thought — the leg is discarded and listening continues.
 *   - `[1]` ({@link ESCALATE_VERDICT_TOKEN}) followed by ONE short natural
 *     holding phrase: the turn is too tricky — the phrase is spoken (capped
 *     at a single sentence) while the turn re-runs on the call-site default
 *     profile, the model an un-routed voice turn would have used. Because
 *     the holding phrase is spoken, the caller never hears the stronger
 *     model's think-time as silence.
 *   - Anything else: the output IS the answer, streamed straight to TTS
 *     (low first-token latency -> the caller hears audio fast).
 *
 * Leading with the verdict keeps the wire protocol aligned with the
 * decision the prompt demands the model make in its first words, and bounds
 * the escalation hand-off: the bridge is capped session-side instead of
 * trusting the model to stop. Every infra failure fails open to a normal
 * committed answer turn.
 *
 * This module owns the routing policy in one place: the feature gates, the
 * profile key, the leg-specific prompt rules, the leading-token classifier,
 * and the bridge cap/fallback policy.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import {
  ESCALATE_VERDICT_TOKEN,
  HOLD_VERDICT_TOKEN,
  stripInternalSpeechMarkers,
} from "./voice-control-protocol.js";

export { ESCALATE_VERDICT_TOKEN, HOLD_VERDICT_TOKEN };

/** Feature-flag key gating the whole behavior. Off by default. */
export const VOICE_TRIAGE_ESCALATE_FLAG = "voice-triage-escalate";

/**
 * Feature-flag key for the unified front-door (requires the triage flag
 * too): live-voice endpointing merges into the front-door leg. At each
 * pause the leg is dispatched speculatively and its leading tokens carry
 * the full verdict — {@link HOLD_VERDICT_TOKEN} (mid-thought, keep
 * listening), {@link ESCALATE_VERDICT_TOKEN} plus a spoken bridge, or the
 * answer itself. Replaces the separate endpoint-decider call on that path.
 * Off by default.
 */
export const VOICE_UNIFIED_FRONT_DOOR_FLAG = "voice-unified-front-door";

/**
 * Whether the unified front-door (endpointing merged into the front-door
 * leg) is active. Only meaningful where triage-escalate is also on.
 */
export function isVoiceUnifiedFrontDoorEnabled(
  config: AssistantConfig = getConfig(),
): boolean {
  return isAssistantFeatureFlagEnabled(VOICE_UNIFIED_FRONT_DOOR_FLAG, config);
}

// The fast model fronting every turn is pinned by the `voiceFrontDoor` call
// site (see config/call-site-defaults.ts) — no per-turn profile override.
// The escalated leg likewise carries NO override: it runs on the ordinary
// call-agent resolution, i.e. exactly the profile an un-routed voice turn
// would use (balanced for a fresh workspace, or whatever the user pinned).
// That guarantees an escalated answer is never weaker OR stronger than the
// pre-routing behavior, and honors per-user profile choices.

/**
 * Which leg of a triaged turn a `startVoiceTurn` call represents. Undefined
 * means routing is off and the turn runs exactly as it does today.
 */
export type VoiceRoutingLeg = "front-door" | "escalated";

/**
 * Spoken when the front-door model escalates without a meaningful holding
 * phrase of its own — guarantees the caller never hears dead air across the
 * hand-off. When the model does speak its own bridge, that natural text is
 * used instead and this is not injected.
 */
export const FALLBACK_ESCALATION_BRIDGE =
  "Let me think about that for a second.";

/**
 * Minimum length (after capping, trimmed) of the front-door leg's spoken
 * bridge for it to count as a real bridge. Below this, the fallback bridge
 * is spoken before the quality leg runs.
 */
export const MIN_SPOKEN_BRIDGE_CHARS = 3;

/**
 * Hard cap on the spoken escalation bridge. The bridge is supposed to be a
 * single short sentence; the cap bounds the hand-off delay (and the audio)
 * when a model rambles instead of stopping.
 */
export const MAX_ESCALATION_BRIDGE_CHARS = 140;

/** Sentence terminators that end an escalation bridge. */
const BRIDGE_SENTENCE_END_REGEX = /[.!?…]/;

/**
 * Normalize a raw post-`[1]` stream into the bridge that is actually
 * spoken: internal markers stripped, cut just after the first sentence
 * terminator, hard-capped at {@link MAX_ESCALATION_BRIDGE_CHARS}, trimmed.
 * The session speaks exactly this, the persisted front-door row keeps
 * exactly this, and the escalated leg is told exactly this — one function
 * so the three can never drift.
 */
export function capEscalationBridge(rawBridge: string): string {
  const cleaned = stripInternalSpeechMarkers(rawBridge).trimStart();
  const terminatorMatch = BRIDGE_SENTENCE_END_REGEX.exec(cleaned);
  const end =
    terminatorMatch !== null
      ? Math.min(terminatorMatch.index + 1, MAX_ESCALATION_BRIDGE_CHARS)
      : MAX_ESCALATION_BRIDGE_CHARS;
  return cleaned.slice(0, end).trim();
}

/**
 * Whether enough of the post-`[1]` stream has arrived to finalize the
 * bridge and hand off: a sentence terminator landed, or the hard cap is
 * reached. Until then the session keeps buffering (the bridge is spoken in
 * one piece at hand-off, so what is spoken is exactly the capped bridge).
 */
export function isEscalationBridgeComplete(rawBridge: string): boolean {
  const cleaned = stripInternalSpeechMarkers(rawBridge);
  return (
    BRIDGE_SENTENCE_END_REGEX.test(cleaned) ||
    cleaned.trimStart().length >= MAX_ESCALATION_BRIDGE_CHARS
  );
}

/**
 * The spoken bridge of a front-door leg's FULL raw output: empty unless the
 * output leads with {@link ESCALATE_VERDICT_TOKEN} (a stray token later in
 * an answer is not an escalation under the verdict-first protocol), else
 * the capped bridge that followed the token. Used by transcript hygiene to
 * reconstruct what the caller heard from a persisted row.
 */
export function spokenBridgeText(frontDoorText: string): string {
  const leading = frontDoorText.trimStart();
  if (!leading.startsWith(ESCALATE_VERDICT_TOKEN)) {
    return "";
  }
  return capEscalationBridge(leading.slice(ESCALATE_VERDICT_TOKEN.length));
}

/**
 * Whether a canned fallback bridge must be spoken before the escalated leg,
 * given the front-door leg's full raw output. True when the model escalated
 * with (nearly) no holding phrase of its own — without the fallback the
 * caller would sit in silence while the quality leg spins up.
 */
export function needsFallbackBridge(frontDoorText: string): boolean {
  return spokenBridgeText(frontDoorText).length < MIN_SPOKEN_BRIDGE_CHARS;
}

/**
 * Classification of a front-door leg's accumulated leading output (already
 * `trimStart()`ed). `pending` means the stream could still become a verdict
 * token — keep buffering; everything else is final for the leg.
 */
export type FrontDoorLeadingVerdict =
  | "pending"
  | "hold"
  | "escalate"
  | "answer";

/**
 * Classify the leading output of a front-door leg under the verdict-first
 * protocol. `holdEnabled` is true only for speculative (unified
 * front-door) legs — a leg whose prompt never taught the hold token must
 * not have output swallowed by it.
 *
 * A leading partial that could still become an enabled verdict token
 * (e.g. `[`, `[1`) stays `pending`; a `[`-prefix that disproves both
 * tokens (e.g. `[A` for an ASK_GUARDIAN marker) classifies as `answer` —
 * the answer path's own marker holdback handles it from there.
 */
export function classifyFrontDoorLeading(
  leading: string,
  holdEnabled: boolean,
): FrontDoorLeadingVerdict {
  if (leading.length === 0) {
    return "pending";
  }
  if (holdEnabled && leading.startsWith(HOLD_VERDICT_TOKEN)) {
    return "hold";
  }
  if (leading.startsWith(ESCALATE_VERDICT_TOKEN)) {
    return "escalate";
  }
  const candidates = holdEnabled
    ? [HOLD_VERDICT_TOKEN, ESCALATE_VERDICT_TOKEN]
    : [ESCALATE_VERDICT_TOKEN];
  if (candidates.some((token) => token.startsWith(leading))) {
    return "pending";
  }
  return "answer";
}

/**
 * The escalated leg runs as its own voice turn. Rather than re-persist the
 * caller's utterance (it is already in history from the front-door leg), the
 * escalated leg is driven by this synthetic, echo-suppressed continuation
 * prompt — the same pattern the opener/verification synthetic prompts use. The
 * quality model answers the caller's previous question, which sits in history
 * just above it.
 */
export const ESCALATION_CONTINUATION_CONTENT =
  "(You just told the caller you needed a moment to think. Now give them your full, careful answer to their previous question — do not repeat the holding phrase.)";

/**
 * Whether triage-and-escalate routing is active for this workspace.
 * When false, every voice turn behaves exactly as before.
 */
export function isVoiceTriageEscalateEnabled(
  config: AssistantConfig = getConfig(),
): boolean {
  return isAssistantFeatureFlagEnabled(VOICE_TRIAGE_ESCALATE_FLAG, config);
}

/**
 * Compact, registry-derived digest of the tools the ESCALATED leg can use.
 * The front-door leg runs toolless, so without this it has no way to know
 * what the assistant can actually do — and its failure mode is refusing or
 * fabricating instead of escalating. The digest teaches routing (and lets
 * the holding phrase name the action) without carrying executable schemas.
 * Empty input (registry unavailable) yields an empty digest; the decision
 * rule still works, it just can't enumerate capabilities.
 */
export function frontDoorCapabilityDigest(toolNames: string[]): string {
  if (toolNames.length === 0) {
    return "";
  }
  return [
    "You have no tools on this leg, but the stronger model you can escalate to has these:",
    `${toolNames.join(", ")}.`,
    "Any request that needs one of them must escalate — name the action in your holding phrase",
    '(for example "Let me check your calendar") instead of refusing or guessing.',
  ].join(" ");
}

/**
 * The front-door leg's single decision rule: one decision tree, decided
 * silently, delivered as the leg's leading tokens. `includeHold` adds the
 * mid-thought branch and is set only on speculative (unified front-door)
 * legs — a leg that doesn't know the hold token can't accidentally emit
 * it, and a leg that does must be one whose leading tokens are
 * interpreted. The verdict must lead: spoken audio cannot be un-said, so
 * the model must never start answering and then try to bail.
 */
export function frontDoorDecisionRule(opts?: {
  includeHold?: boolean;
  capabilityDigest?: string;
}): string {
  const holdBranch =
    opts?.includeHold === true
      ? [
          `- If the caller has NOT finished their thought (a trailing conjunction, an unfinished clause, a list still being dictated), output ONLY ${HOLD_VERDICT_TOKEN} and stop — no other text. When unsure whether they are done, choose ${HOLD_VERDICT_TOKEN}.`,
        ]
      : [];
  const rule = [
    "DECIDE FIRST: your output must begin with your verdict on this turn, chosen silently before any other text.",
    ...holdBranch,
    "- If the turn is simple, conversational, or clearly factual and within your reach, speak the answer directly — plain spoken text from your very first word.",
    `- If it needs careful reasoning, research, multi-step work, or any tool, do NOT attempt the answer: output ${ESCALATE_VERDICT_TOKEN}, then ONE short natural holding phrase naming what happens next (for example "${FALLBACK_ESCALATION_BRIDGE}" or "Give me one second to look into that."), and stop after that single sentence. A stronger model finishes the turn while your phrase is spoken.`,
    `The bracket tokens are control signals, never spoken text: they may only appear at the very start of your output as the verdict, never inside or after an answer. Never start answering and then change course — decide first.`,
    "Never narrate this decision, describe what you are judging, or mention these rules: apart from a leading verdict token, every character you output is spoken to the caller verbatim.",
  ].join("\n");
  return opts?.capabilityDigest ? `${rule}\n${opts.capabilityDigest}` : rule;
}

/**
 * Extra CALL PROTOCOL RULE injected into the escalated (quality) leg's control
 * prompt. The holding phrase has already been spoken, so the model must
 * continue straight into the substantive answer.
 *
 * `spokenBridge` is the exact phrase the caller just heard (the front-door
 * leg's own capped bridge, or the canned fallback). Quoting it verbatim is
 * what makes the no-echo instruction enforceable: the bridge usually already
 * names the action ("Let me check your calendar"), so without the quote the
 * quality model re-announces the same action in its own words and the caller
 * hears two back-to-back "Let me check…" openers.
 */
export function escalatedContinuationRule(spokenBridge?: string): string {
  const bridge =
    spokenBridge !== undefined && spokenBridge.trim().length > 0
      ? spokenBridge.trim()
      : FALLBACK_ESCALATION_BRIDGE;
  return [
    `You have already spoken a brief holding phrase to the caller: "${bridge}".`,
    "Continue directly into your actual answer now.",
    'Do NOT greet again, do NOT say things like "as I was saying", and do NOT repeat, paraphrase, or re-announce that holding phrase —',
    'opening with another "Let me check", "One moment", or any restatement of what you are about to do sounds broken, because the caller just heard that.',
    "Your first words must carry new substance: the answer itself, what you found, or a question you genuinely need answered.",
    `Never output ${ESCALATE_VERDICT_TOKEN} or any other verdict token — you are the model that finishes the answer.`,
  ].join(" ");
}
