import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

// CDP responses and disposal are controlled per test.
type CdpCall = { method: string; params: Record<string, unknown> };
let cdpCalls: CdpCall[] = [];
let cdpSend: (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;
let detachCalls: number;
let clearSnapshotBackendNodeMapMock: ReturnType<typeof mock>;
let storeSnapshotBackendNodeMapMock: ReturnType<typeof mock>;
let storedBackendNodeMaps: Map<string, Map<string, number>>;
const preferredBackendKinds = new Map<string, string>();

mock.module("../tools/browser/browser-manager.js", () => {
  storedBackendNodeMaps = new Map();
  preferredBackendKinds.clear();
  clearSnapshotBackendNodeMapMock = mock((conversationId: string) => {
    storedBackendNodeMaps.delete(conversationId);
  });
  storeSnapshotBackendNodeMapMock = mock(
    (conversationId: string, map: Map<string, number>) => {
      storedBackendNodeMaps.set(conversationId, map);
    },
  );
  return {
    browserManager: {
      storeSnapshotBackendNodeMap: storeSnapshotBackendNodeMapMock,
      clearSnapshotBackendNodeMap: clearSnapshotBackendNodeMapMock,
      resolveSnapshotBackendNodeId: (
        conversationId: string,
        elementId: string,
      ) => {
        const map = storedBackendNodeMaps.get(conversationId);
        if (!map) {
          return null;
        }
        return map.get(elementId) ?? null;
      },
      getPreferredBackendKind: (conversationId: string) =>
        preferredBackendKinds.get(conversationId) ?? null,
      setPreferredBackendKind: (conversationId: string, kind: string) => {
        preferredBackendKinds.set(conversationId, kind);
      },
      clearPreferredBackendKind: (conversationId: string) => {
        preferredBackendKinds.delete(conversationId);
      },
    },
  };
});

mock.module("../tools/network/url-safety.js", () => ({
  parseUrl: () => null,
  isPrivateOrLocalHost: () => false,
  resolveHostAddresses: async () => [],
  resolveRequestAddress: async () => ({}),
  sanitizeUrlForOutput: (url: URL) => url.href,
}));

import {
  executeBrowserClose,
  executeBrowserSnapshot,
} from "../tools/browser/browser-execution.js";

mock.module("../tools/browser/cdp-client/factory.js", () => ({
  getCdpClient: (context: { conversationId: string }) => ({
    kind: "cdp-inspect",
    conversationId: context.conversationId,
    send: (method: string, params?: Record<string, unknown>) => (
      cdpCalls.push({ method, params: params ?? {} }),
      cdpSend(method, params)
    ),
    dispose: () => {
      detachCalls += 1;
    },
  }),
}));

import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  conversationId: "test-conversation",
  workingDir: "/tmp",
  trustClass: "guardian",
};

// ── Fixtures ─────────────────────────────────────────────────────────

/**
 * Minimal three-element Accessibility.getFullAXTree fixture. Mirrors
 * the shape CDP returns — a flat array of nodes with parent/child
 * references via `childIds`. Roles are chosen from the snapshot
 * transformer's interactive-role allowlist so the output contains
 * exactly three elements. The root `WebArea` node owns all three as
 * children so document-order traversal yields e1/e2/e3.
 */
function buildAxTreeFixture(): { nodes: Record<string, unknown>[] } {
  return {
    nodes: [
      {
        nodeId: "1",
        role: { type: "role", value: "WebArea" },
        name: { type: "computedString", value: "" },
        childIds: ["2", "3", "4"],
        backendDOMNodeId: 1,
      },
      {
        nodeId: "2",
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "About Us" },
        properties: [
          { name: "url", value: { type: "string", value: "/about" } },
        ],
        childIds: [],
        backendDOMNodeId: 42,
      },
      {
        nodeId: "3",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Submit" },
        properties: [],
        childIds: [],
        backendDOMNodeId: 99,
      },
      {
        nodeId: "4",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Email" },
        properties: [
          {
            name: "placeholder",
            value: { type: "string", value: "you@example.com" },
          },
        ],
        childIds: [],
        backendDOMNodeId: 101,
      },
    ],
  };
}

/**
 * Build a default CDP `send` handler that returns canned success
 * responses for the methods `executeBrowserSnapshot` touches. Tests
 * pass a map of overrides to customise individual responses or throw
 * from a specific method.
 */
function installCdpSend(
  overrides: Partial<{
    url: string;
    title: string;
    axTree: unknown;
    throwFrom: string;
  }> = {},
) {
  const url = overrides.url ?? "https://example.com/";
  const title = overrides.title ?? "Example Page";
  const axTree = overrides.axTree ?? { nodes: [] };
  const throwFrom = overrides.throwFrom;

  let runtimeEvaluateCall = 0;
  cdpSend = async (method, _params) => {
    if (throwFrom === method) {
      throw new Error("tab detached");
    }
    switch (method) {
      case "Runtime.evaluate": {
        // First call → URL, second → title. Anything beyond returns "".
        const value =
          runtimeEvaluateCall === 0
            ? url
            : runtimeEvaluateCall === 1
              ? title
              : "";
        runtimeEvaluateCall += 1;
        return { result: { value } };
      }
      case "Accessibility.enable":
        return {};
      case "Accessibility.getFullAXTree":
        return axTree;
      default:
        return {};
    }
  };
  return { url, title };
}

function resetCdpState() {
  cdpCalls = [];
  detachCalls = 0;
  cdpSend = async () => ({});
}

// ── browser_snapshot ─────────────────────────────────────────────────

describe("executeBrowserSnapshot (CDP Accessibility.getFullAXTree)", () => {
  beforeEach(() => {
    resetCdpState();
    storedBackendNodeMaps.clear();
    storeSnapshotBackendNodeMapMock.mockClear();
  });

  test("returns URL, title, and a list of interactive elements", async () => {
    installCdpSend({
      url: "https://example.com/",
      title: "Example Page",
      axTree: buildAxTreeFixture(),
    });

    const result = await executeBrowserSnapshot({}, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("URL: https://example.com/");
    expect(result.content).toContain("Title: Example Page");
    expect(result.content).toContain("[e1] <link");
    expect(result.content).toContain("About Us");
    expect(result.content).toContain("[e2] <button> Submit");
    expect(result.content).toContain("[e3] <textbox");
    expect(result.content).toContain("Email");
    expect(result.content).toContain("3 interactive elements found.");
  });

  test("calls Accessibility.enable and getFullAXTree via CDP", async () => {
    installCdpSend();

    await executeBrowserSnapshot({}, ctx);

    const methods = cdpCalls.map((c) => c.method);
    expect(methods).toContain("Accessibility.enable");
    expect(methods).toContain("Accessibility.getFullAXTree");
  });

  test("stores backendNodeId map keyed by eid", async () => {
    installCdpSend({
      axTree: buildAxTreeFixture(),
    });

    await executeBrowserSnapshot({}, ctx);

    expect(storeSnapshotBackendNodeMapMock).toHaveBeenCalledTimes(1);
    const backendMap = storedBackendNodeMaps.get("test-conversation");
    expect(backendMap).toBeDefined();
    expect(backendMap!.get("e1")).toBe(42);
    expect(backendMap!.get("e2")).toBe(99);
    expect(backendMap!.get("e3")).toBe(101);
  });

  test("does not invoke the legacy DOM tagging bridge", async () => {
    installCdpSend({
      axTree: buildAxTreeFixture(),
    });

    await executeBrowserSnapshot({}, ctx);

    // The legacy eid → data-vellum-eid bridge has been removed;
    // interaction tools use the backendNodeId map directly.
    const methods = cdpCalls.map((c) => c.method);
    expect(methods).not.toContain("DOM.pushNodesByBackendIdsToFrontend");
    expect(methods).not.toContain("DOM.setAttributeValue");
  });

  test("renders '(no interactive elements found)' on empty AX tree", async () => {
    installCdpSend({ axTree: { nodes: [] } });

    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("(no interactive elements found)");
    // Empty map should still be stored so stale eids from a previous
    // snapshot cannot resolve after this call.
    expect(storeSnapshotBackendNodeMapMock).toHaveBeenCalledTimes(1);
    const backendMap = storedBackendNodeMaps.get("test-conversation");
    expect(backendMap?.size ?? 0).toBe(0);
  });

  test("returns error content when Accessibility.getFullAXTree throws", async () => {
    installCdpSend({ throwFrom: "Accessibility.getFullAXTree" });

    const result = await executeBrowserSnapshot({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Snapshot failed");
    expect(result.content).toContain("tab detached");
    // dispose still runs in the finally block, which schedules an
    // async session.detach() — flush microtasks before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(detachCalls).toBe(1);
  });

  test("disposes the CdpClient even on success", async () => {
    installCdpSend();

    await executeBrowserSnapshot({}, ctx);
    // dispose schedules detach asynchronously; flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(detachCalls).toBe(1);
  });

  test("shows (none) for empty title", async () => {
    installCdpSend({ title: "", axTree: { nodes: [] } });
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.content).toContain("Title: (none)");
  });
});

// ── browser_close ────────────────────────────────────────────────────

describe("executeBrowserClose", () => {
  beforeEach(() => {
    resetCdpState();
  });
  test("close clears conversation state without closing host tabs", async () => {
    const result = await executeBrowserClose({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Browser session cleared");
  });
  test("close clears conversation state without closing host tabs with close_all_pages", async () => {
    const result = await executeBrowserClose({ close_all_pages: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Browser session cleared");
  });
});
