/**
 * One test per gate, plus the surface selection the gates feed.
 *
 * The progress read is mocked at the hook seam rather than at the transport:
 * this file is about the decision the gate stack makes given a progress
 * snapshot, and `use-activation-progress.ts` owns how that snapshot is
 * fetched.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import {
  ACTIVATION_PROGRESS_ALL_DONE,
  ACTIVATION_PROGRESS_DISMISSED,
  ACTIVATION_PROGRESS_EMPTY,
  ACTIVATION_PROGRESS_MIXED,
} from "@/domains/activation/activation-test-fixtures";
import type { ActivationProgress } from "@/domains/activation/hooks/use-activation-progress";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useBannerVisibilityStore } from "@/stores/banner-visibility-store";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { MIN_VERSION } from "@/lib/backwards-compat/use-supports-activation-progress";

let progress: ActivationProgress | undefined;
// Spread the real module: `mock.module` replaces it for every test file
// sharing this process, so returning only the mocked export would erase the
// rest for anything that loads it later.
const progressModule = await import(
  "@/domains/activation/hooks/use-activation-progress"
);
mock.module("@/domains/activation/hooks/use-activation-progress", () => ({
  ...progressModule,
  useActivationProgress: () => ({ data: progress }),
}));

const { useActivationVisibility } = await import(
  "@/domains/activation/hooks/use-activation-visibility"
);

function wrapper(pathname: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[pathname]}>{children}</MemoryRouter>;
  };
}

const ASSISTANT_ID = "asst-1";

function setArm(arm: string): void {
  useClientFeatureFlagStore
    .getState()
    .setStringFlags({ activationChecklist: arm }, null);
}

function visibility(pathname = "/assistant/conversation/c1") {
  const { result } = renderHook(() => useActivationVisibility(), {
    wrapper: wrapper(pathname),
  });
  return result.current;
}

beforeEach(() => {
  progress = ACTIVATION_PROGRESS_EMPTY;
  setArm("smb");
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
  useAssistantIdentityStore
    .getState()
    .setIdentity("Vel", MIN_VERSION, ASSISTANT_ID);
  useInChatOnboardingStore.setState({ prototypeActive: false });
  useBannerVisibilityStore.setState({ visibleBannerCount: 0 });
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
  useInChatOnboardingStore.setState({ prototypeActive: false });
  useBannerVisibilityStore.setState({ visibleBannerCount: 0 });
});

describe("useActivationVisibility gates", () => {
  test("hides everything when the flag arm is off", () => {
    setArm("off");
    expect(visibility()).toEqual({ surface: null, listId: null });
  });

  test("hides everything when the daemon predates the routes", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("Vel", "0.11.8", ASSISTANT_ID);
    expect(visibility().surface).toBeNull();
  });

  // The assistant-switch window: the active id flips a render before the
  // identity fetch replaces the version it was read for.
  test("hides everything while the version belongs to another assistant", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("Vel", MIN_VERSION, "asst-other");
    expect(visibility().surface).toBeNull();
  });

  test("hides everything until progress has loaded", () => {
    progress = undefined;
    expect(visibility().surface).toBeNull();
  });

  test("hides everything on an onboarding route", () => {
    expect(visibility("/assistant/onboarding/research").surface).toBeNull();
  });

  test("hides everything while the in-chat tour is running", () => {
    useInChatOnboardingStore.setState({ prototypeActive: true });
    expect(visibility().surface).toBeNull();
  });

  test("hides everything while a banner occupies the slot", () => {
    useBannerVisibilityStore.setState({ visibleBannerCount: 1 });
    expect(visibility().surface).toBeNull();
  });

  test("hides everything when the frozen list is not in this build", () => {
    progress = { ...ACTIVATION_PROGRESS_EMPTY, listId: "retired-list" };
    expect(visibility().surface).toBeNull();
  });
});

describe("useActivationVisibility surface selection", () => {
  test("shows the modal until it is dismissed", () => {
    expect(visibility()).toEqual({ surface: "modal", listId: "smb" });
  });

  test("shows the pill once dismissed with starters left", () => {
    progress = ACTIVATION_PROGRESS_DISMISSED;
    expect(visibility()).toEqual({ surface: "pill", listId: "smb" });
  });

  test("keeps the modal while tasks are in flight", () => {
    progress = ACTIVATION_PROGRESS_MIXED;
    expect(visibility().surface).toBe("modal");
  });

  test("shows the celebration once all three starters are done", () => {
    progress = ACTIVATION_PROGRESS_ALL_DONE;
    expect(visibility()).toEqual({ surface: "all-done", listId: "smb" });
  });

  test("shows nothing after the celebration has been seen", () => {
    progress = {
      ...ACTIVATION_PROGRESS_ALL_DONE,
      modalDismissedAt: "2026-09-02T10:00:00.000Z",
      allDoneShownAt: "2026-09-02T10:00:00.000Z",
    };
    expect(visibility().surface).toBeNull();
  });

  // Finishing all three starters without ever clicking "Do it Later" leaves
  // `modalDismissedAt` null, so the celebration has to end the checklist on
  // its own rather than falling through to the welcome modal.
  test("shows nothing after a celebration dismissed without the modal ever being", () => {
    progress = {
      ...ACTIVATION_PROGRESS_ALL_DONE,
      modalDismissedAt: null,
      allDoneShownAt: "2026-09-02T10:00:00.000Z",
    };
    expect(visibility()).toEqual({ surface: null, listId: null });
  });

  // Re-bucketing a user in LaunchDarkly must not reshuffle a checklist they
  // have already started, so the daemon's frozen list beats the arm.
  test("prefers the frozen list over the flag arm", () => {
    setArm("parent");
    progress = { ...ACTIVATION_PROGRESS_EMPTY, listId: "smb" };
    expect(visibility().listId).toBe("smb");
  });

  test("falls back to the arm's list before one is frozen", () => {
    setArm("parent");
    expect(visibility().listId).toBe("parent");
  });
});
