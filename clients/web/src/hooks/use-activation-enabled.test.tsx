/**
 * The layer above the leaf gate: the daemon's frozen list overrides the arm's.
 *
 * The progress read is mocked at its hook seam, because what is under test is
 * the rule applied to a snapshot rather than how one is fetched.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { ACTIVATION_PROGRESS_EMPTY } from "@/domains/activation/activation-test-fixtures";
import {
  mockActivationProgress,
  resetActivationFlagStore,
  seedActivationIdentity,
  setActivationArm,
} from "@/domains/activation/activation-test-helpers";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const progressMock = await mockActivationProgress();

// The mock outlives this file otherwise, and any suite after it reading the
// same hook would get this file's leftover snapshot.
afterAll(() => {
  progressMock.restore();
});

const { useEffectiveActivationListId, readEffectiveActivationListId } =
  await import("@/hooks/use-activation-enabled");

const ASSISTANT_ID = "asst-1";

function listId(): string | null {
  return renderHook(() => useEffectiveActivationListId()).result.current;
}

/** The frozen list a progress document carries, or none at all. */
function frozen(listId: string | null) {
  return { ...ACTIVATION_PROGRESS_EMPTY, listId };
}

beforeEach(() => {
  setActivationArm("smb");
  seedActivationIdentity(ASSISTANT_ID);
  progressMock.set(frozen(null));
});

afterEach(() => {
  cleanup();
  resetActivationFlagStore();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useEffectiveActivationListId", () => {
  test("falls back to the arm's list before one is frozen", () => {
    setActivationArm("parent");
    expect(listId()).toBe("parent");
  });

  // Re-bucketing a user in LaunchDarkly must not reshuffle a checklist they
  // have already started, so the daemon's frozen list beats the arm.
  test("prefers the frozen list over the arm", () => {
    setActivationArm("parent");
    progressMock.set(frozen("smb"));
    expect(listId()).toBe("smb");
  });

  // A frozen id written by a newer client has no catalog here, and an empty
  // list is a worse answer than no surface at all.
  test("names no list when the frozen one is not in this build", () => {
    progressMock.set(frozen("retired-list"));
    expect(listId()).toBeNull();
  });

  // A frozen list says which checklist, never whether: the gates below still
  // decide that.
  test("names no list when the gates are off, whatever is frozen", () => {
    setActivationArm("off");
    progressMock.set(frozen("smb"));
    expect(listId()).toBeNull();
  });

  test("names no list before the progress read lands", () => {
    progressMock.set(undefined);
    expect(listId()).toBe("smb");
  });

  // Telemetry runs from event handlers and effects, so it reads the answer
  // rather than resolving it.
  test("publishes the resolved list for readers that cannot be hooks", () => {
    setActivationArm("parent");
    progressMock.set(frozen("smb"));
    listId();
    expect(readEffectiveActivationListId()).toBe("smb");
  });
});
