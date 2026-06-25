import { describe, expect, test, beforeEach } from "bun:test";

import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";

beforeEach(() => {
  useOnboardingFocusStore.setState({
    sidebarCollapseRequested: false,
    focused: false,
    pendingAvatarTraits: null,
  });
});

describe("useOnboardingFocusStore — sidebar collapse one-shot signal", () => {
  test("requestSidebarCollapse arms the signal", () => {
    useOnboardingFocusStore.getState().requestSidebarCollapse();
    expect(useOnboardingFocusStore.getState().sidebarCollapseRequested).toBe(
      true,
    );
  });

  test("consumeSidebarCollapse clears the signal", () => {
    useOnboardingFocusStore.getState().requestSidebarCollapse();
    useOnboardingFocusStore.getState().consumeSidebarCollapse();
    expect(useOnboardingFocusStore.getState().sidebarCollapseRequested).toBe(
      false,
    );
  });

  test("exitFocus also clears a stale armed signal", () => {
    useOnboardingFocusStore.getState().requestSidebarCollapse();
    useOnboardingFocusStore.getState().exitFocus();
    expect(useOnboardingFocusStore.getState().sidebarCollapseRequested).toBe(
      false,
    );
  });

  test("exitFocus preserves staged avatar traits for the handoff applier", () => {
    const traits = { bodyShape: "round", eyeStyle: "dot", color: "green" };
    useOnboardingFocusStore.getState().setPendingAvatarTraits(traits);

    useOnboardingFocusStore.getState().exitFocus();

    expect(useOnboardingFocusStore.getState().pendingAvatarTraits).toEqual(
      traits,
    );
  });
});
