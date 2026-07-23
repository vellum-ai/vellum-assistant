import { describe, expect, test } from "bun:test";

import { act, renderHook } from "@testing-library/react";

import { useHeldPhase } from "./use-held-phase";

const tick = (ms: number) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe("useHeldPhase", () => {
  test("passes the value straight through when the hold is disabled", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useHeldPhase(value, 0),
      { initialProps: { value: "a" } },
    );
    expect(result.current).toBe("a");
    rerender({ value: "b" });
    expect(result.current).toBe("b");
  });

  test("holds the current value until the minimum has elapsed", async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useHeldPhase(value, 120),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });
    expect(result.current).toBe("a");

    await tick(200);
    expect(result.current).toBe("b");
  });

  test("skips a value that never survives its own hold", async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useHeldPhase(value, 120),
      { initialProps: { value: "a" } },
    );

    // Two changes land well inside the first window: "b" is never readable, so
    // it should never be returned.
    rerender({ value: "b" });
    rerender({ value: "c" });
    expect(result.current).toBe("a");

    await tick(200);
    expect(result.current).toBe("c");
  });

  test("gives each value its own window", async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useHeldPhase(value, 120),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });
    await tick(200);
    expect(result.current).toBe("b");

    rerender({ value: "c" });
    expect(result.current).toBe("b");

    await tick(200);
    expect(result.current).toBe("c");
  });
});
