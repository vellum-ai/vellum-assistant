/**
 * Tests for the `browser_execute` IPC route.
 *
 * Mocks executeBrowserOperation at the module boundary so the route
 * handler can be exercised without spinning up real browser state.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ToolExecutionResult } from "../../tools/types.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockOperationResult: ToolExecutionResult = {
  content: "ok",
  isError: false,
};
let mockOperationCalls: Array<{
  operation: string;
  input: Record<string, unknown>;
  conversationId: string;
  trustClass?: string;
  hostBrowserProxy?: unknown;
  transportInterface?: string;
}> = [];
let mockResolvedContext: {
  conversationId: string;
  trustClass: string;
  hostBrowserProxy?: unknown;
  transportInterface?: string;
} | null = null;
let mockResolverCalls: Array<{
  requestedConversationId?: string;
  fallbackConversationId: string;
}> = [];

mock.module("../../browser/operations.js", () => ({
  executeBrowserOperation: async (
    operation: string,
    input: Record<string, unknown>,
    context: {
      conversationId: string;
      trustClass?: string;
      hostBrowserProxy?: unknown;
      transportInterface?: string;
    },
  ) => {
    mockOperationCalls.push({
      operation,
      input,
      conversationId: context.conversationId,
      trustClass: context.trustClass,
      hostBrowserProxy: context.hostBrowserProxy,
      transportInterface: context.transportInterface,
    });
    return mockOperationResult;
  },
}));

mock.module("../routes/browser-context.js", () => ({
  resolveBrowserIpcContext: (params: {
    requestedConversationId?: string;
    fallbackConversationId: string;
  }) => {
    mockResolverCalls.push(params);
    return (
      mockResolvedContext ?? {
        conversationId: params.fallbackConversationId,
        trustClass: "unknown",
      }
    );
  },
}));

// Import after mocking
const { browserExecuteRoute, browserCliConversationKey } =
  await import("../routes/browser.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  mockOperationResult = { content: "ok", isError: false };
  mockOperationCalls = [];
  mockResolvedContext = null;
  mockResolverCalls = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("browser_execute IPC route", () => {
  test("method is browser_execute", () => {
    expect(browserExecuteRoute.method).toBe("browser_execute");
  });

  // ── Successful dispatch ────────────────────────────────────────────

  test("dispatches a valid operation and returns structured result", async () => {
    mockOperationResult = {
      content: "Navigated to https://example.com",
      isError: false,
    };

    const result = await browserExecuteRoute.handler({
      operation: "navigate",
      input: { url: "https://example.com" },
      sessionId: "test-session",
    });

    expect(result).toEqual({
      content: "Navigated to https://example.com",
      isError: false,
    });
    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0].operation).toBe("navigate");
    expect(mockOperationCalls[0].input).toEqual({
      url: "https://example.com",
    });
  });

  // ── Unknown operation rejection ────────────────────────────────────

  test("rejects unknown operation with a validation error", async () => {
    await expect(
      browserExecuteRoute.handler({
        operation: "nonexistent_operation",
        input: {},
      }),
    ).rejects.toThrow();

    // Should never reach executeBrowserOperation
    expect(mockOperationCalls).toHaveLength(0);
  });

  // ── Session ID mapping ─────────────────────────────────────────────

  test("maps sessionId to deterministic conversation key", async () => {
    await browserExecuteRoute.handler({
      operation: "snapshot",
      input: {},
      sessionId: "my-session",
    });

    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0].conversationId).toBe("browser-cli:my-session");
  });

  test("defaults sessionId to 'default' when omitted", async () => {
    await browserExecuteRoute.handler({
      operation: "snapshot",
      input: {},
    });

    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0].conversationId).toBe("browser-cli:default");
  });

  test("passes requested conversationId to context resolver", async () => {
    await browserExecuteRoute.handler({
      operation: "status",
      input: {},
      sessionId: "s1",
      conversationId: "conv-live-123",
    });

    expect(mockResolverCalls).toHaveLength(1);
    expect(mockResolverCalls[0]).toEqual({
      requestedConversationId: "conv-live-123",
      fallbackConversationId: "browser-cli:s1",
    });
  });

  test("uses resolved context fields when resolver returns live conversation context", async () => {
    const fakeProxy = { isAvailable: () => true };
    mockResolvedContext = {
      conversationId: "conv-live-456",
      trustClass: "trusted",
      hostBrowserProxy: fakeProxy,
      transportInterface: "chrome-extension",
    };

    await browserExecuteRoute.handler({
      operation: "status",
      input: {},
      sessionId: "unused",
      conversationId: "conv-live-456",
    });

    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0]).toMatchObject({
      conversationId: "conv-live-456",
      trustClass: "trusted",
      hostBrowserProxy: fakeProxy,
      transportInterface: "chrome-extension",
    });
  });

  test("same sessionId produces same conversation key", () => {
    const key1 = browserCliConversationKey("alpha");
    const key2 = browserCliConversationKey("alpha");
    expect(key1).toBe(key2);
    expect(key1).toBe("browser-cli:alpha");
  });

  test("different sessionIds produce different conversation keys", () => {
    const key1 = browserCliConversationKey("alpha");
    const key2 = browserCliConversationKey("beta");
    expect(key1).not.toBe(key2);
  });

  // ── Screenshot payload transport ───────────────────────────────────

  test("extracts screenshot base64 payloads from content blocks", async () => {
    mockOperationResult = {
      content: "Screenshot taken",
      isError: false,
      contentBlocks: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgoAAAANS...",
          },
        },
      ],
    };

    const result = (await browserExecuteRoute.handler({
      operation: "screenshot",
      input: {},
      sessionId: "screenshot-test",
    })) as {
      content: string;
      isError: boolean;
      screenshots: Array<{ mediaType: string; data: string }>;
    };

    expect(result.content).toBe("Screenshot taken");
    expect(result.isError).toBe(false);
    expect(result.screenshots).toHaveLength(1);
    expect(result.screenshots[0].mediaType).toBe("image/png");
    expect(result.screenshots[0].data).toBe("iVBORw0KGgoAAAANS...");
  });

  test("omits screenshots field when no image blocks present", async () => {
    mockOperationResult = {
      content: "Snapshot taken",
      isError: false,
    };

    const result = (await browserExecuteRoute.handler({
      operation: "snapshot",
      input: {},
    })) as Record<string, unknown>;

    expect(result.content).toBe("Snapshot taken");
    expect(result.isError).toBe(false);
    expect(result).not.toHaveProperty("screenshots");
  });

  test("handles multiple screenshot content blocks", async () => {
    mockOperationResult = {
      content: "Multiple screenshots",
      isError: false,
      contentBlocks: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "first-screenshot-data",
          },
        },
        {
          type: "text",
          text: "some text block",
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: "second-screenshot-data",
          },
        },
      ],
    };

    const result = (await browserExecuteRoute.handler({
      operation: "screenshot",
      input: { full_page: true },
    })) as {
      content: string;
      isError: boolean;
      screenshots: Array<{ mediaType: string; data: string }>;
    };

    expect(result.screenshots).toHaveLength(2);
    expect(result.screenshots[0].data).toBe("first-screenshot-data");
    expect(result.screenshots[1].data).toBe("second-screenshot-data");
    expect(result.screenshots[1].mediaType).toBe("image/jpeg");
  });

  // ── Error propagation ──────────────────────────────────────────────

  test("propagates isError from operation result", async () => {
    mockOperationResult = {
      content: "Error: page not found",
      isError: true,
    };

    const result = await browserExecuteRoute.handler({
      operation: "navigate",
      input: { url: "https://404.example.com" },
    });

    expect(result).toEqual({
      content: "Error: page not found",
      isError: true,
    });
  });

  // ── Input defaults ─────────────────────────────────────────────────

  test("defaults input to empty object when omitted", async () => {
    await browserExecuteRoute.handler({
      operation: "snapshot",
    });

    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0].input).toEqual({});
  });
});
