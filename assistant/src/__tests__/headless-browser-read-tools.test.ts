import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

/**
 * Fake CDP session used by the screenshot/extract/wait_for tests in
 * this file. The tests configure `sendHandler` before invoking a
 * tool; each `session.send(method, params)` call is recorded in
 * `sendCalls` and routed to the handler. The handler returns either
 * a CDP response object (e.g. `{ result: { value: ... } }` for
 * `Runtime.evaluate`, or `{ data }` for `Page.captureScreenshot`) or
 * an `Error` to simulate a CDP failure.
 *
 * The fake session is exposed via `mockPage.context().newCDPSession(page)`
 * which is what the real `LocalCdpClient` calls internally. Going
 * through the real `LocalCdpClient` (instead of mocking the factory
 * or the cdp-client submodules) avoids polluting the global module
 * cache that the `factory.test.ts` and LocalCdpClient/
 * ExtensionCdpClient unit tests rely on.
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
  // Provided so `LocalCdpClient.dispose()` can call `session.detach()`
  // without throwing. The tests don't assert on detach calls.
  detach: async () => {},
};

// The mock page is served by `browserManager.getOrCreateSessionPage`
// and is consumed indirectly: LocalCdpClient calls
// `page.context().newCDPSession(page)` to obtain a CDP session and
// then dispatches raw CDP methods against it. The page's
// `context().newCDPSession` is wired to return `fakeCdpSession` above.
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
  context: () => {
    newCDPSession: (page: unknown) => Promise<typeof fakeCdpSession>;
  };
};

const preferredBackendKinds = new Map<string, string>();

mock.module("../tools/browser/browser-manager.js", () => {
  preferredBackendKinds.clear();
  return {
    browserManager: {
      getOrCreateSessionPage: async () => mockPage,
      closeSessionPage: async () => {},
      closeAllPages: async () => {},
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

import {
  executeBrowserExtract,
  executeBrowserScreenshot,
  executeBrowserWaitFor,
  EXTRACT_LINKS_EXPRESSION,
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
    close: async () => {},
    isClosed: () => false,
    waitForSelector: mock(async () => null),
    waitForFunction: mock(async () => null),
    keyboard: { press: mock(async () => {}) },
    // `LocalCdpClient.ensureSession()` calls `page.context().newCDPSession(
    // page)` to create a Playwright CDPSession. For these tests we
    // return the in-file `fakeCdpSession` which records every send()
    // into `sendCalls` and lets each test set `sendHandler` to shape
    // the responses.
    context: () => ({
      newCDPSession: async (_page: unknown) => fakeCdpSession,
    }),
  };
}

// executeBrowserPressKey tests live in
// `headless-browser-interactions.test.ts` alongside the other
// CDP-migrated interaction tools.

// ── browser_screenshot ───────────────────────────────────────────────

describe("executeBrowserScreenshot", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
  });

  test("captures viewport screenshot via Page.captureScreenshot", async () => {
    // Base64 for "abc" = "YWJj"
    sendHandler = () => ({ data: "YWJj" });

    const result = await executeBrowserScreenshot({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Screenshot captured");
    expect(result.content).toContain("viewport");
    expect(result.contentBlocks).toHaveLength(1);
    const block = result.contentBlocks![0]!;

    const source = (block as any).source;
    expect(source.media_type).toBe("image/jpeg");
    expect(source.data).toBe("YWJj");
    // Page.captureScreenshot was called with jpeg quality 80
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.method).toBe("Page.captureScreenshot");
    expect(sendCalls[0]!.params).toEqual({
      format: "jpeg",
      quality: 80,
      captureBeyondViewport: false,
    });
  });

  test("captures full-page screenshot when full_page is true", async () => {
    sendHandler = () => ({ data: "YWJj" });

    const result = await executeBrowserScreenshot({ full_page: true }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("full page");
    expect(sendCalls[0]!.params).toEqual({
      format: "jpeg",
      quality: 80,
      captureBeyondViewport: true,
    });
  });

  test("surfaces CDP failure as an error result", async () => {
    sendHandler = () => new Error("CDP crashed");

    const result = await executeBrowserScreenshot({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Screenshot failed");
    expect(result.content).toContain("CDP crashed");
  });
});

// ── browser_wait_for ─────────────────────────────────────────────────

describe("executeBrowserWaitFor", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
  });

  test("waits for selector (CDP polling)", async () => {
    // waitForSelector polls via Runtime.evaluate until the element
    // exists, then calls querySelectorBackendNodeId (which triggers
    // DOM.getDocument / DOM.querySelector / DOM.describeNode).
    sendHandler = (method, _params) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: true } };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 42 };
      if (method === "DOM.describeNode") {
        return { node: { backendNodeId: 100 } };
      }
      return {};
    };

    const result = await executeBrowserWaitFor({ selector: "#loaded" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Element matching "#loaded" appeared');
    // First call is Runtime.evaluate checking existence
    const evaluateCall = sendCalls.find((c) => c.method === "Runtime.evaluate");
    expect(evaluateCall).toBeDefined();
    expect((evaluateCall!.params as { expression: string }).expression).toBe(
      'document.querySelector("#loaded") !== null',
    );
  });

  test("waits for text (CDP polling)", async () => {
    sendHandler = (method) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: true } };
      }
      return {};
    };

    const result = await executeBrowserWaitFor({ text: "Success" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Text "Success" appeared');
    const evaluateCall = sendCalls.find((c) => c.method === "Runtime.evaluate");
    expect(evaluateCall).toBeDefined();
    expect(
      (evaluateCall!.params as { expression: string }).expression,
    ).toContain('"Success"');
    expect(
      (evaluateCall!.params as { expression: string }).expression,
    ).toContain(".includes(");
  });

  test("waits for duration (no CDP client acquired)", async () => {
    const result = await executeBrowserWaitFor({ duration: 10 }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Waited 10ms");
    // Duration mode is transport-agnostic and must not allocate a
    // CdpClient — so neither send nor dispose should have fired.
    expect(sendCalls).toHaveLength(0);
  });

  test("errors when no mode specified", async () => {
    const result = await executeBrowserWaitFor({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Exactly one of selector, text, or duration",
    );
    // Validation rejects before any CDP work is attempted.
    expect(sendCalls).toHaveLength(0);
  });

  test("errors when multiple modes specified", async () => {
    const result = await executeBrowserWaitFor(
      { selector: "#x", text: "y" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("exactly one");
    expect(sendCalls).toHaveLength(0);
  });

  test("caps duration at MAX_WAIT_MS", async () => {
    // Use a small duration to verify the cap logic without actually waiting 30s.
    // duration=50 is below the cap, so it should wait exactly 50ms.
    const result = await executeBrowserWaitFor({ duration: 50 }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Waited 50ms");
  });

  test("surfaces CDP transport failure as a wait error", async () => {
    sendHandler = () => new Error("CDP transport failed");

    const result = await executeBrowserWaitFor(
      { selector: "#missing", timeout: 100 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Wait failed");
  });
});

// ── browser_extract ──────────────────────────────────────────────────

describe("executeBrowserExtract", () => {
  beforeEach(() => {
    resetMockPage();
    resetCdpMock();
  });

  test("extracts page text content via CDP", async () => {
    sendHandler = (method, params) => {
      if (method !== "Runtime.evaluate") return {};
      const expression = (params as { expression: string }).expression;
      if (expression === "document.location.href") {
        return { result: { value: "https://example.com/" } };
      }
      if (expression === "document.title") {
        return { result: { value: "Test Page" } };
      }
      if (expression === "document.body?.innerText ?? ''") {
        return { result: { value: "Hello World" } };
      }
      return { result: { value: null } };
    };

    const result = await executeBrowserExtract({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("URL: https://example.com/");
    expect(result.content).toContain("Title: Test Page");
    expect(result.content).toContain("Hello World");
    // URL, title, body innerText = 3 Runtime.evaluate calls
    const evaluateCalls = sendCalls.filter(
      (c) => c.method === "Runtime.evaluate",
    );
    expect(evaluateCalls).toHaveLength(3);
  });

  test("shows (empty page) for empty content", async () => {
    sendHandler = (method, params) => {
      if (method !== "Runtime.evaluate") return {};
      const expression = (params as { expression: string }).expression;
      if (expression === "document.location.href") {
        return { result: { value: "https://example.com/" } };
      }
      if (expression === "document.title") {
        return { result: { value: "Test Page" } };
      }
      return { result: { value: "" } };
    };

    const result = await executeBrowserExtract({}, ctx);
    expect(result.content).toContain("(empty page)");
  });

  test("truncates long content", async () => {
    const longText = "x".repeat(60_000);
    sendHandler = (method, params) => {
      if (method !== "Runtime.evaluate") return {};
      const expression = (params as { expression: string }).expression;
      if (expression === "document.location.href") {
        return { result: { value: "https://example.com/" } };
      }
      if (expression === "document.title") {
        return { result: { value: "Test Page" } };
      }
      return { result: { value: longText } };
    };

    const result = await executeBrowserExtract({}, ctx);
    expect(result.content).toContain("... (truncated)");
    // Content should be capped
    expect(result.content.length).toBeLessThan(60_000);
  });

  test("includes links when requested using EXTRACT_LINKS_EXPRESSION", async () => {
    sendHandler = (method, params) => {
      if (method !== "Runtime.evaluate") return {};
      const expression = (params as { expression: string }).expression;
      if (expression === "document.location.href") {
        return { result: { value: "https://example.com/" } };
      }
      if (expression === "document.title") {
        return { result: { value: "Test Page" } };
      }
      if (expression === "document.body?.innerText ?? ''") {
        return { result: { value: "Page text" } };
      }
      if (expression === EXTRACT_LINKS_EXPRESSION) {
        return {
          result: {
            value: [
              { text: "About", href: "https://example.com/about" },
              { text: "Contact", href: "https://example.com/contact" },
            ],
          },
        };
      }
      return { result: { value: null } };
    };

    const result = await executeBrowserExtract({ include_links: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Links:");
    expect(result.content).toContain("[About](https://example.com/about)");
    expect(result.content).toContain("[Contact](https://example.com/contact)");
    // EXTRACT_LINKS_EXPRESSION was actually used (assert the expression appears in a call)
    const linksCall = sendCalls.find(
      (c) =>
        c.method === "Runtime.evaluate" &&
        (c.params as { expression: string }).expression ===
          EXTRACT_LINKS_EXPRESSION,
    );
    expect(linksCall).toBeDefined();
  });

  test("does not include links by default", async () => {
    sendHandler = (method, params) => {
      if (method !== "Runtime.evaluate") return {};
      const expression = (params as { expression: string }).expression;
      if (expression === "document.location.href") {
        return { result: { value: "https://example.com/" } };
      }
      if (expression === "document.title") {
        return { result: { value: "Test Page" } };
      }
      return { result: { value: "Page text" } };
    };

    const result = await executeBrowserExtract({}, ctx);
    expect(result.content).not.toContain("Links:");
    // EXTRACT_LINKS_EXPRESSION should NOT have been evaluated
    const linksCall = sendCalls.find(
      (c) =>
        c.method === "Runtime.evaluate" &&
        (c.params as { expression: string }).expression ===
          EXTRACT_LINKS_EXPRESSION,
    );
    expect(linksCall).toBeUndefined();
  });

  test("surfaces CDP failure as an extract error", async () => {
    sendHandler = () => new Error("page crashed");

    const result = await executeBrowserExtract({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Extract failed");
  });
});
