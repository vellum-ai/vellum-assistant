/**
 * Tests for the shared sign-in poll loop: how each settled status maps onto an
 * outcome, that a rejected request is ridden out rather than ending the flow,
 * and that a flow the caller abandoned stops asking.
 */

import { describe, expect, test } from "bun:test";

import {
  pollUntilSettled,
  type PollStatusResponse,
} from "@/utils/poll-until-settled";

function sequence(responses: PollStatusResponse[]) {
  const calls: number[] = [];
  return {
    calls,
    poll: async () => {
      calls.push(calls.length);
      const next = responses[calls.length - 1];
      if (!next) {
        throw new Error("polled past the scripted responses");
      }
      return next;
    },
  };
}

describe("pollUntilSettled", () => {
  test("settles on the first connected status", async () => {
    const scripted = sequence([{ status: "pending" }, { status: "connected" }]);

    const outcome = await pollUntilSettled({
      poll: scripted.poll,
      intervalMs: 1,
      maxAttempts: 10,
      isStale: () => false,
    });

    expect(outcome).toEqual({ kind: "connected" });
    expect(scripted.calls.length).toBe(2);
  });

  test("carries the daemon's own message off an error status", async () => {
    const scripted = sequence([{ status: "error", error: "device flow off" }]);

    const outcome = await pollUntilSettled({
      poll: scripted.poll,
      intervalMs: 1,
      maxAttempts: 10,
      isStale: () => false,
    });

    expect(outcome).toEqual({ kind: "error", message: "device flow off" });
  });

  test("rides out a rejected request and keeps polling", async () => {
    let attempt = 0;
    const outcome = await pollUntilSettled({
      poll: async () => {
        attempt++;
        if (attempt === 1) {
          throw new Error("network blip");
        }
        return { status: "connected" };
      },
      intervalMs: 1,
      maxAttempts: 10,
      isStale: () => false,
    });

    expect(outcome).toEqual({ kind: "connected" });
    expect(attempt).toBe(2);
  });

  test("times out once the attempt budget is spent", async () => {
    let attempt = 0;
    const outcome = await pollUntilSettled({
      poll: async () => {
        attempt++;
        return { status: "pending" };
      },
      intervalMs: 1,
      maxAttempts: 3,
      isStale: () => false,
    });

    expect(outcome).toEqual({ kind: "timed_out" });
    expect(attempt).toBe(3);
  });

  test("stops asking once the flow is abandoned", async () => {
    let attempt = 0;
    const outcome = await pollUntilSettled({
      poll: async () => {
        attempt++;
        return { status: "pending" };
      },
      intervalMs: 1,
      maxAttempts: 10,
      isStale: () => true,
    });

    expect(outcome).toEqual({ kind: "abandoned" });
    expect(attempt).toBe(0);
  });
});
