/**
 * Tests for `CameraViewSettings`.
 *
 * What the panel offers, who it offers it to, and where it lands in the DOM.
 * The availability rule itself belongs to `lib/camera/frame-gate-debug-access`
 * and is stubbed here, so what is under test is the component's own wiring:
 * which rows a session sees, which store each row writes, and the panel
 * portaling inside the component's box rather than beside the room, which is
 * what keeps it clear of the sheet's inert sweep.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

let hudAvailable = false;
mock.module("@/hooks/use-camera-gate-hud", () => ({
  useCameraGateHudAvailable: () => hudAvailable,
  useCameraGateHudEnabled: () => false,
}));

const { CameraViewSettings } = await import("./camera-view-settings");
const { useCameraGateDebugStore } =
  await import("@/stores/camera-gate-debug-store");
const { useVoicePrefsStore } = await import("@/stores/voice-prefs-store");

const trigger = () => screen.getByTestId("camera-view-settings");
const panel = () => screen.queryByTestId("camera-view-settings-panel");
const row = (name: string) => screen.queryByRole("switch", { name });

/** Open the panel the way a user does. */
async function openPanel(): Promise<void> {
  render(<CameraViewSettings />);
  await act(async () => {
    fireEvent.click(trigger());
  });
}

beforeEach(() => {
  hudAvailable = false;
  useCameraGateDebugStore.setState({ hudEnabled: false });
  useVoicePrefsStore.setState({ showKeptFrame: true });
});

afterEach(() => {
  cleanup();
});

describe("CameraViewSettings", () => {
  test("shows the button, and nothing else until it is pressed", async () => {
    render(<CameraViewSettings />);

    expect(trigger().getAttribute("aria-label")).toBe("Camera view options");
    expect(panel()).toBeNull();

    await act(async () => {
      fireEvent.click(trigger());
    });

    expect(panel()).not.toBeNull();
    expect(trigger().getAttribute("aria-pressed")).toBe("true");
  });

  test("the room's control carries the popover's own state", async () => {
    // `VoiceRoomControl` is the room's element rather than the design
    // library's, so a trigger composed onto it only works because it passes
    // what it is handed through to the button underneath.
    render(<CameraViewSettings />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      fireEvent.click(trigger());
    });

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  test("the panel lands inside the button's own box, not beside the room", async () => {
    await openPanel();

    // The room portals its sheet into `#viewport-overlays` and inerts that
    // host's other children while the camera is flush, so a panel portaled
    // there arrives dead. This one is a descendant of the control it opens
    // from, which that sweep never reaches.
    expect(trigger().parentElement?.contains(panel())).toBe(true);
  });

  test("a session without the readout gets the thumbnail row alone", async () => {
    await openPanel();

    expect(row("Kept frame")).not.toBeNull();
    expect(row("Frame gate readout")).toBeNull();
  });

  test("a session with the readout gets both rows", async () => {
    hudAvailable = true;
    await openPanel();

    expect(row("Frame gate readout")).not.toBeNull();
    expect(row("Kept frame")).not.toBeNull();
  });

  test("the thumbnail row writes the voice preference", async () => {
    await openPanel();
    expect(row("Kept frame")?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      fireEvent.click(row("Kept frame")!);
    });

    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(false);
    expect(row("Kept frame")?.getAttribute("aria-checked")).toBe("false");
  });

  test("the readout row writes the switch the Settings page shares", async () => {
    hudAvailable = true;
    await openPanel();

    await act(async () => {
      fireEvent.click(row("Frame gate readout")!);
    });

    expect(useCameraGateDebugStore.getState().hudEnabled).toBe(true);
    // The thumbnail is a different preference, and one row must not move the
    // other.
    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(true);
  });
});
