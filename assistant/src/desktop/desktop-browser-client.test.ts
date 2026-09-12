import { afterEach, expect, test } from "bun:test";

import { executeBrowserOperation } from "../browser/operations.js";
import { browserManager } from "../tools/browser/browser-manager.js";
import {
  type CdpTransportEvent,
  type CdpWsTransport,
  CdpWsTransportError,
} from "../tools/browser/cdp-client/cdp-inspect/ws-transport.js";
import { DesktopBrowserClient } from "./desktop-browser-client.js";

function fixture() {
  const calls: {
    connection: number;
    method: string;
    params: Record<string, unknown>;
    session?: string;
  }[] = [];
  const targets = [
    {
      targetId: "page-1",
      type: "page",
      url: "https://example.com",
      title: "Example",
    },
  ];
  const listeners: ((event: CdpTransportEvent) => void)[] = [];
  let connections = 0;
  let reject:
    | ((method: string, params: Record<string, unknown>) => boolean)
    | undefined;
  const browser = new DesktopBrowserClient(async () => {
    const connection = ++connections;
    let closed = false;
    return {
      async send<T>(
        method: string,
        params: Record<string, unknown> = {},
        options?: { sessionId?: string; signal?: AbortSignal },
      ): Promise<T> {
        options?.signal?.throwIfAborted();
        if (closed) {
          throw new CdpWsTransportError("closed");
        }
        calls.push({ connection, method, params, session: options?.sessionId });
        if (reject?.(method, params)) {
          throw new CdpWsTransportError("closed");
        }
        let result: unknown = {};
        if (method === "Target.getTargets") {
          result = { targetInfos: targets };
        }
        if (method === "Target.attachToTarget") {
          result = { sessionId: `session-${connection}-${params.targetId}` };
        }
        if (method === "Target.createTarget") {
          const targetId = `page-${targets.length + 1}`;
          targets.push({
            targetId,
            type: "page",
            url: "about:blank",
            title: "New",
          });
          result = { targetId };
        }
        if (method === "Runtime.evaluate") {
          result = { result: { value: "Example" } };
        }
        if (method === "DOM.getBoxModel") {
          result = { model: { content: [10, 10, 110, 10, 110, 50, 10, 50] } };
        }
        if (method === "Accessibility.getFullAXTree") {
          result = {
            nodes: [
              {
                nodeId: "1",
                backendDOMNodeId: 42,
                role: { value: "button" },
                name: { value: "Save" },
                properties: [],
              },
            ],
          };
        }
        return result as T;
      },
      addEventListener(listener) {
        listeners.push(listener);
        return () => {};
      },
      dispose() {
        closed = true;
      },
    } satisfies CdpWsTransport;
  });
  return {
    browser,
    calls,
    targets,
    emit: (method: string, params = {}) =>
      listeners.forEach((listener) => listener({ method, params })),
    fail: (predicate?: typeof reject) => {
      reject = predicate;
    },
  };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function session() {
  const f = fixture();
  cleanups.push(() => f.browser.dispose());
  const abort = new AbortController();
  const cdp = await f.browser.client("conv-123", abort.signal);
  return { ...f, cdp, abort };
}

test("shared snapshot and click use desktop element IDs without personal browser state", async () => {
  const f = await session();
  browserManager.storeSnapshotBackendNodeMap(
    "conv-123",
    new Map([["e1", 999]]),
  );
  cleanups.push(() => browserManager.clearSnapshotBackendNodeMap("conv-123"));
  const context = {
    workingDir: "/tmp",
    trustClass: "guardian" as const,
    conversationId: "conv-123",
    cdpClient: f.cdp,
    signal: f.abort.signal,
  };
  const snapshot = await executeBrowserOperation("snapshot", {}, context);
  expect(snapshot.isError).toBe(false);
  expect(snapshot.content).toContain("Save");
  const element = /\b(e\d+)\b/.exec(snapshot.content)?.[1];
  expect(element).toBeDefined();
  const result = await executeBrowserOperation(
    "click",
    { element_id: element },
    context,
  );
  expect(result.isError).toBe(false);
  expect(
    f.calls.find((call) => call.method === "DOM.getBoxModel")?.params
      .backendNodeId,
  ).toBe(42);
  expect(browserManager.resolveSnapshotBackendNodeId("conv-123", "e1")).toBe(
    999,
  );
  const pressIndex = f.calls.findIndex(
    (call) => call.params.type === "mousePressed",
  );
  expect(pressIndex).toBeGreaterThan(0);
  expect(f.calls[pressIndex - 1]?.params.expression).toContain(
    "data-vellum-desktop-cursor",
  );
  expect(
    f.calls.filter((call) => call.params.type === "mousePressed"),
  ).toHaveLength(1);
  f.emit("DOM.documentUpdated");
  const stale = await executeBrowserOperation(
    "click",
    { element_id: element },
    context,
  );
  expect(stale.isError).toBe(true);
  expect(
    f.calls.filter((call) => call.params.type === "mousePressed"),
  ).toHaveLength(1);
});

test("takeover invalidates borrowed clients and releases uncertain input through a fresh connection", async () => {
  const f = await session();
  f.fail(
    (method, params) =>
      method === "Input.dispatchKeyEvent" && params.type === "keyDown",
  );
  await expect(
    f.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Shift",
      code: "ShiftLeft",
    }),
  ).rejects.toThrow("do not retry");
  f.abort.abort();
  f.fail();
  await f.browser.release();
  const releases = f.calls.filter((call) => call.params.type === "keyUp");
  expect(releases).toHaveLength(1);
  expect(releases[0]?.connection).toBe(2);
  expect(releases[0]?.session).toBe("session-2-page-1");
  expect(f.calls.filter((call) => call.params.type === "keyDown")).toHaveLength(
    1,
  );
  await expect(f.cdp.listTabs()).rejects.toBeDefined();
  await expect(
    f.cdp.send("Input.insertText", { text: "late" }),
  ).rejects.toBeDefined();
});

test("failed cleanup retains held input for a later attempt", async () => {
  const f = await session();
  await f.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    x: 10,
    y: 20,
  });
  f.fail((_method, params) => params.type === "mouseReleased");
  await expect(f.browser.release()).rejects.toBeDefined();
  f.fail();
  await f.browser.release();
  expect(
    f.calls
      .filter((call) => call.params.type === "mouseReleased")
      .map((call) => call.connection),
  ).toEqual([2, 3]);
});

test("detachment preserves uncertain key state until target cleanup", async () => {
  const f = await session();
  await f.cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Alt",
    code: "AltLeft",
  });
  f.emit("Target.detachedFromTarget", { sessionId: "session-1-page-1" });
  await f.browser.release();
  expect(f.calls.filter((call) => call.params.type === "keyUp")).toHaveLength(
    1,
  );
});

test("tab changes clear element references and aliases are not reused across leases", async () => {
  const f = await session();
  const first = (await f.cdp.listTabs())[0]!.tabId!;
  browserManager.storeSnapshotBackendNodeMap(
    f.cdp.conversationId,
    new Map([["e1", 42]]),
  );
  const created = await f.cdp.send<{ tabId: number }>("Vellum.createTab");
  expect(
    browserManager.resolveSnapshotBackendNodeId(f.cdp.conversationId, "e1"),
  ).toBeNull();
  await f.cdp.selectTab(first);
  expect((await f.cdp.listTabs()).find((tab) => tab.active)?.tabId).toBe(first);
  f.targets.splice(0, 1);
  f.emit("Target.detachedFromTarget", { sessionId: "session-1-page-1" });
  await expect(
    f.cdp.send("Input.insertText", { text: "wrong page" }),
  ).rejects.toThrow("tab closed");
  expect(f.calls.some((call) => call.params.text === "wrong page")).toBe(false);
  await f.browser.release();
  const next = await f.browser.client("conv-456", new AbortController().signal);
  expect(
    (await next.listTabs()).every((tab) => tab.tabId! > created.tabId),
  ).toBe(true);
});

test("navigation during cursor animation prevents input on the replacement page", async () => {
  const f = await session();
  f.fail((method, params) => {
    if (
      method === "Runtime.evaluate" &&
      String(params.expression).includes("data-vellum-desktop-cursor")
    ) {
      f.emit("Page.frameNavigated");
    }
    return false;
  });
  await expect(
    f.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 50,
      y: 60,
      button: "left",
    }),
  ).rejects.toThrow("page changed");
  expect(f.calls.some((call) => call.params.type === "mousePressed")).toBe(
    false,
  );
});
