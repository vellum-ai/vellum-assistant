/**
 * Tests for the face/name step's voice surface, the only place voice appears in
 * onboarding: a "Hear my voice" audition of the CENTERED avatar's own voice.
 *
 * The pairing is the whole point, so the tests that matter are about which
 * voice belongs to which face: that cycling the carousel changes what plays,
 * that it stops what was playing, and that Continue carries the voice the user
 * actually heard.
 *
 * The decorative avatar layer and audio playback are mocked so the test
 * exercises the voice affordance and wiring, not the carousel or a real
 * <audio> element.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

mock.module("@/utils/use-bundled-avatar-components", () => ({
  // Truthy so the scene renders + the pool generates; `colors: []` keeps
  // `useOnboardingTone` (read by the shared top bar) happy.
  useBundledAvatarComponents: () => ({ colors: [] }),
}));
mock.module(
  "@/domains/onboarding/components/onboarding-character-stage",
  () => ({
    OnboardingCharacterStage: () => null,
  }),
);

// A stand-in catalog: enough of the real one to cover both a voice the pairing
// asks for by name and the fallback when it doesn't.
const SARAH = {
  model: "EXAVITQu4vr4xnSDxMaL",
  label: "Sarah",
  description: "American · professional, reassuring, confident",
  sampleUrl: "https://example.test/sarah.mp3",
  source: "elevenlabs",
};
const DANIEL = {
  model: "onwK4e9ZLuTAKqWW03F9",
  label: "Daniel",
  description: "British · authoritative, steady, formal",
  sampleUrl: "https://example.test/daniel.mp3",
  source: "elevenlabs",
};
let catalog: Array<typeof SARAH> = [];
let voicesLoading = false;
mock.module("@/lib/tts/use-managed-voices", () => ({
  // The audition reads the platform directly, taking no assistant id, so it
  // does not wait on a hatch.
  useUnscopedManagedVoices: () => ({
    voices: catalog,
    defaultModel: catalog[0]?.model ?? null,
    fetched: catalog.length > 0,
    loading: voicesLoading,
  }),
}));

const { useOnboardingAvatarPoolStore } =
  await import("@/domains/onboarding/onboarding-avatar-pool-store");
const { GiveMeAFaceScreen } =
  await import("@/domains/onboarding/screens/give-me-a-face-screen");

let played: string[] = [];
let paused = 0;

beforeAll(() => {
  // happy-dom doesn't implement media playback.
  (
    window.HTMLMediaElement.prototype as unknown as {
      play: () => Promise<void>;
    }
  ).play = function (this: HTMLAudioElement) {
    played.push(this.src);
    return Promise.resolve();
  };
  (
    window.HTMLMediaElement.prototype as unknown as { pause: () => void }
  ).pause = () => {
    paused++;
  };
});

beforeEach(() => {
  catalog = [SARAH, DANIEL];
  voicesLoading = false;
  played = [];
  paused = 0;
  // The avatar pool is a module-level store, so `cleanup` unmounts the screen
  // but leaves whichever avatar the last test cycled to still selected. Every
  // test here asserts on the voice of a KNOWN avatar, so each one starts from
  // the centered-first avatar.
  useOnboardingAvatarPoolStore.setState({ selectedIndex: 0 });
});

afterEach(cleanup);

function renderScreen(
  props: Partial<Parameters<typeof GiveMeAFaceScreen>[0]> = {},
) {
  return render(
    <GiveMeAFaceScreen onContinue={() => {}} onBack={() => {}} {...props} />,
  );
}

const hearButton = () => screen.getByRole("button", { name: "Hear my voice" });

describe("GiveMeAFaceScreen voice audition", () => {
  test("auditions the centered avatar's voice on click, never on landing", async () => {
    renderScreen();
    expect(played).toEqual([]);

    fireEvent.click(hearButton());
    // The first-centered avatar is paired with the platform default voice.
    await waitFor(() => expect(played).toEqual([SARAH.sampleUrl]));
  });

  test("cycling the carousel auditions a different voice", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Next character" }));

    fireEvent.click(hearButton());
    await waitFor(() => expect(played).toEqual([DANIEL.sampleUrl]));
  });

  test("cycling away stops the audition mid-play", async () => {
    renderScreen();
    fireEvent.click(hearButton());
    await waitFor(() => expect(played.length).toBe(1));
    // Playing, so the control offers to stop instead.
    expect(
      screen.getByRole("button", { name: "Stop the voice sample" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next character" }));

    // The voice that belonged to the old face doesn't run over the new one.
    expect(paused).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "Stop the voice sample" }),
    ).toBeNull();
  });

  test("the control stops a playing audition", async () => {
    renderScreen();
    fireEvent.click(hearButton());
    const stop = await screen.findByRole("button", {
      name: "Stop the voice sample",
    });

    fireEvent.click(stop);
    expect(paused).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "Stop the voice sample" }),
    ).toBeNull();
  });

  test("carries the auditioned voice through Continue", () => {
    const onContinue = mock(() => {});
    renderScreen({ onContinue });
    fireEvent.click(screen.getByRole("button", { name: "Next character" }));

    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

    expect(
      (
        onContinue.mock.calls[0] as unknown as [{ voiceModel: string | null }]
      )[0].voiceModel,
    ).toBe(DANIEL.model);
  });

  test("stays inert, and reports no voice, without a catalog", () => {
    const onContinue = mock(() => {});
    // The catalog failed or served nothing, so there is no voice to audition.
    catalog = [];
    renderScreen({ onContinue });

    fireEvent.click(hearButton());
    expect(played).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(
      (
        onContinue.mock.calls[0] as unknown as [{ voiceModel: string | null }]
      )[0].voiceModel,
    ).toBeNull();
  });

  test("reads as pending, not dead, while the catalog is in flight", () => {
    catalog = [];
    voicesLoading = true;
    renderScreen();

    // Still unclickable (there is nothing to play yet) but marked busy, so it
    // presents as loading rather than as a broken control.
    const button = hearButton();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(played).toEqual([]);
  });

  test("drops the pending state once the catalog lands", () => {
    renderScreen();

    const button = hearButton();
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  test("offers no audition at all when the catalog is out of reach", () => {
    // Onboarding that adopts a locally-hosted assistant may hold no platform
    // session, so the control is absent rather than permanently inert.
    renderScreen({ canAuditionVoice: false });

    expect(screen.queryByRole("button", { name: "Hear my voice" })).toBeNull();
    // The rest of the step is untouched.
    expect(screen.getByRole("button", { name: /Continue/ })).toBeTruthy();
  });
});
