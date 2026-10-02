import { afterEach, expect, test } from "bun:test";

import { waitFor } from "../__tests__/helpers/wait-for.js";
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
  let disconnect = () => {};
  let reject:
    | ((
        method: string,
        params: Record<string, unknown>,
      ) => boolean | Promise<boolean>)
    | undefined;
  const browser = new DesktopBrowserClient(async () => {
    const connection = ++connections;
    let closed = false;
    let discoverTargets = false;
    disconnect = () => {
      closed = true;
    };
    return {
      get closed() {
        return closed;
      },
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
        if (await reject?.(method, params)) {
          throw new CdpWsTransportError("closed");
        }
        let result: unknown = {};
        if (method === "Target.setDiscoverTargets") {
          discoverTargets = params.discover === true;
        }
        if (method === "Target.getTargets") {
          result = { targetInfos: targets };
        }
        if (method === "Target.attachToTarget") {
          result = { sessionId: `session-${connection}-${params.targetId}` };
        }
        if (method === "Target.detachFromTarget") {
          for (const listener of listeners) {
            listener({ method: "Target.detachedFromTarget", params });
          }
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
        listeners.push((event) => {
          if (event.method !== "Target.targetDestroyed" || discoverTargets) {
            listener(event);
          }
        });
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
    disconnect: () => disconnect(),
    emit: (method: string, params = {}, sessionId?: string) =>
      listeners.forEach((listener) => listener({ method, params, sessionId })),
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

test("release invalidates borrowed clients and releases uncertain input through a fresh connection", async () => {
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

test("navigation restores the cursor in its tab without replaying mouse input", async () => {
  const f = await session();
  await f.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 50,
    y: 60,
  });
  f.calls.length = 0;
  f.emit("Page.domContentEventFired", {}, "session-1-page-2");
  f.emit("Page.domContentEventFired", {}, "session-1-page-1");
  await Bun.sleep(0);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({
    method: "Runtime.evaluate",
    session: "session-1-page-1",
  });
  expect(f.calls[0]?.params.expression).toContain("translate(50px, 60px)");
});

test("keyboard input restores an existing cursor without synthesizing mouse input", async () => {
  const f = await session();
  await f.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 50,
    y: 60,
  });
  f.calls.length = 0;
  await f.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter" });
  expect(f.calls.map((call) => call.method)).toEqual([
    "Input.dispatchKeyEvent",
    "Runtime.evaluate",
  ]);
  expect(f.calls[1]?.params.expression).toContain("translate(50px, 60px)");
});

test("release suppresses pending cursor restoration and clears it before detaching", async () => {
  const f = await session();
  await f.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 50,
    y: 60,
  });
  f.calls.length = 0;
  f.emit("Page.domContentEventFired", {}, "session-1-page-1");
  await f.browser.release();
  f.emit("Page.domContentEventFired", {}, "session-1-page-1");
  await Bun.sleep(0);
  const expressions = f.calls.filter(
    (call) => call.method === "Runtime.evaluate",
  );
  expect(expressions).toHaveLength(1);
  expect(expressions[0]?.params.expression).toContain("?.remove()");
});

test("release waits for an in-flight cursor restoration before removing it", async () => {
  const f = await session();
  await f.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 50,
    y: 60,
  });
  let finish!: (reject: boolean) => void;
  const restoring = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  let started = false;
  f.fail((method, params) => {
    if (
      method === "Runtime.evaluate" &&
      String(params.expression).includes("translate(")
    ) {
      started = true;
      return restoring;
    }
    return false;
  });
  f.emit("Page.domContentEventFired", {}, "session-1-page-1");
  await waitFor(() => started);
  const released = f.browser.release();
  try {
    await Bun.sleep(0);
    expect(f.calls.some((call) => call.connection === 2)).toBe(false);
  } finally {
    finish(false);
    await released;
  }
  expect(f.calls.at(-1)?.params.expression).toContain("?.remove()");
});

test("closed connections reconnect after cleanup without retrying input or reusing old clients", async () => {
  const f = await session();
  await f.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Shift",
    code: "ShiftLeft",
  });
  let previous = f.cdp;
  for (let round = 0; round < 2; round++) {
    f.disconnect();
    const current = await f.browser.client("conv-123", f.abort.signal);
    await expect(previous.listTabs()).rejects.toThrow("session expired");
    await current.send("Runtime.evaluate", { expression: "document.title" });
    expect(f.calls.at(-1)?.connection).toBe(3 + round * 2);
    previous = current;
  }
  expect(f.calls.filter((call) => call.params.type === "keyDown")).toHaveLength(
    1,
  );
  expect(
    f.calls
      .filter((call) => call.params.type === "keyUp")
      .map((call) => call.connection),
  ).toEqual([2]);
});

test("switching tabs releases held input and removes the cursor before detaching", async () => {
  const f = await session();
  f.targets.push({
    targetId: "page-2",
    type: "page",
    url: "https://example.org",
    title: "Second",
  });
  const second = (await f.cdp.listTabs())[1]!.tabId!;
  await f.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    x: 10,
    y: 20,
  });
  f.calls.length = 0;
  f.emit("Page.domContentEventFired", {}, "session-1-page-1");
  await f.cdp.selectTab(second);
  const release = f.calls.findIndex(
    (call) => call.params.type === "mouseReleased",
  );
  const remove = f.calls.findIndex((call) =>
    String(call.params.expression).includes("?.remove()"),
  );
  const detach = f.calls.findIndex(
    (call) => call.method === "Target.detachFromTarget",
  );
  expect(release).toBeGreaterThanOrEqual(0);
  expect(remove).toBeGreaterThan(release);
  expect(detach).toBeGreaterThan(remove);
  expect(f.calls[detach]?.params.sessionId).toBe("session-1-page-1");
  const calls = f.calls.length;
  f.emit("Page.domContentEventFired", {}, "session-1-page-1");
  await Bun.sleep(0);
  expect(f.calls).toHaveLength(calls);
  await f.browser.release();
  expect(
    f.calls.filter((call) => call.params.type === "mouseReleased"),
  ).toHaveLength(1);
});

test("returning to a detached tab reattaches before taking a fresh snapshot", async () => {
  const f = await session();
  const first = (await f.cdp.listTabs())[0]!.tabId!;
  await f.cdp.send("Vellum.createTab");
  expect(
    f.calls.some((call) => call.method === "Target.detachFromTarget"),
  ).toBe(true);
  const second = await f.browser.client("conv-123", f.abort.signal);
  await second.send("Runtime.evaluate", { expression: "document.title" });
  await second.selectTab(first);
  await expect(
    second.send("Input.insertText", { text: "stale" }),
  ).rejects.toThrow("page changed");
  const current = await f.browser.client("conv-123", f.abort.signal);
  await current.send("Input.insertText", { text: "fresh" });
  expect(
    f.calls.filter(
      (call) =>
        call.method === "Target.attachToTarget" &&
        call.params.targetId === "page-1",
    ),
  ).toHaveLength(2);
  expect(
    f.calls.filter((call) => call.method === "Target.detachFromTarget"),
  ).toHaveLength(2);
  expect(f.calls.at(-1)).toMatchObject({
    method: "Input.insertText",
    session: "session-1-page-1",
    params: { text: "fresh" },
  });
});

test("failed tab cleanup keeps the tab selected and retains input for release", async () => {
  const f = await session();
  f.targets.push({
    targetId: "page-2",
    type: "page",
    url: "https://example.org",
    title: "Second",
  });
  const tabs = await f.cdp.listTabs();
  await f.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Shift",
    code: "ShiftLeft",
  });
  f.fail((_method, params) => params.type === "keyUp");
  await expect(f.cdp.selectTab(tabs[1]!.tabId!)).rejects.toBeDefined();
  expect((await f.cdp.listTabs()).find((tab) => tab.active)?.tabId).toBe(
    tabs[0]!.tabId,
  );
  expect(
    f.calls.some((call) => call.method === "Target.detachFromTarget"),
  ).toBe(false);
  f.fail();
  await f.browser.release();
  expect(
    f.calls
      .filter((call) => call.params.type === "keyUp")
      .map((call) => call.connection),
  ).toEqual([1, 2]);
});

test("tab cleanup finishes when its caller aborts without activating another tab", async () => {
  const f = await session();
  f.targets.push({
    targetId: "page-2",
    type: "page",
    url: "https://example.org",
    title: "Second",
  });
  const second = (await f.cdp.listTabs())[1]!.tabId!;
  await f.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Shift",
    code: "ShiftLeft",
  });
  f.calls.length = 0;
  f.fail((_method, params) => {
    if (params.type === "keyUp") {
      f.abort.abort();
    }
    return false;
  });
  await expect(f.cdp.selectTab(second)).rejects.toBeDefined();
  expect(
    f.calls.some((call) => call.method === "Target.detachFromTarget"),
  ).toBe(true);
  expect(f.calls.some((call) => call.method === "Target.activateTarget")).toBe(
    false,
  );
});

test("retargeted sends detach the previous tab before attaching the selected tab", async () => {
  const f = await session();
  f.targets.push({
    targetId: "page-2",
    type: "page",
    url: "https://example.org",
    title: "Second",
  });
  const second = (await f.cdp.listTabs())[1]!.tabId!;
  f.cdp.setCdpSessionId?.(String(second));
  f.calls.length = 0;
  await f.cdp.send("Runtime.evaluate", { expression: "document.title" });
  const detach = f.calls.findIndex(
    (call) => call.method === "Target.detachFromTarget",
  );
  const attach = f.calls.findIndex(
    (call) => call.method === "Target.attachToTarget",
  );
  expect(detach).toBeGreaterThanOrEqual(0);
  expect(attach).toBeGreaterThan(detach);
  expect(f.calls.at(-1)?.session).toBe("session-1-page-2");
});

test.each(["close", "destroy", "refresh"])(
  "closed targets do not block another tab after %s",
  async (mode) => {
    const f = await session();
    f.targets.push({
      targetId: "page-2",
      type: "page",
      url: "https://example.org",
      title: "Second",
    });
    const tabs = await f.cdp.listTabs();
    await f.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Shift",
      code: "ShiftLeft",
    });
    f.targets.splice(0, 1);
    if (mode === "close") {
      await f.cdp.closeTab(tabs[0]!.tabId!);
    } else if (mode === "destroy") {
      f.emit("Target.targetDestroyed", { targetId: "page-1" });
    }
    f.fail((method) => method === "Target.detachFromTarget");
    f.calls.length = 0;
    await f.cdp.selectTab(tabs[1]!.tabId!);
    const current = await f.browser.client("conv-123", f.abort.signal);
    await current.send("Runtime.evaluate", { expression: "document.title" });
    expect(f.calls.every((call) => call.session !== "session-1-page-1")).toBe(
      true,
    );
    expect(f.calls.at(-1)?.session).toBe("session-1-page-2");
    await f.browser.release();
    expect(f.calls.some((call) => call.params.type === "keyUp")).toBe(false);
  },
);

test("a target destroyed during input cleanup does not block tab selection", async () => {
  const f = await session();
  f.targets.push({
    targetId: "page-2",
    type: "page",
    url: "https://example.org",
    title: "Second",
  });
  const second = (await f.cdp.listTabs())[1]!.tabId!;
  await f.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Shift",
    code: "ShiftLeft",
  });
  f.fail((_method, params) => {
    if (params.type === "keyUp") {
      f.targets.splice(0, 1);
      f.emit("Target.targetDestroyed", { targetId: "page-1" });
      return true;
    }
    return false;
  });
  await f.cdp.selectTab(second);
  expect((await f.cdp.listTabs()).find((tab) => tab.active)?.tabId).toBe(
    second,
  );
  const current = await f.browser.client("conv-123", f.abort.signal);
  await current.send("Runtime.evaluate", { expression: "document.title" });
  expect(f.calls.at(-1)?.session).toBe("session-1-page-2");
  await f.browser.release();
  expect(f.calls.filter((call) => call.params.type === "keyUp")).toHaveLength(
    1,
  );
});

test("failed target discovery setup retries on a fresh connection", async () => {
  const f = fixture();
  cleanups.push(() => f.browser.dispose());
  const signal = new AbortController().signal;
  f.fail((method) => method === "Target.setDiscoverTargets");
  await expect(f.browser.client("conv-123", signal)).rejects.toBeDefined();
  f.fail();
  const client = await f.browser.client("conv-123", signal);
  await client.send("Runtime.evaluate", { expression: "document.title" });
  expect(f.calls.at(-1)?.connection).toBe(2);
});
