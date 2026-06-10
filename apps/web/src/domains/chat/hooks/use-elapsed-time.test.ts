/**
 * Tests for `useElapsedTime` in `"step"` mode — the per-tool-row duration used
 * by the tool-call chip.
 *
 * While a tool runs, the chip should show a live integer-seconds counter where
 * the final duration normally lands; on completion it should switch to the
 * precise duration (1 decimal under a minute). The interval that drives the
 * tick is exercised indirectly: each render reads `Date.now()`, so controlling
 * the system clock lets us assert the value the chip would paint at a given
 * instant without waiting on a real timer.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useElapsedTime } from "@/domains/chat/hooks/use-elapsed-time";

const START = 1_700_000_000_000;

afterEach(() => {
  cleanup();
  setSystemTime();
});

describe("useElapsedTime — step mode", () => {
  test("returns null before a start time is known", () => {
    // GIVEN a tool with no start timestamp (e.g. snapshot without timing)
    // WHEN the hook renders for a running tool
    const { result } = renderHook(() =>
      useElapsedTime(undefined, false, undefined),
    );

    // THEN nothing is shown
    expect(result.current).toBeNull();
  });

  test("shows a live integer-seconds counter while running", () => {
    // GIVEN a tool that started 7.25s before the current clock
    setSystemTime(new Date(START + 7_250));

    // WHEN the hook renders for the still-running tool
    const { result } = renderHook(() =>
      useElapsedTime(START, false, undefined),
    );

    // THEN the running counter floors to whole seconds (no decimal)
    expect(result.current).toBe("7s");
  });

  test("formats a running counter past a minute as Xm Ys", () => {
    // GIVEN a tool that has been running for 1m 5s
    setSystemTime(new Date(START + 65_000));

    // WHEN the hook renders for the running tool
    const { result } = renderHook(() =>
      useElapsedTime(START, false, undefined),
    );

    // THEN minutes and seconds are shown
    expect(result.current).toBe("1m 5s");
  });

  test("clamps to 0s when the server start time is ahead of the local clock", () => {
    // GIVEN a server-stamped start time slightly ahead of this client's clock
    setSystemTime(new Date(START - 500));

    // WHEN the hook renders for the running tool
    const { result } = renderHook(() =>
      useElapsedTime(START, false, undefined),
    );

    // THEN the counter never goes negative
    expect(result.current).toBe("0s");
  });

  test("shows the precise final duration once completed", () => {
    // GIVEN a tool that ran for 3.2s
    // WHEN the hook renders after completion
    const { result } = renderHook(() =>
      useElapsedTime(START, true, START + 3_200),
    );

    // THEN the per-tool duration keeps one decimal under a minute
    expect(result.current).toBe("3.2s");
  });
});
