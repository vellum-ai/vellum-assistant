import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock platform so we don't touch real ~/.vellum
const testDataDir = "/tmp/browser-manager-test";
mock.module("../util/platform.js", () => ({
  getDataDir: () => testDataDir,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  browserManager,
  sanitizeDownloadFilename,
  setLaunchFn,
} from "../tools/browser/browser-manager.js";

function createMockPage(closed = false) {
  let _closed = closed;
  return {
    close: async () => {
      _closed = true;
    },
    isClosed: () => _closed,
    goto: async () => ({ status: () => 200, url: () => "about:blank" }),
    title: async () => "",
    url: () => "about:blank",
    evaluate: async () => null,
    click: async () => {},
    fill: async () => {},
    press: async () => {},
    selectOption: async () => [] as string[],
    hover: async () => {},
    waitForSelector: async () => null,
    waitForFunction: async () => null,
    route: async () => {},
    unroute: async () => {},
    screenshot: async () => Buffer.from(""),
    keyboard: { press: async () => {} },
    mouse: {
      click: async () => {},
      move: async () => {},
      wheel: async () => {},
    },
    bringToFront: async () => {},
    on: () => {},
  };
}

function createMockContext() {
  const pages: ReturnType<typeof createMockPage>[] = [];
  let closed = false;
  return {
    context: {
      newPage: async () => {
        const page = createMockPage();
        pages.push(page);
        return page;
      },
      close: async () => {
        closed = true;
      },
    },
    get pages() {
      return pages;
    },
    get closed() {
      return closed;
    },
  };
}

describe("sanitizeDownloadFilename", () => {
  test("keeps a normal filename", () => {
    expect(sanitizeDownloadFilename("report.json")).toBe("report.json");
  });

  test("removes traversal segments and separators", () => {
    expect(sanitizeDownloadFilename("../../.ssh/authorized_keys")).toBe(
      "authorized_keys",
    );
    expect(
      sanitizeDownloadFilename("..\\..\\windows\\system32\\drivers\\etc\\hosts"),
    ).toBe("hosts");
  });

  test("falls back to safe default for empty or dot paths", () => {
    expect(sanitizeDownloadFilename("   ")).toBe("download");
    expect(sanitizeDownloadFilename(".")).toBe("download");
    expect(sanitizeDownloadFilename("..")).toBe("download");
  });
});

describe("BrowserManager", () => {
  let mockCtx: ReturnType<typeof createMockContext>;

  beforeEach(async () => {
    // Close any existing context from prior tests
    await browserManager.closeAllPages();

    mockCtx = createMockContext();
    setLaunchFn(async () => mockCtx.context);
  });

  // ── getOrCreateSessionPage ───────────────────────────────────

  describe("getOrCreateSessionPage", () => {
    test("creates a new page for a new session", async () => {
      const page = await browserManager.getOrCreateSessionPage("s1");
      expect(page).toBeDefined();
      expect(page.isClosed()).toBe(false);
      expect(mockCtx.pages).toHaveLength(1);
    });

    test("returns same page for same session", async () => {
      const page1 = await browserManager.getOrCreateSessionPage("s1");
      const page2 = await browserManager.getOrCreateSessionPage("s1");
      expect(page1).toBe(page2);
      expect(mockCtx.pages).toHaveLength(1);
    });

    test("creates different pages for different sessions", async () => {
      const page1 = await browserManager.getOrCreateSessionPage("s1");
      const page2 = await browserManager.getOrCreateSessionPage("s2");
      expect(page1).not.toBe(page2);
      expect(mockCtx.pages).toHaveLength(2);
    });

    test("replaces closed page with new one", async () => {
      const page1 = await browserManager.getOrCreateSessionPage("s1");
      await page1.close();
      expect(page1.isClosed()).toBe(true);

      const page2 = await browserManager.getOrCreateSessionPage("s1");
      expect(page2).not.toBe(page1);
      expect(page2.isClosed()).toBe(false);
      expect(mockCtx.pages).toHaveLength(2);
    });

    test("lazily creates browser context on first page request", async () => {
      expect(browserManager.hasContext()).toBe(false);
      await browserManager.getOrCreateSessionPage("s1");
      expect(browserManager.hasContext()).toBe(true);
    });

    test("reuses browser context across sessions", async () => {
      await browserManager.getOrCreateSessionPage("s1");
      await browserManager.getOrCreateSessionPage("s2");
      // Only one context was created (launchFn called once)
      expect(browserManager.hasContext()).toBe(true);
    });
  });

  // ── closeSessionPage ─────────────────────────────────────────

  describe("closeSessionPage", () => {
    test("closes an open session page", async () => {
      const page = await browserManager.getOrCreateSessionPage("s1");
      await browserManager.closeSessionPage("s1");
      expect(page.isClosed()).toBe(true);
    });

    test("is safe to call for non-existent session", async () => {
      await browserManager.closeSessionPage("nonexistent");
      // Should not throw
    });

    test("clears snapshot map for the session", async () => {
      await browserManager.getOrCreateSessionPage("s1");
      browserManager.storeSnapshotMap("s1", new Map([["e1", "#btn"]]));
      expect(browserManager.resolveSnapshotSelector("s1", "e1")).toBe("#btn");

      await browserManager.closeSessionPage("s1");
      expect(browserManager.resolveSnapshotSelector("s1", "e1")).toBeNull();
    });
  });

  // ── closeAllPages ────────────────────────────────────────────

  describe("closeAllPages", () => {
    test("closes all session pages and browser context", async () => {
      const page1 = await browserManager.getOrCreateSessionPage("s1");
      const page2 = await browserManager.getOrCreateSessionPage("s2");

      await browserManager.closeAllPages();

      expect(page1.isClosed()).toBe(true);
      expect(page2.isClosed()).toBe(true);
      expect(mockCtx.closed).toBe(true);
      expect(browserManager.hasContext()).toBe(false);
    });

    test("is safe to call when no pages or context exist", async () => {
      await browserManager.closeAllPages();
      // Should not throw
    });

    test("clears all snapshot maps", async () => {
      await browserManager.getOrCreateSessionPage("s1");
      await browserManager.getOrCreateSessionPage("s2");
      browserManager.storeSnapshotMap("s1", new Map([["e1", "#a"]]));
      browserManager.storeSnapshotMap("s2", new Map([["e2", "#b"]]));

      await browserManager.closeAllPages();

      expect(browserManager.resolveSnapshotSelector("s1", "e1")).toBeNull();
      expect(browserManager.resolveSnapshotSelector("s2", "e2")).toBeNull();
    });
  });

  // ── snapshot map ─────────────────────────────────────────────

  describe("snapshot map", () => {
    test("stores and resolves element selectors", () => {
      const map = new Map([
        ["e1", "#submit-btn"],
        ["e2", 'input[name="email"]'],
      ]);
      browserManager.storeSnapshotMap("s1", map);

      expect(browserManager.resolveSnapshotSelector("s1", "e1")).toBe(
        "#submit-btn",
      );
      expect(browserManager.resolveSnapshotSelector("s1", "e2")).toBe(
        'input[name="email"]',
      );
    });

    test("returns null for unknown element id", () => {
      browserManager.storeSnapshotMap("s1", new Map([["e1", "#btn"]]));
      expect(browserManager.resolveSnapshotSelector("s1", "e999")).toBeNull();
    });

    test("returns null for unknown session", () => {
      expect(
        browserManager.resolveSnapshotSelector("unknown", "e1"),
      ).toBeNull();
    });

    test("overwrites previous snapshot map for same session", () => {
      browserManager.storeSnapshotMap("s1", new Map([["e1", "#old"]]));
      browserManager.storeSnapshotMap("s1", new Map([["e1", "#new"]]));
      expect(browserManager.resolveSnapshotSelector("s1", "e1")).toBe("#new");
    });
  });
});
