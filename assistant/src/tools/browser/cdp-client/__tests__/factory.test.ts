import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { HostBrowserProxy } from "../../../../daemon/host-browser-proxy.js";
import type { ToolContext } from "../../../types.js";
import { CdpError } from "../errors.js";

type FakeClient = {
  kind: "extension" | "local" | "cdp-inspect";
  conversationId: string;
  send: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
};

function makeFakeExtensionClient(conversationId: string): FakeClient {
  return {
    kind: "extension",
    conversationId,
    send: mock(async () => ({ ok: true, via: "extension" })),
    dispose: mock(() => {}),
  };
}

function makeFakeLocalClient(conversationId: string): FakeClient {
  return {
    kind: "local",
    conversationId,
    send: mock(async () => ({ ok: true, via: "local" })),
    dispose: mock(() => {}),
  };
}

function makeFakeCdpInspectClient(conversationId: string): FakeClient {
  return {
    kind: "cdp-inspect",
    conversationId,
    send: mock(async () => ({ ok: true, via: "cdp-inspect" })),
    dispose: mock(() => {}),
  };
}

let lastExtensionClient: FakeClient | undefined;
let lastLocalClient: FakeClient | undefined;
let lastCdpInspectClient: FakeClient | undefined;

const createExtensionCdpClientMock = mock(
  (_proxy: HostBrowserProxy, conversationId: string) => {
    const client = makeFakeExtensionClient(conversationId);
    lastExtensionClient = client;
    return client;
  },
);

const createLocalCdpClientMock = mock((conversationId: string) => {
  const client = makeFakeLocalClient(conversationId);
  lastLocalClient = client;
  return client;
});

const createCdpInspectClientMock = mock(
  (conversationId: string, _options: unknown) => {
    const client = makeFakeCdpInspectClient(conversationId);
    lastCdpInspectClient = client;
    return client;
  },
);

/**
 * Mutable config state. Tests flip `cdpInspectEnabled` and
 * `desktopAutoConfig` to control the factory's config-based selection
 * without needing a real config file.
 */
let cdpInspectEnabled = false;
let desktopAutoConfig = { enabled: true, cooldownMs: 30_000 };

/**
 * Captured log calls for verifying fallback log payloads.
 */
const logWarnCalls: Array<{ args: unknown[] }> = [];
const logDebugCalls: Array<{ args: unknown[] }> = [];

// Spread-real-module pattern: bun's `mock.module` is process-global, so a
// factory that returns ONLY `{ createExtensionCdpClient }` would clobber
// the `ExtensionCdpClient` class export for every later test file that
// imports from this module path (e.g. extension-cdp-client.test.ts). We
// snapshot the real exports first and override only the symbols this
// suite stubs out.
import * as realCdpInspectClient from "../cdp-inspect-client.js";
import * as realExtensionCdpClient from "../extension-cdp-client.js";
import * as realLocalCdpClient from "../local-cdp-client.js";

mock.module("../extension-cdp-client.js", () => ({
  ...realExtensionCdpClient,
  createExtensionCdpClient: createExtensionCdpClientMock,
}));
mock.module("../local-cdp-client.js", () => ({
  ...realLocalCdpClient,
  createLocalCdpClient: createLocalCdpClientMock,
}));
mock.module("../cdp-inspect-client.js", () => ({
  ...realCdpInspectClient,
  createCdpInspectClient: createCdpInspectClientMock,
}));
mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({
    hostBrowser: {
      cdpInspect: {
        enabled: cdpInspectEnabled,
        host: "localhost",
        port: 9222,
        probeTimeoutMs: 500,
        desktopAuto: desktopAutoConfig,
      },
    },
  }),
}));
mock.module("../../../../util/logger.js", () => ({
  getLogger: () => ({
    debug: (...args: unknown[]) => {
      logDebugCalls.push({ args });
    },
    warn: (...args: unknown[]) => {
      logWarnCalls.push({ args });
    },
    info: () => {},
    error: () => {},
  }),
}));

/** Mutable singleton proxy. Tests set this to control extension availability. */
let mockSingletonProxy: HostBrowserProxy | null = null;

/** Default proxy that reports unavailable — used when no test override is set. */
const unavailableFallback: HostBrowserProxy = {
  isAvailable: () => false,
  hasExtensionClient: () => false,
  request: () => Promise.reject(new Error("no extension")),
  resolve: () => {},
  hasPendingRequest: () => false,
  dispose: () => {},
} as unknown as HostBrowserProxy;

mock.module("../../../../daemon/host-browser-proxy.js", () => ({
  HostBrowserProxy: {
    get instance() {
      return mockSingletonProxy ?? unavailableFallback;
    },
    reset() {
      mockSingletonProxy = null;
    },
  },
}));

// Import under test AFTER mock.module calls so that the factory's
// top-level imports resolve to our fakes.
const {
  getCdpClient,
  buildCandidateList,
  buildChainedClient,
  buildPinnedCandidateList,
  _resetDesktopAutoCooldown,
  _getDesktopAutoCooldownSince,
  recordDesktopAutoCooldown,
  isDesktopAutoCooldownActive,
} = await import("../factory.js");

/**
 * Minimal ToolContext suitable for factory tests. Only `conversationId`
 * needs to be populated; other required fields are cast away.
 * Extension availability is controlled via `mockSingletonProxy`.
 */
function makeContext(
  overrides: Partial<ToolContext> & { conversationId: string },
): ToolContext {
  return overrides as unknown as ToolContext;
}

/**
 * Create a fake HostBrowserProxy with a Chrome Extension client connected.
 * Both isAvailable() and hasExtensionClient() return true.
 */
function makeAvailableProxy(): HostBrowserProxy {
  return {
    request: mock(async () => ({})),
    isAvailable: () => true,
    hasExtensionClient: () => true,
  } as unknown as HostBrowserProxy;
}

/**
 * Create a fake HostBrowserProxy where only the macOS SSE bridge is connected
 * (no Chrome Extension). isAvailable() is true but hasExtensionClient() is false.
 */
function makeMacosBridgeOnlyProxy(): HostBrowserProxy {
  return {
    request: mock(async () => ({})),
    isAvailable: () => true,
    hasExtensionClient: () => false,
  } as unknown as HostBrowserProxy;
}

/**
 * Create a fake HostBrowserProxy that reports as unavailable
 * (proxy exists but no client of any kind is connected).
 */
function makeUnavailableProxy(): HostBrowserProxy {
  return {
    request: mock(async () => ({})),
    isAvailable: () => false,
    hasExtensionClient: () => false,
  } as unknown as HostBrowserProxy;
}

describe("getCdpClient", () => {
  beforeEach(() => {
    createExtensionCdpClientMock.mockClear();
    createLocalCdpClientMock.mockClear();
    createCdpInspectClientMock.mockClear();
    lastExtensionClient = undefined;
    lastLocalClient = undefined;
    lastCdpInspectClient = undefined;
    cdpInspectEnabled = false;
    desktopAutoConfig = { enabled: true, cooldownMs: 30_000 };
    _resetDesktopAutoCooldown();
    logWarnCalls.length = 0;
    logDebugCalls.length = 0;
    mockSingletonProxy = null;
  });

  // ── Candidate selection (kind reported before first send) ────────────

  test("routes to ExtensionCdpClient when hostBrowserProxy is set and available", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "test-convo",
    });

    const client = getCdpClient(ctx);

    // kind should reflect extension before first send (top candidate)
    expect(client.kind).toBe("extension");
    expect(client.conversationId).toBe("test-convo");

    // Lazy creation: client is not created until first send
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
      { url: "https://example.com" },
    );
    expect(result).toEqual({ ok: true, via: "extension" });
    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    // Call signature includes optional cdpSessionId, sourceActorPrincipalId,
    // and targetClientId (all undefined here — no pinned session id, no actor
    // binding, no explicit client target in this legacy ctx).
    expect(createExtensionCdpClientMock).toHaveBeenCalledWith(
      fakeProxy,
      "test-convo",
      undefined,
      undefined,
      undefined,
    );
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
  });

  test("skips extension when hostBrowserProxy is present but unavailable", async () => {
    const fakeProxy = makeUnavailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "disconnected-proxy",
    });

    const client = getCdpClient(ctx);

    // Should fall through to local since extension is not available
    expect(client.kind).toBe("local");
    expect(client.conversationId).toBe("disconnected-proxy");

    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "local" });
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createLocalCdpClientMock).toHaveBeenCalledTimes(1);
  });

  test("skips extension but uses cdp-inspect when proxy unavailable and cdp-inspect enabled", async () => {
    cdpInspectEnabled = true;
    const fakeProxy = makeUnavailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "disconnected-inspect",
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("cdp-inspect");

    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "cdp-inspect" });
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).toHaveBeenCalledTimes(1);
  });

  test("extension wins even when cdpInspect is enabled", async () => {
    cdpInspectEnabled = true;
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "ext-wins",
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("extension");
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "extension" });
    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
  });

  test("routes to CdpInspectClient when cdpInspect is enabled and extension is absent", async () => {
    cdpInspectEnabled = true;
    const ctx = makeContext({
      conversationId: "inspect-convo",
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("cdp-inspect");
    expect(client.conversationId).toBe("inspect-convo");

    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
      { url: "https://example.com" },
    );
    expect(result).toEqual({ ok: true, via: "cdp-inspect" });
    expect(createCdpInspectClientMock).toHaveBeenCalledTimes(1);
    expect(createCdpInspectClientMock).toHaveBeenCalledWith("inspect-convo", {
      host: "localhost",
      port: 9222,
      discoveryTimeoutMs: 500,
    });
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
  });

  test("routes to LocalCdpClient when cdpInspect is disabled and extension is absent", async () => {
    cdpInspectEnabled = false;
    const ctx = makeContext({
      conversationId: "local-convo",
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("local");
    expect(client.conversationId).toBe("local-convo");

    const result = await client.send<{ ok: boolean; via: string }>(
      "Runtime.evaluate",
      { expression: "1+1" },
    );
    expect(result).toEqual({ ok: true, via: "local" });
    expect(createLocalCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createLocalCdpClientMock).toHaveBeenCalledWith("local-convo");
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
  });

  test("routes to LocalCdpClient when hostBrowserProxy key is omitted", async () => {
    const ctx = makeContext({ conversationId: "another-convo" });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("local");
    expect(client.conversationId).toBe("another-convo");

    await client.send("Runtime.evaluate");
    expect(createLocalCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createLocalCdpClientMock).toHaveBeenCalledWith("another-convo");
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
  });

  // ── Backwards compatibility: omitted mode behaves as auto ───────────

  test("getCdpClient without options behaves identically to auto mode", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "no-opts",
    });

    const client = getCdpClient(ctx);
    expect(client.kind).toBe("extension");
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "extension" });
  });

  test("getCdpClient with explicit auto mode behaves identically to omitted mode", async () => {
    const ctx = makeContext({ conversationId: "explicit-auto" });

    const client = getCdpClient(ctx, { mode: "auto" });
    expect(client.kind).toBe("local");
    const result = await client.send<{ ok: boolean; via: string }>(
      "Runtime.evaluate",
    );
    expect(result).toEqual({ ok: true, via: "local" });
  });

  // ── send() forwarding ────────────────────────────────────────────────

  test("forwards send() through the manager to the extension-backed client", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "send-ext",
    });

    const client = getCdpClient(ctx);
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
      { url: "https://example.com" },
    );

    expect(result).toEqual({ ok: true, via: "extension" });
    expect(lastExtensionClient?.send).toHaveBeenCalledTimes(1);
    expect(lastExtensionClient?.send).toHaveBeenCalledWith(
      "Page.navigate",
      { url: "https://example.com" },
      undefined,
    );
    expect(lastLocalClient).toBeUndefined();
    expect(lastCdpInspectClient).toBeUndefined();
  });

  test("forwards send() through the manager to the local-backed client", async () => {
    const ctx = makeContext({ conversationId: "send-local" });

    const client = getCdpClient(ctx);
    const result = await client.send<{ ok: boolean; via: string }>(
      "Runtime.evaluate",
      { expression: "1+1" },
    );

    expect(result).toEqual({ ok: true, via: "local" });
    expect(lastLocalClient?.send).toHaveBeenCalledTimes(1);
    expect(lastLocalClient?.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      { expression: "1+1" },
      undefined,
    );
    expect(lastExtensionClient).toBeUndefined();
    expect(lastCdpInspectClient).toBeUndefined();
  });

  test("forwards send() through the manager to the cdp-inspect-backed client", async () => {
    cdpInspectEnabled = true;
    const ctx = makeContext({ conversationId: "send-inspect" });

    const client = getCdpClient(ctx);
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
      { url: "https://example.com" },
    );

    expect(result).toEqual({ ok: true, via: "cdp-inspect" });
    expect(lastCdpInspectClient?.send).toHaveBeenCalledTimes(1);
    expect(lastCdpInspectClient?.send).toHaveBeenCalledWith(
      "Page.navigate",
      { url: "https://example.com" },
      undefined,
    );
    expect(lastExtensionClient).toBeUndefined();
    expect(lastLocalClient).toBeUndefined();
  });

  // ── Error propagation ────────────────────────────────────────────────

  test("propagates CdpError (cdp_error) thrown by the underlying client without failover", async () => {
    cdpInspectEnabled = true;
    const ctx = makeContext({ conversationId: "err-no-failover" });
    const client = getCdpClient(ctx);

    // Override cdp-inspect client to throw a cdp_error
    createCdpInspectClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeCdpInspectClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("cdp_error", "kaboom", {
            cdpMethod: "Page.navigate",
          });
        });
        lastCdpInspectClient = c;
        return c;
      },
    );

    await expect(
      client.send("Page.navigate", { url: "https://example.com" }),
    ).rejects.toMatchObject({ code: "cdp_error", message: "kaboom" });

    // Should NOT have fallen through to local
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
  });

  test("propagates caller AbortSignal to the underlying client", async () => {
    const ctx = makeContext({ conversationId: "abort-local" });
    const client = getCdpClient(ctx);
    const controller = new AbortController();

    // First, do a normal send to establish the sticky backend
    await client.send("Runtime.evaluate", { expression: "1" });

    let sawSignal: AbortSignal | undefined;
    lastLocalClient!.send = mock(
      async (
        _method: string,
        _params?: Record<string, unknown>,
        signal?: AbortSignal,
      ) => {
        sawSignal = signal;
        if (signal?.aborted) {
          throw new CdpError("aborted", "aborted before send");
        }
        return {};
      },
    );

    controller.abort();
    await expect(
      client.send("Page.navigate", { url: "https://x" }, controller.signal),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(sawSignal).toBe(controller.signal);
  });

  // ── Dispose ──────────────────────────────────────────────────────────

  test("dispose() tears down the underlying client and rejects further sends", async () => {
    const ctx = makeContext({ conversationId: "dispose-local" });
    const client = getCdpClient(ctx);

    // Trigger client creation via send
    await client.send("Runtime.evaluate");
    expect(lastLocalClient).toBeDefined();

    client.dispose();
    expect(lastLocalClient?.dispose).toHaveBeenCalledTimes(1);

    // A second dispose is a no-op.
    client.dispose();
    expect(lastLocalClient?.dispose).toHaveBeenCalledTimes(1);

    await expect(client.send("Runtime.evaluate")).rejects.toMatchObject({
      code: "disposed",
    });
  });

  test("dispose() on an extension-backed client tears down the extension client", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "dispose-ext",
    });

    const client = getCdpClient(ctx);
    await client.send("Page.navigate");
    client.dispose();

    expect(lastExtensionClient?.dispose).toHaveBeenCalledTimes(1);
  });

  test("dispose() on a cdp-inspect-backed client tears down the inspect client", async () => {
    cdpInspectEnabled = true;
    const ctx = makeContext({ conversationId: "dispose-inspect" });

    const client = getCdpClient(ctx);
    await client.send("Page.navigate");
    client.dispose();

    expect(lastCdpInspectClient?.dispose).toHaveBeenCalledTimes(1);
  });

  test("send() after dispose() on a cdp-inspect-backed client rejects with disposed", async () => {
    cdpInspectEnabled = true;
    const ctx = makeContext({ conversationId: "post-dispose-inspect" });

    const client = getCdpClient(ctx);
    await client.send("Page.navigate");
    client.dispose();

    // Double dispose is a no-op.
    client.dispose();
    expect(lastCdpInspectClient?.dispose).toHaveBeenCalledTimes(1);

    await expect(client.send("Page.navigate")).rejects.toMatchObject({
      code: "disposed",
    });
  });

  test("dispose() before first send still rejects further sends", async () => {
    const ctx = makeContext({ conversationId: "dispose-before-send" });
    const client = getCdpClient(ctx);

    client.dispose();

    await expect(client.send("Runtime.evaluate")).rejects.toMatchObject({
      code: "disposed",
    });
    // No clients should have been created
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
  });

  // ── transportInterface backwards compatibility ──────────────────────

  test("context without transportInterface still routes to local backend", async () => {
    const ctx = makeContext({ conversationId: "no-interface" });
    expect(ctx.transportInterface).toBeUndefined();

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("local");
    expect(client.conversationId).toBe("no-interface");
    await client.send("Runtime.evaluate");
    expect(createLocalCdpClientMock).toHaveBeenCalledTimes(1);
  });

  test("context with transportInterface set routes normally to extension backend", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "macos-ext",
      transportInterface: "macos",
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("extension");
    expect(client.conversationId).toBe("macos-ext");
    await client.send("Page.navigate");
    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
  });

  test("context with transportInterface=macos routes to desktop-auto cdp-inspect when no proxy", async () => {
    const ctx = makeContext({
      conversationId: "macos-local",
      transportInterface: "macos",
    });

    const client = getCdpClient(ctx);

    // desktopAuto.enabled is true by default and no proxy is provisioned,
    // so cdp-inspect is the first candidate (desktop-auto path).
    expect(client.kind).toBe("cdp-inspect");
    expect(client.conversationId).toBe("macos-local");
    await client.send("Page.navigate");
    expect(createCdpInspectClientMock).toHaveBeenCalledTimes(1);
  });

  test("context with transportInterface set routes to cdp-inspect when enabled", async () => {
    cdpInspectEnabled = true;
    const ctx = makeContext({
      conversationId: "macos-inspect",
      transportInterface: "macos",
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("cdp-inspect");
    expect(client.conversationId).toBe("macos-inspect");
    await client.send("Page.navigate");
    expect(createCdpInspectClientMock).toHaveBeenCalledTimes(1);
  });

  test("threads sourceActorPrincipalId from ToolContext into createExtensionCdpClient", async () => {
    // The proxy uses sourceActorPrincipalId to refuse cross-user dispatch
    // when host_browser is exposed cross-client (web/iOS turn → connected
    // extension/macOS bridge). The factory must thread the value from the
    // ToolContext through to ExtensionCdpClient on every candidate-list path
    // so the actor identity reaches the proxy at request time.
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "actor-bound",
      sourceActorPrincipalId: "user-actor-1",
    });

    const client = getCdpClient(ctx);
    await client.send("Page.navigate");

    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createExtensionCdpClientMock).toHaveBeenCalledWith(
      fakeProxy,
      "actor-bound",
      undefined,
      "user-actor-1",
      undefined,
    );
  });

  test("threads targetClientId from options into createExtensionCdpClient", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "targeted-client",
      sourceActorPrincipalId: "user-actor-1",
    });

    const client = getCdpClient(ctx, { targetClientId: "specific-ext-client" });
    await client.send("Page.navigate");

    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createExtensionCdpClientMock).toHaveBeenCalledWith(
      fakeProxy,
      "targeted-client",
      undefined,
      "user-actor-1",
      "specific-ext-client",
    );
  });

  // ── auto mode + targetClientId: no fallback (Fix 2) ─────────────────

  test("auto mode + targetClientId + no extension → throws targeting error, does not fall through to local", () => {
    // No extension connected — without targetClientId, local would be the
    // fallback. With targetClientId, the factory must fail immediately.
    const ctx = makeContext({ conversationId: "auto-targeted-no-ext" });

    expect(() =>
      getCdpClient(ctx, { mode: "auto", targetClientId: "specific-host-client" }),
    ).toThrow(
      expect.objectContaining({
        code: "transport_error",
        message: expect.stringContaining("specific-host-client"),
      }),
    );
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
  });

  test("auto mode + targetClientId + extension available → routes only to extension, no other backends tried", async () => {
    cdpInspectEnabled = true; // cdp-inspect would normally be in the candidate list
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "auto-targeted-ext-available",
      sourceActorPrincipalId: "actor-42",
    });

    const client = getCdpClient(ctx, {
      mode: "auto",
      targetClientId: "specific-host-client",
    });
    expect(client.kind).toBe("extension");

    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "extension" });

    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createExtensionCdpClientMock).toHaveBeenCalledWith(
      fakeProxy,
      "auto-targeted-ext-available",
      undefined,
      "actor-42",
      "specific-host-client",
    );
    // cdp-inspect and local must NOT have been tried — no fallback.
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
  });
});

// ── buildCandidateList tests ─────────────────────────────────────────────

describe("buildCandidateList", () => {
  beforeEach(() => {
    cdpInspectEnabled = false;
    desktopAutoConfig = { enabled: true, cooldownMs: 30_000 };
    _resetDesktopAutoCooldown();
    mockSingletonProxy = null;
  });

  test("includes extension candidate when proxy is present and available", () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "candidates-ext",
    });

    const candidates = buildCandidateList(ctx);

    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0].kind).toBe("extension");
    // Local is always present as fallback
    expect(candidates[candidates.length - 1].kind).toBe("local");
  });

  test("excludes extension candidate when proxy is present but unavailable", () => {
    const fakeProxy = makeUnavailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "candidates-no-ext",
    });

    const candidates = buildCandidateList(ctx);

    expect(candidates.every((c) => c.kind !== "extension")).toBe(true);
    expect(candidates[0].kind).toBe("local");
  });

  test("excludes extension candidate when only macOS SSE bridge is connected", () => {
    // isAvailable() = true but hasExtensionClient() = false: only macOS bridge.
    // The macOS bridge routes through localhost:9222 on the host, so it must
    // NOT be included under the "extension" candidate kind.
    const fakeProxy = makeMacosBridgeOnlyProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "candidates-macos-bridge-only",
    });

    const candidates = buildCandidateList(ctx);

    expect(candidates.every((c) => c.kind !== "extension")).toBe(true);
    expect(candidates[candidates.length - 1].kind).toBe("local");
  });

  test("includes cdp-inspect candidate when enabled in config", () => {
    cdpInspectEnabled = true;
    const ctx = makeContext({ conversationId: "candidates-inspect" });

    const candidates = buildCandidateList(ctx);

    expect(candidates[0].kind).toBe("cdp-inspect");
    expect(candidates[1].kind).toBe("local");
  });

  test("candidate order: extension > cdp-inspect > local when all present", () => {
    cdpInspectEnabled = true;
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "candidates-all",
    });

    const candidates = buildCandidateList(ctx);

    expect(candidates.length).toBe(3);
    expect(candidates[0].kind).toBe("extension");
    expect(candidates[1].kind).toBe("cdp-inspect");
    expect(candidates[2].kind).toBe("local");
  });

  test("local is always included as final candidate", () => {
    const ctx = makeContext({ conversationId: "candidates-local-only" });

    const candidates = buildCandidateList(ctx);

    expect(candidates.length).toBe(1);
    expect(candidates[0].kind).toBe("local");
  });

  // ── targetClientId: no-fallback single-extension list (Fix 2) ────────

  test("targetClientId: returns a single extension candidate when extension is available", () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({ conversationId: "target-with-ext" });

    const candidates = buildCandidateList(ctx, "host-client-42");

    // Must be exactly one candidate — no cdp-inspect or local fallbacks.
    expect(candidates.length).toBe(1);
    expect(candidates[0].kind).toBe("extension");
    expect(candidates[0].reason).toContain("host-client-42");
  });

  test("targetClientId: throws transport_error immediately when no Chrome Extension is connected", () => {
    // No extension — local would normally be the fallback, but targeting
    // requires the proxy path and must fail loudly instead of routing elsewhere.
    const ctx = makeContext({ conversationId: "target-no-ext" });

    expect(() => buildCandidateList(ctx, "host-client-42")).toThrow(
      expect.objectContaining({
        code: "transport_error",
        message: expect.stringContaining("host-client-42"),
      }),
    );
    // Verify we did NOT silently fall through to a local candidate.
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
  });

  test("targetClientId: threads targetClientId into the extension candidate's create() call", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "target-threads-id",
      sourceActorPrincipalId: "actor-1",
    });

    const candidates = buildCandidateList(ctx, "host-client-99");
    expect(candidates.length).toBe(1);

    // Clear accumulated calls from prior tests in this describe block before
    // materialising the candidate so the call count is unambiguous.
    createExtensionCdpClientMock.mockClear();
    candidates[0].create();

    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createExtensionCdpClientMock).toHaveBeenCalledWith(
      fakeProxy,
      "target-threads-id",
      undefined,
      "actor-1",
      "host-client-99",
    );
  });
});

// ── buildChainedClient failover tests ────────────────────────────────────

describe("buildChainedClient failover", () => {
  beforeEach(() => {
    createExtensionCdpClientMock.mockClear();
    createLocalCdpClientMock.mockClear();
    createCdpInspectClientMock.mockClear();
    lastExtensionClient = undefined;
    lastLocalClient = undefined;
    lastCdpInspectClient = undefined;
    cdpInspectEnabled = false;
    desktopAutoConfig = { enabled: true, cooldownMs: 30_000 };
    _resetDesktopAutoCooldown();
    logWarnCalls.length = 0;
    logDebugCalls.length = 0;
    mockSingletonProxy = null;
  });

  test("fails over from extension to local on transport_error", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;

    // Make extension client fail with transport_error
    createExtensionCdpClientMock.mockImplementationOnce(
      (_proxy: HostBrowserProxy, conversationId: string) => {
        const c = makeFakeExtensionClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError(
            "transport_error",
            "Extension WebSocket disconnected",
            {
              cdpMethod: "Page.navigate",
            },
          );
        });
        lastExtensionClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "failover-ext-to-local",
    });

    const client = getCdpClient(ctx);
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
      { url: "https://example.com" },
    );

    expect(result).toEqual({ ok: true, via: "local" });
    // Extension was tried first
    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    // Then local was used as fallback
    expect(createLocalCdpClientMock).toHaveBeenCalledTimes(1);
  });

  test("fails over from extension to cdp-inspect to local on transport errors", async () => {
    cdpInspectEnabled = true;
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;

    // Make extension fail with transport_error
    createExtensionCdpClientMock.mockImplementationOnce(
      (_proxy: HostBrowserProxy, conversationId: string) => {
        const c = makeFakeExtensionClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "Extension disconnected", {
            cdpMethod: "Page.navigate",
          });
        });
        lastExtensionClient = c;
        return c;
      },
    );

    // Make cdp-inspect also fail with transport_error
    createCdpInspectClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeCdpInspectClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "Chrome not running", {
            cdpMethod: "Page.navigate",
          });
        });
        lastCdpInspectClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "failover-chain",
    });

    const client = getCdpClient(ctx);
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
      { url: "https://example.com" },
    );

    expect(result).toEqual({ ok: true, via: "local" });
    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createCdpInspectClientMock).toHaveBeenCalledTimes(1);
    expect(createLocalCdpClientMock).toHaveBeenCalledTimes(1);
  });

  test("does NOT fail over on cdp_error -- propagates immediately", async () => {
    cdpInspectEnabled = true;
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;

    // Make extension fail with cdp_error (not transport_error)
    createExtensionCdpClientMock.mockImplementationOnce(
      (_proxy: HostBrowserProxy, conversationId: string) => {
        const c = makeFakeExtensionClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("cdp_error", "Protocol error", {
            cdpMethod: "Page.navigate",
          });
        });
        lastExtensionClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "no-failover-cdp-error",
    });

    const client = getCdpClient(ctx);

    await expect(
      client.send("Page.navigate", { url: "https://example.com" }),
    ).rejects.toMatchObject({
      code: "cdp_error",
      message: "Protocol error",
    });

    // cdp-inspect and local should NOT have been tried
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
  });

  test("transport_error on last candidate propagates the error", async () => {
    // Only local is available (no extension, no cdp-inspect)
    const ctx = makeContext({ conversationId: "last-candidate-fail" });

    // Make local fail with transport_error
    createLocalCdpClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeLocalClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "Playwright failed to launch", {
            cdpMethod: "Page.navigate",
          });
        });
        lastLocalClient = c;
        return c;
      },
    );

    const client = getCdpClient(ctx);

    await expect(client.send("Page.navigate")).rejects.toMatchObject({
      code: "transport_error",
      message: "Playwright failed to launch",
    });
  });

  // ── Sticky backend tests ─────────────────────────────────────────────

  test("backend becomes sticky after first successful command", async () => {
    cdpInspectEnabled = true;
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;

    // Make extension fail on first call with transport_error
    createExtensionCdpClientMock.mockImplementationOnce(
      (_proxy: HostBrowserProxy, conversationId: string) => {
        const c = makeFakeExtensionClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "Extension disconnected", {
            cdpMethod: "Page.navigate",
          });
        });
        lastExtensionClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "sticky-test",
    });

    const client = getCdpClient(ctx);

    // First send fails over from extension to cdp-inspect
    const result1 = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
      { url: "https://example.com" },
    );
    expect(result1).toEqual({ ok: true, via: "cdp-inspect" });

    // Second send should reuse cdp-inspect without trying extension again
    const result2 = await client.send<{ ok: boolean; via: string }>(
      "Runtime.evaluate",
      { expression: "1+1" },
    );
    expect(result2).toEqual({ ok: true, via: "cdp-inspect" });

    // Extension should only have been constructed once (during failover)
    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    // cdp-inspect should only have been constructed once (sticky)
    expect(createCdpInspectClientMock).toHaveBeenCalledTimes(1);
    // Local should never have been constructed
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();

    // Verify the sticky client's send was called for both commands
    // The first call is from failover, the second from sticky path
    expect(lastCdpInspectClient?.send).toHaveBeenCalledTimes(2);
  });

  test("sticky backend does not change on subsequent transport errors", async () => {
    const ctx = makeContext({ conversationId: "sticky-err" });

    const client = getCdpClient(ctx);

    // First send succeeds, establishing local as sticky
    await client.send("Runtime.evaluate", { expression: "1" });
    expect(client.kind).toBe("local");

    // Now make local throw a transport error on second send
    lastLocalClient!.send = mock(async () => {
      throw new CdpError("transport_error", "Connection lost");
    });

    // The error should propagate without failover since backend is sticky
    await expect(client.send("Page.navigate")).rejects.toMatchObject({
      code: "transport_error",
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  test("buildChainedClient throws on empty candidate list", () => {
    expect(() => buildChainedClient("test", [])).toThrow(
      "CDP factory: no backend candidates available",
    );
  });

  test("kind reflects the active backend after failover", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;

    // Make extension fail
    createExtensionCdpClientMock.mockImplementationOnce(
      (_proxy: HostBrowserProxy, conversationId: string) => {
        const c = makeFakeExtensionClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "disconnected");
        });
        lastExtensionClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "kind-after-failover",
    });

    const client = getCdpClient(ctx);

    // Before first send, kind reflects the first candidate
    expect(client.kind).toBe("extension");

    // After failover, kind should reflect the local backend
    await client.send("Page.navigate");
    expect(client.kind).toBe("local");
  });

  test("dispose cleans up failed backends from failover chain", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;

    // Make extension fail
    createExtensionCdpClientMock.mockImplementationOnce(
      (_proxy: HostBrowserProxy, conversationId: string) => {
        const c = makeFakeExtensionClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "disconnected");
        });
        lastExtensionClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "dispose-failover",
    });

    const client = getCdpClient(ctx);
    await client.send("Page.navigate");

    // Now dispose -- both the failed extension backend and the
    // successful local backend should be cleaned up.
    client.dispose();

    // The extension client's dispose was already called during
    // failover (via manager.disposeAll()), and local's dispose should
    // be called now
    expect(lastLocalClient?.dispose).toHaveBeenCalled();
  });
});

// ── Desktop-auto cdp-inspect for macOS ──────────────────────────────────

describe("desktop-auto cdp-inspect (macOS)", () => {
  beforeEach(() => {
    createExtensionCdpClientMock.mockClear();
    createLocalCdpClientMock.mockClear();
    createCdpInspectClientMock.mockClear();
    lastExtensionClient = undefined;
    lastLocalClient = undefined;
    lastCdpInspectClient = undefined;
    cdpInspectEnabled = false;
    desktopAutoConfig = { enabled: true, cooldownMs: 30_000 };
    _resetDesktopAutoCooldown();
    logWarnCalls.length = 0;
    logDebugCalls.length = 0;
    mockSingletonProxy = null;
  });

  // ── buildCandidateList with desktopAuto ─────────────────────────────

  test("macOS turn includes cdp-inspect candidate even when enabled is false", () => {
    const ctx = makeContext({
      conversationId: "macos-auto",
      transportInterface: "macos",
    });

    const candidates = buildCandidateList(ctx);

    expect(candidates.length).toBe(2);
    expect(candidates[0].kind).toBe("cdp-inspect");
    expect(candidates[0].reason).toContain("desktopAuto");
    expect(candidates[1].kind).toBe("local");
  });

  test("macOS turn with extension available: extension > cdp-inspect > local", () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "macos-all",
      transportInterface: "macos",
    });

    const candidates = buildCandidateList(ctx);

    expect(candidates.length).toBe(3);
    expect(candidates[0].kind).toBe("extension");
    expect(candidates[1].kind).toBe("cdp-inspect");
    expect(candidates[1].reason).toContain("desktopAuto");
    expect(candidates[2].kind).toBe("local");
  });

  test("macOS turn with registry-routed proxy unavailable skips desktop-auto cdp-inspect (extension intent)", () => {
    const fakeProxy = makeUnavailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "macos-proxy-unavailable-no-inspect",
      transportInterface: "macos",
    });

    const candidates = buildCandidateList(ctx);

    // Extension unavailable => cdp-inspect (desktop-auto) + local
    expect(candidates.length).toBe(2);
    expect(candidates[0].kind).toBe("cdp-inspect");
    expect(candidates[1].kind).toBe("local");
  });

  test("macOS turn with singleton proxy unavailable still includes desktop-auto cdp-inspect", () => {
    const fakeProxy = makeUnavailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "macos-proxy-unavailable-inspect-allowed",
      transportInterface: "macos",
    });

    const candidates = buildCandidateList(ctx);

    // Extension unavailable => cdp-inspect (desktop-auto) + local
    expect(candidates.length).toBe(2);
    expect(candidates[0].kind).toBe("cdp-inspect");
    expect(candidates[1].kind).toBe("local");
  });

  test("macOS turn with no proxy still includes desktop-auto cdp-inspect", () => {
    const ctx = makeContext({
      conversationId: "macos-no-proxy-inspect-allowed",
      transportInterface: "macos",
    });

    const candidates = buildCandidateList(ctx);

    // No proxy provisioned => cdp-inspect remains available as fallback
    expect(candidates.length).toBe(2);
    expect(candidates[0].kind).toBe("cdp-inspect");
    expect(candidates[0].reason).toContain("desktopAuto");
    expect(candidates[1].kind).toBe("local");
  });

  test("macOS turn with extension available still includes cdp-inspect as fallback", () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "macos-ext-available-inspect-fallback",
      transportInterface: "macos",
    });

    const candidates = buildCandidateList(ctx);

    // Extension is available => extension + cdp-inspect (desktop-auto) + local
    expect(candidates.length).toBe(3);
    expect(candidates[0].kind).toBe("extension");
    expect(candidates[1].kind).toBe("cdp-inspect");
    expect(candidates[1].reason).toContain("desktopAuto");
    expect(candidates[2].kind).toBe("local");
  });

  test("macOS turn does NOT include cdp-inspect when desktopAuto.enabled is false", () => {
    desktopAutoConfig = { enabled: false, cooldownMs: 30_000 };
    const ctx = makeContext({
      conversationId: "macos-no-auto",
      transportInterface: "macos",
    });

    const candidates = buildCandidateList(ctx);

    expect(candidates.length).toBe(1);
    expect(candidates[0].kind).toBe("local");
  });

  test("non-macOS turn does NOT include cdp-inspect when enabled is false", () => {
    const ctx = makeContext({
      conversationId: "cli-no-auto",
      transportInterface: "cli",
    });

    const candidates = buildCandidateList(ctx);

    expect(candidates.length).toBe(1);
    expect(candidates[0].kind).toBe("local");
  });

  test("non-macOS turn without transportInterface does NOT include cdp-inspect", () => {
    const ctx = makeContext({
      conversationId: "no-interface-no-auto",
    });

    const candidates = buildCandidateList(ctx);

    expect(candidates.length).toBe(1);
    expect(candidates[0].kind).toBe("local");
  });

  test("explicit cdpInspect.enabled takes precedence over desktopAuto on macOS", () => {
    cdpInspectEnabled = true;
    const ctx = makeContext({
      conversationId: "macos-explicit",
      transportInterface: "macos",
    });

    const candidates = buildCandidateList(ctx);

    // Should include cdp-inspect via the explicit path, not desktopAuto
    expect(candidates.length).toBe(2);
    expect(candidates[0].kind).toBe("cdp-inspect");
    expect(candidates[0].reason).toBe("cdpInspect enabled in config");
    expect(candidates[1].kind).toBe("local");
  });

  // ── Cooldown behaviour ──────────────────────────────────────────────

  test("macOS turn skips cdp-inspect when cooldown is active", () => {
    // Record a cooldown
    recordDesktopAutoCooldown();

    const ctx = makeContext({
      conversationId: "macos-cooldown",
      transportInterface: "macos",
    });

    const candidates = buildCandidateList(ctx);

    // Should skip cdp-inspect and only include local
    expect(candidates.length).toBe(1);
    expect(candidates[0].kind).toBe("local");
  });

  test("macOS turn includes cdp-inspect after cooldown expires", () => {
    // Set cooldown to 0 (disabled)
    desktopAutoConfig = { enabled: true, cooldownMs: 0 };

    // Record a "cooldown" -- but with cooldownMs=0 it should be ignored
    recordDesktopAutoCooldown();

    const ctx = makeContext({
      conversationId: "macos-expired-cooldown",
      transportInterface: "macos",
    });

    const candidates = buildCandidateList(ctx);

    // cooldownMs=0 means never suppress
    expect(candidates.length).toBe(2);
    expect(candidates[0].kind).toBe("cdp-inspect");
    expect(candidates[1].kind).toBe("local");
  });

  // ── Cooldown recording on transport failures ───────────────────────

  test("desktop-auto cdp-inspect transport failure records cooldown", async () => {
    // Make cdp-inspect fail with transport_error
    createCdpInspectClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeCdpInspectClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "Connection refused", {
            cdpMethod: "Page.navigate",
          });
        });
        lastCdpInspectClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "macos-cooldown-record",
      transportInterface: "macos",
    });

    const client = getCdpClient(ctx);

    // First send: cdp-inspect fails, falls over to local
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "local" });

    // Cooldown should now be active
    expect(_getDesktopAutoCooldownSince()).toBeGreaterThan(0);
    expect(isDesktopAutoCooldownActive(30_000)).toBe(true);

    // Subsequent buildCandidateList should skip cdp-inspect
    client.dispose();
    const ctx2 = makeContext({
      conversationId: "macos-after-cooldown",
      transportInterface: "macos",
    });
    const candidates = buildCandidateList(ctx2);
    expect(candidates.length).toBe(1);
    expect(candidates[0].kind).toBe("local");
  });

  test("macOS turn with registry-routed proxy unavailable still tries cdp-inspect (desktop-auto)", async () => {
    const fakeProxy = makeUnavailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "macos-proxy-unavail-route",
      transportInterface: "macos",
    });

    const client = getCdpClient(ctx);

    // Extension unavailable no longer suppresses cdp-inspect — desktop-auto
    // inserts it as a candidate and it succeeds.
    expect(client.kind).toBe("cdp-inspect");
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "cdp-inspect" });
    expect(createCdpInspectClientMock).toHaveBeenCalledTimes(1);
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
    client.dispose();
  });

  test("macOS turn with singleton proxy unavailable still tries cdp-inspect (desktop-auto)", async () => {
    const fakeProxy = makeUnavailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "macos-proxy-unavail-local",
      transportInterface: "macos",
    });

    const client = getCdpClient(ctx);

    // Extension unavailable no longer suppresses cdp-inspect — desktop-auto
    // inserts it as a candidate and it succeeds.
    expect(client.kind).toBe("cdp-inspect");
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "cdp-inspect" });
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).toHaveBeenCalledTimes(1);
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
    client.dispose();
  });

  test("explicit config cdp-inspect failure does NOT record desktop-auto cooldown", async () => {
    cdpInspectEnabled = true;

    // Make cdp-inspect fail with transport_error
    createCdpInspectClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeCdpInspectClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "Connection refused", {
            cdpMethod: "Page.navigate",
          });
        });
        lastCdpInspectClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "explicit-no-cooldown",
      transportInterface: "macos",
    });

    const client = getCdpClient(ctx);
    await client.send<{ ok: boolean; via: string }>("Page.navigate");
    client.dispose();

    // Cooldown should NOT be recorded for explicit config candidates
    expect(_getDesktopAutoCooldownSince()).toBe(0);
  });

  // ── Cooldown utility function tests ─────────────────────────────────

  test("isDesktopAutoCooldownActive returns false when no cooldown recorded", () => {
    expect(isDesktopAutoCooldownActive(30_000)).toBe(false);
  });

  test("isDesktopAutoCooldownActive returns false when cooldownMs is 0", () => {
    recordDesktopAutoCooldown();
    expect(isDesktopAutoCooldownActive(0)).toBe(false);
  });

  test("isDesktopAutoCooldownActive returns true within the window", () => {
    recordDesktopAutoCooldown();
    expect(isDesktopAutoCooldownActive(30_000)).toBe(true);
  });

  test("_resetDesktopAutoCooldown clears the cooldown", () => {
    recordDesktopAutoCooldown();
    expect(isDesktopAutoCooldownActive(30_000)).toBe(true);
    _resetDesktopAutoCooldown();
    expect(isDesktopAutoCooldownActive(30_000)).toBe(false);
    expect(_getDesktopAutoCooldownSince()).toBe(0);
  });
});

// ── Pinned-mode tests ────────────────────────────────────────────────────

describe("pinned-mode selection", () => {
  beforeEach(() => {
    createExtensionCdpClientMock.mockClear();
    createLocalCdpClientMock.mockClear();
    createCdpInspectClientMock.mockClear();
    lastExtensionClient = undefined;
    lastLocalClient = undefined;
    lastCdpInspectClient = undefined;
    cdpInspectEnabled = false;
    desktopAutoConfig = { enabled: true, cooldownMs: 30_000 };
    _resetDesktopAutoCooldown();
    logWarnCalls.length = 0;
    logDebugCalls.length = 0;
    mockSingletonProxy = null;
  });

  // ── Pinned extension ────────────────────────────────────────────────

  test("pinned extension mode routes to extension when proxy is available", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "pinned-ext",
    });

    const client = getCdpClient(ctx, { mode: "extension" });
    expect(client.kind).toBe("extension");

    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "extension" });
    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
  });

  test("pinned extension mode throws when no proxy is provisioned", () => {
    const ctx = makeContext({ conversationId: "pinned-ext-no-proxy" });

    expect(() => getCdpClient(ctx, { mode: "extension" })).toThrow(CdpError);

    try {
      getCdpClient(ctx, { mode: "extension" });
    } catch (err) {
      expect(err).toBeInstanceOf(CdpError);
      const cdpErr = err as CdpError;
      expect(cdpErr.code).toBe("transport_error");
      expect(cdpErr.message).toContain('Pinned mode "extension" unavailable');
      expect(cdpErr.message).toContain("no Chrome Extension connected");
      expect(cdpErr.attemptDiagnostics).toBeDefined();
      expect(cdpErr.attemptDiagnostics).toHaveLength(1);
      expect(cdpErr.attemptDiagnostics![0].candidateKind).toBe("extension");
      expect(cdpErr.attemptDiagnostics![0].stage).toBe("candidate_selection");
    }
  });

  test("pinned extension mode throws when proxy is present but unavailable", () => {
    const fakeProxy = makeUnavailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "pinned-ext-unavail",
    });

    expect(() => getCdpClient(ctx, { mode: "extension" })).toThrow(CdpError);

    try {
      getCdpClient(ctx, { mode: "extension" });
    } catch (err) {
      const cdpErr = err as CdpError;
      expect(cdpErr.code).toBe("transport_error");
      expect(cdpErr.message).toContain("no Chrome Extension connected");
      expect(cdpErr.attemptDiagnostics![0].stage).toBe("candidate_selection");
    }
  });

  test("pinned extension mode does NOT fall back to local on transport error", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;

    // Make extension fail with transport_error
    createExtensionCdpClientMock.mockImplementationOnce(
      (_proxy: HostBrowserProxy, conversationId: string) => {
        const c = makeFakeExtensionClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "WS disconnected");
        });
        lastExtensionClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "pinned-ext-no-fallback",
    });

    const client = getCdpClient(ctx, { mode: "extension" });

    await expect(client.send("Page.navigate")).rejects.toMatchObject({
      code: "transport_error",
      message: "WS disconnected",
    });

    // Local and cdp-inspect should NOT have been tried
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
  });

  // ── Pinned cdp-inspect ──────────────────────────────────────────────

  test("pinned cdp-inspect mode routes to cdp-inspect", async () => {
    const ctx = makeContext({ conversationId: "pinned-inspect" });

    const client = getCdpClient(ctx, { mode: "cdp-inspect" });
    expect(client.kind).toBe("cdp-inspect");

    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "cdp-inspect" });
    expect(createCdpInspectClientMock).toHaveBeenCalledTimes(1);
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
  });

  test("pinned cdp-inspect mode does NOT fall back to local on transport error", async () => {
    createCdpInspectClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeCdpInspectClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "Connection refused");
        });
        lastCdpInspectClient = c;
        return c;
      },
    );

    const ctx = makeContext({ conversationId: "pinned-inspect-no-fb" });
    const client = getCdpClient(ctx, { mode: "cdp-inspect" });

    await expect(client.send("Page.navigate")).rejects.toMatchObject({
      code: "transport_error",
      message: "Connection refused",
    });

    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
  });

  test("pinned cdp-inspect uses config host/port", async () => {
    const ctx = makeContext({ conversationId: "pinned-inspect-cfg" });

    const client = getCdpClient(ctx, { mode: "cdp-inspect" });
    await client.send("Page.navigate");

    expect(createCdpInspectClientMock).toHaveBeenCalledWith(
      "pinned-inspect-cfg",
      {
        host: "localhost",
        port: 9222,
        discoveryTimeoutMs: 500,
      },
    );
  });

  // ── Pinned local ────────────────────────────────────────────────────

  test("pinned local mode routes to local", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "pinned-local",
    });

    // Even with proxy available, pinned local should skip extension
    const client = getCdpClient(ctx, { mode: "local" });
    expect(client.kind).toBe("local");

    const result = await client.send<{ ok: boolean; via: string }>(
      "Runtime.evaluate",
    );
    expect(result).toEqual({ ok: true, via: "local" });
    expect(createLocalCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
  });

  test("pinned local mode does NOT fall back on transport error", async () => {
    createLocalCdpClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeLocalClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "Playwright crashed");
        });
        lastLocalClient = c;
        return c;
      },
    );

    const ctx = makeContext({ conversationId: "pinned-local-no-fb" });
    const client = getCdpClient(ctx, { mode: "local" });

    await expect(client.send("Page.navigate")).rejects.toMatchObject({
      code: "transport_error",
      message: "Playwright crashed",
    });

    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
  });
});

// ── buildPinnedCandidateList tests ───────────────────────────────────────

describe("buildPinnedCandidateList", () => {
  beforeEach(() => {
    createExtensionCdpClientMock.mockClear();
    createLocalCdpClientMock.mockClear();
    createCdpInspectClientMock.mockClear();
    lastExtensionClient = undefined;
    lastLocalClient = undefined;
    lastCdpInspectClient = undefined;
    cdpInspectEnabled = false;
    desktopAutoConfig = { enabled: true, cooldownMs: 30_000 };
    _resetDesktopAutoCooldown();
    mockSingletonProxy = null;
  });

  test("extension mode produces single extension candidate", () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "bpl-ext",
    });

    const candidates = buildPinnedCandidateList(ctx, "extension");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("extension");
    expect(candidates[0].reason).toBe("pinned mode: extension");
  });

  test("cdp-inspect mode produces single cdp-inspect candidate", () => {
    const ctx = makeContext({ conversationId: "bpl-inspect" });

    const candidates = buildPinnedCandidateList(ctx, "cdp-inspect");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("cdp-inspect");
    expect(candidates[0].reason).toBe("pinned mode: cdp-inspect");
  });

  test("local mode produces single local candidate", () => {
    const ctx = makeContext({ conversationId: "bpl-local" });

    const candidates = buildPinnedCandidateList(ctx, "local");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("local");
    expect(candidates[0].reason).toBe("pinned mode: local");
  });

  test("extension mode throws with diagnostics when proxy absent", () => {
    const ctx = makeContext({ conversationId: "bpl-ext-absent" });

    try {
      buildPinnedCandidateList(ctx, "extension");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(CdpError);
      const cdpErr = err as CdpError;
      expect(cdpErr.code).toBe("transport_error");
      expect(cdpErr.attemptDiagnostics).toHaveLength(1);
      expect(cdpErr.attemptDiagnostics![0]).toMatchObject({
        candidateKind: "extension",
        inclusionReason: "pinned mode: extension",
        stage: "candidate_selection",
        errorCode: "transport_error",
      });
    }
  });

  test("extension mode throws when only macOS SSE bridge is connected", () => {
    // This is the bug case: isAvailable() = true but hasExtensionClient() = false.
    // Before the fix, this would build an extension candidate that silently
    // dispatched to the macOS bridge and failed with a misleading localhost:9222 error.
    const fakeProxy = makeMacosBridgeOnlyProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({ conversationId: "bpl-ext-macos-bridge-only" });

    try {
      buildPinnedCandidateList(ctx, "extension");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(CdpError);
      const cdpErr = err as CdpError;
      expect(cdpErr.code).toBe("transport_error");
      expect(cdpErr.message).toContain("no Chrome Extension connected");
    }
  });
});

// ── Attempt diagnostics & fallback log tests ─────────────────────────────

describe("attempt diagnostics", () => {
  beforeEach(() => {
    createExtensionCdpClientMock.mockClear();
    createLocalCdpClientMock.mockClear();
    createCdpInspectClientMock.mockClear();
    lastExtensionClient = undefined;
    lastLocalClient = undefined;
    lastCdpInspectClient = undefined;
    cdpInspectEnabled = false;
    desktopAutoConfig = { enabled: true, cooldownMs: 30_000 };
    _resetDesktopAutoCooldown();
    logWarnCalls.length = 0;
    logDebugCalls.length = 0;
    mockSingletonProxy = null;
  });

  test("exhausted candidates error includes full attempt diagnostics", async () => {
    cdpInspectEnabled = true;
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;

    // Make extension fail
    createExtensionCdpClientMock.mockImplementationOnce(
      (_proxy: HostBrowserProxy, conversationId: string) => {
        const c = makeFakeExtensionClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "ext disconnected");
        });
        lastExtensionClient = c;
        return c;
      },
    );

    // Make cdp-inspect fail
    createCdpInspectClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeCdpInspectClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "inspect refused");
        });
        lastCdpInspectClient = c;
        return c;
      },
    );

    // Make local fail too
    createLocalCdpClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeLocalClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "playwright dead");
        });
        lastLocalClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "diag-all-fail",
    });

    const client = getCdpClient(ctx);

    try {
      await client.send("Page.navigate");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(CdpError);
      const cdpErr = err as CdpError;
      expect(cdpErr.code).toBe("transport_error");
      expect(cdpErr.attemptDiagnostics).toBeDefined();
      expect(cdpErr.attemptDiagnostics).toHaveLength(3);

      // First attempt: extension
      expect(cdpErr.attemptDiagnostics![0]).toMatchObject({
        candidateKind: "extension",
        stage: "send",
        errorCode: "transport_error",
        errorMessage: expect.stringContaining("ext disconnected"),
      });

      // Second attempt: cdp-inspect
      expect(cdpErr.attemptDiagnostics![1]).toMatchObject({
        candidateKind: "cdp-inspect",
        stage: "send",
        errorCode: "transport_error",
        errorMessage: expect.stringContaining("inspect refused"),
      });

      // Third attempt: local
      expect(cdpErr.attemptDiagnostics![2]).toMatchObject({
        candidateKind: "local",
        stage: "send",
        errorCode: "transport_error",
        errorMessage: expect.stringContaining("playwright dead"),
      });
    }
  });

  test("successful fallback still records diagnostics for failed candidates", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;

    // Make extension fail
    createExtensionCdpClientMock.mockImplementationOnce(
      (_proxy: HostBrowserProxy, conversationId: string) => {
        const c = makeFakeExtensionClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "ext down");
        });
        lastExtensionClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "diag-partial",
    });

    const client = getCdpClient(ctx);
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "local" });

    // The fallback log should have been emitted with attempt data
    const fallbackLogs = logWarnCalls.filter(
      (c) =>
        typeof c.args[1] === "string" &&
        c.args[1].includes("auto-mode fallback"),
    );
    expect(fallbackLogs.length).toBeGreaterThan(0);
  });

  test("auto-mode fallback log includes candidate sequence and failure reasons", async () => {
    cdpInspectEnabled = true;
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;

    // Make extension fail
    createExtensionCdpClientMock.mockImplementationOnce(
      (_proxy: HostBrowserProxy, conversationId: string) => {
        const c = makeFakeExtensionClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "WS closed");
        });
        lastExtensionClient = c;
        return c;
      },
    );

    // Make cdp-inspect fail
    createCdpInspectClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeCdpInspectClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "no debugger");
        });
        lastCdpInspectClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "diag-log-shape",
    });

    const client = getCdpClient(ctx);
    await client.send<{ ok: boolean; via: string }>("Page.navigate");

    // Check that a warn-level log was emitted for the completed fallback
    const completedLogs = logWarnCalls.filter(
      (c) =>
        typeof c.args[1] === "string" &&
        c.args[1].includes("fallback completed"),
    );
    expect(completedLogs.length).toBe(1);

    // Verify the log payload contains the expected structure
    const payload = completedLogs[0].args[0] as Record<string, unknown>;
    expect(payload.conversationId).toBe("diag-log-shape");
    expect(payload.stickyCandidate).toBe("local");
    expect(Array.isArray(payload.attemptSequence)).toBe(true);
    const seq = payload.attemptSequence as Array<Record<string, unknown>>;
    expect(seq.length).toBe(3); // extension, cdp-inspect, local
    expect(seq[0].kind).toBe("extension");
    expect(seq[0].errorCode).toBe("transport_error");
    expect(seq[1].kind).toBe("cdp-inspect");
    expect(seq[1].errorCode).toBe("transport_error");
    expect(seq[2].kind).toBe("local");
    expect(seq[2].stage).toBe("success");
  });

  test("pinned mode transport error includes attempt diagnostics on the thrown error", async () => {
    createCdpInspectClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeCdpInspectClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "Connection refused");
        });
        lastCdpInspectClient = c;
        return c;
      },
    );

    const ctx = makeContext({ conversationId: "pinned-diag" });
    const client = getCdpClient(ctx, { mode: "cdp-inspect" });

    try {
      await client.send("Page.navigate");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(CdpError);
      const cdpErr = err as CdpError;
      expect(cdpErr.attemptDiagnostics).toBeDefined();
      expect(cdpErr.attemptDiagnostics).toHaveLength(1);
      expect(cdpErr.attemptDiagnostics![0]).toMatchObject({
        candidateKind: "cdp-inspect",
        inclusionReason: "pinned mode: cdp-inspect",
        stage: "send",
        errorCode: "transport_error",
      });
    }
  });

  test("construction failure is recorded in attempt diagnostics", async () => {
    // Make the cdp-inspect client's create() throw
    createCdpInspectClientMock.mockImplementationOnce(() => {
      throw new Error("Config missing");
    });

    cdpInspectEnabled = true;
    const ctx = makeContext({ conversationId: "diag-construction" });
    const client = getCdpClient(ctx);

    // cdp-inspect construction fails, falls back to local
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "local" });
  });

  test("cdp_error on single-candidate list includes diagnostics", async () => {
    createLocalCdpClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeLocalClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("cdp_error", "Protocol error -32000");
        });
        lastLocalClient = c;
        return c;
      },
    );

    const ctx = makeContext({ conversationId: "diag-cdp-err" });
    const client = getCdpClient(ctx);

    try {
      await client.send("Page.navigate");
      expect(true).toBe(false);
    } catch (err) {
      const cdpErr = err as CdpError;
      expect(cdpErr.code).toBe("cdp_error");
      expect(cdpErr.attemptDiagnostics).toBeDefined();
      expect(cdpErr.attemptDiagnostics).toHaveLength(1);
      expect(cdpErr.attemptDiagnostics![0]).toMatchObject({
        candidateKind: "local",
        stage: "send",
        errorCode: "cdp_error",
      });
    }
  });
});

// ── No-fallback guarantees for pinned modes ──────────────────────────────

describe("no-fallback guarantees", () => {
  beforeEach(() => {
    createExtensionCdpClientMock.mockClear();
    createLocalCdpClientMock.mockClear();
    createCdpInspectClientMock.mockClear();
    lastExtensionClient = undefined;
    lastLocalClient = undefined;
    lastCdpInspectClient = undefined;
    cdpInspectEnabled = false;
    desktopAutoConfig = { enabled: true, cooldownMs: 30_000 };
    _resetDesktopAutoCooldown();
    logWarnCalls.length = 0;
    mockSingletonProxy = null;
  });

  test("pinned extension: only one candidate is ever constructed", async () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;

    // Make extension fail
    createExtensionCdpClientMock.mockImplementationOnce(
      (_proxy: HostBrowserProxy, conversationId: string) => {
        const c = makeFakeExtensionClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "failed");
        });
        lastExtensionClient = c;
        return c;
      },
    );

    const ctx = makeContext({
      conversationId: "nofb-ext",
    });
    const client = getCdpClient(ctx, { mode: "extension" });

    await expect(client.send("Page.navigate")).rejects.toThrow();

    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
  });

  test("pinned cdp-inspect: only one candidate is ever constructed", async () => {
    createCdpInspectClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeCdpInspectClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "failed");
        });
        lastCdpInspectClient = c;
        return c;
      },
    );

    const ctx = makeContext({ conversationId: "nofb-inspect" });
    const client = getCdpClient(ctx, { mode: "cdp-inspect" });

    await expect(client.send("Page.navigate")).rejects.toThrow();

    expect(createCdpInspectClientMock).toHaveBeenCalledTimes(1);
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
  });

  test("pinned local: only one candidate is ever constructed", async () => {
    createLocalCdpClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeLocalClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "failed");
        });
        lastLocalClient = c;
        return c;
      },
    );

    const ctx = makeContext({ conversationId: "nofb-local" });
    const client = getCdpClient(ctx, { mode: "local" });

    await expect(client.send("Page.navigate")).rejects.toThrow();

    expect(createLocalCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
  });

  test("pinned modes do not emit auto-mode fallback logs", async () => {
    createLocalCdpClientMock.mockImplementationOnce(
      (conversationId: string) => {
        const c = makeFakeLocalClient(conversationId);
        c.send = mock(async () => {
          throw new CdpError("transport_error", "failed");
        });
        lastLocalClient = c;
        return c;
      },
    );

    const ctx = makeContext({ conversationId: "nofb-no-log" });
    const client = getCdpClient(ctx, { mode: "local" });

    await expect(client.send("Page.navigate")).rejects.toThrow();

    // No warn-level fallback logs should have been emitted
    const fallbackLogs = logWarnCalls.filter(
      (c) =>
        typeof c.args[1] === "string" &&
        c.args[1].includes("auto-mode fallback"),
    );
    expect(fallbackLogs.length).toBe(0);
  });
});

// ── macOS host-browser proxy backend selection ─────────────────────────
//
// Verify that macOS turns can use the host browser proxy without requiring
// extension registry connectivity. When a HostBrowserProxy is provisioned
// via the SSE sender path (no extension), the factory should select
// extension as the top candidate (because the singleton proxy is available).
// When both proxy and fallback backends exist, selection is deterministic:
// extension > cdp-inspect > local.

describe("macOS host-browser proxy without extension registry", () => {
  beforeEach(() => {
    createExtensionCdpClientMock.mockClear();
    createLocalCdpClientMock.mockClear();
    createCdpInspectClientMock.mockClear();
    lastExtensionClient = undefined;
    lastLocalClient = undefined;
    lastCdpInspectClient = undefined;
    cdpInspectEnabled = false;
    desktopAutoConfig = { enabled: true, cooldownMs: 30_000 };
    _resetDesktopAutoCooldown();
    logWarnCalls.length = 0;
    logDebugCalls.length = 0;
    mockSingletonProxy = null;
  });

  test("macOS turn with SSE-provisioned hostBrowserProxy selects extension backend", async () => {
    // Simulates macOS provisioning a HostBrowserProxy via SSE (no extension
    // registry connection). The proxy is available so extension is selected.
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "macos-sse-proxy",
      transportInterface: "macos",
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("extension");
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
      { url: "https://example.com" },
    );
    expect(result).toEqual({ ok: true, via: "extension" });
    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
  });

  test("macOS turn with both proxy and cdp-inspect produces deterministic 3-candidate chain", () => {
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "macos-deterministic",
      transportInterface: "macos",
    });

    const candidates = buildCandidateList(ctx);

    // Deterministic order: extension > cdp-inspect (desktop-auto) > local
    expect(candidates.length).toBe(3);
    expect(candidates[0].kind).toBe("extension");
    expect(candidates[1].kind).toBe("cdp-inspect");
    expect(candidates[2].kind).toBe("local");
  });

  test("macOS turn without proxy falls through to cdp-inspect then local", () => {
    const ctx = makeContext({
      conversationId: "macos-no-proxy-fallback",
      transportInterface: "macos",
    });

    const candidates = buildCandidateList(ctx);

    // No proxy => skip extension, desktop-auto cdp-inspect + local
    expect(candidates.length).toBe(2);
    expect(candidates[0].kind).toBe("cdp-inspect");
    expect(candidates[1].kind).toBe("local");
  });

  test("non-macOS interface with proxy still selects extension (unchanged behavior)", async () => {
    // Verify non-macOS interfaces are unaffected by the macOS host-browser
    // enablement — proxy presence drives extension selection regardless of
    // interface.
    const fakeProxy = makeAvailableProxy();
    mockSingletonProxy = fakeProxy;
    const ctx = makeContext({
      conversationId: "non-macos-proxy",
      transportInterface: "cli",
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("extension");
    const result = await client.send<{ ok: boolean; via: string }>(
      "Page.navigate",
    );
    expect(result).toEqual({ ok: true, via: "extension" });
  });
});
