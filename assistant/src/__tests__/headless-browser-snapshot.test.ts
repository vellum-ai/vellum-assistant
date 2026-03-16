import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp/headless-browser-snapshot-test",
}));

let mockPage: {
  evaluate: ReturnType<typeof mock>;
  title: ReturnType<typeof mock>;
  url: ReturnType<typeof mock>;
  goto: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
  isClosed: () => boolean;
};

let closeSessionPageMock: ReturnType<typeof mock>;
let closeAllPagesMock: ReturnType<typeof mock>;
let storeSnapshotMapMock: ReturnType<typeof mock>;
let storedMaps: Map<string, Map<string, string>>;

mock.module("../tools/browser/browser-manager.js", () => {
  storedMaps = new Map();
  closeSessionPageMock = mock(async () => {});
  closeAllPagesMock = mock(async () => {});
  storeSnapshotMapMock = mock(
    (conversationId: string, map: Map<string, string>) => {
      storedMaps.set(conversationId, map);
    },
  );
  return {
    browserManager: {
      getOrCreateSessionPage: async () => mockPage,
      closeSessionPage: closeSessionPageMock,
      closeAllPages: closeAllPagesMock,
      storeSnapshotMap: storeSnapshotMapMock,
      resolveSnapshotSelector: (conversationId: string, elementId: string) => {
        const map = storedMaps.get(conversationId);
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

import {
  executeBrowserClose,
  executeBrowserSnapshot,
} from "../tools/browser/browser-execution.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  conversationId: "test-conversation",
  workingDir: "/tmp",
  trustClass: "guardian",
};

function resetMockPage() {
  mockPage = {
    evaluate: mock(async () => []),
    title: mock(async () => "Test Page"),
    url: mock(() => "https://example.com/"),
    goto: mock(async () => ({
      status: () => 200,
      url: () => "https://example.com/",
    })),
    close: mock(async () => {}),
    isClosed: () => false,
  };
}

// ── browser_snapshot ─────────────────────────────────────────────────

describe("executeBrowserSnapshot", () => {
  beforeEach(() => {
    resetMockPage();
    storedMaps.clear();
    storeSnapshotMapMock.mockClear();
  });

  test("returns page URL and title with no elements", async () => {
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("URL: https://example.com/");
    expect(result.content).toContain("Title: Test Page");
    expect(result.content).toContain("(no interactive elements found)");
  });

  test("lists interactive elements with element IDs", async () => {
    mockPage.evaluate = mock(async () => [
      { eid: "e1", tag: "a", attrs: { href: "/about" }, text: "About Us" },
      { eid: "e2", tag: "button", attrs: {}, text: "Submit" },
      {
        eid: "e3",
        tag: "input",
        attrs: { type: "text", name: "email", placeholder: "Email" },
        text: "",
      },
    ]);

    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('[e1] <a href="/about"> About Us');
    expect(result.content).toContain("[e2] <button> Submit");
    expect(result.content).toContain(
      '[e3] <input type="text" name="email" placeholder="Email">',
    );
    expect(result.content).toContain("3 interactive elements found.");
  });

  test("stores selector map in browser manager", async () => {
    mockPage.evaluate = mock(async () => [
      { eid: "e1", tag: "a", attrs: { href: "/" }, text: "Home" },
      { eid: "e2", tag: "button", attrs: {}, text: "OK" },
    ]);

    await executeBrowserSnapshot({}, ctx);
    expect(storeSnapshotMapMock).toHaveBeenCalledTimes(1);

    const stored = storedMaps.get("test-conversation");
    expect(stored).toBeDefined();
    expect(stored!.get("e1")).toBe('[data-vellum-eid="e1"]');
    expect(stored!.get("e2")).toBe('[data-vellum-eid="e2"]');
  });

  test("handles single element with singular count", async () => {
    mockPage.evaluate = mock(async () => [
      { eid: "e1", tag: "button", attrs: {}, text: "Click" },
    ]);

    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.content).toContain("1 interactive element found.");
  });

  test("handles evaluate error", async () => {
    mockPage.evaluate = mock(async () => {
      throw new Error("page crashed");
    });
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Snapshot failed");
    expect(result.content).toContain("page crashed");
  });

  test("shows (none) for empty title", async () => {
    mockPage.title = mock(async () => "");
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.content).toContain("Title: (none)");
  });
});

// ── browser_close ────────────────────────────────────────────────────

describe("executeBrowserClose", () => {
  beforeEach(() => {
    resetMockPage();
    closeSessionPageMock.mockClear();
    closeAllPagesMock.mockClear();
  });

  test("closes session page by default", async () => {
    const result = await executeBrowserClose({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Browser page closed for this session.");
    expect(closeSessionPageMock).toHaveBeenCalledWith("test-conversation");
    expect(closeAllPagesMock).not.toHaveBeenCalled();
  });

  test("closes all pages with close_all_pages=true", async () => {
    const result = await executeBrowserClose({ close_all_pages: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("All browser pages and context closed.");
    expect(closeAllPagesMock).toHaveBeenCalledTimes(1);
    expect(closeSessionPageMock).not.toHaveBeenCalled();
  });

  test("handles close error", async () => {
    closeSessionPageMock.mockImplementation(async () => {
      throw new Error("close failed");
    });
    const result = await executeBrowserClose({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Close failed");
    expect(result.content).toContain("close failed");
  });
});
