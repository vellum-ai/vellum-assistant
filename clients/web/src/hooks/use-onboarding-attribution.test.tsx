/**
 * Covers the onboarding deep-link attribution capture: the `vref` check-in value
 * emits the funnel step exactly once (after auth resolves a user id) and is then
 * stripped from the URL, while other params and unrelated `vref` values are left
 * untouched.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import { useOnboardingAttribution } from "@/hooks/use-onboarding-attribution";

const emit = mock(() => {});
mock.module("@/domains/onboarding/funnel-events", () => ({
  ONBOARDING_ATTRIBUTION_PARAM: "vref",
  RESEARCH_CHECKIN_CALENDAR_ATTRIBUTION: "research_checkin",
  emitResearchOnboardingCheckinCalendarOpened: emit,
}));

afterEach(() => {
  cleanup();
  emit.mockClear();
});

type SetSearchParamsArgs = [unknown, unknown?];

function props(search: string, userId: string | null) {
  const setSearchParams = mock((..._args: SetSearchParamsArgs) => {});
  return {
    searchParams: new URLSearchParams(search),
    setSearchParams,
    userId,
  };
}

describe("useOnboardingAttribution", () => {
  it("emits once and strips the param when auth has resolved", () => {
    const p = props("prompt=hi&vref=research_checkin", "user-1");
    renderHook((x) => useOnboardingAttribution(x), { initialProps: p });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ userId: "user-1" });
    // Stripped via an updater that deletes only the attribution param.
    expect(p.setSearchParams).toHaveBeenCalledTimes(1);
    const updater = p.setSearchParams.mock.calls[0][0] as (
      prev: URLSearchParams,
    ) => URLSearchParams;
    const next = updater(new URLSearchParams("prompt=hi&vref=research_checkin"));
    expect(next.has("vref")).toBe(false);
    expect(next.get("prompt")).toBe("hi");
  });

  it("waits for a user id before emitting", () => {
    const p = props("vref=research_checkin", null);
    const { rerender } = renderHook((x) => useOnboardingAttribution(x), {
      initialProps: p,
    });
    expect(emit).not.toHaveBeenCalled();

    rerender({ ...p, userId: "user-2" });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ userId: "user-2" });
  });

  it("ignores an absent or unrelated vref value", () => {
    renderHook((x) => useOnboardingAttribution(x), {
      initialProps: props("prompt=hi&vref=something_else", "user-1"),
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not re-emit on re-render once consumed", () => {
    const p = props("vref=research_checkin", "user-1");
    const { rerender } = renderHook((x) => useOnboardingAttribution(x), {
      initialProps: p,
    });
    expect(emit).toHaveBeenCalledTimes(1);

    rerender({ ...p, searchParams: new URLSearchParams("vref=research_checkin") });
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
