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

class FakeController {
  readonly callbacks: {
    onProgress: (event: { positionMs: number; remainingMs: number }) => void;
    onTrackEnding: () => void;
    onTrackEnded: () => void;
  };
  readonly playInitial = mock(async (_track: ResolvedRadioTrack) => {});
  readonly pause = mock(() => {});
  readonly resume = mock(async () => {});
  readonly skip = mock(() => {});
  readonly dispose = mock(() => {});
  readonly applyTransition = mock(
    async (_params: {
      outgoingTrack?: ResolvedRadioTrack | null;
      djBreak: ResolvedRadioDjBreak;
      nextTrack: ResolvedRadioTrack;
      playbackPlan: ResolvedRadioPlaybackPlan;
    }) => {},
  );

  constructor(callbacks: FakeController["callbacks"]) {
    this.callbacks = callbacks;
  }
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

const thirdTrack = {
  ...track,
  id: "neon-postcard",
  title: "Neon Postcard",
  audioPath: "radio/tracks/neon-postcard",
};

const djBreak = {
  text: "A little shimmer before Buffer Bloom.",
  audioPath: "audio/dj-1",
  audioId: "dj-1",
  contentType: "audio/mpeg",
};

const thirdDjBreak = {
  text: "Neon Postcard is drifting into view.",
  audioPath: "audio/dj-2",
  audioId: "dj-2",
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

const alternateStartResponse: RadioAdvanceResponse = {
  segmentId: "segment-b",
  displayCue: "song",
  track: thirdTrack,
  playbackPlan: {
    reason: "start",
    displayCue: "song",
    track: thirdTrack,
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

const thirdTransitionResponse: RadioAdvanceResponse = {
  segmentId: "segment-3",
  displayCue: "transition",
  track: thirdTrack,
  playbackPlan: {
    reason: "retry",
    displayCue: "transition",
    track: thirdTrack,
    djBreak: thirdDjBreak,
  },
  djBreak: thirdDjBreak,
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
    advanceRadio: advanceRadioMock,
    runtimeAudioUrl: (assistantId, audioPath) =>
      `/v1/assistants/${encodeURIComponent(assistantId)}/${audioPath}/`,
    createController: (callbacks) => {
      const controller = new FakeController(callbacks);
      controllers.push(controller);
      return controller;
    },
  });
  module.useRadioStore.getState().reset();
  return module.useRadioStore;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
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

  it("keeps outgoing track during transition and promotes incoming track after the transition completes", async () => {
    const store = await loadStore();
    await store.getState().start("assistant-1");
    advanceRadioMock.mockImplementationOnce(async () => transitionResponse);
    const transition = deferred<void>();
    controllers[0]!.applyTransition.mockImplementationOnce(
      async () => transition.promise,
    );

    const skipPromise = store.getState().skip("assistant-1");
    await Promise.resolve();

    let state = store.getState();
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
    expect(state.currentTrack?.id).toBe("soft-launch");
    expect(state.nextTrack?.id).toBe("buffer-bloom");
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

    transition.resolve();
    await skipPromise;

    state = store.getState();
    expect(state.status).toBe("playing");
    expect(state.currentTrack?.id).toBe("buffer-bloom");
    expect(state.nextTrack).toBeNull();
  });

  it("preserves paused status while settling a pending transition to the incoming track", async () => {
    const store = await loadStore();
    await store.getState().start("assistant-1");
    advanceRadioMock.mockImplementationOnce(async () => transitionResponse);
    const transition = deferred<void>();
    controllers[0]!.applyTransition.mockImplementationOnce(
      async () => transition.promise,
    );

    const skipPromise = store.getState().skip("assistant-1");
    await Promise.resolve();

    store.getState().pause();
    expect(store.getState().status).toBe("paused");
    expect(store.getState().currentTrack?.id).toBe("soft-launch");
    expect(store.getState().nextTrack?.id).toBe("buffer-bloom");

    transition.resolve();
    await skipPromise;

    expect(store.getState().status).toBe("paused");
    expect(store.getState().currentTrack?.id).toBe("buffer-bloom");
    expect(store.getState().nextTrack).toBeNull();
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

  it("sets expanded state idempotently", async () => {
    const store = await loadStore();

    store.getState().setExpanded(true);
    store.getState().setExpanded(true);
    expect(store.getState().isExpanded).toBe(true);

    store.getState().setExpanded(false);
    store.getState().setExpanded(false);
    expect(store.getState().isExpanded).toBe(false);
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

  it("ignores an older advance response after a newer advance has started", async () => {
    const store = await loadStore();
    await store.getState().start("assistant-1");
    const oldAdvance = deferred<RadioAdvanceResponse>();
    const newAdvance = deferred<RadioAdvanceResponse>();
    advanceRadioMock.mockImplementation(
      async (_assistantId: string, request: RadioAdvanceRequest) => {
        if (request.reason === "skip") return oldAdvance.promise;
        if (request.reason === "retry") return newAdvance.promise;
        return startResponse;
      },
    );

    const skipPromise = store.getState().skip("assistant-1");
    const retryPromise = store.getState().retry("assistant-1");

    newAdvance.resolve(thirdTransitionResponse);
    await retryPromise;
    expect(store.getState().currentTrack?.id).toBe("neon-postcard");

    oldAdvance.resolve(transitionResponse);
    await skipPromise;

    expect(store.getState().status).toBe("playing");
    expect(store.getState().currentTrack?.id).toBe("neon-postcard");
    expect(store.getState().segmentId).toBe("segment-3");
  });

  it("does not reuse stale station state when starting a different assistant", async () => {
    const store = await loadStore();
    await store.getState().start("assistant-a");
    advanceRadioMock.mockClear();

    await store.getState().start("assistant-b");

    const [, request] = advanceRadioMock.mock.calls[0]!;
    expect(request.reason).toBe("start");
    expect("segmentId" in request).toBe(false);
    expect("currentTrackId" in request).toBe(false);
    expect("recentTrackIds" in request).toBe(false);
  });

  it("clears the previous assistant track when an assistant switch needs setup", async () => {
    const store = await loadStore();
    await store.getState().start("assistant-a");
    advanceRadioMock.mockImplementationOnce(async () => setupResponse);

    await store.getState().start("assistant-b");

    expect(store.getState().status).toBe("setup_needed");
    expect(store.getState().assistantId).toBe("assistant-b");
    expect(store.getState().currentTrack?.id).toBe("buffer-bloom");
    expect(store.getState().nextTrack).toBeNull();
    expect(store.getState().recentTrackIds).toEqual(["buffer-bloom"]);
    expect(controllers[0]?.dispose).toHaveBeenCalled();
  });

  it("starts a different assistant with fresh recent-track history", async () => {
    const store = await loadStore();
    await store.getState().start("assistant-a");
    advanceRadioMock.mockImplementationOnce(async () => alternateStartResponse);

    await store.getState().start("assistant-b");

    expect(store.getState().recentTrackIds).toEqual(["neon-postcard"]);
    advanceRadioMock.mockClear();
    advanceRadioMock.mockImplementationOnce(async () => transitionResponse);

    await store.getState().skip("assistant-b");

    const [, request] = advanceRadioMock.mock.calls[0]!;
    expect(request.currentTrackId).toBe("neon-postcard");
    expect(request.recentTrackIds).toEqual(["neon-postcard"]);
  });

  it("deduplicates automatic song-ended advances while one is already pending", async () => {
    const store = await loadStore();
    await store.getState().start("assistant-1");
    const pendingAdvance = deferred<RadioAdvanceResponse>();
    advanceRadioMock.mockImplementation(
      async (_assistantId: string, request: RadioAdvanceRequest) => {
        if (request.reason === "song_ended") return pendingAdvance.promise;
        return startResponse;
      },
    );

    controllers[0]!.callbacks.onTrackEnding();
    controllers[0]!.callbacks.onTrackEnding();
    await Promise.resolve();

    const songEndedCalls = advanceRadioMock.mock.calls.filter(
      ([, request]) => request.reason === "song_ended",
    );
    expect(songEndedCalls).toHaveLength(1);

    pendingAdvance.resolve(transitionResponse);
    await Promise.resolve();
  });

  it("disposes the controller when resetting playback state", async () => {
    const store = await loadStore();
    await store.getState().start("assistant-1");

    store.getState().reset();

    expect(controllers[0]?.dispose).toHaveBeenCalled();
    expect(store.getState().status).toBe("idle");
    expect(store.getState().currentTrack).toBeNull();
  });
});
