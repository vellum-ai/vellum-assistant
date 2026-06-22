import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import * as eventBus from "@/lib/event-bus";
import {
  createReachabilityBurstLimiter,
  type ReachabilityBurstLimiterDeps,
} from "@/domains/chat/streaming/reachability-burst-limiter";

const publishSpy = spyOn(eventBus, "publish");

beforeEach(() => {
  publishSpy.mockClear();
});

const makeDeps = (
  override: Partial<ReachabilityBurstLimiterDeps> = {},
): {
  deps: ReachabilityBurstLimiterDeps;
  onReady: ReturnType<typeof mock>;
  onClearError: ReturnType<typeof mock>;
  onExhausted: ReturnType<typeof mock>;
  onReset: ReturnType<typeof mock>;
} => {
  const onReady = mock(() => {});
  const onClearError = mock(() => {});
  const onExhausted = mock((_e: { message: string }) => {});
  const onReset = mock(() => {});
  return {
    onReady,
    onClearError,
    onExhausted,
    onReset,
    deps: {
      onReady,
      onClearError,
      onExhausted,
      onReset,
      now: () => 0,
      ...override,
    },
  };
};

describe("reachability burst-limiter", () => {
  test("ignores phases other than ready", () => {
    const { deps, onReady, onExhausted } = makeDeps();
    const limiter = createReachabilityBurstLimiter(deps);

    limiter.handleReachabilityPhase("idle");
    limiter.handleReachabilityPhase("checking");

    expect(publishSpy).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  test("ready success: clears turn + error, publishes retry-requested", () => {
    const { deps, onReady, onClearError, onReset } = makeDeps();
    const limiter = createReachabilityBurstLimiter(deps);

    limiter.handleReachabilityPhase("ready");

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onClearError).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith(
      "reachability.retry-requested",
      {},
    );
    expect(onReset).not.toHaveBeenCalled();
  });

  test("three retries within the window are allowed", () => {
    let t = 0;
    const { deps, onExhausted } = makeDeps({ now: () => t });
    const limiter = createReachabilityBurstLimiter(deps);

    t = 0;
    limiter.handleReachabilityPhase("ready");
    t = 1_000;
    limiter.handleReachabilityPhase("ready");
    t = 5_000;
    limiter.handleReachabilityPhase("ready");

    expect(publishSpy).toHaveBeenCalledTimes(3);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  test("fourth retry inside the window exhausts the budget", () => {
    let t = 0;
    const { deps, onExhausted, onReset } = makeDeps({ now: () => t });
    const limiter = createReachabilityBurstLimiter(deps);

    t = 0;
    limiter.handleReachabilityPhase("ready");
    t = 1_000;
    limiter.handleReachabilityPhase("ready");
    t = 2_000;
    limiter.handleReachabilityPhase("ready");
    publishSpy.mockClear();

    t = 3_000;
    limiter.handleReachabilityPhase("ready");

    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledWith({
      message: "Connection lost. Please try again.",
    });
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("burst counter resets after the 10s window elapses", () => {
    let t = 0;
    const { deps, onExhausted } = makeDeps({ now: () => t });
    const limiter = createReachabilityBurstLimiter(deps);

    // Burn the budget in window 1.
    t = 0;
    limiter.handleReachabilityPhase("ready");
    limiter.handleReachabilityPhase("ready");
    limiter.handleReachabilityPhase("ready");
    expect(onExhausted).not.toHaveBeenCalled();

    // Cross the window — next retry should be allowed.
    t = 10_001;
    publishSpy.mockClear();
    limiter.handleReachabilityPhase("ready");

    expect(publishSpy).toHaveBeenCalledWith(
      "reachability.retry-requested",
      {},
    );
    expect(onExhausted).not.toHaveBeenCalled();
  });
});
