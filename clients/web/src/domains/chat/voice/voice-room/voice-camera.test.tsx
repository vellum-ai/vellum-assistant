/**
 * The camera hook's flash discipline.
 *
 * Every rule here exists because the plugin behind the bridge punishes the
 * alternative: `setFlashMode` throws out of the Android bridge when the active
 * camera has no flash unit, neither platform carries a mode across a flip, and
 * the plugin instance is shared with the composer's capture overlay, so a mode
 * left set is a mode that surface inherits. The acquisition paths themselves
 * are covered in `voice-room.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useRef } from "react";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

// Replaced rather than spread over the real module: platform detection reaches
// the generated auth SDK through `native-auth`, and the hook under test wants
// exactly one thing from it.
let nativeMobile = true;
mock.module("@/runtime/platform-detection", () => ({
  isNativeMobile: () => nativeMobile,
}));

const startSpy = mock(async (_facing: string) => true);
const stopSpy = mock(async () => {});
const flipSpy = mock(async () => true);
const getFlashModesSpy = mock(async (): Promise<string[]> => []);
const setFlashModeSpy = mock(async (_mode: string) => true);
mock.module("@/runtime/native-voice-camera", () => ({
  NATIVE_VOICE_CAMERA_ACTIVE_CLASS: "native-voice-camera-active",
  startNativeVoiceCamera: startSpy,
  stopNativeVoiceCamera: stopSpy,
  flipNativeVoiceCamera: flipSpy,
  captureNativeVoiceCameraFrame: async () => null,
  getNativeVoiceCameraFlashModes: getFlashModesSpy,
  setNativeVoiceCameraFlashMode: setFlashModeSpy,
}));

const { useVoiceCamera } = await import("./voice-camera");
const { useVoicePrefsStore } = await import("@/stores/voice-prefs-store");

/** What a camera with a working flash answers the probe with. */
const FLASH_CAPABLE = ["off", "on", "auto"];

/** The camera hook driven from the outside, the way the room drives it. */
function Probe({ flash = true }: { flash?: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camera = useVoiceCamera(videoRef, { flash });
  return (
    <div>
      <span data-testid="flash-available">
        {camera.flashAvailable ? "yes" : "no"}
      </span>
      <span data-testid="facing">{camera.facing}</span>
      <button
        type="button"
        data-testid="open"
        onClick={() => void camera.openCamera()}
      >
        open
      </button>
      <button
        type="button"
        data-testid="close"
        onClick={() => camera.closeCamera()}
      >
        close
      </button>
      <button
        type="button"
        data-testid="flip"
        onClick={() => void camera.flipCamera()}
      >
        flip
      </button>
    </div>
  );
}

const flashAvailable = () =>
  screen.getByTestId("flash-available").textContent === "yes";

const facing = () => screen.getByTestId("facing").textContent;

async function press(testId: string) {
  await act(async () => {
    screen.getByTestId(testId).click();
  });
}

/** Render the probe and open a native camera, settling the capability probe. */
async function openNativeCamera() {
  render(<Probe />);
  await press("open");
  await waitFor(() => expect(getFlashModesSpy).toHaveBeenCalled());
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);

function stubMediaDevices(value: unknown) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  nativeMobile = true;
  startSpy.mockClear();
  startSpy.mockImplementation(async () => true);
  stopSpy.mockClear();
  flipSpy.mockClear();
  flipSpy.mockImplementation(async () => true);
  getFlashModesSpy.mockClear();
  getFlashModesSpy.mockImplementation(async () => FLASH_CAPABLE);
  setFlashModeSpy.mockClear();
  useVoicePrefsStore.setState({ flashMode: "off" });
});

afterEach(() => {
  cleanup();
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    stubMediaDevices(undefined);
  }
});

describe("useVoiceCamera: which cameras get a flash control", () => {
  test("offers it once a native camera reports a capture-flash mode", async () => {
    await openNativeCamera();

    await waitFor(() => expect(flashAvailable()).toBe(true));
  });

  test("offers nothing on a camera that reports no flash modes", async () => {
    // What both platforms answer for a camera with no flash unit, which is
    // most front cameras. An empty list is an answer, not a failure.
    getFlashModesSpy.mockImplementation(async () => []);
    await openNativeCamera();

    expect(flashAvailable()).toBe(false);
    expect(setFlashModeSpy).not.toHaveBeenCalled();
  });

  test("offers nothing on a camera that reported only part of the cycle", async () => {
    // The control's whole contract is the three-mode cycle, and a mode the
    // probe did not name is a mode the bridge refuses. Rather than reach for
    // the persisted preference and hope, a camera that cannot do all three is
    // not offered the control at all.
    useVoicePrefsStore.setState({ flashMode: "on" });
    getFlashModesSpy.mockImplementation(async () => ["off", "auto"]);
    await openNativeCamera();

    expect(flashAvailable()).toBe(false);
    expect(setFlashModeSpy).not.toHaveBeenCalled();
  });

  test("offers nothing on a camera that has only a lamp", async () => {
    // A torch is a separate, one-way state from the photo flash, so a camera
    // offering only that has nothing this control can drive.
    getFlashModesSpy.mockImplementation(async () => ["torch"]);
    await openNativeCamera();

    expect(flashAvailable()).toBe(false);
    expect(setFlashModeSpy).not.toHaveBeenCalled();
  });

  test("offers nothing on the browser fallback path", async () => {
    nativeMobile = false;
    stubMediaDevices({ getUserMedia: async () => fakeStream() });

    render(<Probe />);
    await press("open");

    expect(flashAvailable()).toBe(false);
    // No flash exists to ask about, so the probe is never made at all.
    expect(getFlashModesSpy).not.toHaveBeenCalled();
  });

  test("leaves the flash alone for a surface that did not ask for it", async () => {
    // The composer's capture overlay runs on this same hook and shows no flash
    // control, so it must not silently fire one the user set somewhere else.
    useVoicePrefsStore.setState({ flashMode: "on" });
    render(<Probe flash={false} />);
    await press("open");

    expect(flashAvailable()).toBe(false);
    expect(getFlashModesSpy).not.toHaveBeenCalled();
    expect(setFlashModeSpy).not.toHaveBeenCalled();
  });

  test("never probes a native camera that failed to start", async () => {
    // Both flash calls reach for the capture device the preview owns. Asking
    // before there is one is the case iOS answers by force-unwrapping.
    startSpy.mockImplementation(async () => false);
    stubMediaDevices(undefined);

    render(<Probe />);
    await press("open");

    expect(flashAvailable()).toBe(false);
    expect(getFlashModesSpy).not.toHaveBeenCalled();
  });
});

describe("useVoiceCamera: putting the preference on the camera", () => {
  test("applies the mode the user last chose when the camera opens", async () => {
    useVoicePrefsStore.setState({ flashMode: "on" });
    await openNativeCamera();

    await waitFor(() => expect(setFlashModeSpy).toHaveBeenCalledWith("on"));
  });

  test("applies a later choice to the camera already running", async () => {
    await openNativeCamera();
    await waitFor(() => expect(flashAvailable()).toBe(true));
    setFlashModeSpy.mockClear();

    await act(async () => {
      useVoicePrefsStore.getState().setFlashMode("auto");
    });

    await waitFor(() => expect(setFlashModeSpy).toHaveBeenCalledWith("auto"));
  });

  test("says 'off' out loud rather than assuming it", async () => {
    // The hand-back on the way out is best effort, so an opening camera cannot
    // assume the plugin is where the last session meant to leave it.
    await openNativeCamera();

    await waitFor(() => expect(setFlashModeSpy).toHaveBeenCalledWith("off"));
  });
});

describe("useVoiceCamera: handing the flash back", () => {
  test("resets the plugin to off when the camera closes", async () => {
    useVoicePrefsStore.setState({ flashMode: "on" });
    await openNativeCamera();
    await waitFor(() => expect(setFlashModeSpy).toHaveBeenCalledWith("on"));
    setFlashModeSpy.mockClear();

    await press("close");

    expect(setFlashModeSpy).toHaveBeenCalledWith("off");
    expect(stopSpy).toHaveBeenCalled();
    expect(flashAvailable()).toBe(false);
  });

  test("leaves a camera it never lit alone on close", async () => {
    await openNativeCamera();
    await waitFor(() => expect(flashAvailable()).toBe(true));
    setFlashModeSpy.mockClear();

    await press("close");

    // Already off. A set on the way out buys nothing and is exactly the
    // speculative call a flashless camera throws on.
    expect(setFlashModeSpy).not.toHaveBeenCalled();
  });

  test("clears the flash before a flip, then re-probes what arrives", async () => {
    useVoicePrefsStore.setState({ flashMode: "on" });
    await openNativeCamera();
    await waitFor(() => expect(setFlashModeSpy).toHaveBeenCalledWith("on"));
    setFlashModeSpy.mockClear();
    getFlashModesSpy.mockClear();

    await press("flip");

    // Cleared while the camera holding the flash was still the active one.
    expect(setFlashModeSpy.mock.calls[0]).toEqual(["off"]);
    expect(getFlashModesSpy).toHaveBeenCalledTimes(1);
  });

  test("hides the control after a flip onto a camera with no flash", async () => {
    useVoicePrefsStore.setState({ flashMode: "on" });
    await openNativeCamera();
    await waitFor(() => expect(flashAvailable()).toBe(true));

    getFlashModesSpy.mockImplementation(async () => []);
    await press("flip");

    await waitFor(() => expect(flashAvailable()).toBe(false));
  });

  test("restores the preference on flipping back to a camera that can fire it", async () => {
    useVoicePrefsStore.setState({ flashMode: "auto" });
    await openNativeCamera();
    await waitFor(() => expect(flashAvailable()).toBe(true));

    getFlashModesSpy.mockImplementation(async () => []);
    await press("flip");
    await waitFor(() => expect(flashAvailable()).toBe(false));

    getFlashModesSpy.mockImplementation(async () => FLASH_CAPABLE);
    setFlashModeSpy.mockClear();
    await press("flip");

    // The preference outlived the flashless camera rather than being clamped
    // to what that camera happened to support.
    await waitFor(() => expect(setFlashModeSpy).toHaveBeenCalledWith("auto"));
    expect(useVoicePrefsStore.getState().flashMode).toBe("auto");
  });
});

describe("useVoiceCamera: a probe that outlives the camera it asked about", () => {
  test("drops a late 'yes' from the camera the user flipped away from", async () => {
    // The rear camera's probe is still in flight when the user flips to a
    // front camera with no flash unit. Its answer describes a camera that is
    // no longer running, and taking it would light the control on one whose
    // Android implementation throws on the very next `setFlashMode`.
    const rearProbe = deferredCall<string[]>();
    getFlashModesSpy.mockImplementation(rearProbe.answer);

    render(<Probe />);
    await press("open");
    await waitFor(() => expect(getFlashModesSpy).toHaveBeenCalledTimes(1));

    // The camera the flip lands on answers first, and answers honestly.
    getFlashModesSpy.mockImplementation(async () => []);
    await press("flip");
    await waitFor(() => expect(getFlashModesSpy).toHaveBeenCalledTimes(2));

    await settle(() => rearProbe.resolve(FLASH_CAPABLE));

    // The set is the part that throws: `off` is still a mode this camera never
    // reported, and the bridge does not care that it is the harmless-looking
    // one.
    expect(setFlashModeSpy).not.toHaveBeenCalled();
    expect(flashAvailable()).toBe(false);
  });

  test("keeps the answer of the camera that is actually running", async () => {
    // The mirror case. A stale empty list is just as wrong as a stale capable
    // one: it would hide a control the running camera can drive.
    useVoicePrefsStore.setState({ flashMode: "on" });
    const frontProbe = deferredCall<string[]>();
    getFlashModesSpy.mockImplementation(frontProbe.answer);

    render(<Probe />);
    await press("open");
    await waitFor(() => expect(getFlashModesSpy).toHaveBeenCalledTimes(1));

    getFlashModesSpy.mockImplementation(async () => FLASH_CAPABLE);
    await press("flip");
    await waitFor(() => expect(flashAvailable()).toBe(true));

    await settle(() => frontProbe.resolve([]));

    expect(flashAvailable()).toBe(true);
    expect(setFlashModeSpy).toHaveBeenCalledWith("on");
  });
});

describe("useVoiceCamera: a flip that resumes onto a different camera", () => {
  test("abandons itself when the camera was replaced mid hand-back", async () => {
    // Handing the flash back is a bridge round trip, and a close plus a reopen
    // fits inside it. What is running on the other side is a preview this flip
    // never opened: flipping it would spin a viewfinder the user just raised
    // and file the capabilities it then probes under the wrong camera.
    useVoicePrefsStore.setState({ flashMode: "on" });
    await openNativeCamera();
    await waitFor(() => expect(setFlashModeSpy).toHaveBeenCalledWith("on"));

    const handBack = deferredCall<boolean>();
    setFlashModeSpy.mockImplementation(handBack.answer);
    await press("flip");
    setFlashModeSpy.mockImplementation(async () => true);

    await press("close");
    await press("open");
    await waitFor(() => expect(flashAvailable()).toBe(true));
    const probesTheReopenMade = getFlashModesSpy.mock.calls.length;

    await settle(() => handBack.resolve(true));

    expect(flipSpy).not.toHaveBeenCalled();
    // The reopened camera keeps its own answer, and its own facing.
    expect(getFlashModesSpy).toHaveBeenCalledTimes(probesTheReopenMade);
    expect(facing()).toBe("environment");
  });

  test("does not announce a facing the replacement never took", async () => {
    // The same race one await later: the flip is already dispatched when the
    // close and the reopen land. With the flash off there is no hand-back to
    // wait behind, so this is the bridge's own round trip.
    await openNativeCamera();
    await waitFor(() => expect(flashAvailable()).toBe(true));

    const flip = deferredCall<boolean>();
    flipSpy.mockImplementation(flip.answer);
    await press("flip");
    flipSpy.mockImplementation(async () => true);

    await press("close");
    await press("open");
    await waitFor(() => expect(flashAvailable()).toBe(true));
    const probesTheReopenMade = getFlashModesSpy.mock.calls.length;

    await settle(() => flip.resolve(true));

    expect(facing()).toBe("environment");
    expect(getFlashModesSpy).toHaveBeenCalledTimes(probesTheReopenMade);
  });
});

/** A bridge call the test decides the timing of, not the microtask queue. */
function deferredCall<T>() {
  let resolve: (value: T) => void = () => {};
  const pending = new Promise<T>((r) => {
    resolve = r;
  });
  return {
    answer: () => pending,
    resolve: (value: T) => resolve(value),
  };
}

/** Run an act pass long enough for a resolved probe to reach React. */
async function settle(release: () => void) {
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * A real `MediaStream`, because happy-dom's `srcObject` setter enforces the
 * same instance check the browser does, with the two methods release needs
 * filled in.
 */
function fakeStream() {
  const stream = new MediaStream();
  Object.defineProperties(stream, {
    getTracks: { value: () => [] },
    getVideoTracks: { value: () => [] },
  });
  return stream;
}
