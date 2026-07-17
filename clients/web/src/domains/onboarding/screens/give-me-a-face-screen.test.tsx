/**
 * Tests for the face/name step's voice surface — the only place voice appears in
 * onboarding: a "Hear my voice" audition, shown only behind the `voice-mode`
 * flag, that synthesizes the assistant's managed voice on demand (never on
 * landing) and plays it.
 *
 * The decorative avatar layer + audio playback are mocked so the test exercises
 * the voice affordance + wiring, not the carousel or a real <audio> element.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("@/utils/use-bundled-avatar-components", () => ({
  // Truthy so the scene renders + the pool generates; `colors: []` keeps
  // `useOnboardingTone` (read by the shared top bar) happy.
  useBundledAvatarComponents: () => ({ colors: [] }),
}));
mock.module("@/domains/onboarding/components/onboarding-character-stage", () => ({
  OnboardingCharacterStage: () => null,
}));

const synthesize = mock(
  (_assistantId: string, _text: string): Promise<Blob | null> =>
    Promise.resolve(new Blob(["audio"])),
);
mock.module("@/domains/onboarding/onboarding-voice-sample", () => ({
  synthesizeManagedVoiceSample: synthesize,
}));

import { GiveMeAFaceScreen } from "@/domains/onboarding/screens/give-me-a-face-screen";

beforeAll(() => {
  // jsdom/happy-dom don't implement media playback or object URLs.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () =>
    "blob:test";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  (
    window.HTMLMediaElement.prototype as unknown as { play: () => Promise<void> }
  ).play = () => Promise.resolve();
  (
    window.HTMLMediaElement.prototype as unknown as { pause: () => void }
  ).pause = () => {};
});

function renderScreen(
  props: Partial<Parameters<typeof GiveMeAFaceScreen>[0]> = {},
) {
  return render(
    <GiveMeAFaceScreen onContinue={() => {}} onBack={() => {}} {...props} />,
  );
}

afterEach(() => {
  cleanup();
  synthesize.mockClear();
});

describe("GiveMeAFaceScreen voice surface", () => {
  test("no 'Hear my voice' affordance when voice is off", () => {
    renderScreen({ assistantId: "asst_1" });
    expect(screen.queryByRole("button", { name: "Hear my voice" })).toBeNull();
  });

  test("auditions the managed voice on click (never on landing)", async () => {
    renderScreen({ voiceEnabled: true, assistantId: "asst_1" });

    const hear = screen.getByRole("button", { name: "Hear my voice" });
    // No synthesis on landing.
    expect(synthesize).not.toHaveBeenCalled();

    fireEvent.click(hear);
    await waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));
    // Synthesized against the hatched assistant.
    expect(synthesize.mock.calls[0]?.[0]).toBe("asst_1");
  });

  test("does not synthesize before the assistant is ready", () => {
    renderScreen({ voiceEnabled: true, assistantId: null });

    fireEvent.click(screen.getByRole("button", { name: "Hear my voice" }));
    expect(synthesize).not.toHaveBeenCalled();
  });
});
