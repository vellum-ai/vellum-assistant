import { describe, expect, mock, test } from "bun:test";

import type { HostBrowserProxy } from "../../../../daemon/host-browser-proxy.js";
import { CdpError } from "../errors.js";
import {
  createExtensionCdpClient,
  ExtensionCdpClient,
} from "../extension-cdp-client.js";

type ProxyResult = { content: string; isError: boolean };

/**
 * Build a fake HostBrowserProxy whose `request` method delegates to the
 * provided handler. The returned object is structurally compatible with
 * the parts of HostBrowserProxy that ExtensionCdpClient touches.
 */
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

describe("ExtensionCdpClient", () => {
  test("kind is 'extension' and exposes conversationId", () => {
    const { proxy } = fakeProxy(async () => ({
      content: "{}",
      isError: false,
    }));
    const client = createExtensionCdpClient(proxy, "conv-abc");
    expect(client).toBeInstanceOf(ExtensionCdpClient);
    expect(client.kind).toBe("extension");
    expect(client.conversationId).toBe("conv-abc");
  });

  test("happy path: send returns parsed JSON and forwards method/params/conversationId", async () => {
    const { proxy, request } = fakeProxy(async () => ({
      content: JSON.stringify({
        product: "Chrome/123.0",
        userAgent: "Mozilla/5.0",
      }),
      isError: false,
    }));

    const client = createExtensionCdpClient(proxy, "conv-1");
    const result = await client.send<{ product: string; userAgent: string }>(
      "Browser.getVersion",
    );

    expect(result).toEqual({
      product: "Chrome/123.0",
      userAgent: "Mozilla/5.0",
    });
    expect(request).toHaveBeenCalledTimes(1);
    const call = request.mock.calls[0];
    expect(call?.[0]).toEqual({
      cdpMethod: "Browser.getVersion",
      cdpParams: undefined,
      cdpSessionId: undefined,
    });
    expect(call?.[1]).toBe("conv-1");
    expect(call?.[2]).toBeUndefined();
  });

  test("params are forwarded verbatim to proxy.request", async () => {
    const { proxy, request } = fakeProxy(async () => ({
      content: JSON.stringify({ frameId: "frame-1", loaderId: "loader-1" }),
      isError: false,
    }));

    const client = createExtensionCdpClient(proxy, "conv-2");
    await client.send("Page.navigate", { url: "https://example.com/" });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toEqual({
      cdpMethod: "Page.navigate",
      cdpParams: { url: "https://example.com/" },
      cdpSessionId: undefined,
    });
  });

  test("cdpSessionId from constructor is forwarded on every send", async () => {
    const { proxy, request } = fakeProxy(async () => ({
      content: "{}",
      isError: false,
    }));

    const client = createExtensionCdpClient(proxy, "conv-3", "session-xyz");
    await client.send("Runtime.evaluate", { expression: "1" });
    await client.send("DOM.getDocument");

    expect(request).toHaveBeenCalledTimes(2);
    for (const call of request.mock.calls) {
      expect((call?.[0] as { cdpSessionId?: string }).cdpSessionId).toBe(
        "session-xyz",
      );
    }
  });

  test("result.isError === true throws CdpError('cdp_error') with .underlying === parsed", async () => {
    const errorBody = {
      code: -32000,
      message: "Cannot find context with specified id",
    };
    const { proxy } = fakeProxy(async () => ({
      content: JSON.stringify(errorBody),
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-4");

    let caught: unknown;
    try {
      await client.send("Runtime.evaluate", { expression: "boom" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("cdp_error");
    expect(err.message).toBe("Cannot find context with specified id");
    expect(err.cdpMethod).toBe("Runtime.evaluate");
    expect(err.cdpParams).toEqual({ expression: "boom" });
    expect(err.underlying).toEqual(errorBody);
  });

  test("result.isError with non-string message falls back to default message", async () => {
    const { proxy } = fakeProxy(async () => ({
      content: JSON.stringify({ code: -32000 }),
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-5");

    let caught: unknown;
    try {
      await client.send("Target.attachToTarget");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("cdp_error");
    expect(err.message).toBe("CDP error for Target.attachToTarget");
    expect(err.underlying).toEqual({ code: -32000 });
  });

  test("non-JSON content throws CdpError('transport_error')", async () => {
    const { proxy } = fakeProxy(async () => ({
      content: "not json at all",
      isError: false,
    }));

    const client = createExtensionCdpClient(proxy, "conv-6");

    let caught: unknown;
    try {
      await client.send("Browser.getVersion");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("transport_error");
    expect(err.cdpMethod).toBe("Browser.getVersion");
    expect(err.underlying).toBeDefined();
    // Underlying should be the JSON.parse error.
    expect(err.underlying).toBeInstanceOf(Error);
  });

  test("result.isError with non-JSON content throws CdpError('cdp_error')", async () => {
    const { proxy } = fakeProxy(async () => ({
      content:
        "Host browser proxy timed out waiting for extension response (check callback failures).",
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-6b");

    let caught: unknown;
    try {
      await client.send("Runtime.evaluate", { expression: "document.title" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("cdp_error");
    expect(err.message).toContain(
      "Host browser proxy timed out waiting for extension response",
    );
    expect(err.cdpMethod).toBe("Runtime.evaluate");
    expect(err.cdpParams).toEqual({ expression: "document.title" });
    expect(err.underlying).toBe(
      "Host browser proxy timed out waiting for extension response (check callback failures).",
    );
  });

  test("result.content === 'Aborted' throws CdpError('aborted')", async () => {
    const { proxy, request } = fakeProxy(async () => ({
      content: "Aborted",
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-7");

    let caught: unknown;
    try {
      await client.send("Page.navigate", { url: "https://slow.example.com/" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("aborted");
    expect(err.cdpMethod).toBe("Page.navigate");
    expect(err.cdpParams).toEqual({ url: "https://slow.example.com/" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("proxy.request throwing wraps as CdpError('transport_error') with .underlying", async () => {
    const underlying = new Error("socket closed");
    const { proxy } = fakeProxy(async () => {
      throw underlying;
    });

    const client = createExtensionCdpClient(proxy, "conv-8");

    let caught: unknown;
    try {
      await client.send("Runtime.evaluate", { expression: "1" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("transport_error");
    expect(err.message).toBe("socket closed");
    expect(err.cdpMethod).toBe("Runtime.evaluate");
    expect(err.cdpParams).toEqual({ expression: "1" });
    expect(err.underlying).toBe(underlying);
  });

  test("proxy.request throwing non-Error wraps as CdpError('transport_error') with stringified message", async () => {
    const { proxy } = fakeProxy(async () => {
      throw "string error";
    });

    const client = createExtensionCdpClient(proxy, "conv-9");

    let caught: unknown;
    try {
      await client.send("Browser.getVersion");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("transport_error");
    expect(err.message).toBe("string error");
    expect(err.underlying).toBe("string error");
  });

  test("send after dispose throws CdpError('disposed') without calling proxy", async () => {
    const { proxy, request } = fakeProxy(async () => ({
      content: "{}",
      isError: false,
    }));

    const client = createExtensionCdpClient(proxy, "conv-10");
    client.dispose();
    // dispose is idempotent
    client.dispose();

    let caught: unknown;
    try {
      await client.send("Browser.getVersion");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("disposed");
    expect(err.cdpMethod).toBe("Browser.getVersion");
    expect(request).not.toHaveBeenCalled();
  });

  test("send with already-aborted signal throws CdpError('aborted') without calling proxy", async () => {
    const { proxy, request } = fakeProxy(async () => ({
      content: "{}",
      isError: false,
    }));

    const client = createExtensionCdpClient(proxy, "conv-11");
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await client.send("Browser.getVersion", undefined, controller.signal);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("aborted");
    expect(err.message).toBe("Aborted before send");
    expect(err.cdpMethod).toBe("Browser.getVersion");
    expect(request).not.toHaveBeenCalled();
  });

  test("signal that aborts after proxy resolve throws CdpError('aborted')", async () => {
    const controller = new AbortController();
    const { proxy } = fakeProxy(async () => {
      // Abort the signal before we return, simulating race between
      // proxy resolution and the caller's abort.
      controller.abort();
      return { content: JSON.stringify({ ok: true }), isError: false };
    });

    const client = createExtensionCdpClient(proxy, "conv-12");

    let caught: unknown;
    try {
      await client.send("Browser.getVersion", undefined, controller.signal);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("aborted");
    expect(err.message).toBe("CDP call aborted");
    expect(err.cdpMethod).toBe("Browser.getVersion");
  });

  // ── Structured transport error classification ────────────────────────

  test("structured error with code 'transport_error' is classified as transport_error", async () => {
    const errorBody = {
      code: "transport_error",
      message: "Extension WebSocket disconnected",
    };
    const { proxy } = fakeProxy(async () => ({
      content: JSON.stringify(errorBody),
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-transport-1");

    let caught: unknown;
    try {
      await client.send("Page.navigate", { url: "https://example.com" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("transport_error");
    expect(err.message).toBe("Extension WebSocket disconnected");
    expect(err.cdpMethod).toBe("Page.navigate");
    expect(err.cdpParams).toEqual({ url: "https://example.com" });
    expect(err.underlying).toEqual(errorBody);
  });

  test("structured error with code 'unreachable' is classified as transport_error", async () => {
    const errorBody = {
      code: "unreachable",
      message: "Host browser not reachable",
    };
    const { proxy } = fakeProxy(async () => ({
      content: JSON.stringify(errorBody),
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-transport-2");

    let caught: unknown;
    try {
      await client.send("Runtime.evaluate", { expression: "1+1" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("transport_error");
    expect(err.message).toBe("Host browser not reachable");
    expect(err.underlying).toEqual(errorBody);
  });

  test("structured error with code 'timeout' is classified as transport_error", async () => {
    const errorBody = {
      code: "timeout",
      message: "CDP call timed out",
    };
    const { proxy } = fakeProxy(async () => ({
      content: JSON.stringify(errorBody),
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-transport-3");

    let caught: unknown;
    try {
      await client.send("Page.captureScreenshot");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("transport_error");
    expect(err.message).toBe("CDP call timed out");
    expect(err.underlying).toEqual(errorBody);
  });

  test("structured error with code 'non_loopback' is classified as transport_error", async () => {
    const errorBody = {
      code: "non_loopback",
      message: "Only loopback addresses are allowed",
    };
    const { proxy } = fakeProxy(async () => ({
      content: JSON.stringify(errorBody),
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-transport-4");

    let caught: unknown;
    try {
      await client.send("Browser.getVersion");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("transport_error");
    expect(err.message).toBe("Only loopback addresses are allowed");
    expect(err.underlying).toEqual(errorBody);
  });

  // ── Command-level CDP errors remain cdp_error ────────────────────────

  test("structured error with numeric code (CDP JSON-RPC) remains cdp_error", async () => {
    const errorBody = {
      code: -32000,
      message: "Cannot find context with specified id",
    };
    const { proxy } = fakeProxy(async () => ({
      content: JSON.stringify(errorBody),
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-cdp-1");

    let caught: unknown;
    try {
      await client.send("Runtime.evaluate", { expression: "boom" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("cdp_error");
    expect(err.message).toBe("Cannot find context with specified id");
  });

  test("structured error with unknown string code remains cdp_error", async () => {
    const errorBody = {
      code: "some_unknown_code",
      message: "Unrecognized error",
    };
    const { proxy } = fakeProxy(async () => ({
      content: JSON.stringify(errorBody),
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-cdp-2");

    let caught: unknown;
    try {
      await client.send("Page.navigate", { url: "https://example.com" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("cdp_error");
    expect(err.message).toBe("Unrecognized error");
  });

  test("structured error without code field remains cdp_error", async () => {
    const errorBody = {
      message: "Something went wrong",
    };
    const { proxy } = fakeProxy(async () => ({
      content: JSON.stringify(errorBody),
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-cdp-3");

    let caught: unknown;
    try {
      await client.send("DOM.getDocument");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("cdp_error");
    expect(err.message).toBe("Something went wrong");
  });

  test("structured error with code: null remains cdp_error", async () => {
    const errorBody = {
      code: null,
      message: "Null code error",
    };
    const { proxy } = fakeProxy(async () => ({
      content: JSON.stringify(errorBody),
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-cdp-4");

    let caught: unknown;
    try {
      await client.send("Browser.getVersion");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("cdp_error");
  });

  test("plain-text isError content still throws cdp_error (no failover)", async () => {
    const { proxy } = fakeProxy(async () => ({
      content: "Connection lost unexpectedly",
      isError: true,
    }));

    const client = createExtensionCdpClient(proxy, "conv-cdp-5");

    let caught: unknown;
    try {
      await client.send("Page.navigate", { url: "https://example.com" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const err = caught as CdpError;
    expect(err.code).toBe("cdp_error");
    expect(err.message).toBe("Connection lost unexpectedly");
    expect(err.underlying).toBe("Connection lost unexpectedly");
  });
});
