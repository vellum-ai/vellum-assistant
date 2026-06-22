import { describe, expect, mock, test } from "bun:test";

import type { HostBrowserProxy } from "../../../../daemon/host-browser-proxy.js";
import { CdpError } from "../errors.js";
import {
  createHostBridgeCdpClient,
  HostBridgeCdpClient,
} from "../host-bridge-cdp-client.js";

type ProxyResult = { content: string; isError: boolean };

function fakeProxy(
  handler: (
    input: unknown,
    conversationId: string,
    signal?: AbortSignal,
  ) => Promise<ProxyResult> | ProxyResult,
): {
  proxy: HostBrowserProxy;
  request: ReturnType<typeof mock>;
} {
  const request = mock(
    async (
      input: unknown,
      conversationId: string,
      signal?: AbortSignal,
    ): Promise<ProxyResult> => handler(input, conversationId, signal),
  );
  const proxy = { request } as unknown as HostBrowserProxy;
  return { proxy, request };
}

describe("HostBridgeCdpClient", () => {
  test("kind is 'host-bridge' and exposes conversationId", () => {
    const { proxy } = fakeProxy(async () => ({
      content: "{}",
      isError: false,
    }));
    const client = createHostBridgeCdpClient(proxy, "conv-bridge");
    expect(client).toBeInstanceOf(HostBridgeCdpClient);
    expect(client.kind).toBe("host-bridge");
    expect(client.conversationId).toBe("conv-bridge");
  });

  test("send forwards raw CDP with no cdpSessionId or targetClientId", async () => {
    const { proxy, request } = fakeProxy(async () => ({
      content: JSON.stringify({ frameId: "frame-1" }),
      isError: false,
    }));

    const client = createHostBridgeCdpClient(proxy, "conv-1", "actor-1");
    const result = await client.send<{ frameId: string }>("Page.navigate", {
      url: "https://example.com/",
    });

    expect(result).toEqual({ frameId: "frame-1" });
    expect(request).toHaveBeenCalledTimes(1);
    const call = request.mock.calls[0];
    expect(call?.[0]).toEqual({
      cdpMethod: "Page.navigate",
      cdpParams: { url: "https://example.com/" },
      cdpSessionId: undefined,
    });
    expect(call?.[1]).toBe("conv-1");
    // sourceActorPrincipalId threads through; targetClientId is never set.
    expect(call?.[3]).toBe("actor-1");
    expect(call?.[4]).toBeUndefined();
  });

  test("bridge 'unreachable' envelope classifies as transport_error (failover-eligible)", async () => {
    const { proxy } = fakeProxy(async () => ({
      content: JSON.stringify({
        code: "unreachable",
        message: "HTTP 404 from http://localhost:9222/json/list",
      }),
      isError: true,
    }));

    const client = createHostBridgeCdpClient(proxy, "conv-err");
    try {
      await client.send("Page.captureScreenshot", {});
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(CdpError);
      expect((err as CdpError).code).toBe("transport_error");
      expect((err as CdpError).message).toContain("HTTP 404");
    }
  });

  test.each(["listTabs", "selectTab", "closeTab"] as const)(
    "%s throws transport_error locally without touching the proxy",
    async (method) => {
      const { proxy, request } = fakeProxy(async () => ({
        content: "{}",
        isError: false,
      }));
      const client = createHostBridgeCdpClient(proxy, "conv-tabs");

      const call =
        method === "listTabs" ? client.listTabs() : client[method](1);
      await expect(call).rejects.toThrow(
        `${method} is not supported by the host-bridge backend (extension backend required)`,
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
});
