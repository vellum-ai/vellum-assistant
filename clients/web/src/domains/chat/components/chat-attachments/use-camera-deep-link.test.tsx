import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";

// The viewfinder itself is covered by `camera-capture-overlay.test.tsx`; this
// suite is about the park-and-drain that raises it, so the surface is stubbed
// to a marker that also hands its two callbacks back for the delivery tests.
let overlayProps: {
  onCapture: (files: File[]) => void;
  onClose: () => void;
} | null = null;
mock.module(
  "@/domains/chat/components/chat-attachments/camera-capture-overlay",
  () => ({
    CameraCaptureOverlay: (props: {
      onCapture: (files: File[]) => void;
      onClose: () => void;
    }) => {
      overlayProps = props;
      return createElement("div", { "data-testid": "camera-surface" });
    },
  }),
);

const { PENDING_CAMERA_TTL_MS, useCameraDeepLink } = await import(
  "@/domains/chat/components/chat-attachments/use-camera-deep-link"
);
const { __resetPendingDeepLinkForTesting, usePendingDeepLinkStore } =
  await import("@/stores/pending-deep-link-store");
const { useLiveVoiceStore } = await import(
  "@/domains/chat/voice/live-voice/live-voice-store"
);

const onFiles = mock((_files: File[]) => {});

function Host({ enabled }: { enabled: boolean }) {
  const { overlayNode, captureOpen } = useCameraDeepLink({ onFiles, enabled });
  return createElement(
    "div",
    { "data-testid": "host", "data-capture-open": String(captureOpen) },
    overlayNode,
  );
}

const renderCameraDeepLink = (enabled = true) =>
  render(createElement(Host, { enabled }));

const surface = () => screen.queryByTestId("camera-surface");
const captureOpen = () =>
  screen.getByTestId("host").getAttribute("data-capture-open");

beforeEach(() => {
  onFiles.mockClear();
  overlayProps = null;
  __resetPendingDeepLinkForTesting();
  useLiveVoiceStore.setState({ state: "idle" });
});

afterEach(() => {
  cleanup();
  __resetPendingDeepLinkForTesting();
  useLiveVoiceStore.setState({ state: "idle" });
});

describe("useCameraDeepLink", () => {
  test("raises no camera until a request is parked", () => {
    renderCameraDeepLink();

    expect(surface()).toBeNull();
    expect(captureOpen()).toBe("false");
  });

  test("drains a park made before the composer mounted, the cold-launch case", () => {
    usePendingDeepLinkStore.getState().setPendingCamera();

    renderCameraDeepLink();

    expect(surface()).not.toBeNull();
    expect(captureOpen()).toBe("true");
    expect(usePendingDeepLinkStore.getState().pendingCameraAt).toBeNull();
  });

  test("drains a park that arrives while already mounted, the warm case", () => {
    renderCameraDeepLink();
    expect(surface()).toBeNull();

    act(() => {
      usePendingDeepLinkStore.getState().setPendingCamera();
    });

    expect(surface()).not.toBeNull();
  });

  test("hands the photo to the composer's attachment pipeline as files", () => {
    usePendingDeepLinkStore.getState().setPendingCamera();
    renderCameraDeepLink();

    const photo = new File([new Uint8Array([1, 2, 3])], "photo-1.jpg", {
      type: "image/jpeg",
    });
    act(() => {
      overlayProps?.onCapture([photo]);
      overlayProps?.onClose();
    });

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]?.[0]).toEqual([photo]);
    expect(surface()).toBeNull();
  });

  test("closing without a photo takes the surface down and attaches nothing", () => {
    usePendingDeepLinkStore.getState().setPendingCamera();
    renderCameraDeepLink();

    act(() => {
      overlayProps?.onClose();
    });

    expect(onFiles).not.toHaveBeenCalled();
    expect(surface()).toBeNull();
    expect(captureOpen()).toBe("false");
  });

  test("delivers exactly once: a closed surface does not come back on re-render", () => {
    usePendingDeepLinkStore.getState().setPendingCamera();
    const { rerender } = renderCameraDeepLink();

    act(() => {
      overlayProps?.onClose();
    });
    rerender(createElement(Host, { enabled: true }));

    expect(surface()).toBeNull();
  });

  test("a park older than the TTL is spent, not acted on: no camera minutes later", () => {
    usePendingDeepLinkStore.setState({
      pendingCameraAt: Date.now() - PENDING_CAMERA_TTL_MS - 1,
    });

    renderCameraDeepLink();

    expect(surface()).toBeNull();
    expect(usePendingDeepLinkStore.getState().pendingCameraAt).toBeNull();
  });

  test("a park just inside the TTL still opens the camera", () => {
    usePendingDeepLinkStore.setState({
      pendingCameraAt: Date.now() - PENDING_CAMERA_TTL_MS + 1_000,
    });

    renderCameraDeepLink();

    expect(surface()).not.toBeNull();
  });

  test("a running call keeps the camera: no surface, and the request is spent", () => {
    // The room's viewfinder and this one are two hooks over one native preview
    // layer, so the drain gives way rather than fighting it for the camera.
    useLiveVoiceStore.setState({ state: "listening" });
    usePendingDeepLinkStore.getState().setPendingCamera();

    const { rerender } = renderCameraDeepLink();

    expect(surface()).toBeNull();
    expect(captureOpen()).toBe("false");
    // Spent rather than parked: a call outlives the TTL, so a held request
    // would raise a viewfinder long after the tap asked for one.
    expect(usePendingDeepLinkStore.getState().pendingCameraAt).toBeNull();

    useLiveVoiceStore.setState({ state: "idle" });
    rerender(createElement(Host, { enabled: true }));

    expect(surface()).toBeNull();
  });

  test("a disabled composer leaves the park alone for the one that answers it", () => {
    usePendingDeepLinkStore.getState().setPendingCamera();

    const { rerender } = renderCameraDeepLink(false);

    expect(surface()).toBeNull();
    expect(usePendingDeepLinkStore.getState().pendingCameraAt).not.toBeNull();

    rerender(createElement(Host, { enabled: true }));

    expect(surface()).not.toBeNull();
  });
});
