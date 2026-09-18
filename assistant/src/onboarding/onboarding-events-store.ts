import {
  ACTIVATION_AB_VARIANT,
  ACTIVATION_FUNNEL_VERSION,
  activationStepIndex,
  type ActivationStepName,
  buildActivationDaemonEventId,
} from "../telemetry/activation-funnel.js";
import {
  LIVE_VOICE_FUNNEL_VERSION,
  LIVE_VOICE_STEPS,
  type LiveVoiceSessionOutcome,
  type LiveVoiceStepName,
} from "../telemetry/live-voice-funnel.js";
import {
  PHONE_CALL_FUNNEL_VERSION,
  PHONE_CALL_STEPS,
  type PhoneCallOutcome,
  type PhoneCallStepName,
} from "../telemetry/phone-call-funnel.js";
import { recordTelemetryOutboxEvent } from "../telemetry/telemetry-events-outbox.js";
import type { OnboardingTelemetryEvent } from "../telemetry/types.js";
import { getLogger } from "../util/logger.js";
import { APP_VERSION } from "../version.js";

const log = getLogger("onboarding-events-store");

/** Identity of a recorded outbox row; the full payload lives in the outbox. */
export interface OnboardingEvent {
  id: string;
  createdAt: number;
}

export interface RecordOnboardingEventParams {
  screen: string;
  tools?: string[];
  tasks?: string[];
  tone?: string;
  googleConnected?: boolean;
  googleScopes?: string[];
  abVariant?: string;
  sessionId?: string | null;
  stepName?: string | null;
  stepIndex?: number | null;
  completedAt?: string | null;
  funnelVersion?: string | null;
  outcome?: string | null;
}

/**
 * Build the wire event stored in the outbox payload at record time.
 * `assistant_version` is therefore record-time: the binary that recorded the
 * event, not the one that later flushes it.
 */
function buildOnboardingTelemetryEvent(
  id: string,
  createdAt: number,
  params: RecordOnboardingEventParams,
): OnboardingTelemetryEvent {
  return {
    type: "onboarding",
    // Wire-only override for activation rows: a deterministic id keyed on
    // funnel_version/session/step lets dbt collapse a moment that fires more
    // than once. Keyed on the params' funnelVersion (frozen into the payload
    // now) so rows recorded under an older version — flushed offline or after
    // an upgrade — keep a stable id and still collapse with already-ingested
    // rows. The outbox row id stays `id`, so flush acks are unaffected.
    daemon_event_id:
      params.sessionId && params.stepName && params.funnelVersion
        ? buildActivationDaemonEventId(
            params.sessionId,
            params.stepName,
            params.funnelVersion,
          )
        : id,
    recorded_at: createdAt,
    screen: params.screen,
    ...(params.tools ? { tools: params.tools } : {}),
    ...(params.tasks ? { tasks: params.tasks } : {}),
    ...(params.tone ? { tone: params.tone } : {}),
    ...(params.googleConnected != null
      ? { google_connected: params.googleConnected }
      : {}),
    ...(params.googleScopes ? { google_scopes: params.googleScopes } : {}),
    ...(params.abVariant ? { ab_variant: params.abVariant } : {}),
    // Activation funnel fields — only present on activation rows.
    ...(params.sessionId ? { session_id: params.sessionId } : {}),
    ...(params.stepName ? { step_name: params.stepName } : {}),
    ...(params.stepIndex != null ? { step_index: params.stepIndex } : {}),
    ...(params.completedAt ? { completed_at: params.completedAt } : {}),
    ...(params.funnelVersion ? { funnel_version: params.funnelVersion } : {}),
    ...(params.outcome ? { outcome: params.outcome } : {}),
    assistant_version: APP_VERSION,
  };
}

/**
 * Record an onboarding event (pre-chat selections and Google connect status).
 * Returns null when usage data collection is disabled or the telemetry
 * database is unavailable.
 */
export function recordOnboardingEvent(
  params: RecordOnboardingEventParams,
): OnboardingEvent | null {
  return recordTelemetryOutboxEvent("onboarding", (id, createdAt) =>
    buildOnboardingTelemetryEvent(id, createdAt, params),
  );
}

/**
 * Record an activation-funnel milestone event. Reuses the onboarding telemetry
 * substrate (`screen` carries the step name). Returns null when usage data
 * collection is disabled or the telemetry database is unavailable.
 */
export function recordActivationEvent(params: {
  stepName: ActivationStepName;
  sessionId: string;
  abVariant?: string;
}): OnboardingEvent | null {
  return recordTelemetryOutboxEvent("onboarding", (id, createdAt) =>
    buildOnboardingTelemetryEvent(id, createdAt, {
      screen: params.stepName,
      abVariant: params.abVariant ?? ACTIVATION_AB_VARIANT,
      sessionId: params.sessionId,
      stepName: params.stepName,
      stepIndex: activationStepIndex(params.stepName),
      completedAt: new Date(createdAt).toISOString(),
      funnelVersion: ACTIVATION_FUNNEL_VERSION,
    }),
  );
}

/**
 * Record a live-voice session milestone (started / ended). Reuses the same
 * onboarding telemetry substrate as {@link recordActivationEvent}, keyed by the
 * live-voice session id so the two events pair up downstream. See
 * `telemetry/live-voice-funnel.ts` for why duration and turn count are derived
 * from that pairing rather than carried as fields.
 *
 * `screen` carries the end reason on the ended event and the originating
 * client and entry point on the started one (see `liveVoiceStartScreen`).
 * Returns null when usage data collection is disabled or the telemetry
 * database is unavailable.
 *
 * **Never throws.** These fire from `LiveVoiceSession.start()` and `.close()`,
 * and from the call store's create and status writes, which are the user's
 * call itself: the outbox insert raises on a telemetry DB that is missing,
 * locked, or mid-migration, and an uncaught raise there would fail the session
 * rather than the measurement. A dropped row costs a gap in a chart; a raised
 * one costs the user their conversation.
 */
function recordVoiceFunnelEventSafely(
  record: () => OnboardingEvent | null,
): OnboardingEvent | null {
  try {
    return record();
  } catch (err) {
    log.warn(
      { err },
      "Failed to record live-voice session telemetry; continuing",
    );
    return null;
  }
}

/**
 * Build one voice funnel row. The live-voice and phone-call funnels differ
 * only in their version stamp and step vocabulary, so they share the row
 * shape: same substrate, same session-keyed pairing, same duration math.
 */
function recordVoiceFunnelEvent(params: {
  funnelVersion: string;
  stepName: string;
  stepIndex: number;
  sessionId: string;
  screen: string;
  outcome?: string;
}): OnboardingEvent | null {
  return recordVoiceFunnelEventSafely(() =>
    recordTelemetryOutboxEvent("onboarding", (id, createdAt) =>
      buildOnboardingTelemetryEvent(id, createdAt, {
        screen: params.screen,
        sessionId: params.sessionId,
        stepName: params.stepName,
        stepIndex: params.stepIndex,
        completedAt: new Date(createdAt).toISOString(),
        funnelVersion: params.funnelVersion,
        ...(params.outcome ? { outcome: params.outcome } : {}),
      }),
    ),
  );
}

export function recordLiveVoiceSessionEvent(params: {
  stepName: LiveVoiceStepName;
  stepIndex: number;
  sessionId: string;
  screen?: string;
  outcome?: LiveVoiceSessionOutcome;
}): OnboardingEvent | null {
  return recordVoiceFunnelEvent({
    funnelVersion: LIVE_VOICE_FUNNEL_VERSION,
    stepName: params.stepName,
    stepIndex: params.stepIndex,
    sessionId: params.sessionId,
    screen: params.screen ?? params.stepName,
    ...(params.outcome ? { outcome: params.outcome } : {}),
  });
}

/**
 * Record the "a live-voice session was attempted" milestone, with where it
 * was attempted from.
 */
export function recordLiveVoiceSessionStarted(params: {
  sessionId: string;
  screen: string;
}): OnboardingEvent | null {
  return recordLiveVoiceSessionEvent({
    stepName: LIVE_VOICE_STEPS.sessionStarted.stepName,
    stepIndex: LIVE_VOICE_STEPS.sessionStarted.stepIndex,
    sessionId: params.sessionId,
    screen: params.screen,
  });
}

/** Record the "a live-voice session ended" milestone, with how it ended. */
export function recordLiveVoiceSessionEnded(params: {
  sessionId: string;
  screen: string;
  outcome: LiveVoiceSessionOutcome;
}): OnboardingEvent | null {
  return recordLiveVoiceSessionEvent({
    stepName: LIVE_VOICE_STEPS.sessionEnded.stepName,
    stepIndex: LIVE_VOICE_STEPS.sessionEnded.stepIndex,
    sessionId: params.sessionId,
    screen: params.screen,
    outcome: params.outcome,
  });
}

/**
 * Record a phone-call milestone (started / ended) on the same substrate as the
 * live-voice pair, keyed by the call session id so the two events pair up
 * downstream. See `telemetry/phone-call-funnel.ts` for why duration and turn
 * count are derived from that pairing rather than carried as fields.
 *
 * Returns null when usage data collection is disabled or the telemetry
 * database is unavailable, and never throws: these fire from the call store's
 * writes, on the call's own path.
 */
function recordPhoneCallEvent(params: {
  stepName: PhoneCallStepName;
  stepIndex: number;
  callSessionId: string;
  screen: string;
  outcome?: PhoneCallOutcome;
}): OnboardingEvent | null {
  return recordVoiceFunnelEvent({
    funnelVersion: PHONE_CALL_FUNNEL_VERSION,
    stepName: params.stepName,
    stepIndex: params.stepIndex,
    sessionId: params.callSessionId,
    screen: params.screen,
    ...(params.outcome ? { outcome: params.outcome } : {}),
  });
}

/**
 * Record the "a phone call was attempted" milestone, with how it was placed.
 */
export function recordPhoneCallStarted(params: {
  callSessionId: string;
  screen: string;
}): OnboardingEvent | null {
  return recordPhoneCallEvent({
    stepName: PHONE_CALL_STEPS.callStarted.stepName,
    stepIndex: PHONE_CALL_STEPS.callStarted.stepIndex,
    callSessionId: params.callSessionId,
    screen: params.screen,
  });
}

/** Record the "a phone call ended" milestone, with how it ended. */
export function recordPhoneCallEnded(params: {
  callSessionId: string;
  screen: string;
  outcome: PhoneCallOutcome;
}): OnboardingEvent | null {
  return recordPhoneCallEvent({
    stepName: PHONE_CALL_STEPS.callEnded.stepName,
    stepIndex: PHONE_CALL_STEPS.callEnded.stepIndex,
    callSessionId: params.callSessionId,
    screen: params.screen,
    outcome: params.outcome,
  });
}
