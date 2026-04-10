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
 * Mutable config state. Tests flip `cdpInspectEnabled` to control
 * the factory's config-based selection without needing a real config
 * file.
 */
let cdpInspectEnabled = false;

mock.module("../extension-cdp-client.js", () => ({
  createExtensionCdpClient: createExtensionCdpClientMock,
}));
mock.module("../local-cdp-client.js", () => ({
  createLocalCdpClient: createLocalCdpClientMock,
}));
mock.module("../cdp-inspect-client.js", () => ({
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
      },
    },
  }),
}));

// Import under test AFTER mock.module calls so that the factory's
// top-level imports resolve to our fakes.
const { getCdpClient } = await import("../factory.js");

/**
 * Minimal ToolContext suitable for factory tests. Only the fields the
 * factory reads (`conversationId` and `hostBrowserProxy`) need to be
 * populated; other required fields are cast away.
 */
function makeContext(
  overrides: Partial<ToolContext> & { conversationId: string },
): ToolContext {
  return overrides as unknown as ToolContext;
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
  });

  test("routes to ExtensionCdpClient when hostBrowserProxy is set", () => {
    const fakeProxy = {
      request: mock(async () => ({})),
    } as unknown as HostBrowserProxy;
    const ctx = makeContext({
      conversationId: "test-convo",
      hostBrowserProxy: fakeProxy,
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("extension");
    expect(client.conversationId).toBe("test-convo");
    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createExtensionCdpClientMock).toHaveBeenCalledWith(
      fakeProxy,
      "test-convo",
    );
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
  });

  test("extension wins even when cdpInspect is enabled", () => {
    cdpInspectEnabled = true;
    const fakeProxy = {
      request: mock(async () => ({})),
    } as unknown as HostBrowserProxy;
    const ctx = makeContext({
      conversationId: "ext-wins",
      hostBrowserProxy: fakeProxy,
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("extension");
    expect(createExtensionCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
  });

  test("routes to CdpInspectClient when cdpInspect is enabled and extension is absent", () => {
    cdpInspectEnabled = true;
    const ctx = makeContext({
      conversationId: "inspect-convo",
      hostBrowserProxy: undefined,
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("cdp-inspect");
    expect(client.conversationId).toBe("inspect-convo");
    expect(createCdpInspectClientMock).toHaveBeenCalledTimes(1);
    expect(createCdpInspectClientMock).toHaveBeenCalledWith("inspect-convo", {
      host: "localhost",
      port: 9222,
      discoveryTimeoutMs: 500,
    });
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createLocalCdpClientMock).not.toHaveBeenCalled();
  });

  test("routes to LocalCdpClient when cdpInspect is disabled and extension is absent", () => {
    cdpInspectEnabled = false;
    const ctx = makeContext({
      conversationId: "local-convo",
      hostBrowserProxy: undefined,
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("local");
    expect(client.conversationId).toBe("local-convo");
    expect(createLocalCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createLocalCdpClientMock).toHaveBeenCalledWith("local-convo");
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
  });

  test("routes to LocalCdpClient when hostBrowserProxy key is omitted", () => {
    const ctx = makeContext({ conversationId: "another-convo" });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("local");
    expect(client.conversationId).toBe("another-convo");
    expect(createLocalCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createLocalCdpClientMock).toHaveBeenCalledWith("another-convo");
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
    expect(createCdpInspectClientMock).not.toHaveBeenCalled();
  });

  test("forwards send() through the manager to the extension-backed client", async () => {
    const fakeProxy = {
      request: mock(async () => ({})),
    } as unknown as HostBrowserProxy;
    const ctx = makeContext({
      conversationId: "send-ext",
      hostBrowserProxy: fakeProxy,
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

  test("propagates CdpError thrown by the underlying client", async () => {
    const ctx = makeContext({ conversationId: "err-local" });
    const client = getCdpClient(ctx);
    const thrown = new CdpError("cdp_error", "kaboom", {
      cdpMethod: "Page.navigate",
    });
    lastLocalClient!.send = mock(async () => {
      throw thrown;
    });

    await expect(
      client.send("Page.navigate", { url: "https://example.com" }),
    ).rejects.toBe(thrown);
  });

  test("propagates caller AbortSignal to the underlying client", async () => {
    const ctx = makeContext({ conversationId: "abort-local" });
    const client = getCdpClient(ctx);
    const controller = new AbortController();
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

  test("dispose() tears down the underlying client and rejects further sends", async () => {
    const ctx = makeContext({ conversationId: "dispose-local" });
    const client = getCdpClient(ctx);

    client.dispose();
    expect(lastLocalClient?.dispose).toHaveBeenCalledTimes(1);

    // A second dispose is a no-op.
    client.dispose();
    expect(lastLocalClient?.dispose).toHaveBeenCalledTimes(1);

    await expect(client.send("Runtime.evaluate")).rejects.toMatchObject({
      code: "disposed",
    });
  });

  test("dispose() on an extension-backed client tears down the extension client", () => {
    const fakeProxy = {
      request: mock(async () => ({})),
    } as unknown as HostBrowserProxy;
    const ctx = makeContext({
      conversationId: "dispose-ext",
      hostBrowserProxy: fakeProxy,
    });

    const client = getCdpClient(ctx);
    client.dispose();

    expect(lastExtensionClient?.dispose).toHaveBeenCalledTimes(1);
  });

  test("dispose() on a cdp-inspect-backed client tears down the inspect client", () => {
    cdpInspectEnabled = true;
    const ctx = makeContext({ conversationId: "dispose-inspect" });

    const client = getCdpClient(ctx);
    client.dispose();

    expect(lastCdpInspectClient?.dispose).toHaveBeenCalledTimes(1);
  });

  test("send() after dispose() on a cdp-inspect-backed client rejects with disposed", async () => {
    cdpInspectEnabled = true;
    const ctx = makeContext({ conversationId: "post-dispose-inspect" });

    const client = getCdpClient(ctx);
    client.dispose();

    // Double dispose is a no-op.
    client.dispose();
    expect(lastCdpInspectClient?.dispose).toHaveBeenCalledTimes(1);

    await expect(client.send("Page.navigate")).rejects.toMatchObject({
      code: "disposed",
    });
  });
});
