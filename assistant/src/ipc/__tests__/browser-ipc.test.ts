/**
 * Tests for the `browser_execute` route.
 *
 * Mocks executeBrowserOperation and findConversation at the module boundary
 * so the route handler can be exercised without spinning up real browser
 * state or the daemon conversation store.
 */

import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { isSessionGroupsEnabled } from "../../config/session-groups-gate.js";
import type { BrowserOperationToken } from "../../daemon/browser-mode-session.js";
import { BrowserModeSessionProducer } from "../../daemon/browser-mode-session.js";
import { desktopDependencyInstaller } from "../../desktop/desktop-dependencies.js";
import * as desktopFeature from "../../desktop/virtual-desktop-feature.js";
import { browserManager } from "../../tools/browser/browser-manager.js";
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
  transportInterface?: string;
  sourceActorPrincipalId?: string;
}> = [];

/** When set, findConversation returns a fake conversation object. */
let mockConversation: {
  trustContext?: { trustClass: string };
  transportInterface?: string;
  currentTurnClientOs?: string;
  clientOs?: string;
  getTurnActorPrincipalId?: () => string | undefined;
  abortController?: AbortController;
  currentRequestId?: string;
  browserModeSessions?: {
    beginOperation: (input: {
      turnId: string;
      lifecycle: "action" | "terminal" | "status";
      at: number;
    }) => BrowserOperationToken | undefined;
    finishOperation: (
      token: BrowserOperationToken | undefined,
      outcome: {
        at: number;
        isError: boolean;
        cancelled: boolean;
        terminalReason?: "browser_closed" | "browser_detached";
      },
    ) => boolean;
  };
} | null = null;

const lifecycleBegins: Array<{
  turnId: string;
  lifecycle: "action" | "terminal" | "status";
  at: number;
}> = [];
const lifecycleFinishes: Array<{
  token: BrowserOperationToken | undefined;
  outcome: {
    at: number;
    isError: boolean;
    cancelled: boolean;
    terminalReason?: "browser_closed" | "browser_detached";
  };
}> = [];

function browserLifecycle() {
  return {
    beginOperation(input: (typeof lifecycleBegins)[number]) {
      lifecycleBegins.push(input);
      return {
        turnId: input.turnId,
        lifecycle: input.lifecycle === "status" ? "action" : input.lifecycle,
        owner: { id: "browser-session", mode: "browser" as const },
      } as BrowserOperationToken;
    },
    finishOperation(
      token: BrowserOperationToken | undefined,
      outcome: (typeof lifecycleFinishes)[number]["outcome"],
    ) {
      lifecycleFinishes.push({ token, outcome });
      return true;
    },
  };
}

let mockFindConversationCalls: string[] = [];

mock.module("../../browser/operations.js", () => ({
  browserOperationLifecycle: (operation: string) =>
    operation === "status"
      ? "status"
      : operation === "close" || operation === "detach"
        ? "terminal"
        : "action",
  executeBrowserOperation: async (
    operation: string,
    input: Record<string, unknown>,
    context: {
      conversationId: string;
      trustClass?: string;
      transportInterface?: string;
      sourceActorPrincipalId?: string;
    },
  ) => {
    mockOperationCalls.push({
      operation,
      input,
      conversationId: context.conversationId,
      trustClass: context.trustClass,
      transportInterface: context.transportInterface,
      sourceActorPrincipalId: context.sourceActorPrincipalId,
    });
    return mockOperationResult;
  },
}));

mock.module("../../daemon/conversation-registry.js", () => ({
  findConversation: (conversationId: string) => {
    mockFindConversationCalls.push(conversationId);
    return mockConversation ?? undefined;
  },
  findConversationOrSubagent: () => mockConversation ?? undefined,
}));

let desktopEnabled = false;
let desktopReady = false;
let desktopFailure = false;
const enabledSpy = spyOn(
  desktopFeature,
  "isVirtualDesktopEnabled",
).mockImplementation(() => desktopEnabled);
const readySpy = spyOn(
  desktopDependencyInstaller,
  "getStatus",
).mockImplementation(() => ({ state: desktopReady ? "ready" : "required" }));
afterAll(() => {
  enabledSpy.mockRestore();
  readySpy.mockRestore();
});

let desktopContext: import("../../tools/types.js").ToolContext | undefined;
mock.module("../../desktop/desktop-browser-operations.js", () => ({
  executeDesktopBrowserTabs: async (
    _params: unknown,
    context: import("../../tools/types.js").ToolContext,
  ) => {
    desktopContext = context;
    return {
      content: JSON.stringify({ ok: true, tabs: [{ tabId: 1 }] }),
      isError: false,
    };
  },
  executeDesktopBrowserOperation: async (
    _operation: string,
    _input: Record<string, unknown>,
    context: import("../../tools/types.js").ToolContext,
  ) => {
    desktopContext = context;
    return {
      content: desktopFailure ? "Desktop is busy" : "desktop",
      isError: desktopFailure,
    };
  },
}));

// Import after mocking — now from the shared routes location
const { ROUTES, browserCliConversationKey } =
  await import("../../runtime/routes/browser-routes.js");

const browserExecuteHandler = ROUTES.find(
  (r) => r.operationId === "browser_execute",
)!.handler;

/** Call the handler with the RouteHandlerArgs shape. */
function callHandler(
  body: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  return browserExecuteHandler({
    body,
    headers,
    pathParams: {},
    queryParams: {},
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  setOverridesForTesting({});
  desktopEnabled = false;
  desktopReady = false;
  desktopFailure = false;
  desktopContext = undefined;
  browserManager.clearPreferredBackendKind("conv-default-browser");
  mockOperationResult = { content: "ok", isError: false };
  mockOperationCalls = [];
  mockConversation = null;
  mockFindConversationCalls = [];
  lifecycleBegins.length = 0;
  lifecycleFinishes.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("browser_execute route", () => {
  test("operationId is browser_execute", () => {
    const route = ROUTES.find((r) => r.operationId === "browser_execute");
    expect(route).toBeDefined();
  });

  // ── Successful dispatch ────────────────────────────────────────────

  test("dispatches a valid operation and returns structured result", async () => {
    mockOperationResult = {
      content: "Navigated to https://example.com",
      isError: false,
    };

    const result = await callHandler({
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
      callHandler({
        operation: "nonexistent_operation",
        input: {},
      }),
    ).rejects.toThrow();

    expect(mockOperationCalls).toHaveLength(0);
  });

  // ── Session ID mapping ─────────────────────────────────────────────

  test("maps sessionId to deterministic conversation key", async () => {
    await callHandler({
      operation: "snapshot",
      input: {},
      sessionId: "my-session",
    });

    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0].conversationId).toBe("browser-cli:my-session");
  });

  test("defaults sessionId to 'default' when omitted", async () => {
    await callHandler({
      operation: "snapshot",
      input: {},
    });

    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0].conversationId).toBe("browser-cli:default");
  });

  test("looks up conversation when conversationId is provided", async () => {
    await callHandler({
      operation: "status",
      input: {},
      sessionId: "s1",
      conversationId: "conv-live-123",
    });

    expect(mockFindConversationCalls).toEqual(["conv-live-123"]);
  });

  test("falls back to session key when conversation not found", async () => {
    mockConversation = null;

    await callHandler({
      operation: "status",
      input: {},
      sessionId: "s1",
      conversationId: "conv-missing",
    });

    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0].conversationId).toBe("browser-cli:s1");
    expect(mockOperationCalls[0].trustClass).toBe("unknown");
  });

  test("uses live conversation context fields when found", async () => {
    mockConversation = {
      trustContext: { trustClass: "trusted" },
      transportInterface: "chrome-extension",
      getTurnActorPrincipalId: () => undefined,
    };

    await callHandler({
      operation: "status",
      input: {},
      sessionId: "unused",
      conversationId: "conv-live-456",
    });

    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0]).toMatchObject({
      conversationId: "conv-live-456",
      trustClass: "trusted",
      transportInterface: "chrome-extension",
    });
  });

  test("threads actor principal header into browser tool context", async () => {
    await callHandler(
      {
        operation: "status",
        input: {},
        sessionId: "actor-session",
      },
      { "x-vellum-actor-principal-id": "actor-123" },
    );

    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0].sourceActorPrincipalId).toBe("actor-123");
  });

  test("falls back to live conversation actor when no actor header exists", async () => {
    mockConversation = {
      trustContext: { trustClass: "trusted" },
      transportInterface: "macos",
      getTurnActorPrincipalId: () => "conversation-actor",
    };

    await callHandler({
      operation: "status",
      input: {},
      sessionId: "unused",
      conversationId: "conv-live-actor",
    });

    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0]).toMatchObject({
      conversationId: "conv-live-actor",
      sourceActorPrincipalId: "conversation-actor",
    });
  });

  test("prefers live conversation actor over the request header", async () => {
    mockConversation = {
      trustContext: { trustClass: "trusted" },
      transportInterface: "macos",
      getTurnActorPrincipalId: () => "conversation-actor",
    };

    await callHandler(
      {
        operation: "status",
        input: {},
        sessionId: "unused",
        conversationId: "conv-live-actor",
      },
      { "x-vellum-actor-principal-id": "header-actor" },
    );

    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0].sourceActorPrincipalId).toBe(
      "conversation-actor",
    );
  });

  test("does not call findConversation when no conversationId provided", async () => {
    await callHandler({
      operation: "snapshot",
      input: {},
      sessionId: "s1",
    });

    expect(mockFindConversationCalls).toHaveLength(0);
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

    const result = (await callHandler({
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

    const result = (await callHandler({
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

    const result = (await callHandler({
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

    const result = await callHandler({
      operation: "navigate",
      input: { url: "https://404.example.com" },
    });

    expect(result).toEqual({
      content: "Error: page not found",
      isError: true,
    });
  });

  test("brackets a typed live-turn action with browser lifecycle", async () => {
    mockConversation = {
      currentRequestId: "turn-123",
      browserModeSessions: browserLifecycle(),
      getTurnActorPrincipalId: () => undefined,
    };

    await callHandler({
      operation: "navigate",
      input: { url: "https://example.com" },
      conversationId: "conv-live",
    });

    expect(lifecycleBegins).toEqual([
      expect.objectContaining({ turnId: "turn-123", lifecycle: "action" }),
    ]);
    expect(lifecycleFinishes).toEqual([
      expect.objectContaining({
        token: expect.objectContaining({ turnId: "turn-123" }),
        outcome: expect.objectContaining({
          isError: false,
          cancelled: false,
        }),
      }),
    ]);
  });

  test("executes a live-turn action without tracking while session groups are disabled", async () => {
    setOverridesForTesting({ "session-groups": false });
    const activateSource = mock(() => {
      throw new Error("disabled tracking must not activate a source");
    });
    mockConversation = {
      currentRequestId: "turn-123",
      browserModeSessions: new BrowserModeSessionProducer(
        {
          activateSource,
          claimTurn: mock(() => undefined),
          getTurnOwner: mock(() => undefined),
          recordActivity: mock(() => false),
          retireSource: mock(() => false),
        },
        1,
        isSessionGroupsEnabled,
      ),
      getTurnActorPrincipalId: () => undefined,
    };

    const result = await callHandler({
      operation: "navigate",
      input: { url: "https://example.com" },
      conversationId: "conv-live",
    });

    expect(result).toEqual({ content: "ok", isError: false });
    expect(mockOperationCalls).toHaveLength(1);
    expect(activateSource).not.toHaveBeenCalled();
  });

  test.each(["navigate", "close"] as const)(
    "executes %s once after tracking admission throws",
    async (operation) => {
      mockConversation = {
        currentRequestId: "turn-123",
        browserModeSessions: {
          ...browserLifecycle(),
          beginOperation() {
            throw new Error("tracking unavailable");
          },
        },
        getTurnActorPrincipalId: () => undefined,
      };
      const result = await callHandler({
        operation,
        conversationId: "conv-live",
      });
      expect(result).toEqual({ content: "ok", isError: false });
      expect(mockOperationCalls).toHaveLength(1);
    },
  );

  test("passes typed terminal success and failure outcomes", async () => {
    mockConversation = {
      currentRequestId: "turn-123",
      browserModeSessions: browserLifecycle(),
      getTurnActorPrincipalId: () => undefined,
    };

    await callHandler({ operation: "detach", conversationId: "conv-live" });
    expect(lifecycleBegins[0]).toMatchObject({ lifecycle: "terminal" });
    expect(lifecycleFinishes[0]?.outcome).toMatchObject({
      isError: false,
      terminalReason: "browser_detached",
    });

    mockOperationResult = { content: "close failed", isError: true };
    await callHandler({ operation: "close", conversationId: "conv-live" });
    expect(lifecycleFinishes[1]?.outcome).toMatchObject({
      isError: true,
      terminalReason: "browser_closed",
    });
  });

  test.each(["navigate", "close"] as const)(
    "preserves a successful %s result when session tracking fails",
    async (operation) => {
      mockOperationResult = {
        content: `${operation} completed`,
        isError: false,
      };
      const lifecycle = browserLifecycle();
      mockConversation = {
        currentRequestId: "turn-123",
        browserModeSessions: {
          ...lifecycle,
          finishOperation(token, outcome) {
            lifecycle.finishOperation(token, outcome);
            throw new Error("session tracking unavailable");
          },
        },
        getTurnActorPrincipalId: () => undefined,
      };

      const result = await callHandler({
        operation,
        input: operation === "navigate" ? { url: "https://example.com" } : {},
        conversationId: "conv-live",
      });

      expect(result).toEqual({
        content: `${operation} completed`,
        isError: false,
      });
      expect(mockOperationCalls).toHaveLength(1);
      expect(lifecycleFinishes).toHaveLength(1);
    },
  );

  test("does not observe lifecycle for a standalone CLI operation", async () => {
    await callHandler({ operation: "navigate", sessionId: "standalone" });
    expect(lifecycleBegins).toEqual([]);
    expect(lifecycleFinishes).toEqual([]);
  });

  // ── Input defaults ─────────────────────────────────────────────────

  test("defaults input to empty object when omitted", async () => {
    await callHandler({
      operation: "snapshot",
    });

    expect(mockOperationCalls).toHaveLength(1);
    expect(mockOperationCalls[0].input).toEqual({});
  });
});

test("desktop route preserves guardian ownership and live-turn cancellation", async () => {
  const abortController = new AbortController();
  mockConversation = {
    trustContext: { trustClass: "guardian" },
    getTurnActorPrincipalId: () => "user-123",
    abortController,
  };
  const result = await callHandler(
    { operation: "snapshot", desktop: true, conversationId: "conv-desktop" },
    { "x-vellum-actor-principal-id": "user-other" },
  );
  expect(result).toMatchObject({ content: "desktop" });
  expect(mockOperationCalls).toHaveLength(0);
  expect(desktopContext).toMatchObject({
    conversationId: "conv-desktop",
    sourceActorPrincipalId: "user-123",
    trustClass: "guardian",
  });
  expect(desktopContext?.signal?.aborted).toBe(false);
  abortController.abort();
  expect(desktopContext?.signal?.aborted).toBe(true);
});

function webConversation(clientOs = "web") {
  desktopEnabled = true;
  desktopReady = true;
  mockConversation = {
    trustContext: { trustClass: "guardian" },
    transportInterface: "web",
    currentTurnClientOs: clientOs,
    getTurnActorPrincipalId: () => "user-123",
  };
}

test("web browser commands default to the installed streamed Chrome", async () => {
  webConversation();
  const result = await callHandler({
    operation: "navigate",
    input: { url: "https://example.com" },
    conversationId: "conv-default-browser",
  });
  expect(result).toMatchObject({ content: "desktop", isError: false });
  expect(mockOperationCalls).toHaveLength(0);
  expect(desktopContext?.clientOs).toBe("web");
});

test.each(["macos", "windows"])(
  "%s renderer uses the personal browser despite its web transport",
  async (clientOs) => {
    webConversation(clientOs);
    await callHandler({
      operation: "snapshot",
      conversationId: "conv-default-browser",
    });
    expect(mockOperationCalls).toHaveLength(1);
    expect(desktopContext).toBeUndefined();
  },
);

test("browser selection uses the active turn rather than a queued message's OS", async () => {
  webConversation("macos");
  mockConversation!.clientOs = "web";
  await callHandler({
    operation: "snapshot",
    conversationId: "conv-default-browser",
  });
  expect(mockOperationCalls).toHaveLength(1);
  expect(desktopContext).toBeUndefined();
});

test.each(["flag", "guardian", "actor"])(
  "web preserves the existing browser when %s is unavailable",
  async (missing) => {
    webConversation();
    if (missing === "flag") {
      desktopEnabled = false;
    }
    if (missing === "guardian") {
      mockConversation!.trustContext = { trustClass: "unknown" };
    }
    if (missing === "actor") {
      mockConversation!.getTurnActorPrincipalId = () => undefined;
    }
    await callHandler({
      operation: "snapshot",
      conversationId: "conv-default-browser",
    });
    expect(mockOperationCalls).toHaveLength(1);
    expect(desktopContext).toBeUndefined();
  },
);

test.each([
  { browser_mode: "local" },
  { browser_mode: "playwright" },
  { browser_mode: "extension" },
  { browser_mode: "cdp-inspect" },
  { target_client_id: "client-123" },
  { use_active_tab: true },
])("explicit browser choice %j wins over the web default", async (input) => {
  webConversation();
  await callHandler({
    operation: "snapshot",
    input,
    conversationId: "conv-default-browser",
  });
  expect(mockOperationCalls).toHaveLength(1);
  expect(desktopContext).toBeUndefined();
});

test("follow-up web commands retain an existing personal browser session", async () => {
  webConversation();
  browserManager.setPreferredBackendKind("conv-default-browser", "extension");
  await callHandler({
    operation: "snapshot",
    conversationId: "conv-default-browser",
  });
  expect(mockOperationCalls).toHaveLength(1);
  expect(desktopContext).toBeUndefined();
});

test("native clients can explicitly select the streamed browser", async () => {
  webConversation("windows");
  const result = await callHandler({
    operation: "snapshot",
    desktop: true,
    conversationId: "conv-default-browser",
  });
  expect(result).toMatchObject({ content: "desktop" });
  expect(desktopContext?.clientOs).toBe("windows");
  expect(mockOperationCalls).toHaveLength(0);
});

test("web tab commands share the streamed browser default", async () => {
  webConversation();
  const { ROUTES } =
    await import("../../runtime/routes/browser-tabs-routes.js");
  const result = await ROUTES[0].handler({
    body: { command: "list", conversationId: "conv-default-browser" },
  });
  expect(result).toEqual({ ok: true, tabs: [{ tabId: 1 }] });
  expect(desktopContext?.clientOs).toBe("web");
});

test("a streamed browser failure does not switch to Playwright or personal Chrome", async () => {
  webConversation();
  desktopFailure = true;
  const result = await callHandler({
    operation: "click",
    input: { selector: "#submit" },
    conversationId: "conv-default-browser",
  });
  expect(result).toMatchObject({ isError: true, content: "Desktop is busy" });
  expect(mockOperationCalls).toHaveLength(0);
});

test("first web browser use routes to virtual desktop setup before installation", async () => {
  webConversation();
  desktopReady = false;
  await callHandler({
    operation: "navigate",
    input: { url: "https://example.com" },
    conversationId: "conv-default-browser",
  });
  expect(desktopContext?.clientOs).toBe("web");
  expect(mockOperationCalls).toHaveLength(0);
});
