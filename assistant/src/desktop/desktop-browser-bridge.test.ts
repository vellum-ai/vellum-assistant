import { describe, expect, test } from "bun:test";

import { DesktopBrowserBridge } from "./desktop-browser-bridge.js";

async function fixture() {
  const bridge = new DesktopBrowserBridge();
  const token = bridge.start();
  const connection = crypto.randomUUID();
  const exchange = (
    kind: "connect" | "poll" | "message",
    message?: Record<string, unknown>,
  ) => bridge.exchange({ token, connection, kind, message }, "user-123");
  await exchange("connect");
  return { bridge, token, connection, exchange };
}

describe("managed desktop browser connection", () => {
  test("binds the capability to this guardian and connection", async () => {
    const f = await fixture();
    await expect(
      f.bridge.send(
        "Page.navigate",
        {},
        "1",
        "user-other",
        "conv-123",
        new AbortController().signal,
      ),
    ).rejects.toThrow("guardian");
    await expect(
      f.bridge.exchange(
        { token: "0".repeat(64), connection: f.connection, kind: "connect" },
        "user-123",
      ),
    ).rejects.toThrow("capability");
    await expect(
      f.bridge.exchange(
        { token: f.token, connection: f.connection, kind: "connect" },
        "local",
      ),
    ).rejects.toThrow("bound guardian");
    f.bridge.stop();
  });

  test("routes one request and rejects callbacks from an old connection", async () => {
    const f = await fixture();
    const result = f.bridge.send(
      "Page.getFrameTree",
      {},
      "42",
      "user-123",
      "conv-123",
      new AbortController().signal,
    );
    const { messages } = (await f.exchange("poll")) as {
      messages: Record<string, unknown>[];
    };
    expect(messages[0]?.cdpSessionId).toBe("42");
    expect(messages[0]?.conversationId).toBe("conv-123");
    await f.exchange("message", {
      requestId: messages[0]?.requestId,
      content: '{"ok":true}',
      isError: false,
    });
    expect(await result).toEqual({ ok: true });
    await f.bridge.exchange(
      { token: f.token, connection: crypto.randomUUID(), kind: "connect" },
      "user-123",
    );
    await expect(
      f.exchange("message", {
        requestId: messages[0]?.requestId,
        content: "{}",
      }),
    ).rejects.toThrow("expired");
    f.bridge.stop();
  });

  test("takeover removes unsent work and emits cancellation without replay", async () => {
    const f = await fixture();
    const abort = new AbortController();
    const result = f.bridge.send(
      "Input.insertText",
      { text: "Example" },
      "42",
      "user-123",
      "conv-123",
      abort.signal,
    );
    abort.abort();
    await expect(result).rejects.toThrow("may have completed");
    const { messages } = (await f.exchange("poll")) as {
      messages: Record<string, unknown>[];
    };
    expect(messages.map((message) => message.type)).toEqual([
      "host_browser_cancel",
    ]);
    f.bridge.stop();
  });

  test("reconnect invalidates observations and outstanding requests", async () => {
    const f = await fixture();
    const generation = f.bridge.generation;
    const pending = f.bridge.send(
      "Input.insertText",
      {},
      "42",
      "user-123",
      "conv-123",
      new AbortController().signal,
    );
    await f.bridge.exchange(
      { token: f.token, connection: crypto.randomUUID(), kind: "connect" },
      "user-123",
    );
    await expect(pending).rejects.toThrow("may have completed");
    expect(f.bridge.generation).toBeGreaterThan(generation);
    f.bridge.stop();
    await expect(f.exchange("connect")).rejects.toThrow("capability");
  });
});

test("readiness waits for the matching guardian connection", async () => {
  const bridge = new DesktopBrowserBridge();
  const token = bridge.start();
  let ready = false;
  const waiting = bridge
    .waitUntilReady("user-123", new AbortController().signal)
    .then(() => {
      ready = true;
    });
  await bridge.exchange(
    { token, connection: "wrong-guardian", kind: "connect" },
    "user-other",
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(ready).toBe(false);
  await bridge.exchange(
    { token, connection: "matching-guardian", kind: "connect" },
    "user-123",
  );
  await waiting;
  expect(ready).toBe(true);
  bridge.stop();
});

test("readiness is bounded and cancellation interrupts startup", async () => {
  const bridge = new DesktopBrowserBridge();
  await expect(
    bridge.waitUntilReady("user-123", new AbortController().signal, 1),
  ).rejects.toThrow("ready in time");
  const controller = new AbortController();
  const waiting = bridge.waitUntilReady("user-123", controller.signal);
  controller.abort(new Error("Take control"));
  await expect(waiting).rejects.toThrow("Take control");
});

test("cleanup follows guardian rebinding while normal actions retain actor checks", async () => {
  const f = await fixture();
  const exchange = (
    kind: "connect" | "poll" | "message",
    message?: Record<string, unknown>,
  ) =>
    f.bridge.exchange(
      { token: f.token, connection: "rebound", kind, message },
      "user-new",
    );
  await exchange("connect");
  await expect(
    f.bridge.send(
      "Input.insertText",
      {},
      "42",
      "user-123",
      "conv-123",
      new AbortController().signal,
    ),
  ).rejects.toThrow("guardian");
  const cleanup = f.bridge.releaseInput(
    "conv-123",
    new AbortController().signal,
  );
  const { messages } = (await exchange("poll")) as {
    messages: Record<string, unknown>[];
  };
  expect(messages).toHaveLength(1);
  expect(messages[0]?.cdpMethod).toBe("Vellum.releaseInput");
  await exchange("message", {
    requestId: messages[0]?.requestId,
    content: "{}",
  });
  await cleanup;
  f.bridge.stop();
});
