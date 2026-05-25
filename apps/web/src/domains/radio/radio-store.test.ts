import { beforeEach, describe, expect, it, mock } from "bun:test";

import type {
  RadioAdvanceRequest,
  RadioAdvanceResponse,
  ResolvedRadioDjBreak,
  ResolvedRadioPlaybackPlan,
  ResolvedRadioTrack,
} from "@/domains/radio/types.js";

const advanceRadioMock = mock(
  async (_assistantId: string, _request: RadioAdvanceRequest) =>
    startResponse,
);

mock.module("@/domains/radio/api.js", () => ({
  RADIO_TTS_SETTINGS_PATH: "/assistant/settings/ai",
  advanceRadio: advanceRadioMock,
  runtimeAudioUrl: (assistantId: string, audioPath: string) =>
    `/v1/assistants/${encodeURIComponent(assistantId)}/${audioPath}/`,
}));

class FakeController {
  readonly playInitial = mock(async (_track: ResolvedRadioTrack) => {});
  readonly pause = mock(() => {});
  readonly resume = mock(async () => {});
  readonly skip = mock(() => {});
  readonly applyTransition = mock(
    async (_params: {
      outgoingTrack?: ResolvedRadioTrack | null;
      djBreak: ResolvedRadioDjBreak;
      nextTrack: ResolvedRadioTrack;
      playbackPlan: ResolvedRadioPlaybackPlan;
    }) => {},
  );
}

const controllers: FakeController[] = [];

const track = {
  id: "soft-launch",
  title: "Soft Launch",
  artist: "Vellum Radio",
  durationMs: 18_000,
  audioPath: "radio/tracks/soft-launch",
  sourceLabel: "Demo track",
  license: "repo-generated" as const,
  sha256: "sha",
};

const nextTrack = {
  ...track,
  id: "buffer-bloom",
  title: "Buffer Bloom",
  audioPath: "radio/tracks/buffer-bloom",
};

const djBreak = {
  text: "A little shimmer before Buffer Bloom.",
  audioPath: "audio/dj-1",
  audioId: "dj-1",
  contentType: "audio/mpeg",
};

const startResponse: RadioAdvanceResponse = {
  segmentId: "segment-1",
  displayCue: "song",
  track,
  playbackPlan: {
    reason: "start",
    displayCue: "song",
    track,
  },
};

const transitionResponse: RadioAdvanceResponse = {
  segmentId: "segment-2",
  displayCue: "transition",
  track: nextTrack,
  playbackPlan: {
    reason: "skip",
    displayCue: "transition",
    track: nextTrack,
    djBreak,
  },
  djBreak,
};

const setupResponse: RadioAdvanceResponse = {
  segmentId: "segment-2",
  displayCue: "setup_needed",
  track: nextTrack,
  playbackPlan: {
    reason: "skip",
    displayCue: "setup_needed",
    track: nextTrack,
  },
  setup: {
    reason: "tts_not_configured",
    settingsPath: "/assistant/settings/ai",
    message: "Configure text to speech in Settings.",
  },
};

async function loadStore() {
  const module = await import("@/domains/radio/radio-store.js");
  module.setRadioStoreDependencies({
    createController: () => {
      const controller = new FakeController();
      controllers.push(controller);
      return controller;
    },
  });
  module.useRadioStore.getState().reset();
  return module.useRadioStore;
}

beforeEach(() => {
  advanceRadioMock.mockReset();
  advanceRadioMock.mockImplementation(
    async (_assistantId: string, _request: RadioAdvanceRequest) =>
      startResponse,
  );
  controllers.length = 0;
});

describe("useRadioStore", () => {
  it("starts radio playback by advancing, resolving the track URL, and playing it", async () => {
    const store = await loadStore();

    await store.getState().start("assistant 1");

    const state = store.getState();
    expect(advanceRadioMock).toHaveBeenCalledWith(
      "assistant 1",
      expect.objectContaining({ reason: "start" }),
    );
    expect(state.status).toBe("playing");
    expect(state.segmentId).toBe("segment-1");
    expect(state.currentTrack?.audioUrl).toBe(
      "/v1/assistants/assistant%201/radio/tracks/soft-launch/",
    );
    expect(state.recentTrackIds).toEqual(["soft-launch"]);
    expect(controllers[0]?.playInitial).toHaveBeenCalledWith(
      expect.objectContaining({ id: "soft-launch" }),
    );
  });

  it("captures setup-needed responses and keeps the settings path for the UI CTA", async () => {
    const store = await loadStore();
    advanceRadioMock.mockImplementationOnce(async () => setupResponse);

    await store.getState().start("assistant-1");

    const state = store.getState();
    expect(state.status).toBe("setup_needed");
    expect(state.setup?.settingsPath).toBe("/assistant/settings/ai");
    expect(state.currentTrack?.id).toBe("buffer-bloom");
    expect(controllers).toHaveLength(0);
  });

  it("skips through the controller with resolved DJ and next-track URLs", async () => {
    const store = await loadStore();
    await store.getState().start("assistant-1");
    advanceRadioMock.mockImplementationOnce(async () => transitionResponse);

    await store.getState().skip("assistant-1");

    const state = store.getState();
    expect(advanceRadioMock).toHaveBeenLastCalledWith(
      "assistant-1",
      expect.objectContaining({
        reason: "skip",
        segmentId: "segment-1",
        currentTrackId: "soft-launch",
        recentTrackIds: ["soft-launch"],
      }),
    );
    expect(state.status).toBe("transitioning");
    expect(state.currentTrack?.id).toBe("buffer-bloom");
    expect(state.djText).toBe(djBreak.text);
    expect(controllers[0]?.applyTransition).toHaveBeenCalledWith({
      outgoingTrack: expect.objectContaining({ id: "soft-launch" }),
      djBreak: expect.objectContaining({
        audioUrl: "/v1/assistants/assistant-1/audio/dj-1/",
      }),
      nextTrack: expect.objectContaining({
        audioUrl: "/v1/assistants/assistant-1/radio/tracks/buffer-bloom/",
      }),
      playbackPlan: expect.objectContaining({ displayCue: "transition" }),
    });
  });

  it("hides and shows without resetting playback state", async () => {
    const store = await loadStore();
    await store.getState().start("assistant-1");

    store.getState().hide();
    expect(store.getState().isHidden).toBe(true);
    expect(store.getState().currentTrack?.id).toBe("soft-launch");

    store.getState().show();
    expect(store.getState().isHidden).toBe(false);
  });

  it("enters an error state when advancing fails and retry starts again", async () => {
    const store = await loadStore();
    advanceRadioMock.mockImplementationOnce(async () => {
      throw new Error("Radio is off air");
    });

    await store.getState().start("assistant-1");

    expect(store.getState().status).toBe("error");
    expect(store.getState().errorMessage).toBe("Radio is off air");

    advanceRadioMock.mockImplementationOnce(async () => startResponse);
    await store.getState().retry("assistant-1");

    expect(advanceRadioMock).toHaveBeenLastCalledWith(
      "assistant-1",
      expect.objectContaining({ reason: "retry" }),
    );
    expect(store.getState().status).toBe("playing");
  });
});
