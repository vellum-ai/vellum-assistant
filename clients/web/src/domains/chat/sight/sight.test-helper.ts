/**
 * The stand-in camera the sight suites share.
 *
 * `voice-camera.test-helper.ts` next door already stubs
 * `navigator.mediaDevices`, and these suites use it for that. What it cannot
 * give them is a stream whose tracks report being stopped: its `getTracks`
 * answers an empty list, and every release assertion here counts `track.stop()`
 * calls.
 */

import { mock } from "bun:test";

export interface FakeCameraStream {
  readonly stream: MediaStream;
  /** One spy per track, so a release can be counted rather than inferred. */
  readonly stops: Array<() => void>;
}

/**
 * A stream whose tracks report being stopped. happy-dom's own `MediaStream` has
 * no `getTracks`, and a duck-typed stand-in cannot be assigned to a `<video>`,
 * so the real class is filled in rather than replaced.
 */
export function fakeCameraStream(): FakeCameraStream {
  const stops = [mock(() => {}), mock(() => {})];
  const tracks = stops.map((stop) => ({ stop }));
  const stream = new MediaStream();
  Object.defineProperties(stream, {
    getTracks: { value: () => tracks },
    getVideoTracks: { value: () => tracks },
  });
  return { stream, stops };
}
