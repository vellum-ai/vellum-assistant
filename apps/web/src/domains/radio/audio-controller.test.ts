import { beforeEach, describe, expect, it } from "bun:test";

import { RadioAudioController } from "@/domains/radio/audio-controller.js";
import type {
  ResolvedRadioDjBreak,
  ResolvedRadioPlaybackPlan,
  ResolvedRadioTrack,
} from "@/domains/radio/types.js";

type AudioEventName = "ended" | "timeupdate";

class FakeAudio {
  readonly src: string;
  currentTime = 0;
  duration = 18;
  volume = 1;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;
  playResult: Promise<void> | null = null;
  private readonly listeners = new Map<AudioEventName, Set<() => void>>();

  constructor(src: string) {
    this.src = src;
  }

  async play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    if (this.playResult) {
      await this.playResult;
      this.paused = false;
    }
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  addEventListener(name: AudioEventName, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: AudioEventName, listener: () => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: AudioEventName): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener();
    }
  }
}

function createFrameScheduler() {
  let nextId = 0;
  const callbacks: Array<{ id: number; callback: FrameRequestCallback }> = [];
  return {
    request(callback: FrameRequestCallback): number {
      const id = ++nextId;
      callbacks.push({ id, callback });
      return id;
    },
    cancel(id: number): void {
      const index = callbacks.findIndex((item) => item.id === id);
      if (index >= 0) callbacks.splice(index, 1);
    },
    run(time: number): void {
      const batch = callbacks.splice(0);
      for (const item of batch) item.callback(time);
    },
  };
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

const track: ResolvedRadioTrack = {
  id: "soft-launch",
  title: "Soft Launch",
  artist: "Vellum Radio",
  durationMs: 18_000,
  audioPath: "radio/tracks/soft-launch",
  audioUrl: "/v1/assistants/assistant-1/radio/tracks/soft-launch/",
  sourceLabel: "Demo track",
  license: "repo-generated",
  sha256: "sha",
};

const nextTrack: ResolvedRadioTrack = {
  ...track,
  id: "buffer-bloom",
  title: "Buffer Bloom",
  audioPath: "radio/tracks/buffer-bloom",
  audioUrl: "/v1/assistants/assistant-1/radio/tracks/buffer-bloom/",
};

const djBreak: ResolvedRadioDjBreak = {
  text: "Tiny lights on the dial. Buffer Bloom is next.",
  audioPath: "audio/dj-1",
  audioUrl: "/v1/assistants/assistant-1/audio/dj-1/",
  audioId: "dj-1",
  contentType: "audio/mpeg",
};

const playbackPlan: ResolvedRadioPlaybackPlan = {
  reason: "skip",
  displayCue: "transition",
  track: nextTrack,
  djBreak,
};

describe("RadioAudioController", () => {
  let createdAudio: FakeAudio[];
  let scheduler: ReturnType<typeof createFrameScheduler>;

  beforeEach(() => {
    createdAudio = [];
    scheduler = createFrameScheduler();
  });

  function createController(
    callbacks: Partial<ConstructorParameters<typeof RadioAudioController>[0]> = {},
  ) {
    return new RadioAudioController({
      createAudio: (url) => {
        const audio = new FakeAudio(url);
        createdAudio.push(audio);
        return audio;
      },
      requestAnimationFrame: scheduler.request,
      cancelAnimationFrame: scheduler.cancel,
      prefetchWindowMs: 5_000,
      rampDurationMs: 1_000,
      ...callbacks,
    });
  }

  it("plays an initial track and reports progress plus one near-ending event", async () => {
    const progress: Array<{ positionMs: number; remainingMs: number }> = [];
    let endingCalls = 0;
    let endedCalls = 0;
    const controller = createController({
      onProgress: (event) => progress.push(event),
      onTrackEnding: () => {
        endingCalls += 1;
      },
      onTrackEnded: () => {
        endedCalls += 1;
      },
    });

    await controller.playInitial(track);
    const [audio] = createdAudio;
    expect(audio.src).toBe(track.audioUrl);
    expect(audio.playCalls).toBe(1);

    audio.currentTime = 14;
    audio.duration = 18;
    audio.dispatch("timeupdate");
    audio.dispatch("timeupdate");
    audio.dispatch("ended");

    expect(progress.at(-1)).toEqual({ positionMs: 14_000, remainingMs: 4_000 });
    expect(endingCalls).toBe(1);
    expect(endedCalls).toBe(0);
  });

  it("awaits async audio creation before playing the initial track", async () => {
    let resolveAudio!: (audio: FakeAudio) => void;
    const audioPromise = new Promise<FakeAudio>((resolve) => {
      resolveAudio = resolve;
    });
    const controller = createController({
      createAudio: () => audioPromise,
    });

    const playPromise = controller.playInitial(track);
    await Promise.resolve();

    const audio = new FakeAudio(track.audioUrl);
    expect(audio.playCalls).toBe(0);

    resolveAudio(audio);
    await playPromise;

    expect(audio.playCalls).toBe(1);
  });

  it("fires the ended callback when a track ends before the prefetch window", async () => {
    let endedCalls = 0;
    const controller = createController({
      onTrackEnded: () => {
        endedCalls += 1;
      },
    });

    await controller.playInitial(track);
    const [audio] = createdAudio;
    audio.currentTime = 6;
    audio.duration = 18;
    audio.dispatch("ended");

    expect(endedCalls).toBe(1);
  });

  it("ducks outgoing music, plays the DJ break, fades in the next track, and stops the old track", async () => {
    const controller = createController();

    await controller.playInitial(track);
    const [outgoing] = createdAudio;

    await controller.applyTransition({
      outgoingTrack: track,
      djBreak,
      nextTrack,
      playbackPlan,
    });

    const [, djAudio, incoming] = createdAudio;
    expect(djAudio.src).toBe(djBreak.audioUrl);
    expect(djAudio.playCalls).toBe(1);
    expect(incoming.src).toBe(nextTrack.audioUrl);
    expect(incoming.volume).toBe(0);
    expect(incoming.playCalls).toBe(1);

    scheduler.run(0);
    scheduler.run(1_000);

    expect(outgoing.volume).toBeCloseTo(0.18, 2);
    expect(incoming.volume).toBeCloseTo(1, 2);
    expect(outgoing.pauseCalls).toBe(1);
  });

  it("pauses outgoing music during a transition", async () => {
    const controller = createController();

    await controller.playInitial(track);
    const [outgoing] = createdAudio;
    await controller.applyTransition({
      outgoingTrack: track,
      djBreak,
      nextTrack,
      playbackPlan,
    });

    const [, djAudio, incoming] = createdAudio;
    controller.pause();

    expect(outgoing.pauseCalls).toBe(1);
    expect(djAudio.pauseCalls).toBeGreaterThanOrEqual(1);
    expect(incoming.pauseCalls).toBe(1);
  });

  it("does not resurrect playback when disposed while DJ audio play is pending", async () => {
    const progress: Array<{ positionMs: number; remainingMs: number }> = [];
    const djPlay = deferred<void>();
    const controller = createController({
      onProgress: (event) => progress.push(event),
      createAudio: (url) => {
        const audio = new FakeAudio(url);
        if (url === djBreak.audioUrl) {
          audio.playResult = djPlay.promise;
        }
        createdAudio.push(audio);
        return audio;
      },
    });

    await controller.playInitial(track);
    const transitionPromise = controller.applyTransition({
      outgoingTrack: track,
      djBreak,
      nextTrack,
      playbackPlan,
    });
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    const [, djAudio, incoming] = createdAudio;
    expect(djAudio.playCalls).toBe(1);
    expect(incoming.playCalls).toBe(0);

    controller.dispose();
    djPlay.resolve();
    await transitionPromise;

    expect(djAudio.pauseCalls).toBeGreaterThanOrEqual(1);
    expect(incoming.pauseCalls).toBe(1);
    expect(incoming.playCalls).toBe(0);

    incoming.currentTime = 14;
    incoming.dispatch("timeupdate");
    expect(progress).toEqual([]);
  });

  it("does not start incoming audio when paused while DJ audio play is pending", async () => {
    const djPlay = deferred<void>();
    const controller = createController({
      createAudio: (url) => {
        const audio = new FakeAudio(url);
        if (url === djBreak.audioUrl) {
          audio.playResult = djPlay.promise;
        }
        createdAudio.push(audio);
        return audio;
      },
    });

    await controller.playInitial(track);
    const transitionPromise = controller.applyTransition({
      outgoingTrack: track,
      djBreak,
      nextTrack,
      playbackPlan,
    });
    await Promise.resolve();

    const [, djAudio, incoming] = createdAudio;
    controller.pause();
    djPlay.resolve();
    await transitionPromise;

    expect(djAudio.paused).toBe(true);
    expect(incoming.playCalls).toBe(0);
    expect(incoming.paused).toBe(true);
    expect(incoming.volume).toBe(1);

    await controller.resume();

    expect(incoming.playCalls).toBe(1);
    expect(incoming.paused).toBe(false);
    expect(djAudio.playCalls).toBe(1);
  });

  it("leaves initial audio paused when paused while initial play is pending", async () => {
    const initialPlay = deferred<void>();
    const controller = createController({
      createAudio: (url) => {
        const audio = new FakeAudio(url);
        audio.playResult = initialPlay.promise;
        createdAudio.push(audio);
        return audio;
      },
    });

    const playPromise = controller.playInitial(track);
    await Promise.resolve();

    const [audio] = createdAudio;
    controller.pause();
    initialPlay.resolve();
    await playPromise;

    expect(audio.playCalls).toBe(1);
    expect(audio.paused).toBe(true);
  });

  it("resolves an interrupted initial play rejection after pause", async () => {
    const initialPlay = deferred<void>();
    const controller = createController({
      createAudio: (url) => {
        const audio = new FakeAudio(url);
        audio.playResult = initialPlay.promise;
        createdAudio.push(audio);
        return audio;
      },
    });

    const playPromise = controller.playInitial(track);
    await Promise.resolve();

    const [audio] = createdAudio;
    controller.pause();
    initialPlay.reject(new DOMException("play() interrupted", "AbortError"));

    await expect(playPromise).resolves.toBeUndefined();
    expect(audio.paused).toBe(true);
  });

  it("rejects an active initial play failure", async () => {
    const initialPlay = deferred<void>();
    const controller = createController({
      createAudio: (url) => {
        const audio = new FakeAudio(url);
        audio.playResult = initialPlay.promise;
        createdAudio.push(audio);
        return audio;
      },
    });

    const playPromise = controller.playInitial(track);
    await Promise.resolve();

    initialPlay.reject(new Error("decoder failed"));

    await expect(playPromise).rejects.toThrow("decoder failed");
  });

  it("resolves an interrupted DJ transition play rejection after pause", async () => {
    const djPlay = deferred<void>();
    const controller = createController({
      createAudio: (url) => {
        const audio = new FakeAudio(url);
        if (url === djBreak.audioUrl) {
          audio.playResult = djPlay.promise;
        }
        createdAudio.push(audio);
        return audio;
      },
    });

    await controller.playInitial(track);
    const transitionPromise = controller.applyTransition({
      outgoingTrack: track,
      djBreak,
      nextTrack,
      playbackPlan,
    });
    await Promise.resolve();

    const [, djAudio, incoming] = createdAudio;
    controller.pause();
    djPlay.reject(new DOMException("play() interrupted", "AbortError"));

    await expect(transitionPromise).resolves.toBeUndefined();
    expect(djAudio.paused).toBe(true);
    expect(incoming.playCalls).toBe(0);
    expect(incoming.paused).toBe(true);
  });

  it("disposes audio, listeners, and pending volume ramps", async () => {
    const progress: Array<{ positionMs: number; remainingMs: number }> = [];
    const controller = createController({
      onProgress: (event) => progress.push(event),
    });

    await controller.playInitial(track);
    const [outgoing] = createdAudio;

    await controller.applyTransition({
      outgoingTrack: track,
      djBreak,
      nextTrack,
      playbackPlan,
    });

    const [, djAudio, incoming] = createdAudio;
    controller.dispose();
    const outgoingVolume = outgoing.volume;
    const incomingVolume = incoming.volume;

    scheduler.run(1_000);
    outgoing.currentTime = 14;
    outgoing.dispatch("timeupdate");

    expect(outgoing.pauseCalls).toBe(1);
    expect(djAudio.pauseCalls).toBe(1);
    expect(incoming.pauseCalls).toBe(1);
    expect(outgoing.volume).toBe(outgoingVolume);
    expect(incoming.volume).toBe(incomingVolume);
    expect(progress).toEqual([]);
  });
});
