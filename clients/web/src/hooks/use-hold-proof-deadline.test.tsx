import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useHoldProofDeadline } from "@/hooks/use-hold-proof-deadline";

/** A wait short enough to run out inside a test, with room to observe it. */
const WINDOW_MS = 40;

const settle = async (ms: number) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

afterEach(cleanup);

describe("the wait behind proof by doing", () => {
  test("says nothing until the window runs out, then that the key never came", async () => {
    const { result } = renderHook(() =>
      useHoldProofDeadline({ active: true, windowMs: WINDOW_MS }),
    );
    expect(result.current.unproven).toBe(false);

    await settle(WINDOW_MS / 2);
    expect(result.current.unproven).toBe(false);

    await settle(WINDOW_MS);
    expect(result.current.unproven).toBe(true);
  });

  test("try again starts the wait over", async () => {
    const { result } = renderHook(() =>
      useHoldProofDeadline({ active: true, windowMs: WINDOW_MS }),
    );
    await settle(WINDOW_MS + 10);
    expect(result.current.unproven).toBe(true);

    act(() => {
      result.current.tryAgain();
    });
    expect(result.current.unproven).toBe(false);

    await settle(WINDOW_MS / 2);
    expect(result.current.unproven).toBe(false);

    await settle(WINDOW_MS);
    expect(result.current.unproven).toBe(true);
  });

  // The step is walked past by the key, not by anything in here: when the
  // caller says the wait is over, whatever the clock had to say is dropped.
  test("going inactive clears the verdict and stops the clock", async () => {
    const { result, rerender } = renderHook(
      (props: { active: boolean }) =>
        useHoldProofDeadline({ active: props.active, windowMs: WINDOW_MS }),
      { initialProps: { active: true } },
    );
    await settle(WINDOW_MS + 10);
    expect(result.current.unproven).toBe(true);

    rerender({ active: false });
    expect(result.current.unproven).toBe(false);

    await settle(WINDOW_MS + 10);
    expect(result.current.unproven).toBe(false);
  });
});
