import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { DictationOverlayState } from "@/runtime/is-electron";

let currentState: DictationOverlayState | null = null;
const requestStopMock = mock(() => undefined);
const setInteractiveMock = mock((_interactive: boolean) => undefined);
const setHitRegionMock = mock(
  (_region: { x: number; y: number; width: number; height: number } | null) =>
    undefined,
);

mock.module("@/runtime/dictation-overlay", () => ({
  getDictationOverlayState: async () => currentState,
  subscribeToDictationOverlayState: () => () => undefined,
  requestDictationOverlayStop: requestStopMock,
  setDictationOverlayInteractive: setInteractiveMock,
  setDictationOverlayHitRegion: setHitRegionMock,
}));

const { DictationOverlayPage } = await import("./dictation-overlay-page");

afterEach(() => {
  cleanup();
  currentState = null;
  requestStopMock.mockClear();
  setInteractiveMock.mockClear();
  setHitRegionMock.mockClear();
});

describe("DictationOverlayPage", () => {
  test("renders a far-right stop control during recording", async () => {
    currentState = {
      kind: "recording",
      transcription: "hello",
      audioLevel: 0.5,
    };

    const { container, getByLabelText } = render(<DictationOverlayPage />);
    const stopButton = await waitFor(() => getByLabelText("Stop recording"));
    const overlay = container.firstElementChild;
    if (!overlay) {
      throw new Error("Expected overlay root to render");
    }
    stopButton.getBoundingClientRect = () =>
      ({
        left: 10,
        right: 30,
        top: 10,
        bottom: 30,
        x: 10,
        y: 10,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      }) as DOMRect;

    fireEvent.mouseMove(overlay, { clientX: 20, clientY: 20 });
    fireEvent.click(stopButton);

    expect(setInteractiveMock.mock.calls).toContainEqual([true]);
    expect(requestStopMock).toHaveBeenCalledTimes(1);
    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([false]);
  });

  test("returns to click-through when forwarded mouse movement leaves the stop control", async () => {
    currentState = {
      kind: "recording",
      transcription: "",
      audioLevel: 0.5,
    };

    const { container, getByLabelText } = render(<DictationOverlayPage />);
    const stopButton = await waitFor(() => getByLabelText("Stop recording"));
    const overlay = container.firstElementChild;
    if (!overlay) {
      throw new Error("Expected overlay root to render");
    }
    stopButton.getBoundingClientRect = () =>
      ({
        left: 10,
        right: 30,
        top: 10,
        bottom: 30,
        x: 10,
        y: 10,
        width: 20,
        height: 20,
        toJSON: () => ({}),
      }) as DOMRect;

    fireEvent.mouseMove(overlay, { clientX: 20, clientY: 20 });
    fireEvent.mouseMove(overlay, { clientX: 100, clientY: 100 });

    expect(setInteractiveMock.mock.calls).toContainEqual([true]);
    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([false]);
  });

  test("reports the stop control's hit region while recording and clears it on teardown", async () => {
    currentState = {
      kind: "recording",
      transcription: "",
      audioLevel: 0.5,
    };

    const { getByLabelText, unmount } = render(<DictationOverlayPage />);
    await waitFor(() => getByLabelText("Stop recording"));

    await waitFor(() => expect(setHitRegionMock).toHaveBeenCalled());
    expect(setHitRegionMock.mock.calls.at(-1)?.[0]).not.toBeNull();

    unmount();
    expect(setHitRegionMock.mock.calls.at(-1)).toEqual([null]);
  });

  test("re-measures the hit region when the layout changes mid-recording", async () => {
    currentState = {
      kind: "recording",
      transcription: "",
      audioLevel: 0.5,
    };

    const observerCallbacks: Array<() => void> = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observerCallbacks.push(() =>
          callback([], this as unknown as ResizeObserver),
        );
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;

    try {
      const { getByLabelText } = render(<DictationOverlayPage />);
      const stopButton = await waitFor(() => getByLabelText("Stop recording"));
      expect(observerCallbacks.length).toBeGreaterThan(0);

      stopButton.getBoundingClientRect = () =>
        ({
          left: 44,
          right: 64,
          top: 8,
          bottom: 28,
          x: 44,
          y: 8,
          width: 20,
          height: 20,
          toJSON: () => ({}),
        }) as DOMRect;
      for (const fire of observerCallbacks) {
        fire();
      }

      expect(setHitRegionMock.mock.calls.at(-1)?.[0]).toEqual({
        x: 44,
        y: 8,
        width: 20,
        height: 20,
      });
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  test("does not render the stop control after recording ends", async () => {
    currentState = { kind: "processing" };

    const { queryByLabelText } = render(<DictationOverlayPage />);

    await waitFor(() => {
      expect(queryByLabelText("Stop recording")).toBeNull();
    });
  });
});
