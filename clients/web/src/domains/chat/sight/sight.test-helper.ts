/**
 * The stand-in camera the sight suites share.
 *
 * `voice-camera.test-helper.ts` next door already stubs
 * `navigator.mediaDevices`, and these suites use it for that. What it cannot
 * give them is a stream whose tracks answer back: every release assertion here
 * counts `track.stop()` calls, and the interruption path needs a track that can
 * be told to end and that reports whether its listener was taken off again.
 */

import { mock } from "bun:test";

export interface FakeCameraTrack {
  /** Spy standing in for `MediaStreamTrack.stop`. */
  readonly stop: () => void;
  /** Fire `ended` at whatever is listening right now. */
  readonly end: () => void;
  /**
   * The `ended` listeners attached right now, as a snapshot.
   *
   * Its length is how a detach is asserted. Holding the handlers themselves is
   * what lets a test fire one that has since been detached, which is the only
   * way to reach the guard behind a listener that outlived its session.
   */
  readonly endedListeners: () => Array<() => void>;
}

export interface FakeCameraStream {
  readonly stream: MediaStream;
  /** The stop spies, in track order. */
  readonly stops: Array<() => void>;
  readonly tracks: FakeCameraTrack[];
}

function fakeTrack(): FakeCameraTrack & {
  addEventListener: (type: string, handler: () => void) => void;
  removeEventListener: (type: string, handler: () => void) => void;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    stop: mock(() => {}),
    addEventListener: (type, handler) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
    },
    removeEventListener: (type, handler) => {
      listeners.get(type)?.delete(handler);
    },
    end: () => {
      // Copied first: a handler is free to detach itself while it runs, which
      // is exactly what the store's release does.
      for (const handler of [...(listeners.get("ended") ?? [])]) {
        handler();
      }
    },
    endedListeners: () => [...(listeners.get("ended") ?? [])],
  };
}

/**
 * A stream whose tracks report being stopped. happy-dom's own `MediaStream` has
 * no `getTracks`, and a duck-typed stand-in cannot be assigned to a `<video>`,
 * so the real class is filled in rather than replaced.
 */
export function fakeCameraStream(): FakeCameraStream {
  const tracks = [fakeTrack(), fakeTrack()];
  const stream = new MediaStream();
  Object.defineProperties(stream, {
    getTracks: { value: () => tracks },
    getVideoTracks: { value: () => tracks },
  });
  return { stream, stops: tracks.map((track) => track.stop), tracks };
}
