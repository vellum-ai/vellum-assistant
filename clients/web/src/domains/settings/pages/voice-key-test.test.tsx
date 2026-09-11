/**
 * The "Test the key" affordance, with the host mocked at the runtime-wrapper
 * seam: `hotkey` hands back the listener so a test can press the key, and
 * `fn-claimants` says which claimants are running. Follows single-file
 * `bun test` isolation.
 */

import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

import { act, fireEvent, render, screen } from "@testing-library/react";

import type { HotkeyEvent } from "@vellumai/ipc-contract";

import { VOICE_KEY_ARRIVAL_TIMEOUT_MS } from "@/utils/voice-key-arrival";

let hotkeyListener: ((event: HotkeyEvent) => void) | null = null;
mock.module("@/runtime/hotkey", () => ({
  // The whole surface the card reaches for, so this mock cannot starve a
  // test file that runs in the same process of an export it needs.
  supportsModifierHold: () => true,
  readFnKeyState: async () => null,
  openKeyboardSettings: async () => {},
  subscribeToHotkeyEvents: (callback: (event: HotkeyEvent) => void) => {
    hotkeyListener = callback;
    return () => {
      hotkeyListener = null;
    };
  },
}));

let running: string[] = [];
mock.module("@/runtime/fn-claimants", () => ({
  runningFnClaimantNames: async () => running,
}));

const { VoiceKeyTest } =
  await import("@/domains/settings/pages/voice-key-test");

function pressTheKey() {
  act(() => {
    hotkeyListener?.({ kind: "modifierHold", state: "down" });
  });
}

/** Run the wait out under fake timers, then hand the clock back for `findBy`. */
function letTheWaitRunOut() {
  act(() => {
    jest.advanceTimersByTime(VOICE_KEY_ARRIVAL_TIMEOUT_MS);
  });
  jest.useRealTimers();
}

beforeEach(() => {
  hotkeyListener = null;
  running = [];
});

describe("VoiceKeyTest", () => {
  test("asks for a hold, and confirms the press that arrives", () => {
    render(<VoiceKeyTest keyLabel="Fn" />);

    fireEvent.click(screen.getByRole("button", { name: "Test the key" }));
    expect(screen.getByText("Hold Fn now.")).toBeTruthy();

    pressTheKey();
    expect(screen.getByText("Fn reached Vellum.")).toBeTruthy();
    expect(screen.queryByText("Hold Fn now.")).toBeNull();
  });

  test("names the claimants running when the press never arrives", async () => {
    running = ["Raycast", "Karabiner-Elements"];
    jest.useFakeTimers();
    render(<VoiceKeyTest keyLabel="Fn" />);

    fireEvent.click(screen.getByRole("button", { name: "Test the key" }));
    letTheWaitRunOut();

    expect(
      await screen.findByText(
        "Fn never reached Vellum. Raycast and Karabiner-Elements may be taking it first.",
      ),
    ).toBeTruthy();
  });

  test("points at the keyboard settings when no claimant is running", async () => {
    jest.useFakeTimers();
    render(<VoiceKeyTest keyLabel="Ctrl+Alt" />);

    fireEvent.click(screen.getByRole("button", { name: "Test the key" }));
    letTheWaitRunOut();

    expect(
      await screen.findByText(
        "Ctrl+Alt never reached Vellum. Check Modifier Keys under Keyboard in System Settings, and any keyboard tools you run.",
      ),
    ).toBeTruthy();
  });

  /** A press seen after the wait ran out is not the one that was asked for. */
  test("a late press does not turn a miss into a hit", async () => {
    jest.useFakeTimers();
    render(<VoiceKeyTest keyLabel="Fn" />);

    fireEvent.click(screen.getByRole("button", { name: "Test the key" }));
    letTheWaitRunOut();
    await screen.findByText(/never reached Vellum/);

    pressTheKey();
    expect(screen.queryByText("Fn reached Vellum.")).toBeNull();
  });
});
