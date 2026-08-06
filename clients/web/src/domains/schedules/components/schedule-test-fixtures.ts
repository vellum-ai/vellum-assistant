import type { SchedulesGetResponse } from "@/generated/daemon/types.gen";

/**
 * The wire schedule shape; assignable to the settings domain's `Schedule`
 * view-model, which the schedule components consume.
 */
type Schedule = SchedulesGetResponse["schedules"][number];

/** Fully-populated recurring execute schedule for component tests. */
export function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "schedule-1",
    name: "Daily digest",
    enabled: true,
    syntax: "cron",
    expression: "0 9 * * *",
    cronExpression: "0 9 * * *",
    timezone: null,
    message: "produce the digest",
    script: null,
    nextRunAt: 1_778_800_000_000,
    lastRunAt: null,
    lastStatus: null,
    retryCount: 0,
    maxRetries: 3,
    retryBackoffMs: 60_000,
    timeoutMs: null,
    inferenceProfile: null,
    groupId: null,
    createdFromConversationId: null,
    createdFromConversationExists: false,
    createdFromConversationArchivedAt: null,
    description: "Summarize the day",
    cadenceDescription: "Every day at 9:00 AM",
    mode: "execute",
    status: "active",
    routingIntent: "all_channels",
    reuseConversation: false,
    wakeConversationId: null,
    workflowName: null,
    sourceKey: null,
    userEnabled: null,
    isOneShot: false,
    isDeferred: false,
    ...overrides,
  };
}
