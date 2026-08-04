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

let configPatchOk = true;
const configPatchCalls: unknown[] = [];
mock.module("@/generated/daemon/sdk.gen", () => ({
  configPatch: async (opts: unknown) => {
    configPatchCalls.push(opts);
    return {
      response: { ok: configPatchOk, status: configPatchOk ? 200 : 500 },
    };
  },
}));

const {
  OnboardingAvatarApplier,
  getAvatarApplyRetryDelayMs,
  shouldDropAvatarHandoff,
} = await import("@/components/onboarding-avatar-applier");

describe("OnboardingAvatarApplier", () => {
  beforeEach(() => {
    saveCharacterTraitsImpl = async () => true;
    saveCharacterTraitsMock.mockClear();
    configPatchOk = true;
    configPatchCalls.length = 0;
    useOnboardingFocusStore.setState({
      pendingAvatarTraits: null,
      pendingAvatarVoice: null,
    });
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

  test("applies the avatar's voice alongside its face", async () => {
    useOnboardingFocusStore.getState().setPendingAvatarTraits(TRAITS);
    useOnboardingFocusStore.getState().setPendingAvatarVoice("aura-2-luna-en");
    useResolvedAssistantsStore.getState().setActiveAssistantId("asst-1");

    render(<OnboardingAvatarApplier />);

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]).toEqual({
      path: { assistant_id: "asst-1" },
      body: {
        services: {
          tts: { providers: { vellum: { model: "aura-2-luna-en" } } },
        },
      },
      throwOnError: false,
    });
    await waitFor(() =>
      expect(useOnboardingFocusStore.getState().pendingAvatarVoice).toBeNull(),
    );
  });

  test("patches no voice when the catalog never resolved one", async () => {
    useOnboardingFocusStore.getState().setPendingAvatarTraits(TRAITS);
    useResolvedAssistantsStore.getState().setActiveAssistantId("asst-1");

    render(<OnboardingAvatarApplier />);

    await waitFor(() =>
      expect(useOnboardingFocusStore.getState().pendingAvatarTraits).toBeNull(),
    );
    // Nothing to say beyond the platform default the assistant already has.
    expect(configPatchCalls.length).toBe(0);
  });

  test("keeps the handoff queued when the voice write fails", async () => {
    configPatchOk = false;
    useOnboardingFocusStore.getState().setPendingAvatarTraits(TRAITS);
    useOnboardingFocusStore.getState().setPendingAvatarVoice("aura-2-luna-en");
    useResolvedAssistantsStore.getState().setActiveAssistantId("asst-1");

    render(<OnboardingAvatarApplier />);

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    // Face and voice are one pick, so a half-landed handoff stays staged for
    // the retry rather than clearing on the traits alone.
    expect(useOnboardingFocusStore.getState().pendingAvatarVoice).toBe(
      "aura-2-luna-en",
    );
    expect(useOnboardingFocusStore.getState().pendingAvatarTraits).toEqual(
      TRAITS,
    );
  });

  test("backs off retry delays after failed saves", () => {
    expect(getAvatarApplyRetryDelayMs(1)).toBe(1_500);
    expect(getAvatarApplyRetryDelayMs(2)).toBe(3_000);
    expect(getAvatarApplyRetryDelayMs(3)).toBe(6_000);
    expect(getAvatarApplyRetryDelayMs(5)).toBe(15_000);
  });

  test("drops the staged handoff after the retry budget is exhausted", () => {
    expect(shouldDropAvatarHandoff(5)).toBe(false);
    expect(shouldDropAvatarHandoff(6)).toBe(true);
  });
});
