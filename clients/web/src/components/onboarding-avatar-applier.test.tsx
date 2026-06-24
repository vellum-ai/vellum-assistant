import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CharacterTraits } from "@/types/avatar";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const TRAITS: CharacterTraits = {
  bodyShape: "round",
  eyeStyle: "dot",
  color: "green",
};

let saveCharacterTraitsImpl: (
  assistantId: string,
  traits: CharacterTraits,
) => Promise<boolean> = async () => true;
const saveCharacterTraitsMock = mock(
  async (assistantId: string, traits: CharacterTraits) =>
    saveCharacterTraitsImpl(assistantId, traits),
);

mock.module("@/assistant/avatar-api", () => ({
  saveCharacterTraits: saveCharacterTraitsMock,
}));

const { OnboardingAvatarApplier } = await import(
  "@/components/onboarding-avatar-applier"
);

describe("OnboardingAvatarApplier", () => {
  beforeEach(() => {
    saveCharacterTraitsImpl = async () => true;
    saveCharacterTraitsMock.mockClear();
    useOnboardingFocusStore.setState({ pendingAvatarTraits: null });
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
  });

  afterEach(cleanup);

  test("clears staged traits after a successful save", async () => {
    useOnboardingFocusStore.getState().setPendingAvatarTraits(TRAITS);
    useResolvedAssistantsStore.getState().setActiveAssistantId("asst-1");

    render(<OnboardingAvatarApplier />);

    await waitFor(() =>
      expect(saveCharacterTraitsMock).toHaveBeenCalledWith("asst-1", TRAITS),
    );
    await waitFor(() =>
      expect(useOnboardingFocusStore.getState().pendingAvatarTraits).toBeNull(),
    );
  });

  test("keeps staged traits queued when the save reports failure", async () => {
    saveCharacterTraitsImpl = async () => false;
    useOnboardingFocusStore.getState().setPendingAvatarTraits(TRAITS);
    useResolvedAssistantsStore.getState().setActiveAssistantId("asst-1");

    render(<OnboardingAvatarApplier />);

    await waitFor(() =>
      expect(saveCharacterTraitsMock).toHaveBeenCalledWith("asst-1", TRAITS),
    );
    expect(useOnboardingFocusStore.getState().pendingAvatarTraits).toEqual(
      TRAITS,
    );
  });
});
