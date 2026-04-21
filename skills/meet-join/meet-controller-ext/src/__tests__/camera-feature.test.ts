/**
 * Unit tests for `src/features/camera.ts` — jsdom-only.
 *
 * Exercises the aria-state no-op short-circuit, the click + poll success
 * path, the timeout failure path, and the `trusted_click` emit for the
 * xdotool bridge.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

import type { ExtensionToBotMessage } from "../../../contracts/native-messaging.js";

import { controlSelectors, isCameraOn } from "../dom/selectors.js";
import { disableCamera, enableCamera } from "../features/camera.js";

const FIXTURE_DIR = join(import.meta.dir, "..", "dom", "__tests__", "fixtures");
const INGAME_FIXTURE = readFileSync(
  join(FIXTURE_DIR, "meet-dom-ingame.html"),
  "utf8",
);

interface InstalledDom {
  dom: JSDOM;
  doc: Document;
  /** Number of times the camera toggle button was clicked. */
  clicks: () => number;
  /** Set the camera toggle's aria-label (mutates the button in place). */
  setCameraState: (on: boolean) => void;
  /** Remove the camera toggle from the DOM (for the "missing toggle" case). */
  removeCameraToggle: () => void;
  /**
   * Arrange the toggle so that clicking it is a no-op (simulates Meet's
   * isTrusted gate rejecting the synthetic `.click()`). The aria-label stays
   * in its initial state and never flips.
   */
  makeClickNoOp: () => void;
}

/**
 * Install a JSDOM document on `globalThis` so `camera.ts`'s bare `document`
 * references resolve to the fixture. Wires up a click handler that flips
 * the aria-label to mimic Meet's state transition on a real click.
 */
function installDom(): InstalledDom {
  const dom = new JSDOM(INGAME_FIXTURE, { runScripts: "outside-only" });
  const window = dom.window;
  const document = window.document;

  const camera = document.querySelector<HTMLButtonElement>(
    controlSelectors.CAMERA_TOGGLE,
  );
  if (!camera) throw new Error("fixture missing the camera toggle");

  let clickCount = 0;
  let flipOnClick = true;
  camera.addEventListener("click", () => {
    clickCount += 1;
    if (!flipOnClick) return;
    const label = camera.getAttribute("aria-label");
    if (label === "Turn off camera") {
      camera.setAttribute("aria-label", "Turn on camera");
    } else if (label === "Turn on camera") {
      camera.setAttribute("aria-label", "Turn off camera");
    }
  });

  const originals: Record<string, unknown> = {};
  const wire = (key: string, value: unknown): void => {
    originals[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = value;
  };
  wire("document", document);
  wire("window", window);
  wire("HTMLButtonElement", window.HTMLButtonElement);

  (dom as unknown as { __restore: () => void }).__restore = () => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) {
        delete (globalThis as Record<string, unknown>)[k];
      } else {
        (globalThis as Record<string, unknown>)[k] = v;
      }
    }
  };

  return {
    dom,
    doc: document,
    clicks: () => clickCount,
    setCameraState: (on) => {
      camera.setAttribute(
        "aria-label",
        on ? "Turn off camera" : "Turn on camera",
      );
    },
    removeCameraToggle: () => camera.remove(),
    makeClickNoOp: () => {
      flipOnClick = false;
    },
  };
}

describe("isCameraOn", () => {
  let installed: InstalledDom | null = null;
  beforeEach(() => {
    installed = installDom();
  });
  afterEach(() => {
    if (installed) {
      (installed.dom as unknown as { __restore: () => void }).__restore();
      installed = null;
    }
  });

  test("returns true when the aria-label indicates camera on", () => {
    installed!.setCameraState(true);
    expect(isCameraOn()).toBe(true);
  });

  test("returns false when the aria-label indicates camera off", () => {
    installed!.setCameraState(false);
    expect(isCameraOn()).toBe(false);
  });

  test("returns null when the toggle is missing", () => {
    installed!.removeCameraToggle();
    expect(isCameraOn()).toBe(null);
  });
});

describe("enableCamera", () => {
  let installed: InstalledDom | null = null;

  beforeEach(() => {
    installed = installDom();
  });

  afterEach(() => {
    if (installed) {
      (installed.dom as unknown as { __restore: () => void }).__restore();
      installed = null;
    }
  });

  test("is a no-op when the camera is already on", async () => {
    installed!.setCameraState(true);
    expect(installed!.clicks()).toBe(0);

    const events: ExtensionToBotMessage[] = [];
    const result = await enableCamera({ onEvent: (ev) => events.push(ev) });

    expect(result).toEqual({ changed: false });
    expect(installed!.clicks()).toBe(0);
    // No trusted_click should be emitted on the no-op path.
    expect(events.filter((e) => e.type === "trusted_click")).toHaveLength(0);
  });

  test("clicks the toggle when the camera is off and confirms the state", async () => {
    installed!.setCameraState(false);

    const result = await enableCamera({ timeoutMs: 1_000 });

    expect(result).toEqual({ changed: true });
    expect(installed!.clicks()).toBe(1);
    expect(isCameraOn()).toBe(true);
  });

  test("emits a trusted_click with computed screen coords and skips the JS click fallback when onEvent is wired", async () => {
    installed!.setCameraState(false);

    // Stub the toggle's getBoundingClientRect so the coordinate math is
    // deterministic. Math mirrors `features/chat.ts`'s send-button block:
    //   x = screenX + rect.left + rect.width/2
    //   y = screenY + (outerHeight - innerHeight) + rect.top + rect.height/2
    const toggle = installed!.doc.querySelector<HTMLButtonElement>(
      controlSelectors.CAMERA_TOGGLE,
    )!;
    toggle.getBoundingClientRect = () =>
      ({
        left: 800,
        top: 680,
        width: 60,
        height: 40,
        right: 860,
        bottom: 720,
        x: 800,
        y: 680,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    const events: ExtensionToBotMessage[] = [];
    // Because the camera toggle inverts state on every accepted click, the
    // production path fires trusted_click ONLY (no JS `.click()` fallback).
    // Simulate xdotool landing the X-server click by flipping aria-label
    // from the onEvent sink — same state transition Meet would publish on a
    // real trusted click.
    const clicksBeforeEmit = installed!.clicks();

    const result = await enableCamera({
      onEvent: (ev) => {
        events.push(ev);
        if (ev.type === "trusted_click") installed!.setCameraState(true);
      },
      // chrome = outerHeight - innerHeight = 100; screen origin = (0, 0).
      // Expected: x = 800 + 30 = 830, y = 100 + 680 + 20 = 800.
      window: {
        screenX: 0,
        screenY: 0,
        outerHeight: 820,
        innerHeight: 720,
      },
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ changed: true });

    const trustedClicks = events.filter(
      (e) => e.type === "trusted_click",
    ) as Array<Extract<ExtensionToBotMessage, { type: "trusted_click" }>>;
    expect(trustedClicks).toHaveLength(1);
    expect(trustedClicks[0]!.x).toBe(830);
    expect(trustedClicks[0]!.y).toBe(800);

    // No JS `.click()` was dispatched — trusted_click is the only path in
    // production, and a second click would invert the toggle back off.
    expect(installed!.clicks()).toBe(clicksBeforeEmit);
  });

  test("throws a descriptive error when the toggle is missing", async () => {
    installed!.removeCameraToggle();
    await expect(enableCamera({ timeoutMs: 100 })).rejects.toThrow(
      /toggle button not found/,
    );
  });

  test("throws after the timeout when the click is swallowed (isTrusted gate simulation)", async () => {
    installed!.setCameraState(false);
    installed!.makeClickNoOp();

    // A short timeout + short poll interval keeps the test quick.
    const err = await enableCamera({
      timeoutMs: 200,
      pollIntervalMs: 20,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not transition to on/);
    // The click was still dispatched — the gate just rejected it.
    expect(installed!.clicks()).toBe(1);
    // Camera stayed off.
    expect(isCameraOn()).toBe(false);
  });
});

describe("disableCamera", () => {
  let installed: InstalledDom | null = null;

  beforeEach(() => {
    installed = installDom();
  });

  afterEach(() => {
    if (installed) {
      (installed.dom as unknown as { __restore: () => void }).__restore();
      installed = null;
    }
  });

  test("is a no-op when the camera is already off", async () => {
    installed!.setCameraState(false);
    expect(installed!.clicks()).toBe(0);

    const result = await disableCamera({ timeoutMs: 1_000 });

    expect(result).toEqual({ changed: false });
    expect(installed!.clicks()).toBe(0);
  });

  test("clicks the toggle when the camera is on and confirms the state", async () => {
    installed!.setCameraState(true);

    const result = await disableCamera({ timeoutMs: 1_000 });

    expect(result).toEqual({ changed: true });
    expect(installed!.clicks()).toBe(1);
    expect(isCameraOn()).toBe(false);
  });

  test("throws after the timeout when the click is swallowed", async () => {
    installed!.setCameraState(true);
    installed!.makeClickNoOp();

    const err = await disableCamera({
      timeoutMs: 200,
      pollIntervalMs: 20,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not transition to off/);
    expect(installed!.clicks()).toBe(1);
    expect(isCameraOn()).toBe(true);
  });
});
