import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";

import type { ConfigGetResponse } from "@/generated/daemon/types.gen";
import { useStickyProfiles } from "./use-sticky-profiles";

type Llm = NonNullable<ConfigGetResponse["llm"]>;

/** Build a minimal `llm` config slice for the hook under test. */
function llm(
  profiles: Record<string, { label?: string }>,
  profileOrder: string[],
): Llm {
  return { profiles, profileOrder } as Llm;
}

const FULL = llm({ smart: { label: "Smart" } }, ["smart"]);
const EMPTY = llm({}, []);

describe("useStickyProfiles", () => {
  test("returns empty before any non-empty config has loaded", () => {
    const { result } = renderHook(() => useStickyProfiles(undefined, "asst-1"));
    expect(result.current.profiles).toEqual({});
    expect(result.current.profileOrder).toEqual([]);
  });

  test("passes through live profiles", () => {
    const { result } = renderHook(() => useStickyProfiles(FULL, "asst-1"));
    expect(Object.keys(result.current.profiles)).toEqual(["smart"]);
    expect(result.current.profileOrder).toEqual(["smart"]);
  });

  test("retains the last non-empty list when config transiently empties", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: Llm }) => useStickyProfiles(value, "asst-1"),
      { initialProps: { value: FULL } },
    );
    expect(Object.keys(result.current.profiles)).toEqual(["smart"]);

    // A transient empty config payload must NOT blank the picker.
    rerender({ value: EMPTY });
    expect(Object.keys(result.current.profiles)).toEqual(["smart"]);
    expect(result.current.profileOrder).toEqual(["smart"]);
  });

  test("adopts a newer non-empty list when it arrives", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: Llm }) => useStickyProfiles(value, "asst-1"),
      { initialProps: { value: FULL } },
    );
    const next = llm(
      { smart: { label: "Smart" }, fast: { label: "Fast" } },
      ["smart", "fast"],
    );
    rerender({ value: next });
    expect(Object.keys(result.current.profiles)).toEqual(["smart", "fast"]);
    expect(result.current.profileOrder).toEqual(["smart", "fast"]);
  });

  test("drops the retained snapshot when the assistant (resetKey) changes", () => {
    const { result, rerender } = renderHook(
      ({ value, key }: { value: Llm; key: string }) =>
        useStickyProfiles(value, key),
      { initialProps: { value: FULL, key: "asst-1" } },
    );
    expect(Object.keys(result.current.profiles)).toEqual(["smart"]);

    // Switch assistants while the new assistant's config is still loading
    // (empty). The previous assistant's profiles must not leak through.
    rerender({ value: EMPTY, key: "asst-2" });
    expect(result.current.profiles).toEqual({});
    expect(result.current.profileOrder).toEqual([]);
  });
});
