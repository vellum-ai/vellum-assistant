import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp/headless-browser-interactions-test",
}));

let mockPage: {
  click: ReturnType<typeof mock>;
  fill: ReturnType<typeof mock>;
  press: ReturnType<typeof mock>;
  evaluate: ReturnType<typeof mock>;
  title: ReturnType<typeof mock>;
  url: ReturnType<typeof mock>;
  goto: ReturnType<typeof mock>;
  screenshot: ReturnType<typeof mock>;
  selectOption: ReturnType<typeof mock>;
  hover: ReturnType<typeof mock>;
  close: () => Promise<void>;
  isClosed: () => boolean;
  keyboard: { press: ReturnType<typeof mock> };
  mouse: { wheel: ReturnType<typeof mock>; move: ReturnType<typeof mock> };
};

let snapshotMaps: Map<string, Map<string, string>>;

mock.module("../tools/browser/browser-manager.js", () => {
  snapshotMaps = new Map();
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
  executeBrowserExtract,
  executeBrowserHover,
  executeBrowserPressKey,
  executeBrowserScreenshot,
  executeBrowserScroll,
  executeBrowserSelectOption,
  executeBrowserSnapshot,
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
    fill: mock(async () => {}),
    press: mock(async () => {}),
    evaluate: mock(async () => ""),
    title: mock(async () => "Test Page"),
    url: mock(() => "https://example.com/"),
    goto: mock(async () => ({
      status: () => 200,
      url: () => "https://example.com/",
    })),
    screenshot: mock(async () => Buffer.from("fake-jpeg-data")),
    selectOption: mock(async () => []),
    hover: mock(async () => {}),
    close: async () => {},
    isClosed: () => false,
    keyboard: { press: mock(async () => {}) },
    mouse: { wheel: mock(async () => {}), move: mock(async () => {}) },
  };
}

// ── browser_click ────────────────────────────────────────────────────

describe("executeBrowserClick", () => {
  beforeEach(() => {
    resetMockPage();
    snapshotMaps.clear();
  });

  test("clicks by element_id via snapshot map", async () => {
    snapshotMaps.set(
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
    snapshotMaps.set(
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

// ── browser_snapshot ──────────────────────────────────────────────────

describe("executeBrowserSnapshot", () => {
  beforeEach(() => {
    resetMockPage();
    snapshotMaps.clear();
  });

  test("returns element list with eid format", async () => {
    const sampleElements = [
      { eid: "e1", tag: "a", attrs: { href: "/about" }, text: "About Us" },
      { eid: "e2", tag: "button", attrs: { type: "submit" }, text: "Submit" },
      {
        eid: "e3",
        tag: "input",
        attrs: { type: "text", name: "email", placeholder: "Enter email" },
        text: "",
      },
    ];
    mockPage.evaluate = mock(async () => sampleElements);
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("[e1]");
    expect(result.content).toContain("[e2]");
    expect(result.content).toContain("[e3]");
    expect(result.content).toContain("<a");
    expect(result.content).toContain("<button");
    expect(result.content).toContain("<input");
    expect(result.content).toContain("3 interactive elements found");
  });

  test("stores snapshot map for later element resolution", async () => {
    const sampleElements = [
      { eid: "e1", tag: "a", attrs: { href: "/" }, text: "Home" },
    ];
    mockPage.evaluate = mock(async () => sampleElements);
    await executeBrowserSnapshot({}, ctx);
    const map = snapshotMaps.get("test-conversation");
    expect(map).toBeDefined();
    expect(map!.get("e1")).toBe('[data-vellum-eid="e1"]');
  });

  test("reports no interactive elements when page is empty", async () => {
    mockPage.evaluate = mock(async () => []);
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("no interactive elements found");
  });

  test("includes page URL and title", async () => {
    mockPage.evaluate = mock(async () => []);
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.content).toContain("URL: https://example.com/");
    expect(result.content).toContain("Title: Test Page");
  });

  test("handles snapshot error from page", async () => {
    mockPage.evaluate = mock(async () => {
      throw new Error("Page crashed");
    });
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Snapshot failed");
    expect(result.content).toContain("Page crashed");
  });
});

// ── browser_screenshot ───────────────────────────────────────────────

describe("executeBrowserScreenshot", () => {
  beforeEach(() => {
    resetMockPage();
  });

  test("captures and returns image content", async () => {
    const fakeBuffer = Buffer.from("fake-jpeg-screenshot-data");
    mockPage.screenshot = mock(async () => fakeBuffer);
    const result = await executeBrowserScreenshot({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Screenshot captured");
    expect(result.content).toContain(`${fakeBuffer.length} bytes`);
    expect(result.content).toContain("viewport");
    expect(result.contentBlocks).toBeDefined();
    expect(result.contentBlocks!.length).toBe(1);
    const imageBlock = result.contentBlocks![0] as {
      type: string;
      source: { type: string; media_type: string; data: string };
    };
    expect(imageBlock.type).toBe("image");
    expect(imageBlock.source.media_type).toBe("image/jpeg");
    expect(imageBlock.source.data).toBe(fakeBuffer.toString("base64"));
  });

  test("supports full_page mode", async () => {
    mockPage.screenshot = mock(async () => Buffer.from("full"));
    const result = await executeBrowserScreenshot({ full_page: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("full page");
    expect(mockPage.screenshot).toHaveBeenCalledWith({
      type: "jpeg",
      quality: 80,
      fullPage: true,
    });
  });

  test("handles screenshot error from page", async () => {
    mockPage.screenshot = mock(async () => {
      throw new Error("Render failed");
    });
    const result = await executeBrowserScreenshot({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Screenshot failed");
    expect(result.content).toContain("Render failed");
  });
});

// ── browser_close ────────────────────────────────────────────────────

describe("executeBrowserClose", () => {
  beforeEach(() => {
    resetMockPage();
  });

  test("closes session page", async () => {
    const result = await executeBrowserClose({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Browser page closed for this session");
  });

  test("closes all pages when close_all_pages=true", async () => {
    const result = await executeBrowserClose({ close_all_pages: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("All browser pages and context closed");
  });
});

// ── browser_extract ──────────────────────────────────────────────────

describe("executeBrowserExtract", () => {
  beforeEach(() => {
    resetMockPage();
  });

  test("extracts text content from page", async () => {
    mockPage.evaluate = mock(
      async () => "Hello, this is the page text content.",
    );
    const result = await executeBrowserExtract({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("URL: https://example.com/");
    expect(result.content).toContain("Title: Test Page");
    expect(result.content).toContain("Hello, this is the page text content.");
  });

  test("includes links when include_links=true", async () => {
    // First call returns text content, second returns link list
    let callCount = 0;
    mockPage.evaluate = mock(async () => {
      callCount++;
      if (callCount === 1) return "Some text";
      return [
        { text: "Example Link", href: "https://example.com/link1" },
        { text: "Another", href: "https://example.com/link2" },
      ];
    });
    const result = await executeBrowserExtract({ include_links: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Links:");
    expect(result.content).toContain(
      "[Example Link](https://example.com/link1)",
    );
    expect(result.content).toContain("[Another](https://example.com/link2)");
  });

  test("handles empty page", async () => {
    mockPage.evaluate = mock(async () => "");
    const result = await executeBrowserExtract({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("(empty page)");
  });

  test("handles extract error from page", async () => {
    mockPage.evaluate = mock(async () => {
      throw new Error("Page not loaded");
    });
    const result = await executeBrowserExtract({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Extract failed");
    expect(result.content).toContain("Page not loaded");
  });
});

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

describe("executeBrowserHover", () => {
  beforeEach(() => {
    resetMockPage();
    snapshotMaps.clear();
  });

  test("hovers by element_id via snapshot map", async () => {
    snapshotMaps.set(
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
    snapshotMaps.clear();
  });

  test("executeBrowserClick matches wrapper contract (input, context) → result", async () => {
    snapshotMaps.set(
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

  test("executeBrowserSnapshot matches wrapper contract", async () => {
    mockPage.evaluate = mock(async () => [
      { eid: "e1", tag: "button", attrs: {}, text: "Click me" },
    ]);
    mockPage.title = mock(async () => "Test");
    mockPage.url = mock(() => "https://example.com");
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(result.isError).toBe(false);
  });

  test("executeBrowserExtract matches wrapper contract", async () => {
    mockPage.evaluate = mock(async () => "Page text content");
    mockPage.title = mock(async () => "Test");
    mockPage.url = mock(() => "https://example.com");
    const result = await executeBrowserExtract({}, ctx);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(result.isError).toBe(false);
  });

  test("executeBrowserPressKey matches wrapper contract", async () => {
    const result = await executeBrowserPressKey({ key: "Enter" }, ctx);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(result.isError).toBe(false);
  });

  test("executeBrowserScreenshot matches wrapper contract", async () => {
    mockPage.screenshot = mock(async () => Buffer.from("fake-image"));
    const result = await executeBrowserScreenshot({}, ctx);
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
    snapshotMaps.set(
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
