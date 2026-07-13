import { v4 as uuid } from "uuid";

import { getCachedShareAnalytics } from "../platform/consent-cache.js";
import {
  ACTIVATION_AB_VARIANT,
  ACTIVATION_FUNNEL_VERSION,
  activationStepIndex,
  type ActivationStepName,
  buildActivationDaemonEventId,
} from "../telemetry/activation-funnel.js";
import { insertTelemetryOutboxEvent } from "../telemetry/telemetry-events-outbox.js";
import type { OnboardingTelemetryEvent } from "../telemetry/types.js";
import { APP_VERSION } from "../version.js";

export interface OnboardingEvent {
  id: string;
  createdAt: number;
  screen: string;
  toolsJson: string | null;
  tasksJson: string | null;
  tone: string | null;
  googleConnected: boolean | null;
  googleScopesJson: string | null;
  abVariant: string | null;
  sessionId: string | null;
  stepName: string | null;
  stepIndex: number | null;
  completedAt: string | null;
  funnelVersion: string | null;
}

export interface RecordOnboardingEventParams {
  screen: string;
  tools?: string[];
  tasks?: string[];
  tone?: string;
  googleConnected?: boolean;
  googleScopes?: string[];
  /** Accepted for caller compatibility; never shipped and no longer stored. */
  priorAssistants?: string[];
  abVariant?: string;
  sessionId?: string | null;
  stepName?: string | null;
  stepIndex?: number | null;
  completedAt?: string | null;
  funnelVersion?: string | null;
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
            params.stepName as ActivationStepName,
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
    assistant_version: APP_VERSION,
  };
}

/**
 * Build the wire payload and insert it into the `telemetry_events` outbox.
 * Shared by all record* entry points. Returns null when the telemetry
 * database is unavailable — the event is dropped, matching the degraded-mode
 * behavior of the other telemetry stores.
 */
function insertOnboardingEvent(
  id: string,
  createdAt: number,
  params: RecordOnboardingEventParams,
): OnboardingEvent | null {
  const inserted = insertTelemetryOutboxEvent({
    id,
    name: "onboarding",
    createdAt,
    event: buildOnboardingTelemetryEvent(id, createdAt, params),
  });
  if (!inserted) {
    return null;
  }
  return {
    id,
    createdAt,
    screen: params.screen,
    toolsJson: params.tools ? JSON.stringify(params.tools) : null,
    tasksJson: params.tasks ? JSON.stringify(params.tasks) : null,
    tone: params.tone ?? null,
    googleConnected: params.googleConnected ?? null,
    googleScopesJson: params.googleScopes
      ? JSON.stringify(params.googleScopes)
      : null,
    abVariant: params.abVariant ?? null,
    sessionId: params.sessionId ?? null,
    stepName: params.stepName ?? null,
    stepIndex: params.stepIndex ?? null,
    completedAt: params.completedAt ?? null,
    funnelVersion: params.funnelVersion ?? null,
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
  if (!getCachedShareAnalytics()) {
    return null;
  }
  return insertOnboardingEvent(uuid(), Date.now(), params);
}

/**
 * Record an activation-funnel milestone event. Reuses the onboarding telemetry
 * substrate (`screen` carries the step name). Returns null when usage data
 * collection is disabled or the telemetry database is unavailable.
 */
export function recordActivationEvent(params: {
  stepName: ActivationStepName;
  sessionId: string;
  userId?: string | null;
  abVariant?: string;
}): OnboardingEvent | null {
  if (!getCachedShareAnalytics()) {
    return null;
  }
  const createdAt = Date.now();
  return insertOnboardingEvent(uuid(), createdAt, {
    screen: params.stepName,
    abVariant: params.abVariant ?? ACTIVATION_AB_VARIANT,
    sessionId: params.sessionId,
    stepName: params.stepName,
    stepIndex: activationStepIndex(params.stepName),
    completedAt: new Date(createdAt).toISOString(),
    funnelVersion: ACTIVATION_FUNNEL_VERSION,
  });
}
