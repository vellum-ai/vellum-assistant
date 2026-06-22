import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { DictationOverlayState } from "@/runtime/is-electron";

let currentState: DictationOverlayState | null = null;
const requestStopMock = mock(() => undefined);
const setInteractiveMock = mock((_interactive: boolean) => undefined);

mock.module("@/runtime/dictation-overlay", () => ({
  getDictationOverlayState: async () => currentState,
  subscribeToDictationOverlayState: () => () => undefined,
  requestDictationOverlayStop: requestStopMock,
  setDictationOverlayInteractive: setInteractiveMock,
}));

const { DictationOverlayPage } = await import("./dictation-overlay-page");

afterEach(() => {
  cleanup();
  currentState = null;
  requestStopMock.mockClear();
  setInteractiveMock.mockClear();
});

describe("DictationOverlayPage", () => {
  test("renders a far-right stop control during recording", async () => {
    currentState = {
      kind: "recording",
      transcription: "hello",
      audioLevel: 0.5,
    };

    const { getByLabelText } = render(<DictationOverlayPage />);
    const stopButton = await waitFor(() => getByLabelText("Stop recording"));

    fireEvent.mouseEnter(stopButton);
    fireEvent.click(stopButton);

    expect(setInteractiveMock.mock.calls).toContainEqual([true]);
    expect(requestStopMock).toHaveBeenCalledTimes(1);
    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([false]);
  });

  test("does not render the stop control after recording ends", async () => {
    currentState = { kind: "processing" };

    const { queryByLabelText } = render(<DictationOverlayPage />);

    await waitFor(() => {
      expect(queryByLabelText("Stop recording")).toBeNull();
    });
  });
});
