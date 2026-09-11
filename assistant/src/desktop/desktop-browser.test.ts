import { expect, test } from "bun:test";

import { DesktopBrowser } from "./desktop-browser.js";
import type { DesktopBrowserBridge } from "./desktop-browser-bridge.js";

function fixture() {
  const calls: string[] = [];
  let actionable = true;
  let loader = "document-1";
  const bridge = {
    generation: 1,
    send: async (method: string) => {
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
