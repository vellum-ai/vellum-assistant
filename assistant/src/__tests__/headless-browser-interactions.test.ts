import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

/**
 * Fake CDP session used by every interaction tool that has been
 * migrated to `CdpClient` (click, hover, type, press_key,
 * select_option, scroll). Each `session.send(method, params)` call is
 * recorded in `sendCalls` and routed to `sendHandler`, which tests
 * configure per-case. The handler returns either a CDP response
 * object or an `Error` to simulate transport failure. `detachCalls`
 * counts `session.detach()` invocations so tests can assert that
 * `CdpClient.dispose()` runs in the tool's `finally` block.
 *
 * The fake session is exposed via `mockPage.context().newCDPSession(
 * page)` so the real `LocalCdpClient` drives it. Routing through the
 * production client (instead of mocking the factory / cdp-client
 * submodules) avoids polluting the global module cache that the CDP
 * unit tests rely on.
 */
interface SendCall {
  method: string;
  params: Record<string, unknown> | undefined;
}

let sendCalls: SendCall[];
let sendHandler: (
  method: string,
  params: Record<string, unknown> | undefined,
) => unknown;
let detachCalls: number;

function resetCdpMock() {
  sendCalls = [];
  detachCalls = 0;
  sendHandler = () => ({});
}

const fakeCdpSession = {
  send: async (method: string, params?: Record<string, unknown>) => {
    sendCalls.push({ method, params });
    const value = sendHandler(method, params);
    if (value instanceof Error) throw value;
    return value;
  },
  detach: async () => {
    detachCalls += 1;
  },
};

/**
 * The mock page only needs to expose `context().newCDPSession()` so
 * the real `LocalCdpClient` can obtain a CDP session. All interaction
 * tools now route through CDP, so no Playwright `page.*` surface is
 * required.
 */
let mockPage: {
  close: () => Promise<void>;
  isClosed: () => boolean;
  context: () => {
    newCDPSession: (page: unknown) => Promise<typeof fakeCdpSession>;
  };
};

let snapshotBackendNodeMaps: Map<string, Map<string, number>>;

const preferredBackendKinds = new Map<string, string>();

mock.module("../tools/browser/browser-manager.js", () => {
  snapshotBackendNodeMaps = new Map();
  preferredBackendKinds.clear();
  return {
    browserManager: {
      getOrCreateSessionPage: async () => mockPage,
      closeSessionPage: async () => {},
      closeAllPages: async () => {},
      storeSnapshotBackendNodeMap: (
        conversationId: string,
        map: Map<string, number>,
      ) => {
        snapshotBackendNodeMaps.set(conversationId, map);
      },
      resolveSnapshotBackendNodeId: (
        conversationId: string,
        elementId: string,
      ) => {
        const map = snapshotBackendNodeMaps.get(conversationId);
        if (!map) return null;
        return map.get(elementId) ?? null;
      },
      clearSnapshotBackendNodeMap: (conversationId: string) => {
        snapshotBackendNodeMaps.delete(conversationId);
      },
      getPreferredBackendKind: (conversationId: string) =>
        preferredBackendKinds.get(conversationId) ?? null,
      setPreferredBackendKind: (conversationId: string, kind: string) => {
        preferredBackendKinds.set(conversationId, kind);
      },
      clearPreferredBackendKind: (conversationId: string) => {
        preferredBackendKinds.delete(conversationId);
      },
    },
  };
});

mock.module("../tools/network/url-safety.js", () => ({
  parseUrl: () => null,
  isPrivateOrLocalHost: () => false,
  resolveHostAddresses: async () => [],
  resolveRequestAddress: async () => ({}),
  sanitizeUrlForOutput: (url: URL) => url.href,
}));

mock.module("../tools/browser/browser-screencast.js", () => ({
  getSender: () => undefined,
  stopBrowserScreencast: async () => {},
  stopAllScreencasts: async () => {},
  ensureScreencast: async () => {},
}));

import {
  executeBrowserAttach,
  executeBrowserClick,
  executeBrowserClose,
  executeBrowserDetach,
  executeBrowserHover,
  executeBrowserPressKey,
  executeBrowserScroll,
  executeBrowserSelectOption,
  executeBrowserType,
} from "../tools/browser/browser-execution.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  conversationId: "test-conversation",
  workingDir: "/tmp",
  trustClass: "guardian",
};

function resetMockPage() {
  mockPage = {
    close: async () => {},
    isClosed: () => false,
    // `LocalCdpClient.ensureSession()` calls `page.context().newCDPSession(
    // page)` to obtain a CDP session. Return the in-file `fakeCdpSession`
    // so tests can assert on the exact CDP method sequence.
    context: () => ({
      newCDPSession: async (_page: unknown) => fakeCdpSession,
    }),
  };
}

/**
 * Default CDP send handler that answers the common plumbing calls
 * used by the migrated tools (querySelectorBackendNodeId, DOM.focus,
 * DOM.resolveNode, Runtime.callFunctionOn, Input.*, and
 * Runtime.evaluate for viewport dimensions). Individual tests can
 * override `sendHandler` to simulate failures or shape responses.
 */
function defaultCdpHandler(
  method: string,
  _params: Record<string, unknown> | undefined,
): unknown {
  switch (method) {
    case "DOM.getDocument":
      return { root: { nodeId: 1 } };
    case "DOM.querySelector":
      return { nodeId: 42 };
    case "DOM.describeNode":
      return { node: { backendNodeId: 100 } };
    case "DOM.resolveNode":
      return { object: { objectId: "obj-1" } };
    case "Runtime.evaluate":
      return { result: { value: { w: 800, h: 600 } } };
    case "Runtime.callFunctionOn":
      // executeBrowserSelectOption invokes a function that returns
      // a `matched` boolean — default to true so wrapper-contract
      // tests don't need to know the inner select-option matching
      // shape. Tests that exercise the no-match path override the
      // handler explicitly.
      return { result: { value: true } };
    default:
      return {};
  }
}

/**
 * Install a CDP `sendHandler` tuned for the click + hover DOM →
 * Input.dispatchMouseEvent chain (`DOM.getDocument`,
 * `DOM.querySelector`, `DOM.describeNode`,
 * `DOM.scrollIntoViewIfNeeded`, `DOM.getBoxModel`,
 * `Input.dispatchMouseEvent`). Tests can override `throwFrom` to make
 * one method reject, or override `backendNodeId` to control what
 * `querySelectorBackendNodeId` resolves to.
 */
function installClickHoverCdpSend(
  overrides: Partial<{
    backendNodeId: number;
    throwFrom: string;
  }> = {},
) {
  const backendNodeId = overrides.backendNodeId ?? 1234;
  const throwFrom = overrides.throwFrom;

  sendHandler = (method, _params) => {
    if (throwFrom === method) {
      return new Error("cdp boom");
    }
    switch (method) {
      case "DOM.getDocument":
        return { root: { nodeId: 1 } };
      case "DOM.querySelector":
        return { nodeId: 2 };
      case "DOM.describeNode":
        return { node: { backendNodeId } };
      case "DOM.scrollIntoViewIfNeeded":
        return {};
      case "DOM.getBoxModel":
        // Flat 8-number quad: (10,20) (30,20) (30,40) (10,40)
        // → center (20, 30).
        return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
      case "Input.dispatchMouseEvent":
        return {};
      case "Runtime.evaluate":
        // cdpWaitForSelector (used by click/hover selector branches)
        // polls Runtime.evaluate with the visible-state probe and
        // expects { result: { value: boolean } }. Returning true on
        // the first poll lets the test resolve immediately instead
        // of timing out after ACTION_TIMEOUT_MS.
        return { result: { value: true } };
      default:
        return {};
    }
  };
}

// ── browser_click ────────────────────────────────────────────────────

describe("executeBrowserClick (CDP)", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
    snapshotBackendNodeMaps.clear();
  });

  test("clicks by selector: runs full DOM → Input.dispatchMouseEvent chain", async () => {
    installClickHoverCdpSend({ backendNodeId: 5555 });
    const result = await executeBrowserClick({ selector: "#submit-btn" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Clicked element: #submit-btn");

    // Expected CDP call sequence for the selector path. The leading
    // Runtime.evaluate is the visible-state probe issued by
    // cdpWaitForSelector before resolving the backend node — this
    // matches Playwright's `page.click(selector, { timeout })`
    // semantics and lets click work on async-hydrated pages.
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toEqual([
      "Runtime.evaluate",
      "DOM.getDocument",
      "DOM.querySelector",
      "DOM.describeNode",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getBoxModel",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);

    // The leading Runtime.evaluate is the visible-state probe.
    const visibleProbe = sendCalls.find(
      (c) => c.method === "Runtime.evaluate",
    )!;
    expect(
      (visibleProbe.params as { expression: string }).expression,
    ).toContain("getBoundingClientRect");

    // Arguments threaded through correctly.
    const qsCall = sendCalls.find((c) => c.method === "DOM.querySelector")!;
    expect(qsCall.params).toMatchObject({ nodeId: 1, selector: "#submit-btn" });
    const scrollCall = sendCalls.find(
      (c) => c.method === "DOM.scrollIntoViewIfNeeded",
    )!;
    expect(scrollCall.params).toMatchObject({ backendNodeId: 5555 });
    const boxCall = sendCalls.find((c) => c.method === "DOM.getBoxModel")!;
    expect(boxCall.params).toMatchObject({ backendNodeId: 5555 });

    // All three mouse events land on the quad midpoint (20, 30).
    const mouseCalls = sendCalls.filter(
      (c) => c.method === "Input.dispatchMouseEvent",
    );
    expect(mouseCalls).toHaveLength(3);
    expect(mouseCalls[0]!.params).toMatchObject({
      type: "mouseMoved",
      x: 20,
      y: 30,
      button: "left",
      clickCount: 1,
    });
    expect(mouseCalls[1]!.params).toMatchObject({
      type: "mousePressed",
      x: 20,
      y: 30,
      button: "left",
      clickCount: 1,
    });
    expect(mouseCalls[2]!.params).toMatchObject({
      type: "mouseReleased",
      x: 20,
      y: 30,
      button: "left",
      clickCount: 1,
    });

    // CdpClient disposed in finally → session.detach called.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(detachCalls).toBe(1);
  });

  test("clicks by element_id (backend path): skips DOM.querySelector", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 42]]));
    installClickHoverCdpSend();

    const result = await executeBrowserClick({ element_id: "e1" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Clicked element: eid=e1");

    const methods = sendCalls.map((c) => c.method);
    // Backend path jumps straight to scrollIntoViewIfNeeded — no
    // DOM.getDocument / querySelector / describeNode round-trip.
    expect(methods).not.toContain("DOM.getDocument");
    expect(methods).not.toContain("DOM.querySelector");
    expect(methods).not.toContain("DOM.describeNode");
    expect(methods).toEqual([
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getBoxModel",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);

    // Backend node id threaded directly from the snapshot map.
    const scrollCall = sendCalls.find(
      (c) => c.method === "DOM.scrollIntoViewIfNeeded",
    )!;
    expect(scrollCall.params).toMatchObject({ backendNodeId: 42 });
    const boxCall = sendCalls.find((c) => c.method === "DOM.getBoxModel")!;
    expect(boxCall.params).toMatchObject({ backendNodeId: 42 });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(detachCalls).toBe(1);
  });

  test("prefers element_id over selector when both provided", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 77]]));
    installClickHoverCdpSend();

    const result = await executeBrowserClick(
      { element_id: "e1", selector: "#ignored" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("eid=e1");

    // DOM.querySelector must NOT have been called (selector ignored).
    const methods = sendCalls.map((c) => c.method);
    expect(methods).not.toContain("DOM.querySelector");
  });

  test("errors when neither element_id nor selector provided", async () => {
    const result = await executeBrowserClick({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Either element_id or selector is required",
    );
    // No CDP session should have been opened at all.
    expect(sendCalls).toHaveLength(0);
    expect(detachCalls).toBe(0);
  });

  test("errors when element_id not found in snapshot map", async () => {
    installClickHoverCdpSend();
    const result = await executeBrowserClick({ element_id: "e99" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
    expect(result.content).toContain("browser_snapshot");
    // Resolution failed before acquiring a CdpClient.
    expect(sendCalls).toHaveLength(0);
  });

  test("errors when snapshot backend-node map is missing for session", async () => {
    installClickHoverCdpSend();
    const result = await executeBrowserClick({ element_id: "e1" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
    expect(sendCalls).toHaveLength(0);
  });

  test("returns error + still disposes CdpClient when cdp.send throws", async () => {
    installClickHoverCdpSend({ throwFrom: "Input.dispatchMouseEvent" });

    const result = await executeBrowserClick({ selector: "#submit-btn" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Click failed");
    expect(result.content).toContain("cdp boom");

    // finally { cdp.dispose() } must still fire → detach called.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(detachCalls).toBe(1);
  });

  test("waits for selector that initially doesn't exist but becomes visible", async () => {
    // Simulates a hydrating page: the visible-state probe returns
    // false for the first 2 polls, then true on the 3rd. The click
    // tool must wait through these polls (instead of failing
    // immediately) and then complete the click as normal.
    let visibleProbeCount = 0;
    sendHandler = (method, _params) => {
      switch (method) {
        case "Runtime.evaluate":
          visibleProbeCount++;
          return { result: { value: visibleProbeCount >= 3 } };
        case "DOM.getDocument":
          return { root: { nodeId: 1 } };
        case "DOM.querySelector":
          return { nodeId: 2 };
        case "DOM.describeNode":
          return { node: { backendNodeId: 8888 } };
        case "DOM.scrollIntoViewIfNeeded":
          return {};
        case "DOM.getBoxModel":
          return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
        case "Input.dispatchMouseEvent":
          return {};
        default:
          return {};
      }
    };

    const result = await executeBrowserClick({ selector: "#hydrated" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Clicked element: #hydrated");
    // The visible-state probe was polled at least 3 times before
    // succeeding, then the rest of the click pipeline ran exactly
    // once.
    expect(visibleProbeCount).toBeGreaterThanOrEqual(3);
    const mouseCalls = sendCalls.filter(
      (c) => c.method === "Input.dispatchMouseEvent",
    );
    expect(mouseCalls).toHaveLength(3);
    // querySelectorBackendNodeId only ran once at the end (after the
    // probe returned true) — not on every polling iteration.
    const describeCalls = sendCalls.filter(
      (c) => c.method === "DOM.describeNode",
    );
    expect(describeCalls).toHaveLength(1);
  });
});

// ── browser_type ─────────────────────────────────────────────────────

describe("executeBrowserType", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
    snapshotBackendNodeMaps.clear();
    sendHandler = defaultCdpHandler;
  });

  test("types with element_id and default clear_first=true", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e3", 555]]));
    const result = await executeBrowserType(
      { element_id: "e3", text: "hello" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Typed into element: element_id "e3"');
    expect(result.content).toContain("cleared existing content");

    // Expected CDP sequence when resolving by backendNodeId + clearFirst:
    //   DOM.focus → DOM.resolveNode → Runtime.callFunctionOn (clear) →
    //   DOM.focus → Input.insertText
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toEqual([
      "DOM.focus",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
      "DOM.focus",
      "Input.insertText",
    ]);
    const focusCall = sendCalls[0]!;
    expect(focusCall.params).toEqual({ backendNodeId: 555 });
    const insertCall = sendCalls[sendCalls.length - 1]!;
    expect(insertCall.params).toEqual({ text: "hello" });
  });

  test("types with raw selector (resolves via DOM.querySelector)", async () => {
    const result = await executeBrowserType(
      { selector: 'input[name="email"]', text: "test" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Typed into element: input[name="email"]');
    // Raw-selector path must resolve the backendNodeId first.
    const methods = sendCalls.map((c) => c.method);
    expect(methods[0]).toBe("DOM.getDocument");
    expect(methods[1]).toBe("DOM.querySelector");
    expect(methods[2]).toBe("DOM.describeNode");
    expect(methods).toContain("Input.insertText");
  });

  test("appends text when clear_first=false", async () => {
    const result = await executeBrowserType(
      { selector: "#input", text: " more", clear_first: false },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("cleared");
    // clear_first=false skips DOM.resolveNode + Runtime.callFunctionOn
    // and the re-focus call, so we should see focus + insertText only.
    const methods = sendCalls.map((c) => c.method);
    expect(methods).not.toContain("DOM.resolveNode");
    expect(methods).not.toContain("Runtime.callFunctionOn");
    const focusCount = methods.filter((m) => m === "DOM.focus").length;
    expect(focusCount).toBe(1);
    expect(methods).toContain("Input.insertText");
  });

  test("presses Enter after typing when press_enter=true", async () => {
    const result = await executeBrowserType(
      { selector: "#search", text: "query", press_enter: true },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("pressed Enter");
    const methods = sendCalls.map((c) => c.method);
    // Input.insertText must come before the Enter keyDown/char/keyUp.
    const insertIdx = methods.indexOf("Input.insertText");
    const keyDownIdx = methods.findIndex(
      (m, i) =>
        m === "Input.dispatchKeyEvent" &&
        (sendCalls[i]!.params as { type: string }).type === "keyDown",
    );
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(keyDownIdx).toBeGreaterThan(insertIdx);
    // Enter is text-producing → keyDown + char + keyUp.
    const keyEvents = sendCalls.filter(
      (c) => c.method === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(3);
    expect((keyEvents[0]!.params as { key: string }).key).toBe("Enter");
    expect((keyEvents[0]!.params as { type: string }).type).toBe("keyDown");
    expect((keyEvents[1]!.params as { type: string }).type).toBe("char");
    expect((keyEvents[2]!.params as { type: string }).type).toBe("keyUp");
  });

  test("errors when text is missing", async () => {
    const result = await executeBrowserType({ selector: "#input" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("text is required");
    expect(sendCalls).toHaveLength(0);
  });

  test("errors when text is empty string", async () => {
    const result = await executeBrowserType(
      { selector: "#input", text: "" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("text is required");
    expect(sendCalls).toHaveLength(0);
  });

  test("errors when neither element_id nor selector provided", async () => {
    const result = await executeBrowserType({ text: "hello" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Either element_id or selector is required",
    );
    expect(sendCalls).toHaveLength(0);
  });

  test("errors when element_id not found", async () => {
    const result = await executeBrowserType(
      { element_id: "e99", text: "hello" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
    expect(sendCalls).toHaveLength(0);
  });

  test("surfaces CDP failure as a type error", async () => {
    sendHandler = () => new Error("focus failed");
    const result = await executeBrowserType(
      { selector: "#div", text: "hello" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Type failed");
    expect(result.content).toContain("focus failed");
  });
});

// NOTE: executeBrowserSnapshot tests live in
// `headless-browser-snapshot.test.ts`.

// browser_screenshot tests live in headless-browser-read-tools.test.ts
// (alongside browser_extract / browser_wait_for).

// ── browser_close ────────────────────────────────────────────────────

describe("executeBrowserClose", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
  });

  test("closes session page", async () => {
    const result = await executeBrowserClose({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "Browser page closed for this conversation",
    );
  });

  test("closes all pages when close_all_pages=true", async () => {
    const result = await executeBrowserClose({ close_all_pages: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("All browser pages and context closed");
  });
});

// ── browser_attach ──────────────────────────────────────────────────

describe("executeBrowserAttach", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
  });

  test("returns success on non-extension (local) backend", async () => {
    const result = await executeBrowserAttach({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Browser session ready");
  });
});

// ── browser_detach ──────────────────────────────────────────────────

describe("executeBrowserDetach", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
  });

  test("clears snapshot state and returns success on non-extension backend", async () => {
    const result = await executeBrowserDetach({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Browser debugger detached");
  });
});

// browser_extract tests live in headless-browser-read-tools.test.ts
// because it drives CDP via getCdpClient() rather than the
// Playwright page mock this file uses.

// ── browser_press_key ────────────────────────────────────────────────

describe("executeBrowserPressKey", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
    snapshotBackendNodeMaps.clear();
    sendHandler = defaultCdpHandler;
  });

  test("presses key on focused element when no target", async () => {
    const result = await executeBrowserPressKey({ key: "Enter" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Pressed "Enter"');
    // No target => no DOM.focus, no selector resolution. Enter is a
    // text-producing key (text "\r") so dispatchKeyPress emits
    // keyDown + char + keyUp.
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toEqual([
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]);
    const keyDown = sendCalls[0]!.params as Record<string, unknown>;
    const charEvt = sendCalls[1]!.params as Record<string, unknown>;
    const keyUp = sendCalls[2]!.params as Record<string, unknown>;
    expect(keyDown.type).toBe("keyDown");
    expect(keyDown.key).toBe("Enter");
    expect(keyDown.windowsVirtualKeyCode).toBe(13);
    expect(charEvt.type).toBe("char");
    expect(keyUp.type).toBe("keyUp");
    expect(keyUp.key).toBe("Enter");
  });

  test("presses key on targeted element via element_id", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e5", 555]]));
    const result = await executeBrowserPressKey(
      { key: "Tab", element_id: "e5" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Pressed "Tab" on element');
    expect(result.content).toContain('element_id "e5"');
    // Backend-resolved path: focus → dispatchKeyEvent × 3 (Tab is
    // text-producing so we also dispatch a char event).
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toEqual([
      "DOM.focus",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]);
    expect(sendCalls[0]!.params).toEqual({ backendNodeId: 555 });
  });

  test("presses key on targeted element via selector", async () => {
    const result = await executeBrowserPressKey(
      { key: "Escape", selector: "#dialog" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Pressed "Escape" on element');
    // Selector path: DOM.getDocument → DOM.querySelector → DOM.describeNode
    // → DOM.focus → dispatchKeyEvent × 2 (Escape has no text, so no char event).
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toEqual([
      "DOM.getDocument",
      "DOM.querySelector",
      "DOM.describeNode",
      "DOM.focus",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]);
  });

  test("errors when key is missing", async () => {
    const result = await executeBrowserPressKey({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("key is required");
    expect(sendCalls).toHaveLength(0);
  });

  test("errors when element_id not found", async () => {
    const result = await executeBrowserPressKey(
      { key: "Enter", element_id: "e99" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
    expect(sendCalls).toHaveLength(0);
  });

  test("surfaces CDP failure as a press-key error", async () => {
    sendHandler = () => new Error("Key not recognized");
    const result = await executeBrowserPressKey({ key: "InvalidKey" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Press key failed");
    expect(result.content).toContain("Key not recognized");
  });
});

// ── browser_scroll ───────────────────────────────────────────────────

describe("executeBrowserScroll", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
    sendHandler = defaultCdpHandler;
  });

  test("scrolls down by default amount", async () => {
    const result = await executeBrowserScroll({ direction: "down" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Scrolled down by 500px");
    // Runtime.evaluate for viewport dimensions, then a single
    // Input.dispatchMouseEvent mouseWheel at the viewport center.
    const evaluateCall = sendCalls.find((c) => c.method === "Runtime.evaluate");
    expect(evaluateCall).toBeDefined();
    expect((evaluateCall!.params as { expression: string }).expression).toBe(
      "({ w: window.innerWidth, h: window.innerHeight })",
    );
    const wheelCall = sendCalls.find(
      (c) => c.method === "Input.dispatchMouseEvent",
    );
    expect(wheelCall).toBeDefined();
    expect(wheelCall!.params).toEqual({
      type: "mouseWheel",
      x: 400,
      y: 300,
      deltaX: 0,
      deltaY: 500,
    });
  });

  test("scrolls up by custom amount", async () => {
    const result = await executeBrowserScroll(
      { direction: "up", amount: 300 },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Scrolled up by 300px");
    const wheelCall = sendCalls.find(
      (c) => c.method === "Input.dispatchMouseEvent",
    );
    expect(wheelCall!.params).toEqual({
      type: "mouseWheel",
      x: 400,
      y: 300,
      deltaX: 0,
      deltaY: -300,
    });
  });

  test("scrolls left", async () => {
    const result = await executeBrowserScroll(
      { direction: "left", amount: 200 },
      ctx,
    );
    expect(result.isError).toBe(false);
    const wheelCall = sendCalls.find(
      (c) => c.method === "Input.dispatchMouseEvent",
    );
    expect(wheelCall!.params).toEqual({
      type: "mouseWheel",
      x: 400,
      y: 300,
      deltaX: -200,
      deltaY: 0,
    });
  });

  test("scrolls right", async () => {
    const result = await executeBrowserScroll(
      { direction: "right", amount: 200 },
      ctx,
    );
    expect(result.isError).toBe(false);
    const wheelCall = sendCalls.find(
      (c) => c.method === "Input.dispatchMouseEvent",
    );
    expect(wheelCall!.params).toEqual({
      type: "mouseWheel",
      x: 400,
      y: 300,
      deltaX: 200,
      deltaY: 0,
    });
  });

  test("errors when direction is missing", async () => {
    const result = await executeBrowserScroll({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("direction is required");
    expect(sendCalls).toHaveLength(0);
  });

  test("errors when direction is invalid", async () => {
    const result = await executeBrowserScroll({ direction: "diagonal" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("direction is required");
    expect(sendCalls).toHaveLength(0);
  });

  test("surfaces CDP failure as a scroll error", async () => {
    sendHandler = () => new Error("viewport unavailable");
    const result = await executeBrowserScroll({ direction: "down" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Scroll failed");
    expect(result.content).toContain("viewport unavailable");
  });
});

// ── browser_select_option ────────────────────────────────────────────

/**
 * Default handler tuned for select-option tests. The Runtime.callFunctionOn
 * call now returns whether an option matched; tests assert on this
 * via `result.value`.
 */
function selectOptionHandler(
  matched = true,
): (method: string, params?: Record<string, unknown>) => unknown {
  return (method, _params) => {
    switch (method) {
      case "DOM.getDocument":
        return { root: { nodeId: 1 } };
      case "DOM.querySelector":
        return { nodeId: 42 };
      case "DOM.describeNode":
        return { node: { backendNodeId: 100 } };
      case "DOM.resolveNode":
        return { object: { objectId: "obj-1" } };
      case "Runtime.callFunctionOn":
        return { result: { value: matched } };
      default:
        return {};
    }
  };
}

describe("executeBrowserSelectOption", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
    snapshotBackendNodeMaps.clear();
    sendHandler = selectOptionHandler();
  });

  test("selects by value via element_id", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e4", 777]]));
    const result = await executeBrowserSelectOption(
      { element_id: "e4", value: "ca" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Selected option");
    expect(result.content).toContain('value="ca"');
    expect(result.content).toContain('element_id "e4"');

    // Expected CDP sequence: DOM.resolveNode → Runtime.callFunctionOn
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toEqual(["DOM.resolveNode", "Runtime.callFunctionOn"]);
    expect(sendCalls[0]!.params).toEqual({ backendNodeId: 777 });
    const callFn = sendCalls[1]!.params as {
      objectId: string;
      arguments: Array<{ value: unknown }>;
      returnByValue?: boolean;
    };
    expect(callFn.objectId).toBe("obj-1");
    expect(callFn.arguments).toEqual([
      { value: "ca" },
      { value: null },
      { value: null },
    ]);
    // returnByValue must be true so the matched boolean comes back
    // primitive instead of as a RemoteObject reference.
    expect(callFn.returnByValue).toBe(true);
  });

  test("selects by label", async () => {
    const result = await executeBrowserSelectOption(
      { selector: "#state", label: "California" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('label="California"');
    // Selector path: querySelectorBackendNodeId sequence + DOM.resolveNode + Runtime.callFunctionOn
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toEqual([
      "DOM.getDocument",
      "DOM.querySelector",
      "DOM.describeNode",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
    ]);
    const callFn = sendCalls[4]!.params as {
      arguments: Array<{ value: unknown }>;
    };
    expect(callFn.arguments).toEqual([
      { value: null },
      { value: "California" },
      { value: null },
    ]);
  });

  test("selects by index", async () => {
    const result = await executeBrowserSelectOption(
      { selector: "#state", index: 2 },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("index=2");
    const callFn = sendCalls.find((c) => c.method === "Runtime.callFunctionOn")!
      .params as { arguments: Array<{ value: unknown }> };
    expect(callFn.arguments).toEqual([
      { value: null },
      { value: null },
      { value: 2 },
    ]);
  });

  test("returns error when no option matches", async () => {
    sendHandler = selectOptionHandler(false);
    const result = await executeBrowserSelectOption(
      { selector: "#state", value: "nope" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Select option failed");
    expect(result.content).toContain("no option matched");
    expect(result.content).toContain('value="nope"');
  });

  test("dispatches input + change events via the function declaration", async () => {
    await executeBrowserSelectOption({ selector: "#state", value: "ca" }, ctx);
    const callFn = sendCalls.find((c) => c.method === "Runtime.callFunctionOn")!
      .params as { functionDeclaration: string };
    // The function body must dispatch BOTH input and change events
    // (HTML spec order: input fires before change for <select>).
    expect(callFn.functionDeclaration).toContain('new Event("input"');
    expect(callFn.functionDeclaration).toContain('new Event("change"');
    const inputIdx = callFn.functionDeclaration.indexOf('new Event("input"');
    const changeIdx = callFn.functionDeclaration.indexOf('new Event("change"');
    expect(inputIdx).toBeGreaterThanOrEqual(0);
    expect(changeIdx).toBeGreaterThan(inputIdx);
  });

  test("errors when no option specifier provided", async () => {
    const result = await executeBrowserSelectOption(
      { selector: "#state" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "One of value, label, or index is required",
    );
    expect(sendCalls).toHaveLength(0);
  });

  test("errors when neither element_id nor selector provided", async () => {
    const result = await executeBrowserSelectOption({ value: "ca" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Either element_id or selector is required",
    );
    expect(sendCalls).toHaveLength(0);
  });

  test("surfaces CDP failure as a select-option error", async () => {
    sendHandler = () => new Error("Not a select element");
    const result = await executeBrowserSelectOption(
      { selector: "#div", value: "x" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Select option failed");
    expect(result.content).toContain("Not a select element");
  });
});

// ── browser_hover ────────────────────────────────────────────────────

describe("executeBrowserHover (CDP)", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
    snapshotBackendNodeMaps.clear();
  });

  test("hovers by selector: emits a single mouseMoved event", async () => {
    installClickHoverCdpSend({ backendNodeId: 9000 });
    const result = await executeBrowserHover(
      { selector: ".menu-trigger" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Hovered element: .menu-trigger");

    // Selector path waits for the element to become visible via
    // cdpWaitForSelector before resolving the backend node.
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toEqual([
      "Runtime.evaluate",
      "DOM.getDocument",
      "DOM.querySelector",
      "DOM.describeNode",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getBoxModel",
      "Input.dispatchMouseEvent",
    ]);

    // Exactly ONE mouseMoved event (no press/release) → hover semantics.
    const mouseCalls = sendCalls.filter(
      (c) => c.method === "Input.dispatchMouseEvent",
    );
    expect(mouseCalls).toHaveLength(1);
    expect(mouseCalls[0]!.params).toMatchObject({
      type: "mouseMoved",
      x: 20,
      y: 30,
      button: "none",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(detachCalls).toBe(1);
  });

  test("hovers by element_id (backend path): skips DOM.querySelector", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e2", 12]]));
    installClickHoverCdpSend();

    const result = await executeBrowserHover({ element_id: "e2" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Hovered element: eid=e2");

    const methods = sendCalls.map((c) => c.method);
    expect(methods).not.toContain("DOM.querySelector");
    expect(methods).toEqual([
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getBoxModel",
      "Input.dispatchMouseEvent",
    ]);

    const scrollCall = sendCalls.find(
      (c) => c.method === "DOM.scrollIntoViewIfNeeded",
    )!;
    expect(scrollCall.params).toMatchObject({ backendNodeId: 12 });
  });

  test("errors when neither element_id nor selector provided", async () => {
    const result = await executeBrowserHover({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Either element_id or selector is required",
    );
    expect(sendCalls).toHaveLength(0);
  });

  test("errors when element_id not found in snapshot map", async () => {
    installClickHoverCdpSend();
    const result = await executeBrowserHover({ element_id: "e99" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
    expect(sendCalls).toHaveLength(0);
  });

  test("returns error + still disposes CdpClient when cdp.send throws", async () => {
    installClickHoverCdpSend({ throwFrom: "DOM.getBoxModel" });

    const result = await executeBrowserHover({ selector: "#gone" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Hover failed");
    expect(result.content).toContain("cdp boom");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(detachCalls).toBe(1);
  });
});

// ── Wrapper contract tests ───────────────────────────────────────────
// Verify that execution functions can be called the same way skill wrapper
// scripts invoke them: run(input, context) → ToolExecutionResult

describe("browser execution wrapper contract", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
    sendHandler = defaultCdpHandler;
    snapshotBackendNodeMaps.clear();
  });

  test("executeBrowserClick matches wrapper contract (input, context) → result", async () => {
    installClickHoverCdpSend();
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 1]]));
    const result = await executeBrowserClick({ element_id: "e1" }, ctx);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(typeof result.content).toBe("string");
    expect(typeof result.isError).toBe("boolean");
    expect(result.isError).toBe(false);
  });

  test("executeBrowserType matches wrapper contract", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e3", 555]]));
    const result = await executeBrowserType(
      { element_id: "e3", text: "hello" },
      ctx,
    );
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(result.isError).toBe(false);
  });

  // executeBrowserSnapshot wrapper-contract check lives in
  // `headless-browser-snapshot.test.ts`.

  // wrapper contract for executeBrowserExtract and
  // executeBrowserScreenshot lives in
  // headless-browser-read-tools.test.ts.

  test("executeBrowserPressKey matches wrapper contract", async () => {
    const result = await executeBrowserPressKey({ key: "Enter" }, ctx);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(result.isError).toBe(false);
  });

  test("executeBrowserClose matches wrapper contract", async () => {
    const result = await executeBrowserClose({}, ctx);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(result.isError).toBe(false);
  });

  test("executeBrowserScroll matches wrapper contract", async () => {
    const result = await executeBrowserScroll({ direction: "down" }, ctx);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(result.isError).toBe(false);
  });

  test("executeBrowserSelectOption matches wrapper contract", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e4", 777]]));
    const result = await executeBrowserSelectOption(
      { element_id: "e4", value: "opt1" },
      ctx,
    );
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(result.isError).toBe(false);
  });

  test("executeBrowserHover matches wrapper contract", async () => {
    installClickHoverCdpSend();
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e2", 2]]));
    const result = await executeBrowserHover({ element_id: "e2" }, ctx);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(result.isError).toBe(false);
  });

  test("error results have isError: true", async () => {
    const result = await executeBrowserClick({}, ctx);
    expect(result.isError).toBe(true);
    expect(typeof result.content).toBe("string");
  });
});
