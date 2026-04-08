import { describe, expect, test } from "bun:test";

import {
  captureScreenshotJpeg,
  dispatchClickAt,
  dispatchHoverAt,
  dispatchInsertText,
  dispatchKeyPress,
  dispatchWheelScroll,
  evaluateExpression,
  focusElement,
  getCenterPoint,
  getCurrentUrl,
  getPageTitle,
  navigateAndWait,
  querySelectorBackendNodeId,
  scrollIntoViewIfNeeded,
  waitForSelector,
  waitForText,
} from "../cdp-dom-helpers.js";
import { CdpError } from "../errors.js";
import type { CdpClient } from "../types.js";

// ── Test utilities ────────────────────────────────────────────────────

type CdpCall = { method: string; params?: Record<string, unknown> };

/**
 * Minimal in-memory fake CdpClient. The programmable `handler` is
 * called for every `send` and must return the raw CDP result object
 * (or throw). Every call is recorded on `calls` so tests can assert
 * method order and param shape.
 */
function fakeCdp(
  handler: (method: string, params?: Record<string, unknown>) => unknown,
): CdpClient & { calls: CdpCall[] } {
  const calls: CdpCall[] = [];
  return {
    calls,
    async send<T>(
      method: string,
      params?: Record<string, unknown>,
    ): Promise<T> {
      calls.push({ method, params });
      const value = handler(method, params);
      return (await value) as T;
    },
    dispose() {},
  };
}

// ── querySelectorBackendNodeId ────────────────────────────────────────

describe("querySelectorBackendNodeId", () => {
  test("returns backendNodeId on happy path", async () => {
    const cdp = fakeCdp((method) => {
      switch (method) {
        case "DOM.getDocument":
          return { root: { nodeId: 1 } };
        case "DOM.querySelector":
          return { nodeId: 42 };
        case "DOM.describeNode":
          return { node: { backendNodeId: 777 } };
        default:
          throw new Error(`unexpected method: ${method}`);
      }
    });

    const backendNodeId = await querySelectorBackendNodeId(cdp, "#submit");

    expect(backendNodeId).toBe(777);
    expect(cdp.calls.map((c) => c.method)).toEqual([
      "DOM.getDocument",
      "DOM.querySelector",
      "DOM.describeNode",
    ]);
    expect(cdp.calls[1]!.params).toEqual({ nodeId: 1, selector: "#submit" });
    expect(cdp.calls[2]!.params).toEqual({ nodeId: 42, depth: 0 });
  });

  test("throws CdpError with code 'cdp_error' when nodeId is 0", async () => {
    const cdp = fakeCdp((method) => {
      switch (method) {
        case "DOM.getDocument":
          return { root: { nodeId: 1 } };
        case "DOM.querySelector":
          return { nodeId: 0 };
        default:
          throw new Error(`unexpected method: ${method}`);
      }
    });

    await expect(
      querySelectorBackendNodeId(cdp, "#missing"),
    ).rejects.toMatchObject({
      name: "CdpError",
      code: "cdp_error",
      cdpMethod: "DOM.querySelector",
      cdpParams: { selector: "#missing" },
    });
  });
});

// ── scrollIntoViewIfNeeded ────────────────────────────────────────────

describe("scrollIntoViewIfNeeded", () => {
  test("sends DOM.scrollIntoViewIfNeeded with backendNodeId", async () => {
    const cdp = fakeCdp(() => ({}));
    await scrollIntoViewIfNeeded(cdp, 99);
    expect(cdp.calls).toEqual([
      { method: "DOM.scrollIntoViewIfNeeded", params: { backendNodeId: 99 } },
    ]);
  });

  test("propagates transport errors from the client", async () => {
    const cdp = fakeCdp(() => {
      throw new CdpError("transport_error", "socket closed");
    });
    await expect(scrollIntoViewIfNeeded(cdp, 99)).rejects.toMatchObject({
      name: "CdpError",
      code: "transport_error",
    });
  });
});

// ── getCenterPoint ────────────────────────────────────────────────────

describe("getCenterPoint", () => {
  test("returns midpoint of the content quad", async () => {
    // Content quad: (10,20) (30,20) (30,40) (10,40)
    // Midpoint: ((10+30)/2, (20+40)/2) = (20, 30)
    const cdp = fakeCdp(() => ({
      model: { content: [10, 20, 30, 20, 30, 40, 10, 40] },
    }));

    const point = await getCenterPoint(cdp, 55);

    expect(point).toEqual({ x: 20, y: 30 });
    expect(cdp.calls[0]).toEqual({
      method: "DOM.getBoxModel",
      params: { backendNodeId: 55 },
    });
  });

  test("throws CdpError when DOM.getBoxModel rejects", async () => {
    const cdp = fakeCdp(() => {
      throw new CdpError("cdp_error", "Could not compute box model.");
    });
    await expect(getCenterPoint(cdp, 55)).rejects.toMatchObject({
      name: "CdpError",
      code: "cdp_error",
    });
  });
});

// ── focusElement ──────────────────────────────────────────────────────

describe("focusElement", () => {
  test("sends DOM.focus with backendNodeId", async () => {
    const cdp = fakeCdp(() => ({}));
    await focusElement(cdp, 123);
    expect(cdp.calls).toEqual([
      { method: "DOM.focus", params: { backendNodeId: 123 } },
    ]);
  });

  test("propagates errors from the client", async () => {
    const cdp = fakeCdp(() => {
      throw new CdpError("cdp_error", "Element is not focusable");
    });
    await expect(focusElement(cdp, 123)).rejects.toMatchObject({
      name: "CdpError",
      code: "cdp_error",
    });
  });
});

// ── dispatchClickAt ───────────────────────────────────────────────────

describe("dispatchClickAt", () => {
  test("emits exactly three Input.dispatchMouseEvent calls in order", async () => {
    const cdp = fakeCdp(() => ({}));

    await dispatchClickAt(cdp, { x: 100, y: 200 });

    expect(cdp.calls).toHaveLength(3);
    expect(cdp.calls[0]).toEqual({
      method: "Input.dispatchMouseEvent",
      params: {
        x: 100,
        y: 200,
        button: "left",
        clickCount: 1,
        type: "mouseMoved",
      },
    });
    expect(cdp.calls[1]).toEqual({
      method: "Input.dispatchMouseEvent",
      params: {
        x: 100,
        y: 200,
        button: "left",
        clickCount: 1,
        type: "mousePressed",
      },
    });
    expect(cdp.calls[2]).toEqual({
      method: "Input.dispatchMouseEvent",
      params: {
        x: 100,
        y: 200,
        button: "left",
        clickCount: 1,
        type: "mouseReleased",
      },
    });
  });

  test("propagates errors from the client", async () => {
    const cdp = fakeCdp(() => {
      throw new CdpError("transport_error", "send failed");
    });
    await expect(dispatchClickAt(cdp, { x: 1, y: 2 })).rejects.toMatchObject({
      name: "CdpError",
      code: "transport_error",
    });
  });
});

// ── dispatchHoverAt ───────────────────────────────────────────────────

describe("dispatchHoverAt", () => {
  test("emits a single mouseMoved event", async () => {
    const cdp = fakeCdp(() => ({}));

    await dispatchHoverAt(cdp, { x: 10, y: 20 });

    expect(cdp.calls).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: 10, y: 20, button: "none" },
      },
    ]);
  });

  test("propagates errors from the client", async () => {
    const cdp = fakeCdp(() => {
      throw new CdpError("cdp_error", "boom");
    });
    await expect(dispatchHoverAt(cdp, { x: 10, y: 20 })).rejects.toMatchObject({
      name: "CdpError",
    });
  });
});

// ── dispatchInsertText ────────────────────────────────────────────────

describe("dispatchInsertText", () => {
  test("sends a single Input.insertText with the expected text", async () => {
    const cdp = fakeCdp(() => ({}));

    await dispatchInsertText(cdp, "hello world");

    expect(cdp.calls).toEqual([
      { method: "Input.insertText", params: { text: "hello world" } },
    ]);
  });

  test("propagates errors from the client", async () => {
    const cdp = fakeCdp(() => {
      throw new CdpError("cdp_error", "boom");
    });
    await expect(dispatchInsertText(cdp, "x")).rejects.toMatchObject({
      name: "CdpError",
    });
  });
});

// ── dispatchKeyPress ──────────────────────────────────────────────────

describe("dispatchKeyPress", () => {
  test("Enter sends keyDown + char + keyUp with windowsVirtualKeyCode 13", async () => {
    const cdp = fakeCdp(() => ({}));

    await dispatchKeyPress(cdp, "Enter");

    // Enter is text-producing (\r) so we get keyDown + char + keyUp.
    expect(cdp.calls).toHaveLength(3);
    for (const call of cdp.calls) {
      expect(call.method).toBe("Input.dispatchKeyEvent");
      const params = call.params as Record<string, unknown>;
      expect(params.key).toBe("Enter");
      expect(params.code).toBe("Enter");
      expect(params.windowsVirtualKeyCode).toBe(13);
      expect(params.text).toBe("\r");
    }
    expect((cdp.calls[0]!.params as Record<string, unknown>).type).toBe(
      "keyDown",
    );
    expect((cdp.calls[1]!.params as Record<string, unknown>).type).toBe("char");
    expect((cdp.calls[2]!.params as Record<string, unknown>).type).toBe(
      "keyUp",
    );
  });

  test("'a' sends keyCode 65, code KeyA, and a char event", async () => {
    const cdp = fakeCdp(() => ({}));

    await dispatchKeyPress(cdp, "a");

    expect(cdp.calls).toHaveLength(3);
    for (const call of cdp.calls) {
      const params = call.params as Record<string, unknown>;
      expect(params.key).toBe("a");
      expect(params.code).toBe("KeyA");
      expect(params.windowsVirtualKeyCode).toBe(65);
      expect(params.text).toBe("a");
    }
    expect((cdp.calls[1]!.params as Record<string, unknown>).type).toBe("char");
  });

  test("ArrowDown sends keyCode 40 and NO char event", async () => {
    const cdp = fakeCdp(() => ({}));

    await dispatchKeyPress(cdp, "ArrowDown");

    // ArrowDown is non-printing → no char event (just keyDown + keyUp).
    expect(cdp.calls).toHaveLength(2);
    for (const call of cdp.calls) {
      const params = call.params as Record<string, unknown>;
      expect(params.key).toBe("ArrowDown");
      expect(params.code).toBe("ArrowDown");
      expect(params.windowsVirtualKeyCode).toBe(40);
      expect(params.text).toBeUndefined();
    }
    expect((cdp.calls[0]!.params as Record<string, unknown>).type).toBe(
      "keyDown",
    );
    expect((cdp.calls[1]!.params as Record<string, unknown>).type).toBe(
      "keyUp",
    );
  });

  test("digit '7' sends keyCode 55 and code Digit7", async () => {
    const cdp = fakeCdp(() => ({}));

    await dispatchKeyPress(cdp, "7");

    expect(cdp.calls).toHaveLength(3);
    const params = cdp.calls[0]!.params as Record<string, unknown>;
    expect(params.key).toBe("7");
    expect(params.code).toBe("Digit7");
    expect(params.windowsVirtualKeyCode).toBe(55);
    expect(params.text).toBe("7");
  });

  test("Tab sends keyCode 9 and text '\\t'", async () => {
    const cdp = fakeCdp(() => ({}));

    await dispatchKeyPress(cdp, "Tab");

    expect(cdp.calls).toHaveLength(3);
    const params = cdp.calls[0]!.params as Record<string, unknown>;
    expect(params.windowsVirtualKeyCode).toBe(9);
    expect(params.text).toBe("\t");
  });

  test("Escape sends keyCode 27 and NO char event", async () => {
    const cdp = fakeCdp(() => ({}));

    await dispatchKeyPress(cdp, "Escape");

    expect(cdp.calls).toHaveLength(2);
    const params = cdp.calls[0]!.params as Record<string, unknown>;
    expect(params.windowsVirtualKeyCode).toBe(27);
    expect(params.text).toBeUndefined();
  });

  test("'Space' (Playwright convention) sends code 'Space' and keyCode 32", async () => {
    // Playwright callers pass "Space" as the key name, but
    // `event.key` is actually " ". Verify both invariants.
    const cdp = fakeCdp(() => ({}));

    await dispatchKeyPress(cdp, "Space");

    expect(cdp.calls).toHaveLength(3);
    for (const call of cdp.calls) {
      const params = call.params as Record<string, unknown>;
      expect(params.key).toBe(" ");
      expect(params.code).toBe("Space");
      expect(params.windowsVirtualKeyCode).toBe(32);
      expect(params.text).toBe(" ");
    }
    expect((cdp.calls[1]!.params as Record<string, unknown>).type).toBe("char");
  });

  test("literal ' ' also maps to code 'Space'", async () => {
    // Passing a literal space character should produce the same
    // event shape as "Space" — not fall through to the generic
    // printable-ASCII path which emits `code: ""`.
    const cdp = fakeCdp(() => ({}));

    await dispatchKeyPress(cdp, " ");

    const params = cdp.calls[0]!.params as Record<string, unknown>;
    expect(params.code).toBe("Space");
    expect(params.windowsVirtualKeyCode).toBe(32);
    expect(params.text).toBe(" ");
  });

  test("Home/End/PageUp/PageDown send the right keyCodes (no char event)", async () => {
    const cases: Array<[string, number]> = [
      ["Home", 36],
      ["End", 35],
      ["PageUp", 33],
      ["PageDown", 34],
    ];
    for (const [key, expectedKeyCode] of cases) {
      const cdp = fakeCdp(() => ({}));
      await dispatchKeyPress(cdp, key);
      // Navigation keys are non-printing → keyDown + keyUp only.
      expect(cdp.calls).toHaveLength(2);
      const params = cdp.calls[0]!.params as Record<string, unknown>;
      expect(params.key).toBe(key);
      expect(params.code).toBe(key);
      expect(params.windowsVirtualKeyCode).toBe(expectedKeyCode);
      expect(params.text).toBeUndefined();
    }
  });

  test("Insert sends keyCode 45 and no char event", async () => {
    const cdp = fakeCdp(() => ({}));
    await dispatchKeyPress(cdp, "Insert");
    expect(cdp.calls).toHaveLength(2);
    const params = cdp.calls[0]!.params as Record<string, unknown>;
    expect(params.windowsVirtualKeyCode).toBe(45);
    expect(params.text).toBeUndefined();
  });

  test("F1-F12 send the right Windows virtual keyCodes", async () => {
    const cases: Array<[string, number]> = [
      ["F1", 112],
      ["F2", 113],
      ["F3", 114],
      ["F4", 115],
      ["F5", 116],
      ["F6", 117],
      ["F7", 118],
      ["F8", 119],
      ["F9", 120],
      ["F10", 121],
      ["F11", 122],
      ["F12", 123],
    ];
    for (const [key, expectedKeyCode] of cases) {
      const cdp = fakeCdp(() => ({}));
      await dispatchKeyPress(cdp, key);
      expect(cdp.calls).toHaveLength(2);
      const params = cdp.calls[0]!.params as Record<string, unknown>;
      expect(params.key).toBe(key);
      expect(params.code).toBe(key);
      expect(params.windowsVirtualKeyCode).toBe(expectedKeyCode);
      expect(params.text).toBeUndefined();
    }
  });

  test("unknown multi-character key falls back to minimal payload", async () => {
    const cdp = fakeCdp(() => ({}));
    // Suppress the console.warn for the duration of the call. F19
    // is not in the static map and cannot be derived dynamically.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await dispatchKeyPress(cdp, "F19");
    } finally {
      console.warn = originalWarn;
    }
    expect(cdp.calls).toHaveLength(2);
    expect(cdp.calls[0]!.params).toEqual({ type: "keyDown", key: "F19" });
    expect(cdp.calls[1]!.params).toEqual({ type: "keyUp", key: "F19" });
  });

  test("propagates errors from the client", async () => {
    const cdp = fakeCdp(() => {
      throw new CdpError("cdp_error", "boom");
    });
    await expect(dispatchKeyPress(cdp, "a")).rejects.toMatchObject({
      name: "CdpError",
    });
  });
});

// ── dispatchWheelScroll ───────────────────────────────────────────────

describe("dispatchWheelScroll", () => {
  test("emits a mouseWheel event with the requested delta", async () => {
    const cdp = fakeCdp(() => ({}));

    await dispatchWheelScroll(
      cdp,
      { x: 100, y: 200 },
      { deltaX: 0, deltaY: 500 },
    );

    expect(cdp.calls).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseWheel",
          x: 100,
          y: 200,
          deltaX: 0,
          deltaY: 500,
        },
      },
    ]);
  });

  test("propagates errors from the client", async () => {
    const cdp = fakeCdp(() => {
      throw new CdpError("transport_error", "boom");
    });
    await expect(
      dispatchWheelScroll(cdp, { x: 0, y: 0 }, { deltaX: 0, deltaY: 10 }),
    ).rejects.toMatchObject({ name: "CdpError", code: "transport_error" });
  });
});

// ── getCurrentUrl ─────────────────────────────────────────────────────

describe("getCurrentUrl", () => {
  test("returns the result.value from Runtime.evaluate", async () => {
    const cdp = fakeCdp((method, params) => {
      expect(method).toBe("Runtime.evaluate");
      expect(params).toEqual({
        expression: "document.location.href",
        returnByValue: true,
      });
      return { result: { value: "https://example.com/" } };
    });

    const url = await getCurrentUrl(cdp);
    expect(url).toBe("https://example.com/");
  });

  test("propagates errors from the client", async () => {
    const cdp = fakeCdp(() => {
      throw new CdpError("transport_error", "boom");
    });
    await expect(getCurrentUrl(cdp)).rejects.toMatchObject({
      name: "CdpError",
      code: "transport_error",
    });
  });
});

// ── getPageTitle ──────────────────────────────────────────────────────

describe("getPageTitle", () => {
  test("returns the result.value from Runtime.evaluate", async () => {
    const cdp = fakeCdp((method, params) => {
      expect(method).toBe("Runtime.evaluate");
      expect(params).toEqual({
        expression: "document.title",
        returnByValue: true,
      });
      return { result: { value: "My Page" } };
    });
    expect(await getPageTitle(cdp)).toBe("My Page");
  });

  test("returns empty string when result value is missing", async () => {
    const cdp = fakeCdp(() => ({ result: { value: undefined } }));
    expect(await getPageTitle(cdp)).toBe("");
  });

  test("propagates errors from the client", async () => {
    const cdp = fakeCdp(() => {
      throw new CdpError("transport_error", "boom");
    });
    await expect(getPageTitle(cdp)).rejects.toMatchObject({
      name: "CdpError",
    });
  });
});

// ── evaluateExpression ────────────────────────────────────────────────

describe("evaluateExpression", () => {
  test("returns result.value on happy path with default opts", async () => {
    const cdp = fakeCdp((method, params) => {
      expect(method).toBe("Runtime.evaluate");
      expect(params).toEqual({
        expression: "1 + 2",
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      return { result: { value: 3 } };
    });

    const value = await evaluateExpression<number>(cdp, "1 + 2");
    expect(value).toBe(3);
  });

  test("honors awaitPromise: false override", async () => {
    const cdp = fakeCdp(() => ({ result: { value: "ok" } }));
    await evaluateExpression<string>(cdp, "'ok'", { awaitPromise: false });
    expect(cdp.calls[0]!.params).toMatchObject({
      awaitPromise: false,
    });
  });

  test("throws CdpError when exceptionDetails is present", async () => {
    const cdp = fakeCdp(() => ({
      result: { value: undefined },
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "ReferenceError: foo is not defined" },
      },
    }));

    await expect(evaluateExpression(cdp, "foo")).rejects.toMatchObject({
      name: "CdpError",
      code: "cdp_error",
      message: "ReferenceError: foo is not defined",
      cdpMethod: "Runtime.evaluate",
      cdpParams: { expression: "foo" },
    });
  });

  test("falls back to exceptionDetails.text if no description", async () => {
    const cdp = fakeCdp(() => ({
      result: { value: undefined },
      exceptionDetails: { text: "Uncaught SyntaxError" },
    }));
    await expect(evaluateExpression(cdp, "???")).rejects.toMatchObject({
      message: "Uncaught SyntaxError",
    });
  });
});

// ── captureScreenshotJpeg ─────────────────────────────────────────────

describe("captureScreenshotJpeg", () => {
  test("returns a Buffer with decoded bytes", async () => {
    const rawBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI + APP0
    const base64 = rawBytes.toString("base64");

    const cdp = fakeCdp((method, params) => {
      expect(method).toBe("Page.captureScreenshot");
      expect(params).toEqual({
        format: "jpeg",
        quality: 80,
        captureBeyondViewport: false,
      });
      return { data: base64 };
    });

    const buf = await captureScreenshotJpeg(cdp);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(rawBytes)).toBe(true);
  });

  test("forwards quality + fullPage options", async () => {
    const cdp = fakeCdp(() => ({ data: "" }));
    await captureScreenshotJpeg(cdp, { quality: 50, fullPage: true });
    expect(cdp.calls[0]!.params).toEqual({
      format: "jpeg",
      quality: 50,
      captureBeyondViewport: true,
    });
  });

  test("propagates errors from the client", async () => {
    const cdp = fakeCdp(() => {
      throw new CdpError("transport_error", "boom");
    });
    await expect(captureScreenshotJpeg(cdp)).rejects.toMatchObject({
      name: "CdpError",
    });
  });
});

// ── navigateAndWait ───────────────────────────────────────────────────

/**
 * Build a programmable fake for `navigateAndWait` tests. Handles the
 * standard shape: pre-nav `document.location.href` read, then
 * `Page.navigate`, then any number of combined `readyState + href`
 * poll evaluations.
 *
 * The `poll` handler is invoked once per combined readyState/href
 * evaluate and must return `{ readyState, href }` (to continue the
 * poll) or throw (to simulate a transient CDP error).
 */
function fakeNavCdp(opts: {
  urlBeforeNav?: string;
  navResponse?: { frameId?: string; errorText?: string };
  poll: (
    callIndex: number,
  ) => { readyState: string; href: string } | { throwError: CdpError };
  onNavigate?: () => void;
}) {
  let pollCalls = 0;
  return fakeCdp((method, params) => {
    if (method === "Page.navigate") {
      opts.onNavigate?.();
      return opts.navResponse ?? {};
    }
    if (method === "Runtime.evaluate") {
      const expr = (params as { expression: string }).expression;
      if (expr === "document.location.href") {
        return { result: { value: opts.urlBeforeNav ?? "about:blank" } };
      }
      if (expr === "document.title") {
        return { result: { value: "" } };
      }
      if (expr.includes("readyState") && expr.includes("href")) {
        const res = opts.poll(pollCalls++);
        if ("throwError" in res) throw res.throwError;
        return { result: { value: res } };
      }
    }
    throw new Error(
      `unexpected: ${method} ${JSON.stringify((params as Record<string, unknown>)?.expression ?? params)}`,
    );
  });
}

describe("navigateAndWait", () => {
  test("calls Page.navigate and returns finalUrl once readyState is complete and URL has committed", async () => {
    const cdp = fakeNavCdp({
      urlBeforeNav: "https://example.com/start",
      poll: () => ({
        readyState: "complete",
        href: "https://example.com/final",
      }),
    });

    const result = await navigateAndWait(cdp, "https://example.com/target", {
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      finalUrl: "https://example.com/final",
      timedOut: false,
    });

    const navigateCalls = cdp.calls.filter((c) => c.method === "Page.navigate");
    expect(navigateCalls).toHaveLength(1);
    expect(navigateCalls[0]!.params).toEqual({
      url: "https://example.com/target",
    });
  });

  test("resolves when readyState becomes interactive (not just complete)", async () => {
    const cdp = fakeNavCdp({
      urlBeforeNav: "https://prev",
      poll: () => ({ readyState: "interactive", href: "https://x" }),
    });

    const result = await navigateAndWait(cdp, "https://x", {
      timeoutMs: 5_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.finalUrl).toBe("https://x");
  });

  test("returns timedOut: true when readyState never becomes ready", async () => {
    const cdp = fakeNavCdp({
      urlBeforeNav: "about:blank",
      poll: () => ({ readyState: "loading", href: "https://slow" }),
    });

    // Use a tiny timeout so the test finishes quickly.
    const result = await navigateAndWait(cdp, "https://slow", {
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    // finalUrl should come from the in-loop observations (the last
    // href we successfully saw), not a post-loop fresh read.
    expect(result.finalUrl).toBe("https://slow");
  });

  test("throws CdpError with code 'aborted' when signal fires", async () => {
    const controller = new AbortController();
    const cdp = fakeNavCdp({
      urlBeforeNav: "about:blank",
      onNavigate: () => controller.abort(),
      poll: () => ({ readyState: "loading", href: "https://x" }),
    });

    await expect(
      navigateAndWait(
        cdp,
        "https://x",
        { timeoutMs: 5_000 },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      name: "CdpError",
      code: "aborted",
    });
  });

  test("throws CdpError when Page.navigate returns errorText", async () => {
    // CDP signals DNS / connection errors via `errorText` rather than
    // throwing — navigateAndWait must surface this instead of polling
    // the OLD page's readyState (which is "complete") and reporting
    // success with the stale URL.
    const cdp = fakeNavCdp({
      urlBeforeNav: "about:blank",
      navResponse: {
        frameId: "f1",
        errorText: "net::ERR_CONNECTION_REFUSED",
      },
      poll: () => ({ readyState: "complete", href: "should not be read" }),
    });

    await expect(
      navigateAndWait(cdp, "https://nope.invalid", { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({
      name: "CdpError",
      code: "cdp_error",
      message: "net::ERR_CONNECTION_REFUSED",
      cdpMethod: "Page.navigate",
      cdpParams: { url: "https://nope.invalid" },
    });

    // Should NOT have polled readyState (only the pre-nav
    // `document.location.href` read is allowed before the navigate
    // attempt).
    const pollEvals = cdp.calls.filter((c) => {
      if (c.method !== "Runtime.evaluate") return false;
      const expr = (c.params as { expression?: string } | undefined)
        ?.expression;
      return typeof expr === "string" && expr.includes("readyState");
    });
    expect(pollEvals).toHaveLength(0);
  });

  test("waits for URL to commit before accepting readyState=complete (same-origin race)", async () => {
    // Reproduces the bug where a same-origin navigation resolves
    // `Page.navigate` but the polling loop sees the OLD page's
    // "complete" readyState and the OLD URL for the first few polls
    // before the new document commits.
    //
    // First 3 polls: old page's "complete" + old URL.
    // Fourth poll: new document fully committed.
    const cdp = fakeNavCdp({
      urlBeforeNav: "https://example.com/page1",
      poll: (callIndex) => {
        if (callIndex < 3) {
          return {
            readyState: "complete",
            href: "https://example.com/page1",
          };
        }
        return { readyState: "complete", href: "https://example.com/page2" };
      },
    });

    const result = await navigateAndWait(cdp, "https://example.com/page2", {
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      finalUrl: "https://example.com/page2",
      timedOut: false,
    });

    // The loop must have polled at least 4 times — proof that it
    // did not break on the first "complete" observation against the
    // old URL.
    const pollEvals = cdp.calls.filter(
      (c) =>
        c.method === "Runtime.evaluate" &&
        typeof (c.params as { expression?: string })?.expression === "string" &&
        (c.params as { expression: string }).expression.includes("readyState"),
    );
    expect(pollEvals.length).toBeGreaterThanOrEqual(4);
  });

  test("retries on transient CdpError during context transition", async () => {
    // After `Page.navigate`, `Runtime.evaluate` can fail transiently
    // while the old execution context is torn down and before the
    // new one is created. navigateAndWait must catch that error and
    // keep polling.
    const cdp = fakeNavCdp({
      urlBeforeNav: "https://prev",
      poll: (callIndex) => {
        if (callIndex === 0) {
          return {
            throwError: new CdpError(
              "cdp_error",
              "Execution context was destroyed.",
            ),
          };
        }
        if (callIndex === 1) {
          return {
            throwError: new CdpError(
              "cdp_error",
              "Cannot find context with specified id",
            ),
          };
        }
        return { readyState: "complete", href: "https://new" };
      },
    });

    const result = await navigateAndWait(cdp, "https://new", {
      timeoutMs: 5_000,
    });
    expect(result).toEqual({
      finalUrl: "https://new",
      timedOut: false,
    });
  });

  test("same-URL reload falls back to readyState-only polling", async () => {
    // When the target URL matches the pre-nav URL (e.g. a reload),
    // there's no URL-change signal to wait for. The commit check
    // must fall back to readyState-only so reloads don't loop
    // forever.
    const cdp = fakeNavCdp({
      urlBeforeNav: "https://example.com/same",
      poll: () => ({
        readyState: "complete",
        href: "https://example.com/same",
      }),
    });

    const result = await navigateAndWait(cdp, "https://example.com/same", {
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      finalUrl: "https://example.com/same",
      timedOut: false,
    });
  });

  test("falls back to readyState-only when pre-nav URL read fails", async () => {
    // If we can't read the pre-nav URL (e.g. fresh about:blank with
    // no Runtime context), commit detection has no baseline and must
    // fall back to readyState-only.
    let sawPreNavRead = false;
    const cdp = fakeCdp((method, params) => {
      if (method === "Page.navigate") return {};
      if (method === "Runtime.evaluate") {
        const expr = (params as { expression: string }).expression;
        if (expr === "document.location.href" && !sawPreNavRead) {
          sawPreNavRead = true;
          throw new CdpError("cdp_error", "no context");
        }
        if (expr.includes("readyState") && expr.includes("href")) {
          return {
            result: { value: { readyState: "complete", href: "https://x" } },
          };
        }
      }
      throw new Error(
        `unexpected: ${method} ${JSON.stringify((params as Record<string, unknown>)?.expression ?? params)}`,
      );
    });

    const result = await navigateAndWait(cdp, "https://x", {
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      finalUrl: "https://x",
      timedOut: false,
    });
  });

  test("reports last observed href on timeout instead of racing a post-loop read", async () => {
    // If polling never reaches readyState-ready + committed, the
    // final URL should come from the last in-loop observation (so
    // the caller doesn't race the commit window again via a
    // post-loop `getCurrentUrl`).
    const observedHrefs: string[] = [];
    const cdp = fakeNavCdp({
      urlBeforeNav: "https://pre",
      poll: (callIndex) => {
        // Keep returning "loading" but advance the URL so we can
        // verify the fallback uses the last observation.
        const href = `https://loading/${callIndex}`;
        observedHrefs.push(href);
        return { readyState: "loading", href };
      },
    });

    const result = await navigateAndWait(cdp, "https://target", {
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    // finalUrl should match the last href we returned from the poll
    // handler (not the pre-nav URL, and not a separately-read value).
    expect(observedHrefs.length).toBeGreaterThan(0);
    expect(result.finalUrl).toBe(observedHrefs[observedHrefs.length - 1]!);
  });

  test("re-throws non-CdpError exceptions from the polling evaluate", async () => {
    // Only CdpErrors are retry-worthy; unexpected JS errors should
    // propagate so they're not swallowed.
    const cdp = fakeNavCdp({
      urlBeforeNav: "https://pre",
      poll: () => {
        throw new Error("unexpected programmer error");
      },
    });

    await expect(
      navigateAndWait(cdp, "https://target", { timeoutMs: 5_000 }),
    ).rejects.toThrow("unexpected programmer error");
  });
});

// ── waitForSelector ───────────────────────────────────────────────────

describe("waitForSelector", () => {
  test("resolves when the selector appears on the 2nd poll (default visible state)", async () => {
    let evalCount = 0;
    let lastExpression = "";
    const cdp = fakeCdp((method, params) => {
      if (method === "Runtime.evaluate") {
        evalCount++;
        lastExpression = (params as { expression: string }).expression;
        // First poll: not present. Second poll: present.
        return { result: { value: evalCount >= 2 } };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 9 };
      if (method === "DOM.describeNode")
        return { node: { backendNodeId: 321 } };
      throw new Error(`unexpected: ${method}`);
    });

    const backendNodeId = await waitForSelector(cdp, "#ready", 5_000);
    expect(backendNodeId).toBe(321);
    expect(evalCount).toBeGreaterThanOrEqual(2);
    // Default state is "visible" — the polling expression must check
    // bounding box + display + visibility, not just `!== null`.
    expect(lastExpression).toContain("getBoundingClientRect");
    expect(lastExpression).toContain("display");
    expect(lastExpression).toContain("visibility");
  });

  test("with state: 'attached' polls DOM existence only", async () => {
    let evalCount = 0;
    let lastExpression = "";
    const cdp = fakeCdp((method, params) => {
      if (method === "Runtime.evaluate") {
        evalCount++;
        lastExpression = (params as { expression: string }).expression;
        return { result: { value: true } };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 9 };
      if (method === "DOM.describeNode")
        return { node: { backendNodeId: 555 } };
      throw new Error(`unexpected: ${method}`);
    });

    const backendNodeId = await waitForSelector(
      cdp,
      "#exists",
      5_000,
      undefined,
      { state: "attached" },
    );
    expect(backendNodeId).toBe(555);
    expect(evalCount).toBeGreaterThanOrEqual(1);
    // Attached state must use the simple `!== null` check, not the
    // bounding-box / computed-style probe.
    expect(lastExpression).toBe(`document.querySelector("#exists") !== null`);
    expect(lastExpression).not.toContain("getBoundingClientRect");
  });

  test("default state polls until the visible-state probe returns true", async () => {
    let evalCount = 0;
    const cdp = fakeCdp((method, params) => {
      if (method === "Runtime.evaluate") {
        evalCount++;
        const expression = (params as { expression: string }).expression;
        // Sanity-check: the polling expression must be the visible
        // probe, not the simple existence check.
        expect(expression).toContain("getBoundingClientRect");
        // Element exists in DOM but isn't yet visible until the third
        // poll.
        return { result: { value: evalCount >= 3 } };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 9 };
      if (method === "DOM.describeNode")
        return { node: { backendNodeId: 999 } };
      throw new Error(`unexpected: ${method}`);
    });

    const backendNodeId = await waitForSelector(cdp, "#hydrating", 5_000);
    expect(backendNodeId).toBe(999);
    expect(evalCount).toBeGreaterThanOrEqual(3);
  });

  test("throws CdpError on timeout", async () => {
    const cdp = fakeCdp((method) => {
      if (method === "Runtime.evaluate") return { result: { value: false } };
      throw new Error(`unexpected: ${method}`);
    });

    await expect(waitForSelector(cdp, "#nope", 50)).rejects.toMatchObject({
      name: "CdpError",
      code: "cdp_error",
      message: "Timed out waiting for #nope",
    });
  });

  test("throws CdpError with code 'aborted' when signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const cdp = fakeCdp(() => ({ result: { value: false } }));
    await expect(
      waitForSelector(cdp, "#x", 5_000, controller.signal),
    ).rejects.toMatchObject({
      name: "CdpError",
      code: "aborted",
    });
  });
});

// ── waitForText ───────────────────────────────────────────────────────

describe("waitForText", () => {
  test("resolves when the text is found", async () => {
    let count = 0;
    const cdp = fakeCdp((method) => {
      if (method === "Runtime.evaluate") {
        count++;
        return { result: { value: count >= 2 } };
      }
      throw new Error(`unexpected: ${method}`);
    });

    await waitForText(cdp, "hello", 5_000);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("throws CdpError on timeout", async () => {
    const cdp = fakeCdp((method) => {
      if (method === "Runtime.evaluate") return { result: { value: false } };
      throw new Error(`unexpected: ${method}`);
    });

    await expect(waitForText(cdp, "never-here", 50)).rejects.toMatchObject({
      name: "CdpError",
      code: "cdp_error",
      message: "Timed out waiting for text: never-here",
    });
  });

  test("throws CdpError with code 'aborted' when signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const cdp = fakeCdp(() => ({ result: { value: false } }));
    await expect(
      waitForText(cdp, "x", 5_000, controller.signal),
    ).rejects.toMatchObject({
      name: "CdpError",
      code: "aborted",
    });
  });
});
