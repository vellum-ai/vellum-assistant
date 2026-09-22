import { describe, expect, test } from "bun:test";

import {
  AVATAR_POOL_SIZE,
  pickInitialAvatarIndex,
  useOnboardingAvatarPoolStore,
} from "@/domains/onboarding/onboarding-avatar-pool-store";
import type { CharacterComponents } from "@/types/avatar";

const COMPONENTS = {} as CharacterComponents;

describe("pickInitialAvatarIndex", () => {
  test("is not hardcoded to the first face", () => {
    expect(pickInitialAvatarIndex(AVATAR_POOL_SIZE, () => 0)).toBe(0);
    expect(pickInitialAvatarIndex(AVATAR_POOL_SIZE, () => 0.99)).toBe(
      AVATAR_POOL_SIZE - 1,
    );
    expect(pickInitialAvatarIndex(AVATAR_POOL_SIZE, () => 0.5)).not.toBe(0);
  });

  test("returns 0 for an empty pool", () => {
    expect(pickInitialAvatarIndex(0, () => 0.9)).toBe(0);
  });
});

describe("onboarding avatar pool", () => {
  test("picks a random centered face when the pool is first generated", () => {
    useOnboardingAvatarPoolStore.setState({
      characters: [],
      selectedIndex: 0,
    });
    useOnboardingAvatarPoolStore
      .getState()
      .ensureGenerated(COMPONENTS, () => 0.99);

    const state = useOnboardingAvatarPoolStore.getState();
    expect(state.characters).toHaveLength(AVATAR_POOL_SIZE);
    expect(state.selectedIndex).toBe(AVATAR_POOL_SIZE - 1);
  });

  test("does not reshuffle a pool that already exists", () => {
    useOnboardingAvatarPoolStore.setState({
      characters: [],
      selectedIndex: 0,
    });
    const store = useOnboardingAvatarPoolStore.getState();
    store.ensureGenerated(COMPONENTS, () => 0.99);
    store.ensureGenerated(COMPONENTS, () => 0);

    expect(useOnboardingAvatarPoolStore.getState().selectedIndex).toBe(
      AVATAR_POOL_SIZE - 1,
    );
  });
});
