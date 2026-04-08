import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { HostBrowserProxy } from "../../../../daemon/host-browser-proxy.js";
import type { ToolContext } from "../../../types.js";

const createExtensionCdpClientMock = mock(
  (_proxy: HostBrowserProxy, conversationId: string) => ({
    kind: "extension" as const,
    conversationId,
    send: async () => ({}),
    dispose: () => {},
  }),
);

const createLocalCdpClientMock = mock((conversationId: string) => ({
  kind: "local" as const,
  conversationId,
  send: async () => ({}),
  dispose: () => {},
}));

mock.module("../extension-cdp-client.js", () => ({
  createExtensionCdpClient: createExtensionCdpClientMock,
}));
mock.module("../local-cdp-client.js", () => ({
  createLocalCdpClient: createLocalCdpClientMock,
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
  });

  test("routes to LocalCdpClient when hostBrowserProxy is undefined", () => {
    const ctx = makeContext({
      conversationId: "test-convo",
      hostBrowserProxy: undefined,
    });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("local");
    expect(client.conversationId).toBe("test-convo");
    expect(createLocalCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createLocalCdpClientMock).toHaveBeenCalledWith("test-convo");
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
  });

  test("routes to LocalCdpClient when hostBrowserProxy key is omitted", () => {
    const ctx = makeContext({ conversationId: "another-convo" });

    const client = getCdpClient(ctx);

    expect(client.kind).toBe("local");
    expect(client.conversationId).toBe("another-convo");
    expect(createLocalCdpClientMock).toHaveBeenCalledTimes(1);
    expect(createLocalCdpClientMock).toHaveBeenCalledWith("another-convo");
    expect(createExtensionCdpClientMock).not.toHaveBeenCalled();
  });
});
