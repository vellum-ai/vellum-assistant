/**
 * One test per gate, plus the surface selection the gates feed.
 *
 * The progress read is mocked at the hook seam rather than at the transport:
 * this file is about the decision the gate stack makes given a progress
 * snapshot, and `use-activation-progress.ts` owns how that snapshot is
 * fetched.
 */

import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import {
  ACTIVATION_PROGRESS_ALL_DONE,
  ACTIVATION_PROGRESS_DISMISSED,
  ACTIVATION_PROGRESS_EMPTY,
  ACTIVATION_PROGRESS_MIXED,
} from "@/domains/activation/activation-test-fixtures";
import {
  mockActivationProgress,
  resetActivationFlagStore,
  seedActivationIdentity,
  setActivationArm,
} from "@/domains/activation/activation-test-helpers";
import { MIN_VERSION } from "@/lib/backwards-compat/use-supports-activation-progress";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useBannerVisibilityStore } from "@/stores/banner-visibility-store";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";

const progressMock = await mockActivationProgress();

// The mock outlives this file otherwise, and any suite after it reading the
// same hook would get this file's leftover snapshot.
afterAll(() => {
  progressMock.restore();
});

const { useActivationVisibility } =
  await import("@/domains/activation/hooks/use-activation-visibility");

function wrapper(pathname: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[pathname]}>{children}</MemoryRouter>;
  };
}

const ASSISTANT_ID = "asst-1";

function visibility(pathname = "/assistant/conversation/c1") {
  const { result } = renderHook(() => useActivationVisibility(), {
    wrapper: wrapper(pathname),
  });
  return result.current;
}

beforeEach(() => {
  progressMock.set(ACTIVATION_PROGRESS_EMPTY);
  setActivationArm("smb");
  seedActivationIdentity(ASSISTANT_ID);
  useInChatOnboardingStore.setState({ prototypeActive: false });
  useBannerVisibilityStore.setState({ visibleBannerCount: 0 });
});

afterEach(() => {
  cleanup();
  resetActivationFlagStore();
  useAssistantIdentityStore.getState().clearIdentity();
  useInChatOnboardingStore.setState({ prototypeActive: false });
  useBannerVisibilityStore.setState({ visibleBannerCount: 0 });
});

describe("useActivationVisibility gates", () => {
  test("hides everything when the flag arm is off", () => {
    setActivationArm("off");
    expect(visibility()).toEqual({ surface: null, listId: null });
  });

  test("hides everything when the daemon predates the routes", () => {
    seedActivationIdentity(ASSISTANT_ID, "0.11.8");
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
    progressMock.set(undefined);
    expect(visibility().surface).toBeNull();
  });

  test("hides everything on an onboarding route", () => {
    expect(visibility("/assistant/onboarding/research").surface).toBeNull();
  });

  // The page the user opened is the whole checklist; a modal over it hides
  // what they came for and a pill beside it points at where they already are.
  test("hides everything on the Inspiration List", () => {
    expect(visibility("/assistant/suggestions").surface).toBeNull();
  });

  test("hides everything on a page nested under the Inspiration List", () => {
    expect(visibility("/assistant/suggestions/task-1").surface).toBeNull();
  });

  // The match is on the segment boundary, so a sibling route that merely
  // starts with the same characters still gets the pill.
  test("shows the pill on a route that only shares the list's prefix", () => {
    progressMock.set(ACTIVATION_PROGRESS_DISMISSED);
    expect(visibility("/assistant/suggestions-archive").surface).toBe("pill");
  });

  test("hides everything while the in-chat tour is running", () => {
    useInChatOnboardingStore.setState({ prototypeActive: true });
    expect(visibility().surface).toBeNull();
  });

  // The banner takes the slot the pill would sit in, so the pill gives way.
  test("hides the pill while a banner occupies the slot", () => {
    progressMock.set(ACTIVATION_PROGRESS_DISMISSED);
    useBannerVisibilityStore.setState({ visibleBannerCount: 1 });
    expect(visibility().surface).toBeNull();
  });

  // The modal is a blocking dialog over the whole screen, not a tenant of the
  // pill's slot. Hiding it behind any composer nudge would retire the
  // checklist for whoever happens to have one.
  test("keeps the welcome modal while a banner occupies the slot", () => {
    useBannerVisibilityStore.setState({ visibleBannerCount: 1 });
    expect(visibility().surface).toBe("modal");
  });

  test("keeps the celebration while a banner occupies the slot", () => {
    progressMock.set(ACTIVATION_PROGRESS_ALL_DONE);
    useBannerVisibilityStore.setState({ visibleBannerCount: 1 });
    expect(visibility().surface).toBe("all-done");
  });

  test("hides everything when the frozen list is not in this build", () => {
    progressMock.set({ ...ACTIVATION_PROGRESS_EMPTY, listId: "retired-list" });
    expect(visibility().surface).toBeNull();
  });
});

describe("useActivationVisibility surface selection", () => {
  test("shows the modal until it is dismissed", () => {
    expect(visibility()).toEqual({ surface: "modal", listId: "smb" });
  });

  test("shows the pill once dismissed with starters left", () => {
    progressMock.set(ACTIVATION_PROGRESS_DISMISSED);
    expect(visibility()).toEqual({ surface: "pill", listId: "smb" });
  });

  test("keeps the modal while tasks are in flight", () => {
    progressMock.set(ACTIVATION_PROGRESS_MIXED);
    expect(visibility().surface).toBe("modal");
  });

  test("shows the celebration once all three starters are done", () => {
    progressMock.set(ACTIVATION_PROGRESS_ALL_DONE);
    expect(visibility()).toEqual({ surface: "all-done", listId: "smb" });
  });

  test("shows nothing after the celebration has been seen", () => {
    progressMock.set({
      ...ACTIVATION_PROGRESS_ALL_DONE,
      modalDismissedAt: "2026-09-02T10:00:00.000Z",
      allDoneShownAt: "2026-09-02T10:00:00.000Z",
    });
    expect(visibility().surface).toBeNull();
  });

  // Finishing all three starters without ever clicking "Do it Later" leaves
  // `modalDismissedAt` null, so the celebration has to end the checklist on
  // its own rather than falling through to the welcome modal.
  test("shows nothing after a celebration dismissed without the modal ever being", () => {
    progressMock.set({
      ...ACTIVATION_PROGRESS_ALL_DONE,
      modalDismissedAt: null,
      allDoneShownAt: "2026-09-02T10:00:00.000Z",
    });
    expect(visibility()).toEqual({ surface: null, listId: null });
  });

  // Re-bucketing a user in LaunchDarkly must not reshuffle a checklist they
  // have already started, so the daemon's frozen list beats the arm.
  test("prefers the frozen list over the flag arm", () => {
    setActivationArm("parent");
    progressMock.set({ ...ACTIVATION_PROGRESS_EMPTY, listId: "smb" });
    expect(visibility().listId).toBe("smb");
  });

  test("falls back to the arm's list before one is frozen", () => {
    setActivationArm("parent");
    expect(visibility().listId).toBe("parent");
  });
});
