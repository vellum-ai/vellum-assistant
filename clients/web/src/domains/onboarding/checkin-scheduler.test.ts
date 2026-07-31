/**
 * Tests for scheduleCheckin's result contract: it must surface the daemon's
 * booked start time + timeZone on a real booking, and collapse every failure
 * mode (not scheduled, response not ok, thrown SDK call) to `{ scheduled: false }`
 * with no start/timeZone.
 *
 * NOTE: `bun mock.module` can leak across files — run this file singly:
 *   bun test src/domains/onboarding/checkin-scheduler.test.ts
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import * as sdkGen from "@/generated/daemon/sdk.gen";

interface CheckinCall {
  path: { assistant_id: string };
  body: {
    userName?: string;
    assistantName?: string;
    timezone?: string;
  };
  throwOnError: false;
}

let calls: CheckinCall[] = [];
let responseOk = true;
let responseStatus = 200;
let scheduled = true;
let start: string | undefined = "2026-06-25T16:00:00-07:00";
let timeZone: string | undefined = "America/Los_Angeles";
let shouldThrow = false;

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  onboardingCheckinPost: (opts: CheckinCall) => {
    calls.push(opts);
    if (shouldThrow) {
      return Promise.reject(new Error("network blew up"));
    }
    return Promise.resolve({
      data: responseOk ? { scheduled, start, timeZone } : undefined,
      error: undefined,
      response: { ok: responseOk, status: responseStatus },
    });
  },
}));

const { scheduleCheckin } = await import("./checkin-scheduler");

afterEach(() => {
  calls = [];
  responseOk = true;
  responseStatus = 200;
  scheduled = true;
  start = "2026-06-25T16:00:00-07:00";
  timeZone = "America/Los_Angeles";
  shouldThrow = false;
});

describe("scheduleCheckin", () => {
  test("returns the booked start + timeZone on a successful booking", async () => {
    const result = await scheduleCheckin({ assistantId: "a1" });

    expect(result).toEqual({
      scheduled: true,
      start: "2026-06-25T16:00:00-07:00",
      timeZone: "America/Los_Angeles",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toEqual({ assistant_id: "a1" });
  });

  test("returns { scheduled: false } with no start when the daemon did not book", async () => {
    scheduled = false;

    const result = await scheduleCheckin({ assistantId: "a1" });

    expect(result).toEqual({ scheduled: false });
    expect(result.start).toBeUndefined();
    expect(result.timeZone).toBeUndefined();
  });

  test("returns { scheduled: false } when the response is not ok", async () => {
    responseOk = false;
    responseStatus = 500;

    const result = await scheduleCheckin({ assistantId: "a1" });

    expect(result).toEqual({ scheduled: false });
  });

  test("swallows a thrown SDK call and returns { scheduled: false }", async () => {
    shouldThrow = true;

    const result = await scheduleCheckin({ assistantId: "a1" });

    expect(result).toEqual({ scheduled: false });
  });
});
