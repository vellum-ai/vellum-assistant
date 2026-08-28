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

import {
  fakeStream,
  restoreMediaDevices,
  stubMediaDevices,
} from "./voice-camera.test-helper";

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
      <span data-testid="flipping">{camera.flipping ? "yes" : "no"}</span>
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

const flipping = () => screen.getByTestId("flipping").textContent === "yes";

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
  restoreMediaDevices();
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
    stubMediaDevices(async () => fakeStream());

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
    stubMediaDevices(null);

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
    // front camera with no flash unit. Its answer describes a stopped camera,
    // and taking it would light the control on one whose Android
    // implementation throws on the very next `setFlashMode`.
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

describe("useVoiceCamera: two flips at once", () => {
  test("collapses a double tap into one flip", async () => {
    // A native flip does not release the capture, so a second flip entering
    // the first one's hand-back shares its generation and reads the same
    // pre-flip facing. Both would compute the same side, spin the hardware
    // twice back to where it started, and agree on the one it is not pointing
    // at: a viewfinder mirrored the wrong way, and every later flip working
    // from a facing the camera does not have.
    useVoicePrefsStore.setState({ flashMode: "on" });
    await openNativeCamera();
    await waitFor(() => expect(setFlashModeSpy).toHaveBeenCalledWith("on"));

    const handBack = deferredCall<boolean>();
    setFlashModeSpy.mockImplementation(handBack.answer);
    await press("flip");
    setFlashModeSpy.mockImplementation(async () => true);

    // The second tap lands while the first flip is still handing the flash
    // back, which is the whole window this guard exists for.
    await press("flip");
    expect(flipSpy).not.toHaveBeenCalled();

    await settle(() => handBack.resolve(true));

    expect(flipSpy).toHaveBeenCalledTimes(1);
    expect(facing()).toBe("user");
  });

  test("takes the next flip once the first one finishes", async () => {
    // The guard is a window, not a latch. A flip that bailed out on a released
    // camera clears it the same as one that completed.
    await openNativeCamera();
    await waitFor(() => expect(flashAvailable()).toBe(true));

    await press("flip");
    expect(facing()).toBe("user");

    await press("flip");
    expect(facing()).toBe("environment");
    expect(flipSpy).toHaveBeenCalledTimes(2);
  });

  test("holds its claim through its own fallback reacquisition", async () => {
    // On Capacitor with the native preview refused, the flip takes the web
    // branch, and `acquire` releases the capture to request the replacement.
    // That release is the running flip's own, so it must leave the claim
    // standing: `sourceRef` reads `native-pending` across the await, and a
    // second tap that got past both guards would start a competing flip.
    startSpy.mockImplementation(async () => false);
    const getUserMedia = mock(async () => fakeStream());
    stubMediaDevices(getUserMedia);

    render(<Probe />);
    await press("open");
    expect(facing()).toBe("environment");

    const slowStart = deferredCall<boolean>();
    startSpy.mockImplementation(slowStart.answer);
    await press("flip");

    // Lands while the first flip is still inside `acquire`.
    await press("flip");
    expect(startSpy).toHaveBeenCalledTimes(2);

    await settle(() => slowStart.resolve(false));

    expect(facing()).toBe("user");
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
});

describe("useVoiceCamera: a flip the bridge never answers", () => {
  test("comes back after a close and a reopen", async () => {
    // Nothing times out a bridge call, so a hand-back that never settles used
    // to hold the flip guard for the life of the hook: the button stopped
    // working, and closing the camera and raising it again did not bring it
    // back.
    useVoicePrefsStore.setState({ flashMode: "on" });
    await openNativeCamera();
    await waitFor(() => expect(setFlashModeSpy).toHaveBeenCalledWith("on"));

    const neverAnswers = deferredCall<boolean>();
    setFlashModeSpy.mockImplementation(neverAnswers.answer);
    await press("flip");
    expect(flipSpy).not.toHaveBeenCalled();
    expect(flipping()).toBe(true);

    setFlashModeSpy.mockImplementation(async () => true);
    await press("close");
    await press("open");
    await waitFor(() => expect(flashAvailable()).toBe(true));
    // The release recovers the shutter along with the flip button: a hung
    // hand-back must not leave the capture disabled for the session's life.
    expect(flipping()).toBe(false);

    await press("flip");

    expect(flipSpy).toHaveBeenCalledTimes(1);
    expect(facing()).toBe("user");
  });

  test("does not release the flip that replaced it when it finally answers", async () => {
    // The other side of the recovery: the abandoned flip still runs its own
    // exit, and by then the claim it took belongs to a flip that is mid-flight.
    // Clearing it there would put two flips on the hardware at once, which is
    // the case the guard exists for.
    useVoicePrefsStore.setState({ flashMode: "on" });
    await openNativeCamera();
    await waitFor(() => expect(setFlashModeSpy).toHaveBeenCalledWith("on"));

    const abandoned = deferredCall<boolean>();
    setFlashModeSpy.mockImplementation(abandoned.answer);
    await press("flip");

    setFlashModeSpy.mockImplementation(async () => true);
    await press("close");
    await press("open");
    await waitFor(() => expect(flashAvailable()).toBe(true));

    const replacement = deferredCall<boolean>();
    setFlashModeSpy.mockImplementation(replacement.answer);
    await press("flip");

    await settle(() => abandoned.resolve(true));
    // The abandoned flip's exit leaves the replacement's `flipping` standing
    // for the same reason it leaves the claim.
    expect(flipping()).toBe(true);

    // The replacement is still handing its own flash back, so this tap is the
    // second flip its guard is there to drop.
    await press("flip");
    expect(flipSpy).not.toHaveBeenCalled();

    await settle(() => replacement.resolve(true));
    expect(flipping()).toBe(false);

    expect(flipSpy).toHaveBeenCalledTimes(1);
    expect(facing()).toBe("user");
  });

  test("does not hold the next flip behind its capability probe", async () => {
    // The probe decides one button and the flip epoch already makes a late
    // answer safe, so waiting on it would let a slow probe do exactly what the
    // hung hand-back above does.
    await openNativeCamera();
    await waitFor(() => expect(flashAvailable()).toBe(true));

    const slowProbe = deferredCall<string[]>();
    getFlashModesSpy.mockImplementation(slowProbe.answer);
    await press("flip");
    expect(facing()).toBe("user");

    await press("flip");

    expect(flipSpy).toHaveBeenCalledTimes(2);
    expect(facing()).toBe("environment");
  });
});

describe("useVoiceCamera: the shutter's window during a fallback flip", () => {
  test("reports the flip while the replacement stream is on its way", async () => {
    // On the browser path a flip releases the running stream before it can
    // request the other camera, and `open` holds true across the wait. The
    // `flipping` bit is what a surface holds its shutter on: a capture in
    // that window has no stream to encode.
    nativeMobile = false;
    const getUserMedia = mock(async () => fakeStream());
    stubMediaDevices(getUserMedia);

    render(<Probe />);
    await press("open");
    expect(flipping()).toBe(false);

    let arrive: () => void = () => {};
    getUserMedia.mockImplementation(
      () =>
        new Promise((resolve) => {
          arrive = () => resolve(fakeStream());
        }),
    );
    await press("flip");
    expect(flipping()).toBe(true);

    await settle(() => arrive());
    expect(flipping()).toBe(false);
    expect(facing()).toBe("user");
  });
});

describe("useVoiceCamera: an open superseded while the bridge starts it", () => {
  test("leaves the reopened camera to its own acquire", async () => {
    // A close lands while the bridge is still starting the camera, and a
    // reopen follows before that start comes back. The close's release posts
    // the stop that separates the two starts on the bridge, so the superseded
    // start has nothing left to clean up: a stop of its own would be posted
    // after the reopen's start and tear down the preview the hook is
    // reporting open.
    const firstStart = deferredCall<boolean>();
    startSpy.mockImplementation(firstStart.answer);

    render(<Probe />);
    await press("open");
    await press("close");
    expect(stopSpy).toHaveBeenCalledTimes(1);

    const secondStart = deferredCall<boolean>();
    startSpy.mockImplementation(secondStart.answer);
    await press("open");
    expect(startSpy).toHaveBeenCalledTimes(2);

    await settle(() => firstStart.resolve(true));
    await settle(() => secondStart.resolve(true));

    // The close's stop stays the only one, and the reopened camera is live
    // enough to answer its own capability probe.
    expect(stopSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(flashAvailable()).toBe(true));
  });

  test("does not stop a camera another surface opened meanwhile", async () => {
    // The surface holding the pending start unmounts, and a different hook
    // instance raises its own camera before the late result arrives. The
    // stale start's own refs are empty either way, so the module ledger is
    // what tells "nothing owns the hardware" from "another surface does".
    const firstStart = deferredCall<boolean>();
    startSpy.mockImplementation(firstStart.answer);
    const first = render(<Probe />);
    await press("open");
    act(() => first.unmount());
    expect(stopSpy).toHaveBeenCalledTimes(1);

    startSpy.mockImplementation(async () => true);
    render(<Probe />);
    await press("open");
    expect(startSpy).toHaveBeenCalledTimes(2);

    await settle(() => firstStart.resolve(true));

    expect(stopSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(flashAvailable()).toBe(true));
  });

  test("stops the camera nothing owns when only a close follows", async () => {
    // The other half of the discipline: with no reopen behind it, the
    // superseded start is the last owner standing, and the stop it posts
    // after resolving is the one guaranteed to land after the start does.
    const slowStart = deferredCall<boolean>();
    startSpy.mockImplementation(slowStart.answer);

    render(<Probe />);
    await press("open");
    await press("close");

    await settle(() => slowStart.resolve(true));

    expect(stopSpy).toHaveBeenCalledTimes(2);
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
