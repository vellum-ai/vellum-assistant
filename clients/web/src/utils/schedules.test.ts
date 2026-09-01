/**
 * Tests for the schedule predicates.
 *
 * These decide whether the notifications bell advertises schedules, so the
 * fixture is typed as the generated `AssistantSchedule` rather than a stub:
 * the two fields the predicates read come from the daemon's OpenAPI spec, and
 * a rename upstream has to break this file rather than silently change who
 * sees the advertisement.
 */
import { describe, expect, test } from "bun:test";

import type { AssistantSchedule } from "@/utils/schedules";
import { canScheduleStillRun, isLiveUserSchedule } from "@/utils/schedules";

/**
 * Compile-time guard on the shape the predicates depend on, which no runtime
 * assertion can cover.
 *
 * `sourceKey` must stay nullable: `isLiveUserSchedule` reads a null there as
 * "the user created this", so a field narrowed to plain `string` would make
 * every schedule look plugin-declared and the card would show to everyone
 * forever. `status` must keep both terminal members, since dropping one would
 * quietly promote spent one-shots back into the count.
 */
type Assert<T extends true> = T;
type SourceKeyStaysNullable = Assert<
  null extends AssistantSchedule["sourceKey"] ? true : false
>;
type StatusKeepsTerminalStates = Assert<
  "fired" | "cancelled" extends AssistantSchedule["status"] ? true : false
>;
// Referenced so the checks are not dead code to the linter.
export type SchedulePredicateContract = [
  SourceKeyStaysNullable,
  StatusKeepsTerminalStates,
];

/** A schedule the user created, active, with every generated field present. */
function schedule(
  overrides: Partial<AssistantSchedule> = {},
): AssistantSchedule {
  return {
    id: "schedule-1",
    name: "Morning briefing",
    enabled: true,
    syntax: "cron",
    expression: null,
    cronExpression: "0 8 * * 1-5",
    timezone: "UTC",
    message: "Post my briefing",
    script: null,
    nextRunAt: 1_800_000_000_000,
    lastRunAt: null,
    lastStatus: null,
    retryCount: 0,
    maxRetries: 3,
    retryBackoffMs: 1000,
    timeoutMs: null,
    inferenceProfile: null,
    groupId: null,
    createdFromConversationId: null,
    createdFromConversationExists: false,
    createdFromConversationArchivedAt: null,
    description: "Every weekday at 8:00",
    cadenceDescription: "Every weekday at 8:00",
    mode: "notify",
    status: "active",
    routingIntent: "single_channel",
    reuseConversation: false,
    wakeConversationId: null,
    workflowName: null,
    sourceKey: null,
    userEnabled: null,
    disarmReason: null,
    isOneShot: false,
    isDeferred: false,
    ...overrides,
  };
}

describe("canScheduleStillRun", () => {
  test("accepts a schedule with a firing ahead of it", () => {
    expect(canScheduleStillRun(schedule({ status: "active" }))).toBe(true);
    expect(canScheduleStillRun(schedule({ status: "firing" }))).toBe(true);
  });

  test("rejects the two terminal states", () => {
    expect(canScheduleStillRun(schedule({ status: "fired" }))).toBe(false);
    expect(canScheduleStillRun(schedule({ status: "cancelled" }))).toBe(false);
  });

  test("accepts a schedule that is merely switched off", () => {
    // A paused schedule runs again the moment it is re-enabled, so `enabled`
    // is not part of this question.
    expect(canScheduleStillRun(schedule({ enabled: false }))).toBe(true);
  });
});

describe("isLiveUserSchedule", () => {
  test("accepts a schedule the user set up", () => {
    expect(isLiveUserSchedule(schedule())).toBe(true);
  });

  test("accepts one the user set up and then paused", () => {
    expect(isLiveUserSchedule(schedule({ enabled: false }))).toBe(true);
  });

  test("rejects a spent one-shot", () => {
    expect(
      isLiveUserSchedule(schedule({ status: "fired", isOneShot: true })),
    ).toBe(false);
    expect(isLiveUserSchedule(schedule({ status: "cancelled" }))).toBe(false);
  });

  test("rejects a plugin-declared schedule", () => {
    // Installed with the plugin rather than chosen by anyone, so it is no
    // evidence the user has ever made a schedule.
    expect(
      isLiveUserSchedule(schedule({ sourceKey: "plugin:gmail/poll-inbox" })),
    ).toBe(false);
  });

  test("rejects a plugin-declared schedule even while it is live", () => {
    expect(
      isLiveUserSchedule(
        schedule({
          sourceKey: "plugin:github/digest",
          status: "firing",
          userEnabled: true,
        }),
      ),
    ).toBe(false);
  });
});
