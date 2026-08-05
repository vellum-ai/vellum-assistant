/**
 * End-to-end escalation regression for deferred wakes, driven through the real
 * route handlers and the real scheduler tick.
 *
 * The attack: a caller who is authenticated but is NOT the assistant's current
 * owner tries to make a wake fire against the guardian's own conversation. The
 * schedule routes require only `settings.write` and a principal type in
 * `ACTOR_PRINCIPALS`, and an `actor` token authenticates a device rather than
 * proving current guardian binding (`auth/require-bound-guardian.ts` exists for
 * exactly that reason), so route reachability is not authority.
 *
 * The autonomous due-tick carries no actor at all, so it cannot re-derive who
 * chose a row's target. Everything therefore has to hold on the write side and
 * in the row's own durable provenance.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockWakeAgentForOpportunity = mock(
  (
    _opts: Record<string, unknown>,
  ): Promise<{
    invoked: boolean;
    producedToolCalls: boolean;
    reason?: string;
  }> => Promise.resolve({ invoked: true, producedToolCalls: false }),
);
mock.module("../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: mockWakeAgentForOpportunity,
}));

// The owner check reads the live vellum guardian binding. Drive it directly so
// "current guardian", "rebound guardian", and "gateway unreachable" are all
// expressible.
let boundGuardianPrincipalId: string | null = "guardian-principal";
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => guardianRows(),
  getGuardianDeliveryFresh: async () => guardianRows(),
  guardianForChannel: (
    list: Array<{ channelType: string; status: string }>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
}));
function guardianRows() {
  if (boundGuardianPrincipalId === null) {
    return null;
  }
  return [
    {
      channelType: "vellum",
      contactId: "guardian-contact",
      principalId: boundGuardianPrincipalId,
      address: boundGuardianPrincipalId,
      status: "active",
    },
  ];
}

import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../daemon/trust-context.js";
import { createConversation } from "../persistence/conversation-crud.js";
import { getDb, getSqliteFrom } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import { ROUTES as SCHEDULE_ROUTES } from "../runtime/routes/schedule-routes.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";
import { LEGACY_DEFER_CREATED_BY } from "../schedule/defer-provenance.js";
import {
  createOwnerDeferredWake,
  createSchedule,
  getSchedule,
} from "../schedule/schedule-store.js";
import { runDueSchedulesOnce } from "../schedule/scheduler.js";

await initializeDb();

const TARGET = "conv-guardian-owned";

/** A device token that is not the currently bound guardian. */
const STALE_ACTOR = {
  "x-vellum-principal-type": "actor",
  "x-vellum-actor-principal-id": "revoked-or-rebound-principal",
};
/** The guardian's own web/desktop client. */
const CURRENT_GUARDIAN = {
  "x-vellum-principal-type": "actor",
  "x-vellum-actor-principal-id": "guardian-principal",
};
/** The guardian's CLI, over the local IPC socket. */
const LOCAL_CALLER = { "x-vellum-principal-type": "local" };

function routeFor(operationId: string) {
  const route = SCHEDULE_ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`route not registered: ${operationId}`);
  }
  return route;
}

function callRoute(
  operationId: string,
  args: RouteHandlerArgs,
): Promise<unknown> {
  return Promise.resolve(routeFor(operationId).handler(args));
}

function forceScheduleDue(scheduleId: string): void {
  getSqliteFrom(getDb()).run(
    "UPDATE cron_jobs SET next_run_at = ? WHERE id = ?",
    [Date.now() - 1000, scheduleId],
  );
}

/** Corrupt a persisted wake target directly, bypassing every route guard. */
function forceWakeTarget(scheduleId: string, conversationId: string): void {
  getSqliteFrom(getDb()).run(
    "UPDATE cron_jobs SET wake_conversation_id = ? WHERE id = ?",
    [conversationId, scheduleId],
  );
}

function trustOfLastWake(): unknown {
  const call = mockWakeAgentForOpportunity.mock.calls.at(-1);
  return (call?.[0] as Record<string, unknown> | undefined)?.trustContext;
}

function resetAll(): void {
  const db = getDb();
  db.run("DELETE FROM cron_runs");
  db.run("DELETE FROM cron_jobs");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  mockWakeAgentForOpportunity.mockClear();
  boundGuardianPrincipalId = "guardian-principal";
  createConversation({ id: TARGET });
}

/** A real owner-created deferral on the guardian's own conversation. */
function seedOwnerDefer() {
  return createOwnerDeferredWake({
    conversationId: TARGET,
    hint: "check the build",
    fireAt: Date.now() + 60_000,
  });
}

describe("a non-owner cannot retarget a schedule onto a guardian conversation", () => {
  beforeEach(resetAll);

  test("POST /v1/schedules refuses to create a wake schedule outright", async () => {
    await expect(
      callRoute("createSchedule", {
        body: {
          name: "pwn",
          expression: "* * * * *",
          message: "run something as the guardian",
          mode: "wake",
          wakeConversationId: TARGET,
        },
        headers: STALE_ACTOR,
      }),
    ).rejects.toThrow(/Only 'execute', 'script', and 'workflow' modes/);
  });

  test("PATCH cannot flip an owned schedule to wake mode", async () => {
    const schedule = await createSchedule({
      name: "innocuous",
      message: "hello",
      mode: "execute",
      expression: "* * * * *",
      nextRunAt: Date.now() + 60_000,
    });

    await expect(
      callRoute("updateSchedule", {
        pathParams: { id: schedule.id },
        body: {
          mode: "wake",
          wakeConversationId: TARGET,
          message: "exfiltrate the workspace",
        },
        headers: STALE_ACTOR,
      }),
    ).rejects.toThrow(/only be changed by the assistant's owner/);

    const after = getSchedule(schedule.id);
    expect(after?.mode).toBe("execute");
    expect(after?.wakeConversationId).toBeNull();
  });

  test("PATCH cannot retarget or rewrite an existing defer", async () => {
    const defer = await seedOwnerDefer();

    for (const body of [
      { wakeConversationId: "conv-elsewhere" },
      { message: "exfiltrate the workspace" },
    ]) {
      await expect(
        callRoute("updateSchedule", {
          pathParams: { id: defer.id },
          body,
          headers: STALE_ACTOR,
        }),
      ).rejects.toThrow(/only be changed by the assistant's owner/);
    }

    const after = getSchedule(defer.id);
    expect(after?.wakeConversationId).toBe(TARGET);
    expect(after?.message).toBe("check the build");
  });

  test("the due tick cannot be made to fire a retargeted wake", async () => {
    const schedule = await createSchedule({
      name: "innocuous",
      message: "hello",
      mode: "execute",
      expression: "* * * * *",
      nextRunAt: Date.now() + 60_000,
    });
    await callRoute("updateSchedule", {
      pathParams: { id: schedule.id },
      body: { mode: "wake", wakeConversationId: TARGET },
      headers: STALE_ACTOR,
    }).catch(() => undefined);

    forceScheduleDue(schedule.id);
    await runDueSchedulesOnce();

    expect(
      mockWakeAgentForOpportunity.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>).conversationId === TARGET,
      ),
    ).toHaveLength(0);
  });
});

describe("a locked-field edit is refused as a caller error, not a daemon fault", () => {
  beforeEach(resetAll);

  test("an owner PATCHing a locked field gets a 400 with the actionable refusal", async () => {
    const defer = await seedOwnerDefer();

    const err = await callRoute("updateSchedule", {
      pathParams: { id: defer.id },
      body: { message: "do something else" },
      headers: LOCAL_CALLER,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    // The refusal itself is correct; what matters here is the shape: a
    // BadRequestError (HTTP 400) whose message names the invariant and the
    // cancel-and-recreate workaround, not a generic InternalError (500).
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).statusCode).toBe(400);
    expect((err as BadRequestError).message).toMatch(
      /fixed at creation; cancel and re-create it/,
    );
    expect(getSchedule(defer.id)?.message).toBe("check the build");
  });

  test("same-value and unrelated edits still succeed for the owner", async () => {
    const defer = await seedOwnerDefer();

    await callRoute("updateSchedule", {
      pathParams: { id: defer.id },
      body: { message: "check the build", name: "renamed" },
      headers: LOCAL_CALLER,
    });

    expect(getSchedule(defer.id)?.name).toBe("renamed");
    expect(getSchedule(defer.id)?.message).toBe("check the build");
  });
});

describe("toggle-enable cannot be used as a firing trigger", () => {
  beforeEach(resetAll);

  test("a non-owner cannot enable a disabled wake schedule", async () => {
    const defer = await seedOwnerDefer();
    await callRoute("toggleSchedule", {
      pathParams: { id: defer.id },
      body: { enabled: false },
      headers: LOCAL_CALLER,
    });

    await expect(
      callRoute("toggleSchedule", {
        pathParams: { id: defer.id },
        body: { enabled: true },
        headers: STALE_ACTOR,
      }),
    ).rejects.toThrow(/only be changed by the assistant's owner/);

    // Still disabled, so the due tick fires nothing even once it is past due.
    forceScheduleDue(defer.id);
    await runDueSchedulesOnce();
    expect(mockWakeAgentForOpportunity).not.toHaveBeenCalled();
  });

  test("cancel and delete are owner-gated too", async () => {
    const defer = await seedOwnerDefer();

    await expect(
      callRoute("cancelSchedule", {
        pathParams: { id: defer.id },
        headers: STALE_ACTOR,
      }),
    ).rejects.toThrow(/only be changed by the assistant's owner/);
    await expect(
      callRoute("deleteSchedule", {
        pathParams: { id: defer.id },
        headers: STALE_ACTOR,
      }),
    ).rejects.toThrow(/only be changed by the assistant's owner/);

    expect(getSchedule(defer.id)).not.toBeNull();
  });

  test("ordinary schedules are unaffected by the wake bar", async () => {
    const schedule = await createSchedule({
      name: "ordinary",
      message: "hello",
      mode: "execute",
      expression: "* * * * *",
      nextRunAt: Date.now() + 60_000,
    });

    await callRoute("toggleSchedule", {
      pathParams: { id: schedule.id },
      body: { enabled: false },
      headers: STALE_ACTOR,
    });

    expect(getSchedule(schedule.id)?.enabled).toBe(false);
  });
});

describe("run-now is refused outright for a non-owner", () => {
  beforeEach(resetAll);

  test("an unauthorized run-now makes zero wake calls", async () => {
    const defer = await seedOwnerDefer();

    await expect(
      callRoute("runScheduleNow", {
        pathParams: { id: defer.id },
        headers: STALE_ACTOR,
      }),
    ).rejects.toThrow(/only be changed by the assistant's owner/);

    // Not merely trust-less: no turn runs at all. Firing early would pollute
    // the guardian's transcript and spend inference, and refusing suppresses
    // nothing, since the autonomous tick still fires the deferral on time.
    expect(mockWakeAgentForOpportunity).not.toHaveBeenCalled();
  });

  test("a caller with no identity headers is refused", async () => {
    const defer = await seedOwnerDefer();

    await expect(
      callRoute("runScheduleNow", {
        pathParams: { id: defer.id },
        headers: {},
      }),
    ).rejects.toThrow(/only be changed by the assistant's owner/);
    expect(mockWakeAgentForOpportunity).not.toHaveBeenCalled();
  });

  test("a rebound guardian's old token stops qualifying", async () => {
    const defer = await seedOwnerDefer();
    boundGuardianPrincipalId = "a-different-principal";

    await expect(
      callRoute("runScheduleNow", {
        pathParams: { id: defer.id },
        headers: CURRENT_GUARDIAN,
      }),
    ).rejects.toThrow(/only be changed by the assistant's owner/);
    expect(mockWakeAgentForOpportunity).not.toHaveBeenCalled();
  });

  test("an unreadable guardian binding fails closed", async () => {
    const defer = await seedOwnerDefer();
    boundGuardianPrincipalId = null;

    await expect(
      callRoute("runScheduleNow", {
        pathParams: { id: defer.id },
        headers: CURRENT_GUARDIAN,
      }),
    ).rejects.toThrow(/only be changed by the assistant's owner/);
    expect(mockWakeAgentForOpportunity).not.toHaveBeenCalled();
  });

  test("the current bound guardian may run it now, with trust recovered", async () => {
    const defer = await seedOwnerDefer();

    await callRoute("runScheduleNow", {
      pathParams: { id: defer.id },
      headers: CURRENT_GUARDIAN,
    });

    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    expect(trustOfLastWake()).toEqual(INTERNAL_GUARDIAN_TRUST_CONTEXT);
  });

  test("a local caller may run it now, with trust recovered", async () => {
    const defer = await seedOwnerDefer();

    await callRoute("runScheduleNow", {
      pathParams: { id: defer.id },
      headers: LOCAL_CALLER,
    });

    expect(trustOfLastWake()).toEqual(INTERNAL_GUARDIAN_TRUST_CONTEXT);
  });
});

describe("the due tick honors durable row provenance", () => {
  beforeEach(resetAll);

  test("an owner-created defer fires with the target's guardian trust", async () => {
    const defer = await seedOwnerDefer();
    forceScheduleDue(defer.id);

    await runDueSchedulesOnce();

    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    expect(trustOfLastWake()).toEqual(INTERNAL_GUARDIAN_TRUST_CONTEXT);
  });

  test("a pre-upgrade defer row fires without trust", async () => {
    // The row an upgrade inherits: it may already have been retargeted or
    // rewritten while the update surface still allowed it, and nothing tells
    // it apart from an untouched one. It keeps working as a schedule and
    // never recovers trust.
    const legacy = await createSchedule({
      name: "Deferred wake",
      message: "check the build",
      mode: "wake",
      wakeConversationId: TARGET,
      createdFromConversationId: TARGET,
      createdBy: LEGACY_DEFER_CREATED_BY,
      nextRunAt: Date.now() + 60_000,
    });
    forceScheduleDue(legacy.id);

    await runDueSchedulesOnce();

    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    expect(trustOfLastWake()).toBeUndefined();
  });

  test("a marked row whose target was corrupted in the DB fires without trust", async () => {
    // Belt to the route guard's braces: even with the marker intact and every
    // route bypassed, moving the target breaks its equality with the write-once
    // source binding, so the tick refuses to elevate.
    createConversation({ id: "conv-other-guardian-owned" });
    const defer = await seedOwnerDefer();
    forceWakeTarget(defer.id, "conv-other-guardian-owned");
    forceScheduleDue(defer.id);

    await runDueSchedulesOnce();

    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    expect(
      (
        mockWakeAgentForOpportunity.mock.calls.at(-1)?.[0] as Record<
          string,
          unknown
        >
      ).conversationId,
    ).toBe("conv-other-guardian-owned");
    expect(trustOfLastWake()).toBeUndefined();
  });
});
