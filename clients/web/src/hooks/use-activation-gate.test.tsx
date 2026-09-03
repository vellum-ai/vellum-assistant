/**
 * The leaf gate: which list the arm names, and when the two gates behind it
 * have answered.
 *
 * Driven through the stores the gate reads rather than mocked, because what is
 * worth proving is that a client the feature is not meant for gets `null`, and
 * that a caller which navigates is never handed an answer that has not
 * arrived.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  resetActivationFlagStore,
  seedActivationIdentity,
} from "@/domains/activation/activation-test-helpers";
import {
  useActivationEnabledListId,
  useActivationGatesSettled,
} from "@/hooks/use-activation-gate";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ASSISTANT_ID = "asst-1";

/** The arm's values, without saying whether a server response has landed. */
function setArmValue(arm: string): void {
  useClientFeatureFlagStore
    .getState()
    .setStringFlags({ activationChecklist: arm }, null);
}

function listId(): string | null {
  return renderHook(() => useActivationEnabledListId()).result.current;
}

function settled(): boolean {
  return renderHook(() => useActivationGatesSettled()).result.current;
}

beforeEach(() => {
  setArmValue("smb");
  useClientFeatureFlagStore.setState({ hydrated: true });
  seedActivationIdentity(ASSISTANT_ID);
});

afterEach(() => {
  cleanup();
  resetActivationFlagStore();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useActivationEnabledListId", () => {
  test("names the arm's list", () => {
    expect(listId()).toBe("smb");
    setArmValue("parent");
    expect(listId()).toBe("parent");
  });

  test("names no list on the off arm", () => {
    setArmValue("off");
    expect(listId()).toBeNull();
  });

  // A list added to LaunchDarkly ahead of the build reading it still shows the
  // surface: the user has been targeted into the feature, and hiding it is a
  // worse answer than showing the default list.
  test("falls back to smb on an arm this build does not know", () => {
    setArmValue("astronaut");
    expect(listId()).toBe("smb");
  });

  test("names no list on a daemon without the routes", () => {
    seedActivationIdentity(ASSISTANT_ID, "0.11.0");
    expect(listId()).toBeNull();
  });

  test("names no list while the assistant's version is unknown", () => {
    useAssistantIdentityStore.getState().clearIdentity();
    expect(listId()).toBeNull();
  });
});

describe("useActivationGatesSettled", () => {
  test("has answered once both gates say yes", () => {
    expect(settled()).toBe(true);
  });

  // A cold load has neither the flag values nor the assistant's version in
  // hand, and both read as "off" until they land.
  test("waits while the flag values are still in flight", () => {
    useClientFeatureFlagStore.setState({ hydrated: false });
    expect(settled()).toBe(false);
  });

  test("waits while the assistant's version is still in flight", () => {
    useAssistantIdentityStore.getState().clearIdentity();
    expect(settled()).toBe(false);
  });

  // A gate that has said no has settled the question. Waiting on the other one
  // for a second opinion it cannot change is how an arm switched off leaves a
  // bookmark on a page that renders nothing at all.
  test("an arm that is off settles the question whatever the version does", () => {
    setArmValue("off");
    useAssistantIdentityStore.getState().clearIdentity();
    expect(settled()).toBe(true);
  });

  // `fetchAssistantIdentity` turns an unreachable runtime into a successful
  // `null`, so the version never lands and never will. The wait ends on the
  // fetch settling, not on a version that is not coming.
  test("an identity fetch that gave up settles the question, disabled", () => {
    useAssistantIdentityStore.getState().clearIdentity();
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    useAssistantIdentityStore.getState().markIdentityUnavailable(ASSISTANT_ID);
    expect(settled()).toBe(true);
    expect(listId()).toBeNull();
  });

  // The dead end is scoped like the version it stands in for: one recorded for
  // the assistant the user just left says nothing about this one.
  test("waits when another assistant's identity fetch gave up", () => {
    useAssistantIdentityStore.getState().clearIdentity();
    useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
    useAssistantIdentityStore.getState().markIdentityUnavailable("asst-other");
    expect(settled()).toBe(false);
  });
});
