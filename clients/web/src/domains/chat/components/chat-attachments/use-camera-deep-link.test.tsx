import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement } from "react";

// The picker itself is covered by `use-attachment-file-picker.test.tsx`; this
// suite is about the park-and-drain on top of it, so the hook is stubbed to a
// spy. The options it was handed are captured so the "this is the camera, not
// the OS chooser" contract can be asserted without a DOM.
const openPickerMock = mock(() => {});
let pickerOptions: Record<string, unknown> | null = null;
mock.module(
  "@/domains/chat/components/chat-attachments/use-attachment-file-picker",
  () => ({
    useAttachmentFilePicker: (options: Record<string, unknown>) => {
      pickerOptions = options;
      return {
        openPicker: openPickerMock,
        inputNode: createElement("input"),
        pickerOpen: false,
      };
    },
  }),
);

const { PENDING_CAMERA_TTL_MS, useCameraDeepLink } =
  await import("@/domains/chat/components/chat-attachments/use-camera-deep-link");
const { __resetPendingDeepLinkForTesting, usePendingDeepLinkStore } =
  await import("@/stores/pending-deep-link-store");

const onFiles = () => {};
const renderCameraDeepLink = (enabled = true) =>
  renderHook(
    ({ on }: { on: boolean }) => useCameraDeepLink({ onFiles, enabled: on }),
    {
      initialProps: { on: enabled },
    },
  );

beforeEach(() => {
  openPickerMock.mockClear();
  pickerOptions = null;
  __resetPendingDeepLinkForTesting();
});

afterEach(() => {
  cleanup();
  __resetPendingDeepLinkForTesting();
});

describe("useCameraDeepLink", () => {
  test("asks for the rear camera rather than the OS chooser", () => {
    renderCameraDeepLink();

    expect(pickerOptions).toMatchObject({
      accept: "image/*",
      capture: "environment",
    });
  });

  test("drains a park made before the composer mounted, the cold-launch case", () => {
    usePendingDeepLinkStore.getState().setPendingCamera();

    renderCameraDeepLink();

    expect(openPickerMock).toHaveBeenCalledTimes(1);
    expect(usePendingDeepLinkStore.getState().pendingCameraAt).toBeNull();
  });

  test("drains a park that arrives while already mounted, the warm case", () => {
    renderCameraDeepLink();
    expect(openPickerMock).not.toHaveBeenCalled();

    act(() => {
      usePendingDeepLinkStore.getState().setPendingCamera();
    });

    expect(openPickerMock).toHaveBeenCalledTimes(1);
  });

  test("delivers exactly once: a re-render does not reopen the camera", () => {
    usePendingDeepLinkStore.getState().setPendingCamera();

    const { rerender } = renderCameraDeepLink();
    rerender({ on: true });

    expect(openPickerMock).toHaveBeenCalledTimes(1);
  });

  test("a park older than the TTL is spent, not acted on: no camera minutes later", () => {
    usePendingDeepLinkStore.setState({
      pendingCameraAt: Date.now() - PENDING_CAMERA_TTL_MS - 1,
    });

    renderCameraDeepLink();

    expect(openPickerMock).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingCameraAt).toBeNull();
  });

  test("a park just inside the TTL still opens the camera", () => {
    usePendingDeepLinkStore.setState({
      pendingCameraAt: Date.now() - PENDING_CAMERA_TTL_MS + 1_000,
    });

    renderCameraDeepLink();

    expect(openPickerMock).toHaveBeenCalledTimes(1);
  });

  test("a disabled composer leaves the park alone for the one that answers it", () => {
    usePendingDeepLinkStore.getState().setPendingCamera();

    const { rerender } = renderCameraDeepLink(false);

    expect(openPickerMock).not.toHaveBeenCalled();
    expect(usePendingDeepLinkStore.getState().pendingCameraAt).not.toBeNull();

    rerender({ on: true });

    expect(openPickerMock).toHaveBeenCalledTimes(1);
  });
});
