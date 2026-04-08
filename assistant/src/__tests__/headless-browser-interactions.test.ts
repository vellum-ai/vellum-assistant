import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let mockPage: {
  fill: ReturnType<typeof mock>;
  press: ReturnType<typeof mock>;
  evaluate: ReturnType<typeof mock>;
  title: ReturnType<typeof mock>;
  url: ReturnType<typeof mock>;
  goto: ReturnType<typeof mock>;
  selectOption: ReturnType<typeof mock>;
  close: () => Promise<void>;
  isClosed: () => boolean;
  keyboard: { press: ReturnType<typeof mock> };
  mouse: { wheel: ReturnType<typeof mock>; move: ReturnType<typeof mock> };
  // CDP routing surface. LocalCdpClient lazily calls
  // `page.context().newCDPSession()` on the first `send`, which lets
  // the real factory + LocalCdpClient run against our in-memory
  // handler without having to mock `factory.js` or `local-cdp-client.js`
  // (both of which would bleed into other test files via bun's shared
  // mock registry).
  context: () => {
    newCDPSession: () => Promise<{
      send: (
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
      detach: () => Promise<void>;
    }>;
  };
};

/**
 * Shared fake CDP session state. Tests that exercise the CDP-migrated
 * tools (click, hover) install a custom `cdpSend` implementation in
 * their setup, then assert against `cdpCalls` and `detachCalls` after
 * the tool runs.
 */
type CdpCall = { method: string; params: Record<string, unknown> };
let cdpCalls: CdpCall[] = [];
let cdpSend: (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;
let detachCalls: number;

let snapshotMaps: Map<string, Map<string, string>>;
let snapshotBackendNodeMaps: Map<string, Map<string, number>>;

mock.module("../tools/browser/browser-manager.js", () => {
  snapshotMaps = new Map();
  snapshotBackendNodeMaps = new Map();
  return {
    browserManager: {
      getOrCreateSessionPage: async () => mockPage,
      closeSessionPage: async () => {},
      closeAllPages: async () => {},
      storeSnapshotMap: (conversationId: string, map: Map<string, string>) => {
        snapshotMaps.set(conversationId, map);
      },
      resolveSnapshotSelector: (conversationId: string, elementId: string) => {
        const map = snapshotMaps.get(conversationId);
        if (!map) return null;
        return map.get(elementId) ?? null;
      },
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
  const fakeSession = {
    send: async (method: string, params?: Record<string, unknown>) => {
      cdpCalls.push({ method, params: params ?? {} });
      return cdpSend(method, params);
    },
    detach: async () => {
      detachCalls += 1;
    },
  };
  mockPage = {
    fill: mock(async () => {}),
    press: mock(async () => {}),
    evaluate: mock(async () => ""),
    title: mock(async () => "Test Page"),
    url: mock(() => "https://example.com/"),
    goto: mock(async () => ({
      status: () => 200,
      url: () => "https://example.com/",
    })),
    selectOption: mock(async () => []),
    close: async () => {},
    isClosed: () => false,
    keyboard: { press: mock(async () => {}) },
    mouse: { wheel: mock(async () => {}), move: mock(async () => {}) },
    context: () => ({
      newCDPSession: async () => fakeSession,
    }),
  };
}

function resetCdpState() {
  cdpCalls = [];
  detachCalls = 0;
  cdpSend = async () => ({});
}

/**
 * Install a default CDP `send` handler that returns canned success
 * responses for the methods click + hover touch
 * (`DOM.getDocument`, `DOM.querySelector`, `DOM.describeNode`,
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

  cdpSend = async (method, _params) => {
    if (throwFrom === method) {
      throw new Error("cdp boom");
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
      default:
        return {};
    }
  };
}

// ── browser_click ────────────────────────────────────────────────────

describe("executeBrowserClick (CDP)", () => {
  beforeEach(() => {
    resetCdpState();
    resetMockPage();
    snapshotMaps.clear();
    snapshotBackendNodeMaps.clear();
  });

  test("clicks by selector: runs full DOM → Input.dispatchMouseEvent chain", async () => {
    installClickHoverCdpSend({ backendNodeId: 5555 });
    const result = await executeBrowserClick({ selector: "#submit-btn" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Clicked element: #submit-btn");

    // Expected CDP call sequence for the selector path:
    const methods = cdpCalls.map((c) => c.method);
    expect(methods).toEqual([
      "DOM.getDocument",
      "DOM.querySelector",
      "DOM.describeNode",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getBoxModel",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);

    // Arguments threaded through correctly.
    const qsCall = cdpCalls.find((c) => c.method === "DOM.querySelector")!;
    expect(qsCall.params).toMatchObject({ nodeId: 1, selector: "#submit-btn" });
    const scrollCall = cdpCalls.find(
      (c) => c.method === "DOM.scrollIntoViewIfNeeded",
    )!;
    expect(scrollCall.params).toMatchObject({ backendNodeId: 5555 });
    const boxCall = cdpCalls.find((c) => c.method === "DOM.getBoxModel")!;
    expect(boxCall.params).toMatchObject({ backendNodeId: 5555 });

    // All three mouse events land on the quad midpoint (20, 30).
    const mouseCalls = cdpCalls.filter(
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

    const methods = cdpCalls.map((c) => c.method);
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
    const scrollCall = cdpCalls.find(
      (c) => c.method === "DOM.scrollIntoViewIfNeeded",
    )!;
    expect(scrollCall.params).toMatchObject({ backendNodeId: 42 });
    const boxCall = cdpCalls.find((c) => c.method === "DOM.getBoxModel")!;
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
    const methods = cdpCalls.map((c) => c.method);
    expect(methods).not.toContain("DOM.querySelector");
  });

  test("errors when neither element_id nor selector provided", async () => {
    const result = await executeBrowserClick({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Either element_id or selector is required",
    );
    // No CDP session should have been opened at all.
    expect(cdpCalls).toHaveLength(0);
    expect(detachCalls).toBe(0);
  });

  test("errors when element_id not found in snapshot map", async () => {
    installClickHoverCdpSend();
    const result = await executeBrowserClick({ element_id: "e99" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
    expect(result.content).toContain("browser_snapshot");
    // Resolution failed before acquiring a CdpClient.
    expect(cdpCalls).toHaveLength(0);
  });

  test("errors when snapshot backend-node map is missing for session", async () => {
    installClickHoverCdpSend();
    const result = await executeBrowserClick({ element_id: "e1" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
    expect(cdpCalls).toHaveLength(0);
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
});

// ── browser_type ─────────────────────────────────────────────────────

describe("executeBrowserType", () => {
  beforeEach(() => {
    resetMockPage();
    snapshotMaps.clear();
  });

  test("types with element_id and default clear_first=true", async () => {
    snapshotMaps.set(
      "test-conversation",
      new Map([["e3", '[data-vellum-eid="e3"]']]),
    );
    const result = await executeBrowserType(
      { element_id: "e3", text: "hello" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Typed into element");
    expect(result.content).toContain("cleared existing content");
    expect(mockPage.fill).toHaveBeenCalledWith(
      '[data-vellum-eid="e3"]',
      "hello",
      { timeout: 10000 },
    );
  });

  test("types with raw selector", async () => {
    const result = await executeBrowserType(
      { selector: 'input[name="email"]', text: "test" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(mockPage.fill).toHaveBeenCalledWith('input[name="email"]', "test", {
      timeout: 10000,
    });
  });

  test("appends text when clear_first=false", async () => {
    mockPage.evaluate = mock(async () => "existing");
    const result = await executeBrowserType(
      { selector: "#input", text: " more", clear_first: false },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(mockPage.evaluate).toHaveBeenCalled();
    expect(mockPage.fill).toHaveBeenCalledWith("#input", "existing more", {
      timeout: 10000,
    });
    expect(result.content).not.toContain("cleared");
  });

  test("presses Enter after typing when press_enter=true", async () => {
    const result = await executeBrowserType(
      { selector: "#search", text: "query", press_enter: true },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("pressed Enter");
    expect(mockPage.fill).toHaveBeenCalledWith("#search", "query", {
      timeout: 10000,
    });
    expect(mockPage.press).toHaveBeenCalledWith("#search", "Enter");
  });

  test("errors when text is missing", async () => {
    const result = await executeBrowserType({ selector: "#input" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("text is required");
  });

  test("errors when text is empty string", async () => {
    const result = await executeBrowserType(
      { selector: "#input", text: "" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("text is required");
  });

  test("errors when neither element_id nor selector provided", async () => {
    const result = await executeBrowserType({ text: "hello" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Either element_id or selector is required",
    );
  });

  test("errors when element_id not found", async () => {
    const result = await executeBrowserType(
      { element_id: "e99", text: "hello" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
  });

  test("handles type error from page", async () => {
    mockPage.fill = mock(async () => {
      throw new Error("Element is not an input");
    });
    const result = await executeBrowserType(
      { selector: "#div", text: "hello" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Type failed");
    expect(result.content).toContain("Element is not an input");
  });
});

// NOTE: executeBrowserSnapshot tests live in
// `headless-browser-snapshot.test.ts`. The snapshot tool now talks to
// CDP via `getCdpClient` (no longer Playwright `page.evaluate`), so its
// mocking surface is incompatible with the Playwright `mockPage`
// scaffolding used here. The interactions file continues to drive the
// still-Playwright-backed click/type/hover/etc. tools through the
// `browserManager.snapshotMaps` bridge the snapshot tool writes.

// browser_screenshot tests live in headless-browser-read-tools.test.ts
// (alongside browser_extract / browser_wait_for) because it drives
// CDP via getCdpClient() rather than the Playwright page mock this
// file uses for the interaction-oriented tools.

// ── browser_close ────────────────────────────────────────────────────

describe("executeBrowserClose", () => {
  beforeEach(() => {
    resetMockPage();
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
    snapshotMaps.clear();
  });

  test("presses key on page (focused element) when no target", async () => {
    const result = await executeBrowserPressKey({ key: "Enter" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Pressed "Enter"');
    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Enter");
  });

  test("presses key on targeted element via element_id", async () => {
    snapshotMaps.set(
      "test-conversation",
      new Map([["e5", '[data-vellum-eid="e5"]']]),
    );
    const result = await executeBrowserPressKey(
      { key: "Tab", element_id: "e5" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Pressed "Tab" on element');
    expect(mockPage.press).toHaveBeenCalledWith(
      '[data-vellum-eid="e5"]',
      "Tab",
    );
  });

  test("presses key on targeted element via selector", async () => {
    const result = await executeBrowserPressKey(
      { key: "Escape", selector: "#dialog" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Pressed "Escape" on element');
    expect(mockPage.press).toHaveBeenCalledWith("#dialog", "Escape");
  });

  test("errors when key is missing", async () => {
    const result = await executeBrowserPressKey({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("key is required");
  });

  test("errors when element_id not found", async () => {
    const result = await executeBrowserPressKey(
      { key: "Enter", element_id: "e99" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
  });

  test("handles press key error from page", async () => {
    mockPage.keyboard.press = mock(async () => {
      throw new Error("Key not recognized");
    });
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
    snapshotMaps.clear();
  });

  test("scrolls down by default amount", async () => {
    const result = await executeBrowserScroll({ direction: "down" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Scrolled down by 500px");
    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, 500);
  });

  test("scrolls up by custom amount", async () => {
    const result = await executeBrowserScroll(
      { direction: "up", amount: 300 },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Scrolled up by 300px");
    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, -300);
  });

  test("scrolls left", async () => {
    const result = await executeBrowserScroll(
      { direction: "left", amount: 200 },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(-200, 0);
  });

  test("scrolls right", async () => {
    const result = await executeBrowserScroll(
      { direction: "right", amount: 200 },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(200, 0);
  });

  test("errors when direction is missing", async () => {
    const result = await executeBrowserScroll({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("direction is required");
  });

  test("errors when direction is invalid", async () => {
    const result = await executeBrowserScroll({ direction: "diagonal" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("direction is required");
  });
});

// ── browser_select_option ────────────────────────────────────────────

describe("executeBrowserSelectOption", () => {
  beforeEach(() => {
    resetMockPage();
    snapshotMaps.clear();
  });

  test("selects by value via element_id", async () => {
    snapshotMaps.set(
      "test-conversation",
      new Map([["e4", '[data-vellum-eid="e4"]']]),
    );
    const result = await executeBrowserSelectOption(
      { element_id: "e4", value: "ca" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Selected option");
    expect(result.content).toContain('value="ca"');
    expect(mockPage.selectOption).toHaveBeenCalledWith(
      '[data-vellum-eid="e4"]',
      { value: "ca" },
    );
  });

  test("selects by label", async () => {
    const result = await executeBrowserSelectOption(
      { selector: "#state", label: "California" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('label="California"');
    expect(mockPage.selectOption).toHaveBeenCalledWith("#state", {
      label: "California",
    });
  });

  test("selects by index", async () => {
    const result = await executeBrowserSelectOption(
      { selector: "#state", index: 2 },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("index=2");
    expect(mockPage.selectOption).toHaveBeenCalledWith("#state", { index: 2 });
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
  });

  test("errors when neither element_id nor selector provided", async () => {
    const result = await executeBrowserSelectOption({ value: "ca" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Either element_id or selector is required",
    );
  });

  test("handles select option error from page", async () => {
    mockPage.selectOption = mock(async () => {
      throw new Error("Not a select element");
    });
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
    resetCdpState();
    resetMockPage();
    snapshotMaps.clear();
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

    const methods = cdpCalls.map((c) => c.method);
    expect(methods).toEqual([
      "DOM.getDocument",
      "DOM.querySelector",
      "DOM.describeNode",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getBoxModel",
      "Input.dispatchMouseEvent",
    ]);

    // Exactly ONE mouseMoved event (no press/release) → hover semantics.
    const mouseCalls = cdpCalls.filter(
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

    const methods = cdpCalls.map((c) => c.method);
    expect(methods).not.toContain("DOM.querySelector");
    expect(methods).toEqual([
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getBoxModel",
      "Input.dispatchMouseEvent",
    ]);

    const scrollCall = cdpCalls.find(
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
    expect(cdpCalls).toHaveLength(0);
  });

  test("errors when element_id not found in snapshot map", async () => {
    installClickHoverCdpSend();
    const result = await executeBrowserHover({ element_id: "e99" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
    expect(cdpCalls).toHaveLength(0);
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
    resetCdpState();
    resetMockPage();
    snapshotMaps.clear();
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
    snapshotMaps.set(
      "test-conversation",
      new Map([["e3", '[data-vellum-eid="e3"]']]),
    );
    const result = await executeBrowserType(
      { element_id: "e3", text: "hello" },
      ctx,
    );
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(result.isError).toBe(false);
  });

  // executeBrowserSnapshot wrapper-contract check lives in
  // `headless-browser-snapshot.test.ts` since the tool now talks to CDP
  // and can't reuse this file's Playwright mock surface.

  // wrapper contract for executeBrowserExtract and
  // executeBrowserScreenshot lives in
  // headless-browser-read-tools.test.ts alongside their
  // CDP-driven tests.

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
    snapshotMaps.set(
      "test-conversation",
      new Map([["e4", '[data-vellum-eid="e4"]']]),
    );
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
