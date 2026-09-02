/**
 * Live-voice session telemetry vocabulary: the single source of truth for the
 * step names, funnel version, and end-reason values the live-voice session
 * emitter uses.
 *
 * Rides the existing onboarding telemetry substrate (`type: "onboarding"`),
 * exactly as `activation-funnel.ts` does: the backend stores `step_name` and
 * `funnel_version` as open strings, so this funnel needs no platform serializer
 * and no wire-contract change.
 *
 * **Duration is not a field.** The onboarding event shape carries no numeric
 * slot for it, so the two events below are keyed by the live-voice `sessionId`
 * in `session_id` and the warehouse subtracts their `recorded_at` stamps. That
 * yields exact percentiles rather than the bucketed-string dimension the tips
 * and tour funnels pack into `screen`.
 *
 * **Turn count is not a field either.** It comes from the `turn` telemetry
 * events voice turns already produce, which carry this session's id in their
 * `client` bag (see `voice-session-bridge.ts`), so a turn count is a count of
 * those rows rather than a number restated here.
 *
 * A session that starts and never ends is **censored, not infinite**: a daemon
 * crash or kill emits no end event, so downstream duration math must drop
 * unmatched `started` rows instead of treating them as open-ended sessions.
 */

import type { LiveVoiceSessionCloseReason } from "../live-voice/live-voice-session-manager.js";
import type { LiveVoiceProtocolErrorCode } from "../live-voice/protocol.js";

/** Funnel version stamped on every live-voice session event. */
export const LIVE_VOICE_FUNNEL_VERSION = "live_voice_v1_2026_08";

/**
 * Live-voice session funnel steps. `stepName` is the wire value; `stepIndex`
 * is the ordinal position.
 *
 * `sessionStarted` fires for every *attempted* session, before the credential
 * preflight that can reject it. A session that fails to connect is exactly the
 * one worth counting, and gating the start event on `ready` would hide it from
 * the failure rate entirely.
 */
export const LIVE_VOICE_STEPS = {
  sessionStarted: { stepName: "live_voice_session_started", stepIndex: 0 },
  sessionEnded: { stepName: "live_voice_session_ended", stepIndex: 1 },
} as const;

export type LiveVoiceStepName =
  (typeof LIVE_VOICE_STEPS)[keyof typeof LIVE_VOICE_STEPS]["stepName"];

/**
 * How a session ended, stamped as `outcome`.
 *
 * `failed` means the session died on an error: a credential preflight
 * rejection before `ready`, or an utterance-arm failure after it. Everything
 * else, including a dropped socket, is `completed`: the session ran and then
 * stopped, and the close reason on `screen` says how.
 */
export type LiveVoiceSessionOutcome = "completed" | "failed";

/**
 * How far a session that produced NO turn actually got.
 *
 * A quarter of live-voice sessions end without a single turn, at a median of a
 * few seconds. That is the closest thing the telemetry has to a "voice didn't
 * work for me" rate, and a bare connect/close row cannot separate a denied
 * microphone from a muted one from someone deliberately backing out. Those have
 * completely different fixes, so the reason is what makes the rate actionable.
 *
 * The values are ordered by how far the session got, and each one narrows the
 * cause to a different layer:
 *
 * - `no_ready`  never reached `active`: died in the credential preflight or
 *               the transport, before the user could have said anything.
 * - `text_only` opened without a speech-to-text leg because the client could
 *               type, and then the user never typed. Ranked ahead of the audio
 *               signals because they cannot mean anything here: no microphone
 *               was ever expected, so scoring such a session `no_audio` would
 *               read as a failure the session does not have.
 * - `no_audio`  reached `active` but not one audio chunk ever arrived, so the
 *               microphone never opened. Permission denial looks like this.
 * - `no_speech` audio arrived but the detector never classified any of it as
 *               speech: a muted or dead mic, or a genuinely silent user.
 * - `no_turn`   speech was detected but no turn was ever dispatched, so the
 *               utterance was abandoned, aborted, or failed to arm.
 */
export type LiveVoiceSilenceReason =
  | "no_ready"
  | "text_only"
  | "no_audio"
  | "no_speech"
  | "no_turn";

/**
 * Classify a zero-turn session from what the session observed. Call only when
 * the session really produced no turn: every branch here asserts silence, so a
 * session that did dispatch a turn would be mislabelled by the last one.
 */
export function liveVoiceSilenceReason(signals: {
  reachedActive: boolean;
  audioInput: boolean;
  receivedAudio: boolean;
  detectedSpeech: boolean;
}): LiveVoiceSilenceReason {
  if (!signals.reachedActive) {
    return "no_ready";
  }
  if (!signals.audioInput) {
    return "text_only";
  }
  if (!signals.receivedAudio) {
    return "no_audio";
  }
  if (!signals.detectedSpeech) {
    return "no_speech";
  }
  return "no_turn";
}

/**
 * The `screen` dimension for an ended session: how it closed, plus a detail
 * half. That detail is the protocol error code when a failure closed it, or the
 * silence classification when the session produced no turn at all.
 *
 * Every part is the daemon's own vocabulary verbatim
 * (`LiveVoiceSessionCloseReason`, `LiveVoiceProtocolErrorCode`,
 * {@link LiveVoiceSilenceReason}) rather than a mapping, so a rename on any of
 * them surfaces here as a compile error instead of a silently-empty dashboard
 * facet. The longest combination this can produce is well inside the wire
 * field's 64-char bound.
 *
 * A failure code wins over a silence reason when both apply: a session that
 * died on an error is explained by the error, and the silence is a consequence
 * of it rather than a separate finding.
 *
 * The silence value carries a `silent_` prefix on purpose. It shares the detail
 * slot with failure codes, and the admin dashboard currently renders that slot
 * in a column labelled "failure code", so the value has to read correctly even
 * where the column header is wrong, until that panel learns the difference.
 */
export function liveVoiceEndScreen(
  reason: LiveVoiceSessionCloseReason,
  failureCode?: LiveVoiceProtocolErrorCode | null,
  silenceReason?: LiveVoiceSilenceReason | null,
): string {
  if (failureCode) {
    return `ended_${reason}:${failureCode}`;
  }
  if (silenceReason) {
    return `ended_${reason}:silent_${silenceReason}`;
  }
  return `ended_${reason}`;
}
