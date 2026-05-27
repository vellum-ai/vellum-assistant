/**
 * Tests that listTabs, selectTab, and closeTab are properly forwarded through
 * the real buildChainedClient wrapper.
 *
 * Per the test-flat-mocks-trap rule, these tests use the REAL buildChainedClient
 * function with a mock candidate — NOT a flat fake that has the methods defined
 * directly on the scoped client.
 */

import { describe, expect, mock, test } from "bun:test";

import type { BrowserBackend, CdpCommand, CdpResult } from "../../../../browser-session/types.js";
import { CdpError } from "../errors.js";
import type { BackendCandidate, CdpClient, TabInfo } from "../types.js";

// Import buildChainedClient directly. Since this test file does not mock
// any of factory.ts's imports, we import directly.
const { buildChainedClient } = await import("../factory.js");

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Create a BrowserBackend that delegates CDP sends through a CdpClient.
 * This is the real wiring that factory.ts uses — the backend wraps the
 * client's send method via dispatchThroughClient.
 */
function makeBackendFromClient(client: CdpClient, kind: "extension" | "local" | "cdp-inspect"): BrowserBackend {
  return {
    kind,
    isAvailable: () => true,
    send: async (command: CdpCommand, signal?: AbortSignal): Promise<CdpResult> => {
      try {
        const result = await client.send(command.method, command.params, signal);
        return { result };
      } catch (err) {
        if (err instanceof CdpError) {
          return {
            error: { code: -1, message: err.message, data: err },
          };
        }
        throw err;
      }
    },
    dispose: () => client.dispose(),
  };
}

interface FakeClientWithTabMethods extends CdpClient {
  kind: "extension";
  conversationId: string;
  listTabsMock: ReturnType<typeof mock>;
  selectTabMock: ReturnType<typeof mock>;
  closeTabMock: ReturnType<typeof mock>;
}

function makeFakeExtensionClientWithTabMethods(
  conversationId: string,
): FakeClientWithTabMethods {
  const listTabsMock = mock(async (): Promise<TabInfo[]> => [
    {
      tabId: 1,
      windowId: 10,
      url: "https://example.com",
      title: "Example",
      active: true,
      pinned: false,
    },
  ]);
  const selectTabMock = mock(async (_tabId: number) => ({
    tabId: 42,
    windowId: 10,
    url: "https://example.com",
    title: "Example",
    clientId: "clientA",
  }));
  const closeTabMock = mock(async (_tabId: number) => ({
    closed: true as const,
    tabId: 99,
  }));

  return {
    kind: "extension",
    conversationId,
    listTabsMock,
    selectTabMock,
    closeTabMock,
    send: mock(async () => ({ ok: true })) as unknown as CdpClient["send"],
    dispose: mock(() => {}),
    listTabs: listTabsMock,
    selectTab: selectTabMock,
    closeTab: closeTabMock,
  };
}

/**
 * Build a BackendCandidate that wraps a fake extension client with tab methods.
 */
function makeCandidateFromClient(
  conversationId: string,
  fakeClient: CdpClient,
  kind: "extension" | "local" | "cdp-inspect",
): BackendCandidate {
  return {
    kind,
    reason: `test ${kind} client`,
    create() {
      return {
        client: fakeClient,
        backend: makeBackendFromClient(fakeClient, kind),
      };
    },
  };
}

// ── Helpers for fresh-client (pre-sticky) tests ───────────────────────

/**
 * A fake extension client whose `send` method returns Vellum.* pseudo-responses
 * so that fresh-client tab calls can succeed without a prior `send("Runtime.*")`.
 * This simulates how the real ExtensionCdpClient handles Vellum.listTabs etc.
 * through the dispatcher before chrome.debugger.sendCommand.
 */
function makeFakeExtensionClientForFreshPath(conversationId: string) {
  return {
    kind: "extension" as const,
    conversationId,
    send: mock(
      async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
        if (method === "Vellum.listTabs") {
          return {
            tabs: [
              {
                tabId: 1,
                windowId: 10,
                url: "https://example.com",
                title: "Example",
                active: true,
                pinned: false,
              },
            ],
          };
        }
        if (method === "Vellum.selectTab") {
          return {
            tabId: params?.tabId,
            windowId: 10,
            url: "https://example.com",
            title: "Example",
            clientId: "clientA",
          };
        }
        if (method === "Vellum.closeTab") {
          return { closed: true, tabId: params?.tabId };
        }
        return {};
      },
    ) as unknown as CdpClient["send"],
    dispose: mock(() => {}),
    // These must be present so active?.client.listTabs etc. check passes
    listTabs: mock(async (): Promise<TabInfo[]> => []),
    selectTab: mock(async (_tabId: number) => ({
      tabId: _tabId,
      windowId: 10,
      url: "https://example.com",
      title: "Example",
      clientId: "clientA",
    })),
    closeTab: mock(async (_tabId: number) => ({
      closed: true as const,
      tabId: _tabId,
    })),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("buildChainedClient — tab management methods", () => {
  test("listTabs is forwarded to the underlying client after backend becomes sticky", async () => {
    const conversationId = "conv-tabs-list";
    const fakeClient = makeFakeExtensionClientWithTabMethods(conversationId);
    const candidate = makeCandidateFromClient(conversationId, fakeClient, "extension");

    const scoped = buildChainedClient(conversationId, [candidate]);

    // Establish sticky by sending a command first
    await scoped.send("Runtime.evaluate", {});

    const tabs = await scoped.listTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].tabId).toBe(1);
    expect(tabs[0].active).toBe(true);
    expect(fakeClient.listTabsMock).toHaveBeenCalledTimes(1);

    scoped.dispose();
  });

  test("selectTab is forwarded to the underlying client", async () => {
    const conversationId = "conv-tabs-select";
    const fakeClient = makeFakeExtensionClientWithTabMethods(conversationId);
    const candidate = makeCandidateFromClient(conversationId, fakeClient, "extension");

    const scoped = buildChainedClient(conversationId, [candidate]);

    // Establish sticky
    await scoped.send("Runtime.evaluate", {});

    const result = await scoped.selectTab(42);
    expect(result.tabId).toBe(42);
    expect(result.clientId).toBe("clientA");
    expect(fakeClient.selectTabMock).toHaveBeenCalledWith(42);

    scoped.dispose();
  });

  test("closeTab is forwarded to the underlying client", async () => {
    const conversationId = "conv-tabs-close";
    const fakeClient = makeFakeExtensionClientWithTabMethods(conversationId);
    const candidate = makeCandidateFromClient(conversationId, fakeClient, "extension");

    const scoped = buildChainedClient(conversationId, [candidate]);

    // Establish sticky
    await scoped.send("Runtime.evaluate", {});

    const result = await scoped.closeTab(99);
    expect(result.closed).toBe(true);
    expect(result.tabId).toBe(99);
    expect(fakeClient.closeTabMock).toHaveBeenCalledWith(99);

    scoped.dispose();
  });

  test("listTabs throws transport_error when backend does not support it", async () => {
    const conversationId = "conv-tabs-no-list";
    // A local client without listTabs/selectTab/closeTab
    const noTabsClient: CdpClient & {
      kind: "local";
      conversationId: string;
    } = {
      kind: "local",
      conversationId,
      send: mock(async () => ({})) as unknown as CdpClient["send"],
      dispose: mock(() => {}),
    };
    const candidate = makeCandidateFromClient(
      conversationId,
      noTabsClient,
      "local",
    );

    const scoped = buildChainedClient(conversationId, [candidate]);

    // Establish sticky
    await scoped.send("Runtime.evaluate", {});

    let caught: unknown;
    try {
      await scoped.listTabs();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    expect((caught as CdpError).code).toBe("transport_error");

    scoped.dispose();
  });

  test("selectTab throws transport_error when backend does not support it", async () => {
    const conversationId = "conv-tabs-no-select";
    const noTabsClient: CdpClient & {
      kind: "local";
      conversationId: string;
    } = {
      kind: "local",
      conversationId,
      send: mock(async () => ({})) as unknown as CdpClient["send"],
      dispose: mock(() => {}),
    };
    const candidate = makeCandidateFromClient(
      conversationId,
      noTabsClient,
      "local",
    );

    const scoped = buildChainedClient(conversationId, [candidate]);

    // Establish sticky
    await scoped.send("Runtime.evaluate", {});

    let caught: unknown;
    try {
      await scoped.selectTab(42);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    expect((caught as CdpError).code).toBe("transport_error");

    scoped.dispose();
  });

  test("closeTab throws transport_error when backend does not support it", async () => {
    const conversationId = "conv-tabs-no-close";
    const noTabsClient: CdpClient & {
      kind: "local";
      conversationId: string;
    } = {
      kind: "local",
      conversationId,
      send: mock(async () => ({})) as unknown as CdpClient["send"],
      dispose: mock(() => {}),
    };
    const candidate = makeCandidateFromClient(
      conversationId,
      noTabsClient,
      "local",
    );

    const scoped = buildChainedClient(conversationId, [candidate]);

    // Establish sticky
    await scoped.send("Runtime.evaluate", {});

    let caught: unknown;
    try {
      await scoped.closeTab(77);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    expect((caught as CdpError).code).toBe("transport_error");

    scoped.dispose();
  });
});

describe("buildChainedClient — fresh-client tab calls (no prior send)", () => {
  test("listTabs on a fresh client triggers failover walk and returns tabs", async () => {
    const conversationId = "conv-fresh-list";
    const fakeClient = makeFakeExtensionClientForFreshPath(conversationId);
    const candidate = makeCandidateFromClient(conversationId, fakeClient, "extension");
    const scoped = buildChainedClient(conversationId, [candidate]);

    // Call listTabs WITHOUT establishing sticky — this is the production scenario
    const tabs = await scoped.listTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].tabId).toBe(1);
    expect(tabs[0].active).toBe(true);

    scoped.dispose();
  });

  test("selectTab on a fresh client triggers failover walk and returns tab info", async () => {
    const conversationId = "conv-fresh-select";
    const fakeClient = makeFakeExtensionClientForFreshPath(conversationId);
    const candidate = makeCandidateFromClient(conversationId, fakeClient, "extension");
    const scoped = buildChainedClient(conversationId, [candidate]);

    const result = await scoped.selectTab(42);
    expect(result.tabId).toBe(42);
    expect(result.clientId).toBe("clientA");

    scoped.dispose();
  });

  test("closeTab on a fresh client triggers failover walk and returns closed status", async () => {
    const conversationId = "conv-fresh-close";
    const fakeClient = makeFakeExtensionClientForFreshPath(conversationId);
    const candidate = makeCandidateFromClient(conversationId, fakeClient, "extension");
    const scoped = buildChainedClient(conversationId, [candidate]);

    const result = await scoped.closeTab(99);
    expect(result.closed).toBe(true);
    expect(result.tabId).toBe(99);

    scoped.dispose();
  });

  test("listTabs on fresh non-extension client throws transport_error after sticky established", async () => {
    const conversationId = "conv-fresh-no-list";
    const noTabsClient: CdpClient & { kind: "local"; conversationId: string } = {
      kind: "local",
      conversationId,
      send: mock(async () => ({})) as unknown as CdpClient["send"],
      dispose: mock(() => {}),
    };
    const candidate = makeCandidateFromClient(conversationId, noTabsClient, "local");
    const scoped = buildChainedClient(conversationId, [candidate]);

    // No prior send — fresh client, non-extension backend
    let caught: unknown;
    try {
      await scoped.listTabs();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    expect((caught as CdpError).code).toBe("transport_error");

    scoped.dispose();
  });
});
