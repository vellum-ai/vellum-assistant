import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { Capacitor } from "@capacitor/core";
import { act, renderHook } from "@testing-library/react";

let nativeMobile = false;

spyOn(Capacitor, "isNativePlatform").mockImplementation(() => nativeMobile);
spyOn(Capacitor, "getPlatform").mockImplementation(() =>
  nativeMobile ? "ios" : "web",
);

const startSpy = mock(async () => {});
const stopSpy = mock(async () => {});
const captureSpy = mock(async () => ({ value: "jpeg-base64" }));
const flipSpy = mock(async () => {});

mock.module("@capacitor-community/camera-preview", () => ({
  CameraPreview: {
    start: startSpy,
    stop: stopSpy,
    capture: captureSpy,
    flip: flipSpy,
  },
}));

const {
  NATIVE_VOICE_CAMERA_ACTIVE_CLASS,
  captureNativeVoiceCameraFrame,
  flipNativeVoiceCamera,
  startNativeVoiceCamera,
  stopNativeVoiceCamera,
} = await import("@/runtime/native-voice-camera");
const { useVoiceCamera } =
  await import("@/domains/chat/voice/voice-room/voice-camera");

beforeEach(() => {
  nativeMobile = false;
  startSpy.mockClear();
  stopSpy.mockClear();
  captureSpy.mockClear();
  flipSpy.mockClear();
  startSpy.mockImplementation(async () => {});
  stopSpy.mockImplementation(async () => {});
  captureSpy.mockImplementation(async () => ({ value: "jpeg-base64" }));
  flipSpy.mockImplementation(async () => {});
  document.documentElement.classList.remove(
    NATIVE_VOICE_CAMERA_ACTIVE_CLASS,
  );
});

afterEach(() => {
  nativeMobile = false;
  document.documentElement.classList.remove(
    NATIVE_VOICE_CAMERA_ACTIVE_CLASS,
  );
});

describe("native voice camera", () => {
  test("does not call the plugin outside a native mobile shell", async () => {
    expect(await startNativeVoiceCamera("environment")).toBe(false);
    expect(startSpy).not.toHaveBeenCalled();
    expect(
      document.documentElement.classList.contains(
        NATIVE_VOICE_CAMERA_ACTIVE_CLASS,
      ),
    ).toBe(false);
  });

  test("starts a video-only native high-resolution preview", async () => {
    nativeMobile = true;

    expect(await startNativeVoiceCamera("environment")).toBe(true);
    expect(startSpy).toHaveBeenCalledWith({
      position: "rear",
      toBack: true,
      storeToFile: false,
      enableHighResolution: true,
      disableAudio: true,
      enableZoom: true,
    });
    expect(
      document.documentElement.classList.contains(
        NATIVE_VOICE_CAMERA_ACTIVE_CLASS,
      ),
    ).toBe(true);
  });

  test("clears the native layer marker when an older shell rejects start", async () => {
    nativeMobile = true;
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    startSpy.mockImplementation(async () => {
      throw new Error("plugin unavailable");
    });

    expect(await startNativeVoiceCamera("user")).toBe(false);
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ position: "front", disableAudio: true }),
    );
    expect(
      document.documentElement.classList.contains(
        NATIVE_VOICE_CAMERA_ACTIVE_CLASS,
      ),
    ).toBe(false);
    debugSpy.mockRestore();
  });

  test("a refusal arriving after a replacement start leaves it visible", async () => {
    nativeMobile = true;
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});

    // The first open's refusal is still on the bridge while a stop and a
    // second open run. The visibility belongs to the second open: the late
    // refusal must not hide the preview it is putting up.
    let refuseFirst: () => void = () => {};
    startSpy.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuseFirst = () => reject(new Error("camera busy"));
        }),
    );
    const first = startNativeVoiceCamera("environment");

    await stopNativeVoiceCamera();
    startSpy.mockImplementation(async () => {});
    const second = startNativeVoiceCamera("user");

    refuseFirst();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(
      document.documentElement.classList.contains(
        NATIVE_VOICE_CAMERA_ACTIVE_CLASS,
      ),
    ).toBe(true);
    debugSpy.mockRestore();
  });

  test("captures, flips, and stops through the native bridge", async () => {
    nativeMobile = true;
    document.documentElement.classList.add(
      NATIVE_VOICE_CAMERA_ACTIVE_CLASS,
    );

    expect(await captureNativeVoiceCameraFrame(85)).toBe("jpeg-base64");
    expect(captureSpy).toHaveBeenCalledWith({ quality: 85 });
    expect(await flipNativeVoiceCamera()).toBe(true);
    expect(flipSpy).toHaveBeenCalledTimes(1);

    await stopNativeVoiceCamera();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(
      document.documentElement.classList.contains(
        NATIVE_VOICE_CAMERA_ACTIVE_CLASS,
      ),
    ).toBe(false);
  });

  test("drives the voice camera hook without an HTML video stream", async () => {
    nativeMobile = true;
    captureSpy.mockImplementation(async () => ({ value: "AQID" }));
    const videoRef: { current: HTMLVideoElement | null } = { current: null };
    const { result, unmount } = renderHook(() => useVoiceCamera(videoRef));

    await act(async () => {
      await result.current.openCamera();
    });
    expect(result.current.open).toBe(true);
    expect(result.current.native).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);

    const photo = await result.current.captureFrame();
    expect(photo?.name).toBe("photo-1.jpg");
    expect(photo?.size).toBe(3);

    await act(async () => {
      await result.current.flipCamera();
    });
    expect(result.current.facing).toBe("user");

    act(() => result.current.closeCamera());
    expect(result.current.open).toBe(false);
    expect(result.current.native).toBe(false);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    unmount();
  });
});
