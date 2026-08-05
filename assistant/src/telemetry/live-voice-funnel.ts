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
 * The `screen` dimension for an ended session: how it closed, plus the
 * protocol error code when a failure is what closed it.
 *
 * Both halves are the daemon's own vocabulary verbatim
 * (`LiveVoiceSessionCloseReason`, `LiveVoiceProtocolErrorCode`) rather than a
 * mapping, so a rename on either side surfaces here as a compile error instead
 * of a silently-empty dashboard facet. The longest pair this can produce is
 * well inside the wire field's 64-char bound.
 */
export function liveVoiceEndScreen(
  reason: LiveVoiceSessionCloseReason,
  failureCode?: LiveVoiceProtocolErrorCode | null,
): string {
  return failureCode ? `ended_${reason}:${failureCode}` : `ended_${reason}`;
}
