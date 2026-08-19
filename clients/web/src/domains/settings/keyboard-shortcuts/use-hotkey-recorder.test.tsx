/**
 * The recorder's write path, specifically what a caller is told about it.
 *
 * `onBound` exists so a caller can settle a binding this hook knows nothing
 * about — Settings, Voice clears Fn when a chord is recorded, because the two
 * are one choice. That makes the timing load-bearing: a caller that acts on a
 * write which never landed clears the binding that still worked and saves
 * nothing in its place.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type { ResolvedHotkey } from "@/runtime/hotkeys";

const catalog: ResolvedHotkey[] = [
  {
    key: "toggleVoice",
    label: "Talk",
    scope: "global",
    defaultAccelerator: "",
    override: null,
    accelerator: "",
    rebindable: true,
  },
];

const getHotkeys = mock(() => Promise.resolve(catalog));
const setHotkey = mock((_key: string, _accelerator: string | null) =>
  Promise.resolve(),
);
const onHotkeysChange = mock(() => () => {});

mock.module("@/runtime/hotkeys", () => ({
  getHotkeys,
  setHotkey,
  onHotkeysChange,
}));

const { useHotkeyRecorder } = await import(
  "@/domains/settings/keyboard-shortcuts/use-hotkey-recorder"
);

const onBound = mock((_key: string) => {});

beforeEach(() => {
  getHotkeys.mockClear();
  setHotkey.mockClear();
  onHotkeysChange.mockClear();
  onBound.mockClear();
  setHotkey.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup();
});

/** Record a chord against `toggleVoice` and wait for the write to be attempted. */
async function recordChord() {
  const { result } = renderHook(() => useHotkeyRecorder({ onBound }));
  await waitFor(() => expect(result.current.catalog.length).toBe(1));

  result.current.startRecording("toggleVoice");
  await waitFor(() => expect(result.current.recordingKey).toBe("toggleVoice"));

  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "J",
      code: "KeyJ",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitFor(() => expect(setHotkey).toHaveBeenCalled());
}

describe("useHotkeyRecorder", () => {
  test("tells the caller a chord is bound once the write lands", async () => {
    await recordChord();

    expect(setHotkey).toHaveBeenCalledWith("toggleVoice", "CmdOrCtrl+Shift+J");
    await waitFor(() => expect(onBound).toHaveBeenCalledWith("toggleVoice"));
  });

  test("tells the caller nothing when the host rejects the write", async () => {
    // An older host whose catalog predates this command rejects it by name.
    // Voice would otherwise clear Fn here, leaving the user with no binding at
    // all: none saved, and the working one discarded.
    setHotkey.mockImplementation(() =>
      Promise.reject(new Error("Unknown hotkey command: toggleVoice")),
    );

    await recordChord();
    // Let the rejection settle; `onBound` must still not have fired, and the
    // rejection must be handled rather than escaping as unhandled.
    await Promise.resolve();
    await Promise.resolve();

    expect(onBound).not.toHaveBeenCalled();
  });
});
