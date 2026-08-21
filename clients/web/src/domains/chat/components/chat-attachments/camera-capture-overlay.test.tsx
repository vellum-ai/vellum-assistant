/**
 * The camera the widget's camera button raises.
 *
 * The point of the surface is that it opens without a tap: the request comes
 * from outside the web view, so there is no DOM user activation and a hidden
 * `<input capture>` would never present anything on iOS. These tests hold that
 * contract from both ends (the acquisition runs on mount, and no file input
 * exists on the path at all) and cover the ways a photo can fail to arrive.
 *
 * The same absence of a tap is why the modality is covered here: a surface that
 * arrives on its own has to move focus in, hold it, hand it back, and take the
 * app behind it out of reach, none of which a `role="dialog"` attribute does.
 *
 * `useVoiceCamera` is stubbed: which of its two backends is live (the native
 * Capacitor preview, the `getUserMedia` fallback) is that module's own test's
 * business, and what matters here is only what this surface does with the
 * answer.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

let cameraOpen = true;
let cameraNative = true;
let cameraError: string | null = null;
let capturedFrame: File | null = null;

const openCameraMock = mock(async () => {});
const flipCameraMock = mock(async () => {});
const closeCameraMock = mock(() => {});
const captureFrameMock = mock(async () => capturedFrame);

mock.module("@/domains/chat/voice/voice-room/voice-camera", () => ({
  useVoiceCamera: () => ({
    open: cameraOpen,
    native: cameraNative,
    facing: "environment",
    error: cameraError,
    openCamera: openCameraMock,
    closeCamera: closeCameraMock,
    flipCamera: flipCameraMock,
    captureFrame: captureFrameMock,
  }),
}));

const { CameraCaptureOverlay } = await import(
  "@/domains/chat/components/chat-attachments/camera-capture-overlay"
);

function renderOverlay() {
  const onCapture = mock((_files: File[]) => {});
  const onClose = mock(() => {});
  const result = render(
    <CameraCaptureOverlay onCapture={onCapture} onClose={onClose} />,
  );
  return { ...result, onCapture, onClose };
}

const shutter = () => screen.getByTestId("camera-deep-link-shutter");
const closeControl = () => screen.getByTestId("camera-deep-link-close");
/** Portalled out of the caller's tree, so it is never in `container`. */
const surface = () => screen.getByTestId("camera-deep-link-surface");

/** The focus scope restores on a macrotask, so its work has to be let out. */
const flushFocusRestore = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  cameraOpen = true;
  cameraNative = true;
  cameraError = null;
  capturedFrame = null;
  openCameraMock.mockClear();
  flipCameraMock.mockClear();
  closeCameraMock.mockClear();
  captureFrameMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("CameraCaptureOverlay", () => {
  test("opens the camera on mount, since there is no tap to open it from", () => {
    renderOverlay();

    expect(openCameraMock).toHaveBeenCalledTimes(1);
  });

  test("reaches the camera through the bridge, never a file input", () => {
    renderOverlay();

    expect(document.body.querySelector('input[type="file"]')).toBeNull();
  });

  test("leaves the native preview uncovered", () => {
    renderOverlay();

    // The preview is a layer behind the web view, so neither the fallback
    // `<video>` nor a painted background may sit in front of it.
    expect(surface().querySelector("video")).toBeNull();
    expect(surface().className).toContain("bg-transparent");
  });

  test("renders its own viewfinder on a shell without the native preview", () => {
    cameraNative = false;

    renderOverlay();

    expect(surface().querySelector("video")).not.toBeNull();
  });

  test("escapes the composer's transformed ancestors by portalling to the body", () => {
    const { container } = renderOverlay();

    expect(container.querySelector("[data-testid]")).toBeNull();
    expect(surface().parentElement).toBe(document.body);
  });

  test("hands the captured frame over and takes the surface down", async () => {
    const photo = new File([new Uint8Array([1, 2, 3])], "photo-1.jpg", {
      type: "image/jpeg",
    });
    capturedFrame = photo;
    const { onCapture, onClose } = renderOverlay();

    await act(async () => {
      fireEvent.click(shutter());
    });

    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture.mock.calls[0]?.[0]).toEqual([photo]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a frame that never encoded closes the surface and attaches nothing", async () => {
    capturedFrame = null;
    const { onCapture, onClose } = renderOverlay();

    await act(async () => {
      fireEvent.click(shutter());
    });

    expect(onCapture).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("the shutter waits for the viewfinder rather than capturing a blank", () => {
    cameraOpen = false;

    renderOverlay();

    expect(shutter().hasAttribute("disabled")).toBe(true);
  });

  test("an acquisition failure closes the surface rather than stranding it", () => {
    cameraError = "permission-denied";

    const { onClose } = renderOverlay();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape closes the surface", () => {
    const { onClose } = renderOverlay();

    fireEvent.keyDown(surface(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("moves focus into the surface, since nothing tapped its way in", () => {
    renderOverlay();

    // The box rather than a control: both controls carry a tooltip, and a
    // tooltip opened by autofocus is a dismissable layer that would own the
    // first Escape.
    expect(document.activeElement).toBe(surface());
    expect(screen.queryAllByRole("tooltip")).toHaveLength(0);
  });

  test("returns focus to whatever held it once the surface goes away", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const { unmount } = renderOverlay();
    expect(document.activeElement).not.toBe(opener);

    unmount();
    await flushFocusRestore();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  test("takes the app behind it out of the accessibility tree", () => {
    // The `getUserMedia` path leaves `#root` on screen behind a full-screen
    // viewfinder, so the composer under it has to stop being reachable.
    cameraNative = false;
    const { container } = renderOverlay();

    expect(container.getAttribute("aria-hidden")).toBe("true");
  });

  test("keeps Tab inside the surface", () => {
    renderOverlay();

    // Off the last control, so the cycle has to come back around rather than
    // reaching the composer behind the camera.
    const flip = screen.getByTestId("camera-deep-link-flip");
    flip.focus();
    fireEvent.keyDown(flip, { key: "Tab" });

    expect(document.activeElement).toBe(closeControl());
  });

  test("the flip control switches cameras without leaving the surface", () => {
    const { onClose } = renderOverlay();

    fireEvent.click(screen.getByTestId("camera-deep-link-flip"));

    expect(flipCameraMock).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
