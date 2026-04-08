import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

/**
 * Fake CDP session used by the tools that have been migrated to
 * CdpClient (type, press_key, select_option, scroll). Each
 * `session.send(method, params)` call is recorded in `sendCalls` and
 * routed to `sendHandler`, which tests configure per-case. The
 * handler returns either a CDP response object or an `Error` to
 * simulate transport failure.
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

function resetCdpMock() {
  sendCalls = [];
  sendHandler = () => ({});
}

const fakeCdpSession = {
  send: async (method: string, params?: Record<string, unknown>) => {
    sendCalls.push({ method, params });
    const value = sendHandler(method, params);
    if (value instanceof Error) throw value;
    return value;
  },
  detach: async () => {},
};

/**
 * The Playwright mock page backs two code paths:
 *   • executeBrowserClick / executeBrowserHover drive the Playwright
 *     `page.click` / `page.hover` methods directly.
 *   • The CDP-migrated tools (type, press_key, select_option,
 *     scroll) only use `page.context().newCDPSession(page)` to grab a
 *     CDP session, which is wired to `fakeCdpSession` above.
 */
let mockPage: {
  click: ReturnType<typeof mock>;
  hover: ReturnType<typeof mock>;
  close: () => Promise<void>;
  isClosed: () => boolean;
  context: () => {
    newCDPSession: (page: unknown) => Promise<typeof fakeCdpSession>;
  };
};

let snapshotStringMaps: Map<string, Map<string, string>>;
let snapshotBackendNodeMaps: Map<string, Map<string, number>>;

mock.module("../tools/browser/browser-manager.js", () => {
  snapshotStringMaps = new Map();
  snapshotBackendNodeMaps = new Map();
  return {
    browserManager: {
      getOrCreateSessionPage: async () => mockPage,
      closeSessionPage: async () => {},
      closeAllPages: async () => {},
      storeSnapshotMap: (conversationId: string, map: Map<string, string>) => {
        snapshotStringMaps.set(conversationId, map);
      },
      storeSnapshotBackendNodeMap: (
        conversationId: string,
        map: Map<string, number>,
      ) => {
        snapshotBackendNodeMaps.set(conversationId, map);
      },
      resolveSnapshotSelector: (conversationId: string, elementId: string) => {
        const map = snapshotStringMaps.get(conversationId);
        if (!map) return null;
        return map.get(elementId) ?? null;
      },
      resolveSnapshotBackendNodeId: (
        conversationId: string,
        elementId: string,
      ) => {
        const map = snapshotBackendNodeMaps.get(conversationId);
        if (!map) return null;
        return map.get(elementId) ?? null;
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
  executeBrowserClick,
  executeBrowserClose,
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
    click: mock(async () => {}),
    hover: mock(async () => {}),
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
    default:
      return {};
  }
}

// ── browser_click ────────────────────────────────────────────────────

describe("executeBrowserClick", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
    snapshotStringMaps.clear();
    snapshotBackendNodeMaps.clear();
  });

  test("clicks by element_id via snapshot map", async () => {
    snapshotStringMaps.set(
      "test-conversation",
      new Map([["e1", '[data-vellum-eid="e1"]']]),
    );
    const result = await executeBrowserClick({ element_id: "e1" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Clicked element");
    expect(mockPage.click).toHaveBeenCalledWith('[data-vellum-eid="e1"]', {
      timeout: 10000,
    });
  });

  test("clicks by raw selector", async () => {
    const result = await executeBrowserClick({ selector: "#submit-btn" }, ctx);
    expect(result.isError).toBe(false);
    expect(mockPage.click).toHaveBeenCalledWith("#submit-btn", {
      timeout: 10000,
    });
  });

  test("prefers element_id over selector", async () => {
    snapshotStringMaps.set(
      "test-conversation",
      new Map([["e1", '[data-vellum-eid="e1"]']]),
    );
    const result = await executeBrowserClick(
      { element_id: "e1", selector: "#other" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(mockPage.click).toHaveBeenCalledWith('[data-vellum-eid="e1"]', {
      timeout: 10000,
    });
  });

  test("errors when neither element_id nor selector provided", async () => {
    const result = await executeBrowserClick({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Either element_id or selector is required",
    );
  });

  test("errors when element_id not found in snapshot map", async () => {
    const result = await executeBrowserClick({ element_id: "e99" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
    expect(result.content).toContain("browser_snapshot");
  });

  test("errors when snapshot map is missing for session", async () => {
    const result = await executeBrowserClick({ element_id: "e1" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  test("handles click error from page", async () => {
    mockPage.click = mock(async () => {
      throw new Error("Element not visible");
    });
    const result = await executeBrowserClick({ selector: "#hidden" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Click failed");
    expect(result.content).toContain("Element not visible");
  });
});

// ── browser_type ─────────────────────────────────────────────────────

describe("executeBrowserType", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
    snapshotStringMaps.clear();
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
    // Input.insertText must come before the Enter keyDown/keyUp.
    const insertIdx = methods.indexOf("Input.insertText");
    const keyDownIdx = methods.findIndex(
      (m, i) =>
        m === "Input.dispatchKeyEvent" &&
        (sendCalls[i]!.params as { type: string }).type === "keyDown",
    );
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(keyDownIdx).toBeGreaterThan(insertIdx);
    const keyEvents = sendCalls.filter(
      (c) => c.method === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(2);
    expect((keyEvents[0]!.params as { key: string }).key).toBe("Enter");
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

// browser_extract tests live in headless-browser-read-tools.test.ts
// because it drives CDP via getCdpClient() rather than the
// Playwright page mock this file uses.

// ── browser_press_key ────────────────────────────────────────────────

describe("executeBrowserPressKey", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
    snapshotStringMaps.clear();
    snapshotBackendNodeMaps.clear();
    sendHandler = defaultCdpHandler;
  });

  test("presses key on focused element when no target", async () => {
    const result = await executeBrowserPressKey({ key: "Enter" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Pressed "Enter"');
    // No target => no DOM.focus, no selector resolution, just keyDown + keyUp.
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toEqual([
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]);
    const keyDown = sendCalls[0]!.params as { type: string; key: string };
    const keyUp = sendCalls[1]!.params as { type: string; key: string };
    expect(keyDown.type).toBe("keyDown");
    expect(keyDown.key).toBe("Enter");
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
    // Backend-resolved path: focus → dispatchKeyEvent × 2
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toEqual([
      "DOM.focus",
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
    // → DOM.focus → dispatchKeyEvent × 2
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

describe("executeBrowserSelectOption", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
    snapshotStringMaps.clear();
    snapshotBackendNodeMaps.clear();
    sendHandler = defaultCdpHandler;
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
    };
    expect(callFn.objectId).toBe("obj-1");
    expect(callFn.arguments).toEqual([
      { value: "ca" },
      { value: null },
      { value: null },
    ]);
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

describe("executeBrowserHover", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
    snapshotStringMaps.clear();
    snapshotBackendNodeMaps.clear();
  });

  test("hovers by element_id via snapshot map", async () => {
    snapshotStringMaps.set(
      "test-conversation",
      new Map([["e2", '[data-vellum-eid="e2"]']]),
    );
    const result = await executeBrowserHover({ element_id: "e2" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Hovered element");
    expect(mockPage.hover).toHaveBeenCalledWith('[data-vellum-eid="e2"]', {
      timeout: 10000,
    });
  });

  test("hovers by raw selector", async () => {
    const result = await executeBrowserHover(
      { selector: ".menu-trigger" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(mockPage.hover).toHaveBeenCalledWith(".menu-trigger", {
      timeout: 10000,
    });
  });

  test("errors when neither element_id nor selector provided", async () => {
    const result = await executeBrowserHover({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Either element_id or selector is required",
    );
  });

  test("errors when element_id not found in snapshot map", async () => {
    const result = await executeBrowserHover({ element_id: "e99" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
  });

  test("handles hover error from page", async () => {
    mockPage.hover = mock(async () => {
      throw new Error("Element detached");
    });
    const result = await executeBrowserHover({ selector: "#gone" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Hover failed");
    expect(result.content).toContain("Element detached");
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
    snapshotStringMaps.clear();
    snapshotBackendNodeMaps.clear();
  });

  test("executeBrowserClick matches wrapper contract (input, context) → result", async () => {
    snapshotStringMaps.set(
      "test-conversation",
      new Map([["e1", '[data-vellum-eid="e1"]']]),
    );
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
    snapshotStringMaps.set(
      "test-conversation",
      new Map([["e2", '[data-vellum-eid="e2"]']]),
    );
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
