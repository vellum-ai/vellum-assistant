/**
 * The camera the Eyes toggle owns: what it asks the browser for, what releases
 * it, and which frame a send would carry.
 *
 * The sampler and the frame encoder are replaced wholesale. Neither can do its
 * real work here (happy-dom has no video decode and no canvas readback), and
 * both are covered by their own suites, so what is under test is the store's
 * ownership rules around them.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { fakeCameraStream } from "@/domains/chat/sight/sight.test-helper";
import {
  restoreMediaDevices,
  stubMediaDevices,
} from "@/domains/chat/voice/voice-room/voice-camera.test-helper";
import type { FrameSamplerOptions } from "@/lib/camera/frame-sampler";

let samplerOptions: FrameSamplerOptions | null = null;
const samplerStart = mock((_video: HTMLVideoElement) => {});
const samplerStop = mock(() => {});
mock.module("@/lib/camera/frame-sampler", () => ({
  createFrameSampler: (options: FrameSamplerOptions) => {
    samplerOptions = options;
    return { start: samplerStart, stop: samplerStop };
  },
}));

const captureVideoFrame = mock(
  async (_video: HTMLVideoElement, filename: string) =>
    new File([new Uint8Array([1, 2, 3])], filename, { type: "image/jpeg" }),
);
mock.module("@/domains/chat/voice/voice-room/voice-camera", () => ({
  captureVideoFrame,
}));

const { useSightStore } = await import("./sight-store");
const { publish } = await import("@/lib/event-bus");
const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");

/** Let the queued microtasks behind an `onDecision` capture run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  samplerOptions = null;
  samplerStart.mockClear();
  samplerStop.mockClear();
  captureVideoFrame.mockClear();
});

afterEach(() => {
  useSightStore.getState().stop();
  useLiveVoiceStore.getState().reset();
  restoreMediaDevices();
});

describe("sight store", () => {
  test("start opens a video-only capture and reaches on", async () => {
    const { stream } = fakeCameraStream();
    let seen: MediaStreamConstraints | undefined;
    stubMediaDevices((constraints) => {
      seen = constraints;
      return Promise.resolve(stream);
    });

    await useSightStore.getState().start();

    expect(useSightStore.getState().status).toBe("on");
    expect(useSightStore.getState().stream).toBe(stream);
    // The hard invariant: an audio track requested here would renegotiate the
    // microphone a live-voice call is streaming from.
    expect(seen?.audio).toBeUndefined();
    expect(Object.keys(seen ?? {})).toEqual(["video"]);
  });

  test("a denied permission lands in the error state", async () => {
    stubMediaDevices(() =>
      Promise.reject(new DOMException("denied", "NotAllowedError")),
    );

    await useSightStore.getState().start();

    expect(useSightStore.getState().status).toBe("error");
    expect(useSightStore.getState().error).toBe("permission-denied");
    expect(useSightStore.getState().stream).toBeNull();
  });

  test("stop releases every track, clears the slot, and repeats safely", async () => {
    const { stream, stops } = fakeCameraStream();
    stubMediaDevices(() => Promise.resolve(stream));
    await useSightStore.getState().start();

    const video = document.createElement("video");
    useSightStore.getState().attachPreviewVideo(video);
    samplerOptions?.onDecision(
      { keep: true, reason: "first", motion: null, novelty: null, detail: 40 },
      0,
    );
    await flush();
    expect(useSightStore.getState().latestKeep).not.toBeNull();

    useSightStore.getState().stop();

    for (const stop of stops) {
      expect(stop).toHaveBeenCalledTimes(1);
    }
    expect(samplerStop).toHaveBeenCalled();
    expect(useSightStore.getState().status).toBe("off");
    expect(useSightStore.getState().stream).toBeNull();
    expect(useSightStore.getState().latestKeep).toBeNull();

    useSightStore.getState().stop();

    for (const stop of stops) {
      expect(stop).toHaveBeenCalledTimes(1);
    }
    expect(useSightStore.getState().status).toBe("off");
  });

  test("the app going to the background releases the camera", async () => {
    const { stream, stops } = fakeCameraStream();
    stubMediaDevices(() => Promise.resolve(stream));
    await useSightStore.getState().start();

    publish("app.hidden", { signal: "visibility" });

    expect(useSightStore.getState().status).toBe("off");
    for (const stop of stops) {
      expect(stop).toHaveBeenCalledTimes(1);
    }
  });

  test("a voice session starting takes the camera", async () => {
    const { stream, stops } = fakeCameraStream();
    stubMediaDevices(() => Promise.resolve(stream));
    await useSightStore.getState().start();
    expect(useSightStore.getState().status).toBe("on");

    // The room raises a viewfinder of its own, and two surfaces cannot hold
    // one webcam. Settled, so the burst a session start writes on its way to
    // `listening` is read once.
    useLiveVoiceStore.getState().setState("connecting");
    await flush();

    expect(useSightStore.getState().status).toBe("off");
    for (const stop of stops) {
      expect(stop).toHaveBeenCalledTimes(1);
    }
  });

  test("a session that failed to start leaves the camera alone", async () => {
    const { stream } = fakeCameraStream();
    stubMediaDevices(() => Promise.resolve(stream));
    await useSightStore.getState().start();

    // `failed` is not a running session: it is the surfaced error a retry
    // starts from, and the camera it never took must not be closed for it.
    useLiveVoiceStore.getState().setState("failed");
    await flush();

    expect(useSightStore.getState().status).toBe("on");
  });

  test("a start that resolves into a live call releases at once", async () => {
    const { stream, stops } = fakeCameraStream();
    let deliver!: (value: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => {
      deliver = resolve;
    });
    stubMediaDevices(() => pending);

    const started = useSightStore.getState().start();
    // A call started while the permission prompt was up, before the store
    // subscribed, so only the state check at the end of start can catch it.
    useLiveVoiceStore.getState().setState("listening");
    deliver(stream);
    await started;

    expect(useSightStore.getState().status).toBe("off");
    for (const stop of stops) {
      expect(stop).toHaveBeenCalledTimes(1);
    }
  });

  test("a start that resolves behind a hidden window releases at once", async () => {
    const { stream, stops } = fakeCameraStream();
    let deliver!: (value: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => {
      deliver = resolve;
    });
    stubMediaDevices(() => pending);

    const started = useSightStore.getState().start();
    // The app hides while the permission prompt is up: the bus publishes
    // app.hidden before the store has subscribed, so only the state check at
    // the end of start can catch it.
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    try {
      deliver(stream);
      await started;

      expect(useSightStore.getState().status).toBe("off");
      for (const stop of stops) {
        expect(stop).toHaveBeenCalledTimes(1);
      }
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  test("a stop racing an in-flight start leaves no live tracks", async () => {
    const { stream, stops } = fakeCameraStream();
    // Definite assignment: a promise executor runs synchronously, so the
    // resolver is in hand before the next statement.
    let deliver!: (value: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => {
      deliver = resolve;
    });
    stubMediaDevices(() => pending);

    const started = useSightStore.getState().start();
    useSightStore.getState().stop();
    deliver(stream);
    await started;

    expect(useSightStore.getState().status).toBe("off");
    expect(useSightStore.getState().stream).toBeNull();
    for (const stop of stops) {
      expect(stop).toHaveBeenCalledTimes(1);
    }
  });

  test("a keep replaces the held frame, and takeSendFrame hands it over", async () => {
    const { stream } = fakeCameraStream();
    stubMediaDevices(() => Promise.resolve(stream));
    await useSightStore.getState().start();

    const video = document.createElement("video");
    useSightStore.getState().attachPreviewVideo(video);
    expect(samplerStart).toHaveBeenCalledWith(video);

    samplerOptions?.onDecision(
      { keep: false, reason: "moving", motion: 0.4, novelty: null, detail: 40 },
      0,
    );
    await flush();
    expect(useSightStore.getState().latestKeep).toBeNull();

    samplerOptions?.onDecision(
      { keep: true, reason: "first", motion: null, novelty: null, detail: 40 },
      10,
    );
    await flush();
    const first = useSightStore.getState().latestKeep;
    expect(first).not.toBeNull();
    expect(await useSightStore.getState().takeSendFrame()).toBe(first!.file);

    samplerOptions?.onDecision(
      { keep: true, reason: "novel", motion: 0, novelty: 0.9, detail: 40 },
      20,
    );
    await flush();
    const second = useSightStore.getState().latestKeep;
    expect(second).not.toBeNull();
    expect(second!.file).not.toBe(first!.file);
    expect(await useSightStore.getState().takeSendFrame()).toBe(second!.file);
  });

  test("takeSendFrame answers null while the camera is off", async () => {
    expect(useSightStore.getState().status).toBe("off");
    expect(await useSightStore.getState().takeSendFrame()).toBeNull();
  });

  test("takeSendFrame falls back to the live frame before any keep", async () => {
    const { stream } = fakeCameraStream();
    stubMediaDevices(() => Promise.resolve(stream));
    await useSightStore.getState().start();
    useSightStore
      .getState()
      .attachPreviewVideo(document.createElement("video"));

    const frame = await useSightStore.getState().takeSendFrame();

    expect(frame).not.toBeNull();
    expect(captureVideoFrame).toHaveBeenCalledTimes(1);
  });

  test("a track ending from outside releases the camera into the error state", async () => {
    // GIVEN a running capture the browser then takes away: a revoked
    // permission, a webcam unplugged, another app claiming the device.
    const { stream, stops, tracks } = fakeCameraStream();
    stubMediaDevices(() => Promise.resolve(stream));
    await useSightStore.getState().start();
    const video = document.createElement("video");
    useSightStore.getState().attachPreviewVideo(video);
    samplerOptions?.onDecision(
      { keep: true, reason: "first", motion: null, novelty: null, detail: 40 },
      0,
    );
    await flush();
    expect(useSightStore.getState().latestKeep).not.toBeNull();

    tracks[0]!.end();

    // The tile has something to say rather than silently vanishing, the
    // hardware is back, and the frozen frame cannot ride a later send.
    expect(useSightStore.getState().status).toBe("error");
    expect(useSightStore.getState().error).toBe("interrupted");
    expect(useSightStore.getState().stream).toBeNull();
    expect(useSightStore.getState().latestKeep).toBeNull();
    expect(samplerStop).toHaveBeenCalled();
    for (const stop of stops) {
      expect(stop).toHaveBeenCalledTimes(1);
    }
    for (const track of tracks) {
      expect(track.endedListeners()).toHaveLength(0);
    }
  });

  test("stop takes the ended listeners back off the tracks", async () => {
    const { stream, tracks } = fakeCameraStream();
    stubMediaDevices(() => Promise.resolve(stream));
    await useSightStore.getState().start();
    for (const track of tracks) {
      expect(track.endedListeners()).toHaveLength(1);
    }

    useSightStore.getState().stop();

    for (const track of tracks) {
      expect(track.endedListeners()).toHaveLength(0);
    }
  });

  test("a listener outliving its capture says nothing about the next one", async () => {
    // The detach on the way out is what should make this unreachable, so the
    // handler is held from before the stop: the epoch is the second line, and
    // firing a genuinely stale listener is the only way to reach it.
    const first = fakeCameraStream();
    stubMediaDevices(() => Promise.resolve(first.stream));
    await useSightStore.getState().start();
    const staleListeners = first.tracks[0]!.endedListeners();
    expect(staleListeners).toHaveLength(1);
    useSightStore.getState().stop();

    const second = fakeCameraStream();
    stubMediaDevices(() => Promise.resolve(second.stream));
    await useSightStore.getState().start();

    for (const handler of staleListeners) {
      handler();
    }

    expect(useSightStore.getState().status).toBe("on");
    expect(useSightStore.getState().stream).toBe(second.stream);
    for (const stop of second.stops) {
      expect(stop).not.toHaveBeenCalled();
    }
  });
});
