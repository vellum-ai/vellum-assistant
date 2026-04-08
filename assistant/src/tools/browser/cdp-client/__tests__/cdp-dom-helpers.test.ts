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
  test("emits keyDown + keyUp with the requested key", async () => {
    const cdp = fakeCdp(() => ({}));

    await dispatchKeyPress(cdp, "Enter");

    expect(cdp.calls).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", key: "Enter" },
      },
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", key: "Enter" },
      },
    ]);
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

describe("navigateAndWait", () => {
  test("calls Page.navigate and returns finalUrl once readyState is complete", async () => {
    const cdp = fakeCdp((method, params) => {
      if (method === "Page.navigate") return {};
      if (method === "Runtime.evaluate") {
        const expr = (params as { expression: string }).expression;
        if (expr === "document.readyState")
          return { result: { value: "complete" } };
        if (expr === "document.location.href")
          return { result: { value: "https://example.com/final" } };
      }
      throw new Error(`unexpected: ${method}`);
    });

    const result = await navigateAndWait(cdp, "https://example.com/start", {
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      finalUrl: "https://example.com/final",
      timedOut: false,
    });

    const navigateCalls = cdp.calls.filter((c) => c.method === "Page.navigate");
    expect(navigateCalls).toHaveLength(1);
    expect(navigateCalls[0]!.params).toEqual({
      url: "https://example.com/start",
    });
  });

  test("resolves when readyState becomes interactive (not just complete)", async () => {
    const cdp = fakeCdp((method, params) => {
      if (method === "Page.navigate") return {};
      if (method === "Runtime.evaluate") {
        const expr = (params as { expression: string }).expression;
        if (expr === "document.readyState")
          return { result: { value: "interactive" } };
        if (expr === "document.location.href")
          return { result: { value: "https://x" } };
      }
      throw new Error(`unexpected: ${method}`);
    });

    const result = await navigateAndWait(cdp, "https://x", {
      timeoutMs: 5_000,
    });
    expect(result.timedOut).toBe(false);
  });

  test("returns timedOut: true when readyState never becomes ready", async () => {
    const cdp = fakeCdp((method, params) => {
      if (method === "Page.navigate") return {};
      if (method === "Runtime.evaluate") {
        const expr = (params as { expression: string }).expression;
        if (expr === "document.readyState")
          return { result: { value: "loading" } };
        if (expr === "document.location.href")
          return { result: { value: "https://slow" } };
      }
      throw new Error(`unexpected: ${method}`);
    });

    // Use a tiny timeout so the test finishes quickly.
    const result = await navigateAndWait(cdp, "https://slow", {
      timeoutMs: 50,
    });
    expect(result).toEqual({
      finalUrl: "https://slow",
      timedOut: true,
    });
  });

  test("throws CdpError with code 'aborted' when signal fires", async () => {
    const controller = new AbortController();
    const cdp = fakeCdp((method) => {
      if (method === "Page.navigate") {
        controller.abort();
        return {};
      }
      if (method === "Runtime.evaluate")
        return { result: { value: "loading" } };
      throw new Error(`unexpected: ${method}`);
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
