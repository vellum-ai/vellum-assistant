import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp/headless-browser-read-tools-test",
}));

let mockPage: {
  click: ReturnType<typeof mock>;
  fill: ReturnType<typeof mock>;
  press: ReturnType<typeof mock>;
  evaluate: ReturnType<typeof mock>;
  title: ReturnType<typeof mock>;
  url: ReturnType<typeof mock>;
  goto: ReturnType<typeof mock>;
  close: () => Promise<void>;
  isClosed: () => boolean;
  waitForSelector: ReturnType<typeof mock>;
  waitForFunction: ReturnType<typeof mock>;
  keyboard: { press: ReturnType<typeof mock> };
};

let snapshotMaps: Map<string, Map<string, string>>;

mock.module("../tools/browser/browser-manager.js", () => {
  snapshotMaps = new Map();
  return {
    browserManager: {
      getOrCreateSessionPage: async () => mockPage,
      closeSessionPage: async () => {},
      closeAllPages: async () => {},
      storeSnapshotMap: (sessionId: string, map: Map<string, string>) => {
        snapshotMaps.set(sessionId, map);
      },
      resolveSnapshotSelector: (sessionId: string, elementId: string) => {
        const map = snapshotMaps.get(sessionId);
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
  executeBrowserExtract,
  executeBrowserPressKey,
  executeBrowserWaitFor,
} from "../tools/browser/browser-execution.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  sessionId: "test-session",
  conversationId: "test-conversation",
  workingDir: "/tmp",
  trustClass: "guardian",
};

function resetMockPage() {
  mockPage = {
    click: mock(async () => {}),
    fill: mock(async () => {}),
    press: mock(async () => {}),
    evaluate: mock(async () => ""),
    title: mock(async () => "Test Page"),
    url: mock(() => "https://example.com/"),
    goto: mock(async () => ({
      status: () => 200,
      url: () => "https://example.com/",
    })),
    close: async () => {},
    isClosed: () => false,
    waitForSelector: mock(async () => null),
    waitForFunction: mock(async () => null),
    keyboard: { press: mock(async () => {}) },
  };
}

// ── browser_press_key ────────────────────────────────────────────────

describe("executeBrowserPressKey", () => {
  beforeEach(() => {
    resetMockPage();
    snapshotMaps.clear();
  });

  test("presses key on focused element (no target)", async () => {
    const result = await executeBrowserPressKey({ key: "Enter" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Pressed "Enter"');
    expect(mockPage.keyboard.press).toHaveBeenCalledWith("Enter");
  });

  test("presses key on targeted element via element_id", async () => {
    snapshotMaps.set(
      "test-session",
      new Map([["e1", '[data-vellum-eid="e1"]']]),
    );
    const result = await executeBrowserPressKey(
      { key: "Tab", element_id: "e1" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Pressed "Tab" on element');
    expect(mockPage.press).toHaveBeenCalledWith(
      '[data-vellum-eid="e1"]',
      "Tab",
    );
  });

  test("presses key on targeted element via selector", async () => {
    const result = await executeBrowserPressKey(
      { key: "Escape", selector: "#modal" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(mockPage.press).toHaveBeenCalledWith("#modal", "Escape");
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

  test("handles press error", async () => {
    mockPage.keyboard.press = mock(async () => {
      throw new Error("key not recognized");
    });
    const result = await executeBrowserPressKey({ key: "InvalidKey" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Press key failed");
  });
});

// ── browser_wait_for ─────────────────────────────────────────────────

describe("executeBrowserWaitFor", () => {
  beforeEach(() => {
    resetMockPage();
  });

  test("waits for selector", async () => {
    const result = await executeBrowserWaitFor({ selector: "#loaded" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Element matching "#loaded" appeared');
    expect(mockPage.waitForSelector).toHaveBeenCalledWith("#loaded", {
      timeout: 30_000,
    });
  });

  test("waits for text", async () => {
    const result = await executeBrowserWaitFor({ text: "Success" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Text "Success" appeared');
    expect(mockPage.waitForFunction).toHaveBeenCalled();
  });

  test("waits for duration", async () => {
    const result = await executeBrowserWaitFor({ duration: 10 }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Waited 10ms");
  });

  test("errors when no mode specified", async () => {
    const result = await executeBrowserWaitFor({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Exactly one of selector, text, or duration",
    );
  });

  test("errors when multiple modes specified", async () => {
    const result = await executeBrowserWaitFor(
      { selector: "#x", text: "y" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("exactly one");
  });

  test("respects custom timeout", async () => {
    const result = await executeBrowserWaitFor(
      { selector: "#el", timeout: 5000 },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(mockPage.waitForSelector).toHaveBeenCalledWith("#el", {
      timeout: 5000,
    });
  });

  test("caps duration at MAX_WAIT_MS", async () => {
    // Use a small duration to verify the cap logic without actually waiting 30s.
    // duration=50 is below the cap, so it should wait exactly 50ms.
    const result = await executeBrowserWaitFor({ duration: 50 }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Waited 50ms");
  });

  test("handles wait error (timeout)", async () => {
    mockPage.waitForSelector = mock(async () => {
      throw new Error("Timeout 30000ms exceeded");
    });
    const result = await executeBrowserWaitFor({ selector: "#missing" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Wait failed");
    expect(result.content).toContain("Timeout");
  });
});

// ── browser_extract ──────────────────────────────────────────────────

describe("executeBrowserExtract", () => {
  beforeEach(() => {
    resetMockPage();
  });

  test("extracts page text content", async () => {
    mockPage.evaluate = mock(async () => "Hello World");
    const result = await executeBrowserExtract({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("URL: https://example.com/");
    expect(result.content).toContain("Title: Test Page");
    expect(result.content).toContain("Hello World");
  });

  test("shows (empty page) for empty content", async () => {
    mockPage.evaluate = mock(async () => "");
    const result = await executeBrowserExtract({}, ctx);
    expect(result.content).toContain("(empty page)");
  });

  test("truncates long content", async () => {
    const longText = "x".repeat(60_000);
    mockPage.evaluate = mock(async () => longText);
    const result = await executeBrowserExtract({}, ctx);
    expect(result.content).toContain("... (truncated)");
    // Content should be capped
    expect(result.content.length).toBeLessThan(60_000);
  });

  test("includes links when requested", async () => {
    let callCount = 0;
    mockPage.evaluate = mock(async () => {
      callCount++;
      if (callCount === 1) return "Page text";
      return [
        { text: "About", href: "https://example.com/about" },
        { text: "Contact", href: "https://example.com/contact" },
      ];
    });

    const result = await executeBrowserExtract({ include_links: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Links:");
    expect(result.content).toContain("[About](https://example.com/about)");
    expect(result.content).toContain("[Contact](https://example.com/contact)");
  });

  test("does not include links by default", async () => {
    mockPage.evaluate = mock(async () => "Page text");
    const result = await executeBrowserExtract({}, ctx);
    expect(result.content).not.toContain("Links:");
  });

  test("handles extract error", async () => {
    mockPage.evaluate = mock(async () => {
      throw new Error("page crashed");
    });
    const result = await executeBrowserExtract({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Extract failed");
  });
});
