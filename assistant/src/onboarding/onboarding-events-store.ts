import { and, asc, eq, gt, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getTelemetryDb } from "../persistence/db-connection.js";
import { onboardingEvents } from "../persistence/schema/index.js";
import { getCachedShareAnalytics } from "../platform/consent-cache.js";
import {
  ACTIVATION_AB_VARIANT,
  ACTIVATION_FUNNEL_VERSION,
  activationStepIndex,
  type ActivationStepName,
} from "../telemetry/activation-funnel.js";

export interface OnboardingEvent {
  id: string;
  createdAt: number;
  screen: string;
  toolsJson: string | null;
  tasksJson: string | null;
  tone: string | null;
  googleConnected: boolean | null;
  googleScopesJson: string | null;
  priorAssistantsJson: string | null;
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
  priorAssistants?: string[];
  abVariant?: string;
  sessionId?: string | null;
  stepName?: string | null;
  stepIndex?: number | null;
  completedAt?: string | null;
  funnelVersion?: string | null;
}

/**
 * Insert a fully-built event row. Shared by all record* entry points.
 * Returns null when the telemetry database is unavailable — the event is
 * dropped, matching the degraded-mode behavior of the other telemetry stores.
 */
function insertOnboardingEvent(event: OnboardingEvent): OnboardingEvent | null {
  const db = getTelemetryDb();
  if (!db) return null;
  db.insert(onboardingEvents).values(event).run();
  return event;
}

/**
 * Record an onboarding event (pre-chat selections and Google connect status).
 * Returns null when usage data collection is disabled or the telemetry
 * database is unavailable.
 */
export function recordOnboardingEvent(
  params: RecordOnboardingEventParams,
): OnboardingEvent | null {
  if (!getCachedShareAnalytics()) return null;
  return insertOnboardingEvent({
    id: uuid(),
    createdAt: Date.now(),
    screen: params.screen,
    toolsJson: params.tools ? JSON.stringify(params.tools) : null,
    tasksJson: params.tasks ? JSON.stringify(params.tasks) : null,
    tone: params.tone ?? null,
    googleConnected: params.googleConnected ?? null,
    googleScopesJson: params.googleScopes
      ? JSON.stringify(params.googleScopes)
      : null,
    priorAssistantsJson: params.priorAssistants
      ? JSON.stringify(params.priorAssistants)
      : null,
    abVariant: params.abVariant ?? null,
    sessionId: params.sessionId ?? null,
    stepName: params.stepName ?? null,
    stepIndex: params.stepIndex ?? null,
    completedAt: params.completedAt ?? null,
    funnelVersion: params.funnelVersion ?? null,
  });
}

/**
 * Record an activation-funnel milestone event. Reuses the onboarding telemetry
 * substrate (`screen` carries the step name to satisfy the NOT NULL column).
 * Returns null when usage data collection is disabled or the telemetry
 * database is unavailable.
 */
export function recordActivationEvent(params: {
  stepName: ActivationStepName;
  sessionId: string;
  userId?: string | null;
  abVariant?: string;
}): OnboardingEvent | null {
  if (!getCachedShareAnalytics()) return null;
  const createdAt = Date.now();
  return insertOnboardingEvent({
    id: uuid(),
    createdAt,
    screen: params.stepName,
    toolsJson: null,
    tasksJson: null,
    tone: null,
    googleConnected: null,
    googleScopesJson: null,
    priorAssistantsJson: null,
    abVariant: params.abVariant ?? ACTIVATION_AB_VARIANT,
    sessionId: params.sessionId,
    stepName: params.stepName,
    stepIndex: activationStepIndex(params.stepName),
    completedAt: new Date(createdAt).toISOString(),
    funnelVersion: ACTIVATION_FUNNEL_VERSION,
  });
}

/**
 * Query onboarding events that haven't been reported to telemetry yet.
 * Uses a compound cursor (createdAt + id) for reliable watermarking.
 */
export function queryUnreportedOnboardingEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): OnboardingEvent[] {
  const db = getTelemetryDb();
  if (!db) return [];
  const rows = db
    .select({
      id: onboardingEvents.id,
      createdAt: onboardingEvents.createdAt,
      screen: onboardingEvents.screen,
      toolsJson: onboardingEvents.toolsJson,
      tasksJson: onboardingEvents.tasksJson,
      tone: onboardingEvents.tone,
      googleConnected: onboardingEvents.googleConnected,
      googleScopesJson: onboardingEvents.googleScopesJson,
      priorAssistantsJson: onboardingEvents.priorAssistantsJson,
      abVariant: onboardingEvents.abVariant,
      sessionId: onboardingEvents.sessionId,
      stepName: onboardingEvents.stepName,
      stepIndex: onboardingEvents.stepIndex,
      completedAt: onboardingEvents.completedAt,
      funnelVersion: onboardingEvents.funnelVersion,
    })
    .from(onboardingEvents)
    .where(
      afterId
        ? or(
            gt(onboardingEvents.createdAt, afterCreatedAt),
            and(
              eq(onboardingEvents.createdAt, afterCreatedAt),
              gt(onboardingEvents.id, afterId),
            ),
          )
        : gt(onboardingEvents.createdAt, afterCreatedAt),
    )
    .orderBy(asc(onboardingEvents.createdAt), asc(onboardingEvents.id))
    .limit(limit)
    .all();
  return rows;
}
