/**
 * Phone-call telemetry vocabulary: the single source of truth for the step
 * names, funnel version, and dimension values the call store's emitter uses.
 *
 * The phone half of the live-voice funnel, and deliberately its mirror image:
 * same onboarding substrate (`type: "onboarding"`), same open-string
 * `step_name` / `funnel_version`, same reason for both. See
 * `live-voice-funnel.ts` for the full argument; the short version is that the
 * backend stores those two as open strings, so a new funnel needs no platform
 * serializer and no wire-contract change.
 *
 * **Duration is not a field**, for the same reason it is not one on live
 * voice: the onboarding event shape has no numeric slot. The two events below
 * are keyed by the call session id in `session_id` and the warehouse subtracts
 * their `recorded_at` stamps.
 *
 * **Turn count is not a field either.** Phone turns already carry the call
 * session id in their `client` bag (`voiceTelemetry` at the bridge call site),
 * so a turn count is a count of those rows.
 *
 * A call that starts and never ends is **censored, not infinite**: a daemon
 * crash between the two writes emits no end event, so duration math must drop
 * unmatched `started` rows rather than treat the call as still running.
 */

import type { CallMode, CallStatus } from "../calls/types.js";

/** Funnel version stamped on every phone-call event. */
export const PHONE_CALL_FUNNEL_VERSION = "phone_call_v1_2026_09";

/**
 * Phone-call funnel steps. `stepName` is the wire value; `stepIndex` is the
 * ordinal position.
 *
 * `callStarted` fires when the call session row is created, before the
 * provider has dialled: a call that never connects is exactly the one worth
 * counting, so the start event precedes no-answer, busy, provider failure and
 * the inbound credential preflight (an inbound session exists before that
 * preflight runs and records against it).
 *
 * It does **not** cover an outbound attempt rejected before a session exists:
 * `startCall`, `startVerificationCall` and `startInviteCall` all return on a
 * failed `preflightVoiceIngress()` without creating a row, and this funnel is
 * keyed by the session id it would have had. Counting those needs a key that
 * does not depend on a session row, which is its own piece of work.
 */
export const PHONE_CALL_STEPS = {
  callStarted: { stepName: "phone_call_started", stepIndex: 0 },
  callEnded: { stepName: "phone_call_ended", stepIndex: 1 },
} as const;

export type PhoneCallStepName =
  (typeof PHONE_CALL_STEPS)[keyof typeof PHONE_CALL_STEPS]["stepName"];

/**
 * Which way the call was placed. Inbound is someone dialling the assistant's
 * number; outbound is the assistant dialling out on a task.
 */
export type PhoneCallDirection = "inbound" | "outbound";

/**
 * How a call ended, stamped as `outcome`.
 *
 * `failed` means the call died on an error: no answer, a provider or
 * credential failure, a dropped media stream. A call the caller or the
 * assistant hung up, including one cancelled before it connected, is
 * `completed`: it ran its course and the close reason on `screen` says how.
 */
export type PhoneCallOutcome = "completed" | "failed";

/**
 * How far a call that produced NO caller turn actually got.
 *
 * The phone analogue of the live-voice silence taxonomy, and the closest thing
 * call telemetry has to a "the phone path didn't work" rate. A bare
 * started/ended pair cannot separate a call that never connected from one that
 * connected to silence, and those have completely different fixes.
 *
 * - `no_connect` the call never reached `in_progress`: it failed, was
 *                cancelled, or was never answered, so nobody could have
 *                spoken.
 * - `no_turn`    the call connected and then no caller utterance was ever
 *                transcribed: a silent line, a failed STT leg, or a caller who
 *                hung up on the disclosure.
 */
export type PhoneCallSilenceReason = "no_connect" | "no_turn";

/**
 * Classify a call that produced no caller turn. Call only when the call really
 * produced none: the second branch asserts silence, so a call that did take a
 * turn would be mislabelled by it.
 */
export function phoneCallSilenceReason(signals: {
  connected: boolean;
}): PhoneCallSilenceReason {
  return signals.connected ? "no_turn" : "no_connect";
}

/**
 * The mode an ordinary call carries. Only the verification and invite flows
 * write a mode on the session row, so a null there is not a missing dimension
 * but the ordinary conversation every other path creates.
 */
const PHONE_CALL_DEFAULT_MODE: CallMode = "normal";

/**
 * The `screen` dimension for a started call: which way it was placed and what
 * kind of call it is, as `started_<direction>:<mode>`.
 *
 * The mode separates the three things a phone call can be (a normal
 * conversation, a callee verification, an invite redemption) because they have
 * completely different shapes and success criteria, and a funnel that mixed
 * them would report the verification flow's brevity as a conversation problem.
 */
export function phoneCallStartScreen(
  direction: PhoneCallDirection,
  mode?: CallMode | null,
): string {
  return `started_${direction}:${mode ?? PHONE_CALL_DEFAULT_MODE}`;
}

/**
 * The `screen` dimension for an ended call: the terminal status it reached,
 * plus a detail half carrying the silence classification when the call took no
 * caller turn at all.
 *
 * The status is the daemon's own `CallStatus` verbatim rather than a mapping,
 * so a rename surfaces here as a compile error instead of a silently-empty
 * dashboard facet.
 *
 * The silence value carries a `silent_` prefix to match the live-voice stamp,
 * which shares its detail slot with failure codes and renders in an admin
 * column labelled "failure code". Reading the two funnels side by side is
 * worth more than a shorter string here.
 */
export function phoneCallEndScreen(
  status: CallStatus,
  silenceReason?: PhoneCallSilenceReason | null,
): string {
  if (silenceReason) {
    return `ended_${status}:silent_${silenceReason}`;
  }
  return `ended_${status}`;
}
