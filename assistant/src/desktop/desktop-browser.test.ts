import { expect, test } from "bun:test";

import { DesktopBrowser } from "./desktop-browser.js";
import type { DesktopBrowserBridge } from "./desktop-browser-bridge.js";

function fixture() {
  const calls: string[] = [];
  let actionable = true;
  let loader = "document-1";
  const bridge = {
    generation: 1,
    waitUntilReady: async () => {},
    send: async (method: string): Promise<unknown> => {
      calls.push(method);
      if (method === "Vellum.listTabs") {
        return {
          tabs: [{ tabId: 42, url: "https://example.com", active: true }],
        };
      }
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: {
              id: "frame-1",
              loaderId: loader,
              url: "https://example.com",
            },
          },
        };
      }
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              nodeId: "1",
              backendDOMNodeId: 1,
              role: { value: "button" },
              name: { value: "Submit" },
            },
            {
              nodeId: "2",
              role: { value: "StaticText" },
              name: { value: "Example reading content" },
            },
          ],
        };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "object-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: actionable ? { x: 10, y: 10 } : null } };
      }
      return {};
    },
  };
  const browser = new DesktopBrowser(bridge as unknown as DesktopBrowserBridge);
  const execute = (input: Record<string, unknown>) =>
    browser.execute(
      { scope: "browser", ...input },
      "user-123",
      "conv-123",
      new AbortController().signal,
    );
  return {
    calls,
    bridge,
    execute,
    navigate: () => {
      loader = "document-2";
    },
    obscure: () => {
      actionable = false;
    },
  };
}

test("browser actions return bounded text and fresh references without screenshots", async () => {
  const f = fixture();
  const first = await f.execute({ action: "observe" });
  expect(first.text).toContain("Example reading content");
  const next = await f.execute({
    action: "click",
    element: "e1",
    observation_id: first.observation_id,
  });
  expect(next.observation_id).not.toBe(first.observation_id);
  expect(
    f.calls.filter((method) => method === "Input.dispatchMouseEvent"),
  ).toHaveLength(3);
  expect(f.calls).not.toContain("Page.captureScreenshot");
  await expect(
    f.execute({
      action: "click",
      element: "e1",
      observation_id: first.observation_id,
    }),
  ).rejects.toThrow("Stale");
});

test("navigation and reconnect invalidate element references before input", async () => {
  for (const change of ["document", "connection"] as const) {
    const f = fixture();
    const observed = await f.execute({ action: "observe" });
    if (change === "document") {
      f.navigate();
    } else {
      f.bridge.generation++;
    }
    await expect(
      f.execute({
        action: "click",
        element: "e1",
        observation_id: observed.observation_id,
      }),
    ).rejects.toThrow();
    expect(f.calls).not.toContain("Input.dispatchMouseEvent");
  }
});

test("failed actionability never dispatches the click", async () => {
  const f = fixture();
  const observed = await f.execute({ action: "observe" });
  f.obscure();
  await expect(
    f.execute({
      action: "click",
      element: "e1",
      observation_id: observed.observation_id,
    }),
  ).rejects.toThrow("obscured");
  expect(f.calls).not.toContain("Input.dispatchMouseEvent");
});

test("the browser interface rejects arbitrary CDP and evaluation", async () => {
  const f = fixture();
  await expect(
    f.execute({ action: "evaluate", expression: "document.cookie" }),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("scroll without a direction is rejected before mouse input", async () => {
  const f = fixture();
  const observed = await f.execute({ action: "observe" });
  await expect(
    f.execute({ action: "scroll", observation_id: observed.observation_id }),
  ).rejects.toThrow("direction");
  expect(f.calls).not.toContain("Input.dispatchMouseEvent");
});

for (const extraTabs of [0, 100]) {
  test(`new tabs retain identity with ${extraTabs} additional tabs`, async () => {
    const f = fixture();
    const first = await f.execute({ action: "observe" });
    const originalSend = f.bridge.send;
    const targets: Array<{ method: string; tab?: string }> = [];
    f.bridge.send = async (
      method: string,
      _params?: Record<string, unknown>,
      tab?: string,
    ) => {
      targets.push({ method, tab });
      if (method === "Vellum.createTab") {
        return { tabId: "43" };
      }
      if (method === "Vellum.listTabs") {
        return {
          tabs: [
            { tabId: 42, url: "https://example.com", active: false },
            ...Array.from({ length: extraTabs }, (_, index) => ({
              tabId: index + 100,
              url: "https://example.org",
              active: false,
            })),
            { tabId: 43, url: "about:blank", active: true },
          ],
        };
      }
      return originalSend(method);
    };
    const created = await f.execute({
      action: "new_tab",
      observation_id: first.observation_id,
    });
    expect(created.tab_id).toBe(43);
    const tabs = created.tabs as Array<{ tab_id: number }>;
    expect(tabs.length).toBeLessThanOrEqual(100);
    expect(tabs.some((tab) => tab.tab_id === 43)).toBe(true);
    await f.execute({
      action: "navigate",
      url: "https://example.org",
      observation_id: created.observation_id,
    });
    expect(targets.find((call) => call.method === "Page.navigate")?.tab).toBe(
      "43",
    );
  });
}

test("initial observation waits for browser readiness before sending commands", async () => {
  const f = fixture();
  let ready!: () => void;
  f.bridge.waitUntilReady = () =>
    new Promise<void>((resolve) => {
      ready = resolve;
    });
  const pending = f.execute({ action: "observe" });
  expect(f.calls).toEqual([]);
  ready();
  expect((await pending).tab_id).toBe(42);
});
