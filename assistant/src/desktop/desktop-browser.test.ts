import { describe, expect, test } from "bun:test";

import type {
  CdpTransportEvent,
  CdpWsTransport,
} from "../tools/browser/cdp-client/cdp-inspect/ws-transport.js";
import {
  DesktopBrowser,
  desktopBrowserActionSchema,
} from "./desktop-browser.js";
import { validateDesktopWebSocket } from "./desktop-browser-endpoint.js";

function fixture() {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  let listener: ((event: CdpTransportEvent) => void) | undefined;
  let document = 1;
  let targets = [
    {
      targetId: "tab-1",
      type: "page",
      title: "Example",
      url: "https://example.com",
    },
  ];
  let intercept:
    | ((method: string, signal?: AbortSignal) => Promise<void>)
    | undefined;
  let disposed = 0;
  const transport: CdpWsTransport = {
    async send<T>(
      method: string,
      params?: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ) {
      opts?.signal?.throwIfAborted();
      calls.push({ method, params });
      await intercept?.(method, opts?.signal);
      let result: unknown = {};
      if (method === "Target.getTargets") {
        result = { targetInfos: targets };
      }
      if (method === "Target.attachToTarget") {
        result = { sessionId: "session-1" };
      }
      if (method === "Page.getFrameTree") {
        result = {
          frameTree: {
            frame: {
              id: "frame-1",
              loaderId: "loader-1",
              url: "https://example.com",
            },
          },
        };
      }
      if (method === "Page.createIsolatedWorld") {
        result = { executionContextId: 9 };
      }
      if (method === "DOM.describeNode") {
        result = { node: { backendNodeId: document } };
      }
      if (method === "DOM.resolveNode") {
        result = { object: { objectId: "element-1" } };
      }
      if (method === "Accessibility.getFullAXTree") {
        result = {
          nodes: [
            {
              role: { value: "button" },
              name: { value: "Submit" },
              backendDOMNodeId: 10,
            },
          ],
        };
      }
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression);
        result =
          expression === "document"
            ? { result: { objectId: "document-1" } }
            : expression === "document.visibilityState === 'visible'"
              ? { result: { value: true } }
              : {
                  result: {
                    value: {
                      url: "https://example.com",
                      title: "Example",
                      text: "Useful reading text",
                      ready: "complete",
                      visible: true,
                    },
                  },
                };
      }
      if (method === "Runtime.callFunctionOn") {
        result = {
          result: { value: { x: 100, y: 80, width: 40, height: 20 } },
        };
      }
      return result as T;
    },
    addEventListener(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    dispose() {
      disposed += 1;
    },
  };
  const browser = new DesktopBrowser(async () => transport);
  const signal = new AbortController().signal;
  return {
    browser,
    calls,
    signal,
    observe: () =>
      browser.execute({ action: "observe", target_id: "tab-1" }, signal),
    event: (method: string) => listener?.({ method, sessionId: "session-1" }),
    replaceDocument: () => {
      document += 1;
    },
    closeTab: () => {
      targets = [];
    },
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
    disposed: () => disposed,
  };
}

describe("desktop browser reference lifecycle", () => {
  test("explicitly activates a target and returns reading text and semantic refs without screenshots", async () => {
    const f = fixture();
    const state = await f.observe();
    expect(state.text).toBe("Useful reading text");
    expect(state.elements).toEqual([
      { eid: "e1", role: "button", name: "Submit", attrs: {} },
    ]);
    expect(f.calls.map((call) => call.method)).toContain(
      "Target.activateTarget",
    );
    expect(f.calls.map((call) => call.method)).toContain("Page.bringToFront");
    expect(f.calls.some((call) => /Screenshot|Input\./.test(call.method))).toBe(
      false,
    );
    const next = await f.browser.execute(
      {
        action: "click",
        observation_id: String(state.observation_id),
        ref: "e1",
      },
      f.signal,
    );
    expect(next.outcome).toBe("dispatched");
    expect(next.observation_id).not.toBe(state.observation_id);
    expect(
      f.calls.filter((call) => call.method === "Input.dispatchMouseEvent"),
    ).toHaveLength(3);
    const replay = await f.browser.execute(
      {
        action: "click",
        observation_id: String(state.observation_id),
        ref: "e1",
      },
      f.signal,
    );
    expect(replay.outcome).toBe("not_dispatched");
    expect(
      f.calls.filter((call) => call.method === "Input.dispatchMouseEvent"),
    ).toHaveLength(3);
  });

  test.each([
    "Page.frameNavigated",
    "Page.frameDetached",
    "Page.navigatedWithinDocument",
    "DOM.documentUpdated",
    "Runtime.executionContextsCleared",
    "document",
    "closed",
    "scope",
    "restart",
  ])("invalidates refs after %s", async (change) => {
    const f = fixture();
    const state = await f.observe();
    if (change === "document") {
      f.replaceDocument();
    } else if (change === "closed") {
      f.closeTab();
    } else if (change === "scope") {
      f.browser.invalidate();
    } else if (change === "restart") {
      f.browser.dispose();
    } else {
      f.event(change);
    }
    const result = await f.browser.execute(
      {
        action: "click",
        observation_id: String(state.observation_id),
        ref: "e1",
      },
      f.signal,
    );
    expect(result.outcome).toBe("not_dispatched");
    expect(f.calls.some((call) => call.method.startsWith("Input."))).toBe(
      false,
    );
  });

  test("navigation during observation does not publish a usable reference", async () => {
    const f = fixture();
    f.intercept(async (method) => {
      if (method === "Accessibility.getFullAXTree") {
        f.event("Page.frameNavigated");
      }
    });
    const result = await f.observe();
    expect(result.error).toContain("Page changed");
    expect(result.observation_id).toBeUndefined();
  });

  test("takeover after mouse press cancels the action without retry and releases the held button", async () => {
    const f = fixture();
    const state = await f.observe();
    const abort = new AbortController();
    f.intercept(async (method, signal) => {
      if (
        method === "Input.dispatchMouseEvent" &&
        f.calls.at(-1)?.params?.type === "mousePressed"
      ) {
        abort.abort();
        signal?.throwIfAborted();
      }
    });
    const result = await f.browser.execute(
      {
        action: "click",
        observation_id: String(state.observation_id),
        ref: "e1",
      },
      abort.signal,
    );
    expect(result.outcome).toBe("unknown");
    expect(result.next).toContain("Do not blindly retry");
    expect(
      f.calls.filter((call) => call.params?.type === "mousePressed"),
    ).toHaveLength(1);
    await f.browser.release();
    expect(
      f.calls.filter((call) => call.params?.type === "mouseReleased"),
    ).toHaveLength(1);
    expect(f.disposed()).toBe(1);
  });

  test("rejects a stale target without attaching to another tab", async () => {
    const f = fixture();
    const result = await f.browser.execute(
      { action: "observe", target_id: "missing" },
      f.signal,
    );
    expect(result.error).toContain("current target_id");
    expect(
      f.calls.some((call) => call.method === "Target.attachToTarget"),
    ).toBe(false);
  });
});

test("only accepts the exact loopback browser WebSocket endpoint", () => {
  expect(
    validateDesktopWebSocket(
      "ws://127.0.0.1:19299/devtools/browser/test-1",
      19299,
    ),
  ).toContain("test-1");
  for (const value of [
    "ws://example.com:19299/devtools/browser/test",
    "ws://127.0.0.1:9222/devtools/browser/test",
    "ws://user:secret@127.0.0.1:19299/devtools/browser/test",
    "ws://127.0.0.1:19299/devtools/page/test",
    "wss://127.0.0.1:19299/devtools/browser/test",
    "ws://127.0.0.1:19299/devtools/browser/test?url=x",
  ]) {
    expect(() => validateDesktopWebSocket(value, 19299)).toThrow();
  }
});

test("model surface rejects arbitrary protocol, evaluation and privileged navigation", () => {
  for (const input of [
    { action: "eval", expression: "document.cookie" },
    { action: "send", method: "Network.getCookies" },
    {
      action: "navigate",
      observation_id: crypto.randomUUID(),
      url: "file:///etc/passwd",
    },
  ]) {
    expect(desktopBrowserActionSchema.safeParse(input).success).toBe(false);
  }
});

test("release uses the Space descriptor after cancellation between keyDown and keyUp", async () => {
  const f = fixture();
  const state = await f.observe();
  const abort = new AbortController();
  f.intercept(async (method, signal) => {
    if (
      method === "Input.dispatchKeyEvent" &&
      f.calls.at(-1)?.params?.type === "keyDown"
    ) {
      abort.abort();
      signal?.throwIfAborted();
    }
  });
  const result = await f.browser.execute(
    {
      action: "key",
      key: "Space",
      observation_id: String(state.observation_id),
      ref: "e1",
    },
    abort.signal,
  );
  expect(result.outcome).toBe("unknown");
  await f.browser.release();
  const release = f.calls.find(
    (call) =>
      call.method === "Input.dispatchKeyEvent" && call.params?.type === "keyUp",
  );
  expect(release?.params).toMatchObject({
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
  });
});

test("hover-triggered navigation prevents mouse press and needs no synthetic button release", async () => {
  const f = fixture();
  const state = await f.observe();
  f.intercept(async (method) => {
    if (
      method === "Input.dispatchMouseEvent" &&
      f.calls.at(-1)?.params?.type === "mouseMoved"
    ) {
      f.event("Page.frameNavigated");
    }
  });
  const result = await f.browser.execute(
    {
      action: "click",
      observation_id: String(state.observation_id),
      ref: "e1",
    },
    f.signal,
  );
  expect(result.error).toContain("changed after hover");
  await f.browser.release();
  expect(
    f.calls.filter((call) =>
      ["mousePressed", "mouseReleased"].includes(String(call.params?.type)),
    ),
  ).toHaveLength(0);
});
