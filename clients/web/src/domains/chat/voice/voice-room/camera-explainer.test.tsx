/**
 * Tests for `CameraExplainer`.
 *
 * The component is presentational, so what is under test is its own contract:
 * which presentation a surface gets, where it renders, what it says, and which
 * name it reports for each way out. When it appears and what the caller does
 * with the dismissal belong to the room, and are that file's subject.
 *
 * The presentation is forced by stubbing the touch-surface media query, which
 * is the only seam the design library offers: it reads `window.matchMedia`
 * directly rather than through a provider.
 *
 * Copy is pinned by literal string rather than by importing a catalog key, so a
 * silent edit to the words a user reads fails here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { TOUCH_SURFACE_MEDIA_QUERY } from "@vellumai/design-library";

import { pressBackdrop } from "@/lib/overlay-test-helpers";

import {
  CameraExplainer,
  type CameraExplainerDismissal,
} from "./camera-explainer";

const ASSISTANT_NAME = "Luna";

/**
 * Stands in for the element the room owns and hands down: the full-size,
 * press-through box the explainer lays itself out against.
 */
let host: HTMLDivElement | null = null;
let dismissals: CameraExplainerDismissal[] = [];

const originalMatchMedia = window.matchMedia.bind(window);

/**
 * Answer the touch-surface query with `touch`, leaving every other query to
 * the real implementation.
 */
function stubSurface(touch: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: ((query: string) => {
      const result = originalMatchMedia(query);
      if (query !== TOUCH_SURFACE_MEDIA_QUERY) {
        return result;
      }
      return {
        ...result,
        media: query,
        matches: touch,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as MediaQueryList;
    }) as typeof window.matchMedia,
  });
}

interface RenderOptions {
  touch?: boolean;
  tryLiveOffered?: boolean;
  withHost?: boolean;
  /** A React ancestor whose own press handler the sheet must not reach. */
  onAncestorPointerDown?: () => void;
}

function renderExplainer({
  touch = true,
  tryLiveOffered = true,
  withHost = true,
  onAncestorPointerDown,
}: RenderOptions = {}): void {
  stubSurface(touch);
  render(
    <div onPointerDown={onAncestorPointerDown}>
      <button type="button" data-testid="sibling">
        {"sibling"}
      </button>
      <CameraExplainer
        open
        host={withHost ? host : null}
        assistantName={ASSISTANT_NAME}
        tryLiveOffered={tryLiveOffered}
        onDismiss={(how) => dismissals.push(how)}
      />
    </div>,
  );
}

const dialog = () => document.querySelector('[data-testid="camera-explainer"]');
const sheetOverlay = () =>
  document.querySelector('[data-slot="bottom-sheet-overlay"]');
const modalOverlay = () =>
  document.querySelector('[data-slot="modal-overlay"]');
const text = () => dialog()?.textContent ?? "";

async function press(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

beforeEach(() => {
  dismissals = [];
  host = document.createElement("div");
  host.className = "pointer-events-none absolute inset-0";
  document.body.appendChild(host);
});

afterEach(() => {
  cleanup();
  host?.remove();
  host = null;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe("CameraExplainer", () => {
  test("renders nothing at all while the host is null", () => {
    renderExplainer({ withHost: false });

    expect(dialog()).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("renders inside the host it is handed", () => {
    renderExplainer();

    expect(host?.contains(dialog()!)).toBe(true);
  });

  describe("the scrim is laid out against the host, not the window", () => {
    // The primitives position themselves `fixed`, which would dim the whole
    // window from inside a room that only owns a pane of it.
    test("on the sheet", () => {
      renderExplainer({ touch: true });

      expect(sheetOverlay()?.className).toContain("absolute");
      expect(sheetOverlay()?.className).not.toContain("fixed");
      // The sheet rides the host's bottom edge rather than the window's.
      expect(dialog()?.className).toContain("absolute");
      expect(dialog()?.className).not.toContain("fixed");
    });

    test("on the modal", () => {
      renderExplainer({ touch: false });

      expect(modalOverlay()?.className).toContain("absolute");
      expect(modalOverlay()?.className).not.toContain("fixed");
      // The dialog is centred by the overlay and stays `relative` inside it,
      // so the overlay is the only element whose position changes.
      expect(dialog()?.className).toContain("relative");
    });
  });

  test("a touch surface gets the sheet, with its grabber", () => {
    renderExplainer({ touch: true });

    expect(dialog()?.getAttribute("data-slot")).toBe("bottom-sheet-content");
    expect(
      document.querySelector('[data-slot="bottom-sheet-grabber"]'),
    ).not.toBeNull();
    // The modal's close glyph belongs to the other presentation; a sheet that
    // grew one would put a second way out beside the grabber.
    expect(screen.queryByLabelText("Close")).toBeNull();
  });

  test("a pointer surface gets the modal, with the library's own close", () => {
    renderExplainer({ touch: false });

    expect(dialog()?.getAttribute("data-slot")).toBe("modal-content");
    expect(screen.queryByLabelText("Close")).not.toBeNull();
    expect(
      document.querySelector('[data-slot="bottom-sheet-grabber"]'),
    ).toBeNull();
  });

  test("the sheet says what each mode does, in the assistant's name", () => {
    renderExplainer({ touch: true });

    expect(text()).toContain("Photo or Live?");
    expect(text()).toContain(
      "Pick how Luna sees what you're pointing at. You can switch any time.",
    );
    expect(text()).toContain(
      "Take a picture. Luna sees just that one picture.",
    );
    expect(text()).toContain(
      "Luna watches as you move the camera. Just talk about what Luna sees.",
    );
    expect(text()).toContain(
      "Everything Luna sees stays in Luna's own private workspace. Live ends when you close the camera.",
    );
    expect(screen.queryByRole("button", { name: "Got it" })).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Try Live now" }),
    ).not.toBeNull();
  });

  test("the modal carries the longer Live line and the shorter button", () => {
    renderExplainer({ touch: false });

    // The desktop card has room for the sentence the sheet drops, and the
    // button beside the primary is shorter than the phone's full-width one.
    expect(text()).toContain(
      "Luna watches as you move the camera. Just talk about what Luna sees. Stop whenever you like.",
    );
    expect(screen.queryByRole("button", { name: "Try Live" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Try Live now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Got it" })).not.toBeNull();
  });

  test("the cards are drawings, not controls", () => {
    renderExplainer({ touch: true });

    // Two buttons and nothing else: the modes are explained here, not picked.
    const names = screen
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(["Got it", "Try Live now"]);
  });

  test("no secondary action where Live is not offered", () => {
    renderExplainer({ touch: true, tryLiveOffered: false });

    expect(screen.queryByRole("button", { name: "Try Live now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Got it" })).not.toBeNull();
  });

  test("focus lands on the title rather than the first button", () => {
    renderExplainer({ touch: true });

    const title = document.querySelector('[data-slot="bottom-sheet-title"]');
    expect(document.activeElement).toBe(title);
  });

  describe("each way out names itself", () => {
    test("the primary reports gotIt", async () => {
      renderExplainer({ touch: true });

      await press(screen.getByRole("button", { name: "Got it" }));

      expect(dismissals).toEqual(["gotIt"]);
    });

    test("the secondary reports tryLive", async () => {
      renderExplainer({ touch: true });

      await press(screen.getByRole("button", { name: "Try Live now" }));

      expect(dismissals).toEqual(["tryLive"]);
    });

    test("a backdrop press on the sheet reports scrim", async () => {
      renderExplainer({ touch: true });

      await act(async () => {
        pressBackdrop(sheetOverlay()!);
      });

      expect(dismissals).toEqual(["scrim"]);
    });

    test("a backdrop press on the modal reports scrim, not close", async () => {
      renderExplainer({ touch: false });

      await act(async () => {
        pressBackdrop(modalOverlay()!);
      });

      expect(dismissals).toEqual(["scrim"]);
    });

    test("the modal's close glyph reports close", async () => {
      renderExplainer({ touch: false });

      await press(screen.getByLabelText("Close"));

      expect(dismissals).toEqual(["close"]);
    });

    test("Escape reports escape, once", async () => {
      renderExplainer({ touch: true });

      await act(async () => {
        fireEvent.keyDown(dialog()!, { key: "Escape" });
      });

      // Escape can reach the dialog through up to three listeners; the caller
      // hears about it once.
      expect(dismissals).toEqual(["escape"]);
    });

    test("Escape reports escape on the modal too", async () => {
      renderExplainer({ touch: false });

      await act(async () => {
        fireEvent.keyDown(dialog()!, { key: "Escape" });
      });

      expect(dismissals).toEqual(["escape"]);
    });
  });

  test("a press inside the sheet never reaches the room's drag handler", async () => {
    let ancestorPresses = 0;
    renderExplainer({
      touch: true,
      onAncestorPointerDown: () => {
        ancestorPresses += 1;
      },
    });

    await act(async () => {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Got it" }));
    });
    expect(ancestorPresses).toBe(0);

    // The same ancestor hears a press that did not start inside the sheet, so
    // the count above is the carve-out rather than a handler that never ran.
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("sibling"));
    });
    expect(ancestorPresses).toBe(1);
  });
});
