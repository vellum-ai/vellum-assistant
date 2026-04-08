import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger from local-cdp-client.
mock.module("../../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

let fakeSessionSendCalls: Array<{ method: string; params?: unknown }> = [];
let fakeSessionDetachCalls = 0;
let newCdpSessionCalls = 0;
let getOrCreateSessionPageCalls = 0;
let fakeSessionHandler: (method: string, params?: unknown) => unknown = () =>
  undefined;

function resetFakes() {
  fakeSessionSendCalls = [];
  fakeSessionDetachCalls = 0;
  newCdpSessionCalls = 0;
  getOrCreateSessionPageCalls = 0;
  fakeSessionHandler = () => undefined;
}

mock.module("../../browser-manager.js", () => {
  const fakeSession = {
    send: async (method: string, params?: unknown) => {
      fakeSessionSendCalls.push({ method, params });
      return fakeSessionHandler(method, params);
    },
    detach: async () => {
      fakeSessionDetachCalls += 1;
    },
  };
  const fakePage = {
    context: () => ({
      newCDPSession: async () => {
        newCdpSessionCalls += 1;
        return fakeSession;
      },
    }),
  };
  return {
    browserManager: {
      getOrCreateSessionPage: async (_conversationId: string) => {
        getOrCreateSessionPageCalls += 1;
        return fakePage;
      },
    },
  };
});

// Import under test AFTER mock.module calls so that the module's
// top-level imports resolve to our fakes.
const { createLocalCdpClient, LocalCdpClient } =
  await import("../local-cdp-client.js");
const { CdpError } = await import("../errors.js");

describe("LocalCdpClient", () => {
  beforeEach(() => {
    resetFakes();
  });

  test("kind is 'local' and exposes conversationId", () => {
    const client = createLocalCdpClient("conv-kind");
    expect(client).toBeInstanceOf(LocalCdpClient);
    expect(client.kind).toBe("local");
    expect(client.conversationId).toBe("conv-kind");
  });

  test("send() returns the underlying session's response", async () => {
    fakeSessionHandler = (method) => {
      if (method === "Browser.getVersion") {
        return { product: "HeadlessChrome/120.0.0.0" };
      }
      return undefined;
    };
    const client = createLocalCdpClient("conv-happy");
    const result = await client.send<{ product: string }>("Browser.getVersion");
    expect(result).toEqual({ product: "HeadlessChrome/120.0.0.0" });
    expect(fakeSessionSendCalls).toEqual([
      { method: "Browser.getVersion", params: undefined },
    ]);
    expect(getOrCreateSessionPageCalls).toBe(1);
    expect(newCdpSessionCalls).toBe(1);
  });

  test("send() forwards params to the underlying session", async () => {
    fakeSessionHandler = () => ({ ok: true });
    const client = createLocalCdpClient("conv-params");
    await client.send("Page.navigate", { url: "https://example.com/" });
    expect(fakeSessionSendCalls).toEqual([
      {
        method: "Page.navigate",
        params: { url: "https://example.com/" },
      },
    ]);
  });

  test("multiple send() calls share a single CDP session", async () => {
    fakeSessionHandler = () => ({ ok: true });
    const client = createLocalCdpClient("conv-reuse");
    await client.send("Browser.getVersion");
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    expect(newCdpSessionCalls).toBe(1);
    expect(getOrCreateSessionPageCalls).toBe(1);
    expect(fakeSessionSendCalls.map((c) => c.method)).toEqual([
      "Browser.getVersion",
      "Runtime.enable",
      "Page.enable",
    ]);
  });

  test("concurrent send() calls share a single in-flight session", async () => {
    fakeSessionHandler = () => ({ ok: true });
    const client = createLocalCdpClient("conv-concurrent");
    await Promise.all([
      client.send("Browser.getVersion"),
      client.send("Runtime.enable"),
      client.send("Page.enable"),
    ]);
    expect(newCdpSessionCalls).toBe(1);
    expect(getOrCreateSessionPageCalls).toBe(1);
    expect(fakeSessionSendCalls.length).toBe(3);
  });

  test("dispose() detaches the CDP session exactly once", async () => {
    fakeSessionHandler = () => ({ ok: true });
    const client = createLocalCdpClient("conv-dispose");
    await client.send("Browser.getVersion");
    client.dispose();
    // dispose schedules detach asynchronously; flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeSessionDetachCalls).toBe(1);

    // Idempotent: a second dispose is a no-op.
    client.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeSessionDetachCalls).toBe(1);
  });

  test("dispose() without any sends does not call detach", async () => {
    const client = createLocalCdpClient("conv-dispose-empty");
    client.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeSessionDetachCalls).toBe(0);
    expect(newCdpSessionCalls).toBe(0);
  });

  test("send() after dispose throws CdpError with code 'disposed'", async () => {
    const client = createLocalCdpClient("conv-after-dispose");
    client.dispose();
    let caught: unknown;
    try {
      await client.send("Browser.getVersion");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("disposed");
    expect(cdpErr.cdpMethod).toBe("Browser.getVersion");
    // No session was ever created, so no calls to the fake page.
    expect(newCdpSessionCalls).toBe(0);
    expect(fakeSessionSendCalls.length).toBe(0);
  });

  test("send() with an already-aborted signal throws CdpError 'aborted' without touching the session", async () => {
    const client = createLocalCdpClient("conv-pre-aborted");
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      await client.send("Browser.getVersion", undefined, controller.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("aborted");
    expect(cdpErr.cdpMethod).toBe("Browser.getVersion");
    expect(fakeSessionSendCalls.length).toBe(0);
    expect(newCdpSessionCalls).toBe(0);
    expect(getOrCreateSessionPageCalls).toBe(0);
  });

  test("send() wraps underlying session errors as CdpError 'cdp_error'", async () => {
    const underlying = new Error("target closed");
    fakeSessionHandler = () => {
      throw underlying;
    };
    const client = createLocalCdpClient("conv-throw");
    let caught: unknown;
    try {
      await client.send("Runtime.evaluate", { expression: "1+1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("cdp_error");
    expect(cdpErr.message).toBe("target closed");
    expect(cdpErr.cdpMethod).toBe("Runtime.evaluate");
    expect(cdpErr.cdpParams).toEqual({ expression: "1+1" });
    expect(cdpErr.underlying).toBe(underlying);
  });

  test("send() classifies as 'aborted' when the signal fires during the underlying call", async () => {
    const controller = new AbortController();
    fakeSessionHandler = () => {
      controller.abort();
      throw new Error("target closed");
    };
    const client = createLocalCdpClient("conv-abort-mid");
    let caught: unknown;
    try {
      await client.send(
        "Page.navigate",
        { url: "about:blank" },
        controller.signal,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("aborted");
    expect(cdpErr.cdpMethod).toBe("Page.navigate");
    expect(cdpErr.underlying).toBeInstanceOf(Error);
  });
});
