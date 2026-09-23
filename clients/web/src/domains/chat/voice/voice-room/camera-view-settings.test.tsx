/**
 * Tests for `CameraViewSettings`.
 *
 * What the panel offers, who it offers it to, and where it lands in the DOM.
 * The availability rule itself belongs to `lib/camera/frame-gate-debug-access`
 * and is stubbed here, so what is under test is the component's own wiring:
 * which rows a session sees, which store each row writes, and the panel
 * rendering into the host it is handed. Which element that host is, and where
 * the room puts it, is the room's own subject in `voice-room.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

/** Stands in for the element the room owns and hands down. */
let panelHost: HTMLDivElement | null = null;

/** Stands in for the room's own way of raising the explainer; unset is a room that offers none. */
let showExplainer: (() => void) | undefined;

/** Render the control with a host to put its panel in. */
function renderSettings(): void {
  render(
    <CameraViewSettings
      panelHost={panelHost}
      onShowExplainer={showExplainer}
    />,
  );
}

/** Open the panel the way a user does. */
async function openPanel(): Promise<void> {
  renderSettings();
  await act(async () => {
    fireEvent.click(trigger());
  });
}

beforeEach(() => {
  hudAvailable = false;
  showExplainer = undefined;
  panelHost = document.createElement("div");
  document.body.appendChild(panelHost);
  useCameraGateDebugStore.setState({ hudEnabled: false });
  useVoicePrefsStore.setState({ showKeptFrame: true });
});

afterEach(() => {
  cleanup();
  panelHost?.remove();
  panelHost = null;
});

describe("CameraViewSettings", () => {
  test("shows the button, and nothing else until it is pressed", async () => {
    renderSettings();

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
    renderSettings();
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      fireEvent.click(trigger());
    });

    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  test("the panel is announced by its own heading", async () => {
    await openPanel();

    // Radix presents the content as a dialog, and an unnamed dialog is
    // announced as nothing at all.
    const labelledBy = panel()?.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy ?? "")?.textContent).toBe("Show");
  });

  test("the panel renders into the host it is handed, not beside the trigger", async () => {
    await openPanel();

    // The host is the room's, and being the room's is what keeps the panel
    // clear of both the sheet's inert sweep and the corner cluster's own
    // stacking context. Rendering beside the trigger would put it back in the
    // second of those.
    expect(panelHost?.contains(panel())).toBe(true);
    expect(trigger().parentElement?.contains(panel())).toBe(false);
  });

  /**
   * Dismissal by tap, which the popover's own outside-press handling does not
   * deliver here: it waits for a document-level `click`, and WebKit does not
   * synthesize one for a tap on the bare viewfinder this panel opens over.
   */
  describe("the backdrop", () => {
    const backdrop = () =>
      screen.queryByTestId("camera-view-settings-backdrop");

    test("is absent until the panel is open, so it swallows nothing", () => {
      renderSettings();

      expect(backdrop()).toBeNull();
    });

    test("closes the panel on a tap, and goes with it", async () => {
      await openPanel();
      expect(backdrop()).not.toBeNull();

      await act(async () => {
        fireEvent.click(backdrop()!);
      });

      expect(panel()).toBeNull();
      // Gone as well as closed: the room underneath answers presses again,
      // and the shutter is the press this must not go on intercepting.
      expect(backdrop()).toBeNull();
    });

    test("carries its own click handler rather than leaving it to the document", async () => {
      await openPanel();

      // The whole point on iOS: a document-level listener never hears a tap on
      // a noninteractive element, so the dismissal has to ride a handler the
      // element carries itself.
      expect(backdrop()?.onclick).toBeTruthy();
    });

    test("sits under the panel, so a press inside the panel is the panel's", async () => {
      await openPanel();
      const inside = row("Latest shared frame")!;

      await act(async () => {
        fireEvent.click(inside);
      });

      // The switch answered, and the panel is still up: the backdrop covers
      // the room, not the surface it belongs to.
      expect(panel()).not.toBeNull();
      expect(useVoicePrefsStore.getState().showKeptFrame).toBe(false);
    });
  });

  test("a session without the readout gets the thumbnail row alone", async () => {
    await openPanel();

    expect(row("Latest shared frame")).not.toBeNull();
    expect(row("Frame gate tuning")).toBeNull();
  });

  test("a session with the readout gets both rows", async () => {
    hudAvailable = true;
    await openPanel();

    expect(row("Frame gate tuning")).not.toBeNull();
    expect(row("Latest shared frame")).not.toBeNull();
  });

  test("each switch points at its own description", async () => {
    hudAvailable = true;
    await openPanel();

    /** The text a screen reader is given after the switch's name. */
    const describedText = (name: string): string | undefined => {
      const id = row(name)?.getAttribute("aria-describedby");
      return id ? (document.getElementById(id)?.textContent ?? "") : undefined;
    };

    // The helper line is the only thing that says what a row shows, so a
    // switch that did not point at its own would be announced as a bare name
    // with the explanation on screen and out of reach.
    expect(describedText("Latest shared frame")).toBe(
      "Shows the most recent frame Live sent.",
    );
    expect(describedText("Frame gate tuning")).toBe(
      "Debug overlay for how Live picks which frames to send.",
    );
  });

  test("the thumbnail row writes the voice preference", async () => {
    await openPanel();
    expect(row("Latest shared frame")?.getAttribute("aria-checked")).toBe(
      "true",
    );

    await act(async () => {
      fireEvent.click(row("Latest shared frame")!);
    });

    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(false);
    expect(row("Latest shared frame")?.getAttribute("aria-checked")).toBe(
      "false",
    );

    // The direction a fresh profile takes, since the preference ships off:
    // this row is the only place a call turns the thumbnail on.
    await act(async () => {
      fireEvent.click(row("Latest shared frame")!);
    });

    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(true);
    expect(row("Latest shared frame")?.getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  /**
   * The one row that opens something rather than switching something. What it
   * opens is the room's, so all this row owes is the ask and the panel's own
   * exit.
   */
  describe("the explainer row", () => {
    const howItWorks = () =>
      screen.queryByRole("button", { name: "How Photo and Live work" });

    test("is absent where the room has no explainer to raise", async () => {
      await openPanel();

      expect(howItWorks()).toBeNull();
    });

    test("asks for the explainer, and closes so nothing is left under it", async () => {
      const show = mock(() => {});
      showExplainer = show;
      await openPanel();

      // Found by the words on it: a button rather than a third switch, and
      // named by its own text rather than by a label something else carries.
      expect(howItWorks()).not.toBeNull();

      await act(async () => {
        fireEvent.click(howItWorks()!);
      });

      // Deferred to the panel's own close, so that the trigger has focus again
      // by the time the explainer records what to give it back to.
      await waitFor(() => {
        expect(show).toHaveBeenCalledTimes(1);
      });
      // The explainer covers the room, and a panel left open beneath it is a
      // surface nothing can reach.
      expect(panel()).toBeNull();
    });
  });

  test("the readout row writes the persisted switch", async () => {
    hudAvailable = true;
    await openPanel();

    await act(async () => {
      fireEvent.click(row("Frame gate tuning")!);
    });

    expect(useCameraGateDebugStore.getState().hudEnabled).toBe(true);
    // The thumbnail is a different preference, and one row must not move the
    // other.
    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(true);
  });
});
