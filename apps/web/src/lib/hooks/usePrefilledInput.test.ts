/**
 * Tests for `usePrefilledInput`.
 *
 * Coverage:
 *   1. Synchronously-available seed shows up on the first render via
 *      the lazy initializer (no flicker for cached / already-resolved
 *      auth sessions).
 *   2. Empty / nullish / whitespace-only seeds produce an empty value,
 *      so consumers without a seed (e.g. email-only signup) get the
 *      same blank-input behavior they'd get without the hook.
 *   3. Whitespace is trimmed from the seed.
 *   4. A seed that arrives after mount backfills an empty input (the
 *      common case where async data resolves a tick after the initial
 *      render).
 *   5. Once `onChange` has been called, a later seed change does NOT
 *      overwrite the user's value — including the case where the user
 *      cleared the field intentionally.
 *   6. A seed change while untouched but already-filled (e.g. seed
 *      went from "Magic" to "Wizard") preserves the original fill —
 *      we only fill an empty input, never re-overwrite an existing
 *      one — so the user's first impression of the value is stable.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { usePrefilledInput } from "@/lib/hooks/usePrefilledInput.js";

afterEach(() => {
  cleanup();
});

describe("usePrefilledInput", () => {
  test("seeds the value via the lazy initializer (synchronous seed)", () => {
    const { result } = renderHook(() => usePrefilledInput("Magic"));
    expect(result.current.value).toBe("Magic");
  });

  test("returns an empty value for nullish or empty seeds", () => {
    const cases: (string | null | undefined)[] = [null, undefined, "", "   "];
    for (const seed of cases) {
      const { result, unmount } = renderHook(() => usePrefilledInput(seed));
      expect(result.current.value).toBe("");
      unmount();
    }
  });

  test("trims surrounding whitespace from the seed", () => {
    const { result } = renderHook(() => usePrefilledInput("  Magic  "));
    expect(result.current.value).toBe("Magic");
  });

  test("backfills an empty value when the seed arrives after mount", () => {
    const { result, rerender } = renderHook(
      ({ seed }: { seed: string | null | undefined }) =>
        usePrefilledInput(seed),
      { initialProps: { seed: undefined as string | null | undefined } },
    );
    expect(result.current.value).toBe("");

    rerender({ seed: "Magic" });
    expect(result.current.value).toBe("Magic");
  });

  test("does NOT overwrite a user-typed value when the seed changes", () => {
    const { result, rerender } = renderHook(
      ({ seed }: { seed: string | null | undefined }) =>
        usePrefilledInput(seed),
      { initialProps: { seed: undefined as string | null | undefined } },
    );
    expect(result.current.value).toBe("");

    act(() => {
      result.current.onChange("Wizard");
    });
    expect(result.current.value).toBe("Wizard");

    rerender({ seed: "Magic" });
    expect(result.current.value).toBe("Wizard");
  });

  test("does NOT overwrite a user-cleared value when the seed changes", () => {
    const { result, rerender } = renderHook(
      ({ seed }: { seed: string | null | undefined }) =>
        usePrefilledInput(seed),
      { initialProps: { seed: "Magic" as string | null | undefined } },
    );
    expect(result.current.value).toBe("Magic");

    act(() => {
      result.current.onChange("");
    });
    expect(result.current.value).toBe("");

    rerender({ seed: "Wizard" });
    expect(result.current.value).toBe("");
  });

  test("does NOT re-overwrite an already-seeded value if the seed changes", () => {
    const { result, rerender } = renderHook(
      ({ seed }: { seed: string | null | undefined }) =>
        usePrefilledInput(seed),
      { initialProps: { seed: "Magic" as string | null | undefined } },
    );
    expect(result.current.value).toBe("Magic");

    rerender({ seed: "Wizard" });
    expect(result.current.value).toBe("Magic");
  });
});
