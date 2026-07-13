/**
 * Triage-and-escalate voice routing (weak -> strong model) — Phase 1.
 *
 * A fast "front-door" model fronts every phone-call turn. It answers simple
 * turns outright (low first-token latency -> the caller hears audio fast).
 * When a turn is too tricky, the front-door model speaks a brief natural
 * holding phrase, appends the `[ESCALATE]` marker, and stops. The call
 * controller then re-runs the same turn on the stronger "quality" model, whose
 * answer streams into the same TTS pipe. Because the holding phrase is spoken,
 * the caller never hears the quality model's think-time as silence.
 *
 * This module owns the routing policy in one place: the feature gate, the two
 * profile keys, the leg-specific prompt fragments, and the fallback bridge.
 *
 * Phase 2/3 (not implemented here): fire the quality model the instant the
 * marker is detected so its prefill overlaps the spoken bridge; model-generated
 * (rather than canned) fallback bridges; a triage-threshold eval harness; and
 * extending the orchestration to in-app live voice (`live-voice/`), which drives
 * `startVoiceTurn` through its own session rather than the call controller.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { DefaultProfileKey } from "../config/default-profile-names.js";
import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import {
  ESCALATE_MARKER,
  stripInternalSpeechMarkers,
} from "./voice-control-protocol.js";

/** Feature-flag key gating the whole behavior. Off by default. */
export const VOICE_TRIAGE_ESCALATE_FLAG = "voice-triage-escalate";

/** Fast/weak profile that fronts every turn when the flag is on. */
export const FRONT_DOOR_PROFILE: DefaultProfileKey = "cost-optimized";

/** Strong/quality profile a tricky turn escalates to. */
export const ESCALATION_PROFILE: DefaultProfileKey = "quality-optimized";

/**
 * Which leg of a triaged turn a `startVoiceTurn` call represents. Undefined
 * means routing is off and the turn runs exactly as it does today.
 */
export type VoiceRoutingLeg = "front-door" | "escalated";

/**
 * Spoken when the front-door model emits `[ESCALATE]` without a meaningful
 * holding phrase of its own — guarantees the caller never hears dead air
 * across the hand-off. When the model does speak its own bridge, that natural
 * text is used instead and this is not injected.
 */
export const FALLBACK_ESCALATION_BRIDGE =
  "Let me think about that for a second.";

/**
 * Minimum length (after marker stripping, trimmed) of the front-door leg's
 * spoken text for it to count as a real bridge. Below this, the fallback
 * bridge is injected before the quality leg runs.
 */
export const MIN_SPOKEN_BRIDGE_CHARS = 3;

/**
 * Whether a canned fallback bridge must be spoken before the escalated leg,
 * given the front-door leg's full response text.
 *
 * Only the text BEFORE `[ESCALATE]` was actually spoken — the controller
 * suppresses everything after the marker from TTS — so the decision is based on
 * that slice, not the full response (which may carry ignored post-marker text
 * the model emitted despite being told to stop). Without this, a bare
 * `[ESCALATE]` followed by ignored weak text would skip the fallback and leave
 * the caller in silence while the quality leg spins up.
 */
export function needsFallbackBridge(frontDoorText: string): boolean {
  const markerIdx = frontDoorText.indexOf(ESCALATE_MARKER);
  const spokenBridge = stripInternalSpeechMarkers(
    markerIdx === -1 ? frontDoorText : frontDoorText.slice(0, markerIdx),
  ).trim();
  return spokenBridge.length < MIN_SPOKEN_BRIDGE_CHARS;
}

/**
 * The escalated leg runs as its own voice turn. Rather than re-persist the
 * caller's utterance (it is already in history from the front-door leg), the
 * escalated leg is driven by this synthetic, echo-suppressed continuation
 * prompt — the same pattern the opener/verification synthetic prompts use. The
 * quality model answers the caller's previous question, which sits in history
 * just above it.
 *
 * Phase 2 could collapse the two legs into a single persisted turn; Phase 1
 * keeps each leg a normal, independently-understood `startVoiceTurn`.
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
 * Extra CALL PROTOCOL RULE injected into the front-door leg's control prompt.
 * The decision must happen up front: the model triages BEFORE it starts
 * answering so it never speaks half an answer and then bails — spoken audio
 * cannot be un-said. Escalation triggers include anything needing careful
 * reasoning, research, or a tool it is unsure of, so the weak model never
 * fabricates an answer that actually required a tool.
 */
export function frontDoorTriageRule(): string {
  return [
    "TRIAGE FIRST: Before you begin answering, judge whether this turn is within your reach.",
    "If it is simple, conversational, or clearly factual, just answer it normally.",
    "If it needs careful reasoning, research, multi-step work, or a tool you are unsure how to use,",
    `do NOT attempt the answer. Instead say one short, natural holding phrase out loud (for example "${FALLBACK_ESCALATION_BRIDGE}" or "Give me one second to look into that"), then append ${ESCALATE_MARKER} and stop.`,
    `Make this decision in your first words. Never start answering and then emit ${ESCALATE_MARKER}. Everything you say before ${ESCALATE_MARKER} is spoken to the caller; everything after it is discarded.`,
  ].join(" ");
}

/**
 * Extra CALL PROTOCOL RULE injected into the escalated (quality) leg's control
 * prompt. The holding phrase has already been spoken, so the model must
 * continue straight into the substantive answer.
 */
export function escalatedContinuationRule(): string {
  return [
    "You have already spoken a brief holding phrase to the caller (something like",
    `"${FALLBACK_ESCALATION_BRIDGE}").`,
    "Continue directly into your actual answer now.",
    'Do NOT greet again, do NOT repeat the holding phrase, and do NOT say things like "as I was saying".',
    `Never emit ${ESCALATE_MARKER} — you are the model that finishes the answer.`,
  ].join(" ");
}
