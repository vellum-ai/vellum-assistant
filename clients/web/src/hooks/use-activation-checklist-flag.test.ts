/**
 * Tests for the `activation-checklist` read seam: the arm-to-list contract,
 * including the fallback that keeps a targeted user on a surface when the
 * build does not know the arm's list.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  ACTIVATION_LIST_IDS,
  resolveActivationListId,
  useActivationChecklistArm,
} from "@/hooks/use-activation-checklist-flag";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

const initialState = useClientFeatureFlagStore.getState();

beforeEach(() => {
  useClientFeatureFlagStore.setState(initialState, true);
});

afterEach(() => {
  cleanup();
  useClientFeatureFlagStore.setState(initialState, true);
});

describe("resolveActivationListId", () => {
  test("returns null for the off arm", () => {
    expect(resolveActivationListId("off")).toBeNull();
  });

  test("returns null for an empty arm", () => {
    expect(resolveActivationListId("")).toBeNull();
  });

  test("returns each known arm unchanged", () => {
    for (const listId of ACTIVATION_LIST_IDS) {
      expect(resolveActivationListId(listId)).toBe(listId);
    }
  });

  test("falls back to smb for an arm this build does not know", () => {
    expect(resolveActivationListId("variant-x")).toBe("smb");
  });
});

describe("useActivationChecklistArm", () => {
  test("is off before the flags hydrate", () => {
    const { result } = renderHook(() => useActivationChecklistArm());
    expect(result.current).toBe("off");
  });

  test("reads the hydrated arm", () => {
    useClientFeatureFlagStore
      .getState()
      .setStringFlags({ activationChecklist: "parent" }, null);
    const { result } = renderHook(() => useActivationChecklistArm());
    expect(result.current).toBe("parent");
  });
});
