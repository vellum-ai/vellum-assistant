/**
 * The `navigator.mediaDevices` stubbing the camera suites share.
 *
 * Both the hook's own tests (`voice-camera.test.tsx`) and the room's
 * acquisition tests (`voice-room.test.tsx`) have to present a camera to
 * `useVoiceCamera`, take it away again, and hand back a stream that survives
 * happy-dom's `srcObject` instance check. One copy, so a fix to the stand-in
 * stream reaches both.
 */

/** What a stubbed `mediaDevices` answers `getUserMedia` with. */
export type FakeGetUserMedia = (
  constraints?: MediaStreamConstraints,
) => Promise<unknown>;

const originalMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);

/**
 * Present a camera to the code under test. Pass the `getUserMedia` on its own,
 * or the whole `mediaDevices` object when a test needs to shape the rest of it;
 * `null` / `undefined` removes the API entirely, which is the "this device has
 * no camera" case.
 */
export function stubMediaDevices(
  mediaDevices:
    FakeGetUserMedia | { getUserMedia: FakeGetUserMedia } | null | undefined,
): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value:
      typeof mediaDevices === "function"
        ? { getUserMedia: mediaDevices }
        : (mediaDevices ?? undefined),
  });
}

/** Put `navigator.mediaDevices` back the way the suite found it. */
export function restoreMediaDevices(): void {
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    return;
  }
  stubMediaDevices(null);
}

/**
 * A real `MediaStream`, because happy-dom's `HTMLMediaElement.srcObject` setter
 * enforces the same instance check the browser does and a duck-typed stand-in
 * throws where a real camera would not. happy-dom's implementation has no
 * `getTracks()` or `getVideoTracks()`, which release and the negotiated-track
 * log need, so those two are filled in.
 */
export function fakeStream(
  getSettings?: () => MediaTrackSettings,
): MediaStream {
  const stream = new MediaStream();
  Object.defineProperties(stream, {
    getTracks: { value: () => [] },
    getVideoTracks: {
      value: () => (getSettings ? [{ getSettings }] : []),
    },
  });
  return stream;
}
