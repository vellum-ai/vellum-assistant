import { and, asc, eq, gt, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import { getDb } from "./db-connection.js";
import { onboardingEvents } from "./schema.js";

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
}

/**
 * Record an onboarding event (pre-chat selections and Google connect status).
 * Returns null when usage data collection is disabled.
 */
export function recordOnboardingEvent(
  params: RecordOnboardingEventParams,
): OnboardingEvent | null {
  if (!getConfig().collectUsageData) return null;
  const db = getDb();
  const event: OnboardingEvent = {
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
  };
  db.insert(onboardingEvents)
    .values({
      id: event.id,
      createdAt: event.createdAt,
      screen: event.screen,
      toolsJson: event.toolsJson,
      tasksJson: event.tasksJson,
      tone: event.tone,
      googleConnected: event.googleConnected,
      googleScopesJson: event.googleScopesJson,
      priorAssistantsJson: event.priorAssistantsJson,
      abVariant: event.abVariant,
    })
    .run();
  return event;
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
  const db = getDb();
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
