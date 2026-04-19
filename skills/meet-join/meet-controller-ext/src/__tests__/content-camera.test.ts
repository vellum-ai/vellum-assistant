/**
 * Unit tests for the content-script `handleCameraToggle` handler.
 *
 * `handleCameraToggle` is the path the bot takes when it needs to flip
 * the Meet camera on/off (e.g. in response to an HTTP `/avatar/enable`
 * or `/avatar/disable` route). We need to confirm it threads an
 * `onEvent` sink + `window` reference through to the camera feature
 * module and emits a correlated `camera_result` reply back through
 * `chrome.runtime.sendMessage`.
 *
 * Mirrors the harness pattern in `content-send-chat.test.ts` — `content.ts`
 * runs side effects at import time, so we install a fake `chrome` + JSDOM
 * before the dynamic import.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { JSDOM } from "jsdom";

import type { ExtensionToBotMessage } from "../../../contracts/native-messaging.js";

import { controlSelectors } from "../dom/selectors.js";

const FIXTURE_DIR = pathJoin(
  import.meta.dir,
  "..",
  "dom",
  "__tests__",
  "fixtures",
);
const INGAME_FIXTURE = readFileSync(
  pathJoin(FIXTURE_DIR, "meet-dom-ingame.html"),
  "utf8",
);

interface FakeChrome {
  runtime: {
    sendMessage: (msg: unknown) => void;
    onMessage: {
      addListener: (
        cb: (
          raw: unknown,
          sender: unknown,
          sendResponse: (response?: unknown) => void,
        ) => boolean,
      ) => void;
    };
  };
  sent: unknown[];
}

interface InstalledHarness {
  dom: JSDOM;
  chrome: FakeChrome;
  /** Set the camera toggle's aria-label. */
  setCameraState: (on: boolean) => void;
  /** Make the toggle's `.click()` a no-op (simulate isTrusted rejection). */
  makeClickNoOp: () => void;
  restore: () => void;
}

function installHarness(): InstalledHarness {
  const dom = new JSDOM(INGAME_FIXTURE, {
    runScripts: "outside-only",
    url: "https://meet.google.com/abc-defg-hij",
  });
  const window = dom.window;
  const document = window.document;

  const camera = document.querySelector<HTMLButtonElement>(
    controlSelectors.CAMERA_TOGGLE,
  );
  if (!camera) throw new Error("fixture missing camera toggle");

  let flipOnClick = true;
  camera.addEventListener("click", () => {
    if (!flipOnClick) return;
    const label = camera.getAttribute("aria-label");
    if (label === "Turn off camera") {
      camera.setAttribute("aria-label", "Turn on camera");
    } else if (label === "Turn on camera") {
      camera.setAttribute("aria-label", "Turn off camera");
    }
  });

  const sent: unknown[] = [];
  const chrome: FakeChrome = {
    sent,
    runtime: {
      sendMessage: (msg) => {
        sent.push(msg);
      },
      onMessage: {
        addListener: () => {},
      },
    },
  };

  const originals: Record<string, unknown> = {};
  const wire = (key: string, value: unknown): void => {
    originals[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = value;
  };
  wire("document", document);
  wire("window", window);
  wire("location", window.location);
  wire("HTMLButtonElement", window.HTMLButtonElement);
  wire("chrome", chrome);
  wire("screenX", 0);
  wire("screenY", 0);
  wire("outerHeight", 820);
  wire("innerHeight", 720);

  return {
    dom,
    chrome,
    setCameraState: (on) => {
      camera.setAttribute(
        "aria-label",
        on ? "Turn off camera" : "Turn on camera",
      );
    },
    makeClickNoOp: () => {
      flipOnClick = false;
    },
    restore: () => {
      for (const [k, v] of Object.entries(originals)) {
        if (v === undefined) {
          delete (globalThis as Record<string, unknown>)[k];
        } else {
          (globalThis as Record<string, unknown>)[k] = v;
        }
      }
    },
  };
}

describe("handleCameraToggle", () => {
  let harness: InstalledHarness | null = null;
  let handleCameraToggle:
    | ((cmd: {
        type: "camera.enable" | "camera.disable";
        requestId: string;
      }) => Promise<void>)
    | null = null;

  beforeEach(async () => {
    harness = installHarness();
    const mod = (await import("../content.js")) as {
      __handleCameraToggle: typeof handleCameraToggle;
    };
    handleCameraToggle = mod.__handleCameraToggle;
  });

  afterEach(() => {
    if (harness) {
      harness.restore();
      harness = null;
    }
    handleCameraToggle = null;
  });

  test("camera.enable on an already-on camera emits camera_result(ok=true, changed=false) with no trusted_click", async () => {
    harness!.setCameraState(true);

    await handleCameraToggle!({ type: "camera.enable", requestId: "req-1" });

    const sent = harness!.chrome.sent as ExtensionToBotMessage[];
    const results = sent.filter((e) => e.type === "camera_result");
    expect(results).toHaveLength(1);
    const result = results[0]!;
    if (result.type === "camera_result") {
      expect(result.requestId).toBe("req-1");
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(false);
    }
    // No trusted_click because the no-op short-circuit fires before the
    // click + emit block.
    expect(sent.filter((e) => e.type === "trusted_click")).toHaveLength(0);
  });

  test("camera.enable on an off camera clicks + emits trusted_click + camera_result(ok=true, changed=true)", async () => {
    harness!.setCameraState(false);

    await handleCameraToggle!({ type: "camera.enable", requestId: "req-2" });

    const sent = harness!.chrome.sent as ExtensionToBotMessage[];
    const trustedClicks = sent.filter((e) => e.type === "trusted_click");
    expect(trustedClicks).toHaveLength(1);

    const results = sent.filter((e) => e.type === "camera_result");
    expect(results).toHaveLength(1);
    const result = results[0]!;
    if (result.type === "camera_result") {
      expect(result.requestId).toBe("req-2");
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(true);
    }
  });

  test("camera.disable on an on camera clicks + emits trusted_click + camera_result(ok=true, changed=true)", async () => {
    harness!.setCameraState(true);

    await handleCameraToggle!({
      type: "camera.disable",
      requestId: "req-3",
    });

    const sent = harness!.chrome.sent as ExtensionToBotMessage[];
    const trustedClicks = sent.filter((e) => e.type === "trusted_click");
    expect(trustedClicks).toHaveLength(1);

    const results = sent.filter((e) => e.type === "camera_result");
    expect(results).toHaveLength(1);
    const result = results[0]!;
    if (result.type === "camera_result") {
      expect(result.requestId).toBe("req-3");
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(true);
    }
  });

  test("camera.disable on an already-off camera emits camera_result(ok=true, changed=false)", async () => {
    harness!.setCameraState(false);

    await handleCameraToggle!({
      type: "camera.disable",
      requestId: "req-4",
    });

    const sent = harness!.chrome.sent as ExtensionToBotMessage[];
    const results = sent.filter((e) => e.type === "camera_result");
    expect(results).toHaveLength(1);
    const result = results[0]!;
    if (result.type === "camera_result") {
      expect(result.requestId).toBe("req-4");
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(false);
    }
  });
});
