import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const sentMessages: unknown[] = [];
const resolvedInteractionIds: string[] = [];
let mockHasClient = false;

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => sentMessages.push(msg),
  assistantEventHub: {
    getMostRecentClientByCapability: (cap: string) =>
      cap === "host_app_control" && mockHasClient
        ? { id: "mock-client" }
        : null,
  },
}));

mock.module("../runtime/pending-interactions.js", () => ({
  register: () => undefined,
  resolve: (requestId: string) => {
    resolvedInteractionIds.push(requestId);
    return undefined;
  },
  get: () => undefined,
  getByKind: () => [],
  getByConversation: () => [],
  removeByConversation: () => {},
}));

const {
  HostAppControlProxy,
  _getActiveAppControlSession,
  _resetActiveAppControlSession,
  _setActiveAppControlSession,
} = await import("../daemon/host-app-control-proxy.js");

import type { HostAppControlResultPayload } from "../daemon/message-types/host-app-control.js";

/**
 * Build a result payload with stable defaults plus per-test overrides.
 * Default state is "running" so `start` succeeds and the singleton lock
 * is acquired.
 */
function payload(
  overrides: Partial<HostAppControlResultPayload> = {},
): HostAppControlResultPayload {
  return {
    requestId: "ignored-by-proxy",
    state: "running",
    ...overrides,
  };
}

/** Tiny base64-encoded PNG-ish blob — content is irrelevant to the hashing logic. */
const PNG_A = "AAAA";
const PNG_B = "BBBB";

describe("HostAppControlProxy", () => {
  beforeEach(() => {
    sentMessages.length = 0;
    resolvedInteractionIds.length = 0;
    mockHasClient = false;
    _resetActiveAppControlSession();
  });

  afterEach(() => {
    _resetActiveAppControlSession();
  });

  // -------------------------------------------------------------------------
  // (a) Start round-trip
  // -------------------------------------------------------------------------

  describe("start round-trip", () => {
    test("dispatches host_app_control_request and resolves with formatted result", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const controller = new AbortController();

      const resultPromise = proxy.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-1",
        controller.signal,
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.type).toBe("host_app_control_request");
      expect(sent.conversationId).toBe("conv-1");
      expect(sent.toolName).toBe("app_control_start");
      expect(sent.input).toEqual({
        tool: "start",
        app: "com.example.editor",
      });
      expect(typeof sent.requestId).toBe("string");

      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      proxy.resolve(
        requestId,
        payload({
          pngBase64: PNG_A,
          windowBounds: { x: 10, y: 20, width: 800, height: 600 },
          executionResult: "Editor launched",
        }),
      );

      const result = await resultPromise;
      expect(result.isError).toBe(false);
      expect(result.content).toContain("State: running");
      expect(result.content).toContain("800x600 at (10, 20)");
      expect(result.content).toContain("Editor launched");
      expect(result.contentBlocks).toBeDefined();
      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks![0]).toEqual({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: PNG_A,
        },
      });

      // Session lock acquired by this conversation, bound to the started app.
      const session = _getActiveAppControlSession();
      expect(session?.conversationId).toBe("conv-1");
      expect(session?.app).toBe("com.example.editor");

      proxy.dispose();
    });

    test("formats execution error with isError=true", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const controller = new AbortController();

      // Acquire a session first so the click below passes the auth gate
      // and reaches dispatch.
      const startCtrl = new AbortController();
      const startPromise = proxy.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-1",
        startCtrl.signal,
      );
      proxy.resolve(
        (sentMessages[0] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_A }),
      );
      await startPromise;
      sentMessages.length = 0;

      const resultPromise = proxy.request(
        "app_control_click",
        { tool: "click", app: "com.example.editor", x: 100, y: 200 },
        "conv-1",
        controller.signal,
      );

      const sent = sentMessages[0] as Record<string, unknown>;
      proxy.resolve(
        sent.requestId as string,
        payload({
          executionError: "Element not found at (100, 200)",
        }),
      );

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toContain(
        "Action failed: Element not found at (100, 200)",
      );
      expect(result.content).toContain("State: running");

      proxy.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // (b) Session lock
  // -------------------------------------------------------------------------

  describe("session lock", () => {
    test("second conversation's start returns isError naming the holder", async () => {
      const proxy1 = new HostAppControlProxy("conv-1");
      const ctrl1 = new AbortController();

      const p1 = proxy1.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-1",
        ctrl1.signal,
      );
      const sent1 = sentMessages[0] as Record<string, unknown>;
      proxy1.resolve(sent1.requestId as string, payload({ pngBase64: PNG_A }));
      await p1;

      expect(_getActiveAppControlSession()?.conversationId).toBe("conv-1");

      // Second conversation tries to start — should be rejected without
      // sending any envelope.
      const proxy2 = new HostAppControlProxy("conv-2");
      const ctrl2 = new AbortController();
      sentMessages.length = 0;

      const result = await proxy2.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-2",
        ctrl2.signal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("conv-1");
      expect(result.content.toLowerCase()).toContain(
        "currently holds the app-control session",
      );
      expect(sentMessages).toHaveLength(0); // No envelope dispatched

      proxy1.dispose();
      proxy2.dispose();
    });

    test("same conversation re-starting is allowed", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const ctrl = new AbortController();

      const p1 = proxy.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-1",
        ctrl.signal,
      );
      proxy.resolve(
        (sentMessages[0] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_A }),
      );
      await p1;

      // Same conversation can re-start without being blocked.
      const p2 = proxy.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-1",
        ctrl.signal,
      );
      expect(sentMessages).toHaveLength(2);
      proxy.resolve(
        (sentMessages[1] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_B }),
      );
      const result2 = await p2;
      expect(result2.isError).toBe(false);

      proxy.dispose();
    });

    test("non-start tool with no active session is rejected before dispatch", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const ctrl = new AbortController();

      const result = await proxy.request(
        "app_control_type",
        {
          tool: "type",
          app: "com.example.editor",
          text: "rm -rf ~",
        },
        "conv-1",
        ctrl.signal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("No app-control session is active");
      expect(result.content).toContain("app_control_start");
      expect(sentMessages).toHaveLength(0); // No envelope dispatched

      proxy.dispose();
    });

    test("non-start tool from non-owning conversation is rejected", async () => {
      const proxyOwner = new HostAppControlProxy("conv-1");
      const startCtrl = new AbortController();

      const pStart = proxyOwner.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-1",
        startCtrl.signal,
      );
      proxyOwner.resolve(
        (sentMessages[0] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_A }),
      );
      await pStart;
      sentMessages.length = 0;

      // conv-2 tries to observe the app conv-1 owns — must be rejected
      // before any host dispatch.
      const proxyOther = new HostAppControlProxy("conv-2");
      const ctrl = new AbortController();
      const result = await proxyOther.request(
        "app_control_observe",
        { tool: "observe", app: "com.example.editor" },
        "conv-2",
        ctrl.signal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("conv-1");
      expect(result.content).toContain("currently");
      expect(sentMessages).toHaveLength(0);

      proxyOwner.dispose();
      proxyOther.dispose();
    });

    test("non-start tool with mismatched app is rejected (cross-app bypass)", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const startCtrl = new AbortController();

      // User approves control of the editor.
      const pStart = proxy.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-1",
        startCtrl.signal,
      );
      proxy.resolve(
        (sentMessages[0] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_A }),
      );
      await pStart;
      sentMessages.length = 0;

      // The model attempts to type into a different app — must be
      // rejected with an informative error.
      const ctrl = new AbortController();
      const result = await proxy.request(
        "app_control_type",
        {
          tool: "type",
          app: "com.apple.Terminal",
          text: "rm -rf ~",
        },
        "conv-1",
        ctrl.signal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("com.example.editor");
      expect(result.content).toContain("com.apple.Terminal");
      expect(result.content).toContain("app_control_stop");
      expect(sentMessages).toHaveLength(0);

      proxy.dispose();
    });

    test("non-start tool with case-different but otherwise matching app is allowed", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const startCtrl = new AbortController();

      const pStart = proxy.request(
        "app_control_start",
        { tool: "start", app: "com.apple.Safari" },
        "conv-1",
        startCtrl.signal,
      );
      proxy.resolve(
        (sentMessages[0] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_A }),
      );
      await pStart;
      sentMessages.length = 0;

      // Different casing of the same bundle ID — bundle IDs are
      // case-insensitive on macOS, so this should pass the gate.
      const ctrl = new AbortController();
      const obsPromise = proxy.request(
        "app_control_observe",
        { tool: "observe", app: "COM.APPLE.SAFARI" },
        "conv-1",
        ctrl.signal,
      );
      expect(sentMessages).toHaveLength(1);
      proxy.resolve(
        (sentMessages[0] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_B }),
      );
      const result = await obsPromise;
      expect(result.isError).toBe(false);

      proxy.dispose();
    });

    test("non-start tool from owning conversation with matching app dispatches", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const startCtrl = new AbortController();

      const pStart = proxy.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-1",
        startCtrl.signal,
      );
      proxy.resolve(
        (sentMessages[0] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_A }),
      );
      await pStart;
      sentMessages.length = 0;

      const ctrl = new AbortController();
      const obsPromise = proxy.request(
        "app_control_observe",
        { tool: "observe", app: "com.example.editor" },
        "conv-1",
        ctrl.signal,
      );
      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      expect(sent.toolName).toBe("app_control_observe");

      proxy.resolve(sent.requestId as string, payload({ pngBase64: PNG_B }));
      const result = await obsPromise;
      expect(result.isError).toBe(false);

      proxy.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // (c) PNG-hash loop guard
  // -------------------------------------------------------------------------

  describe("PNG-hash loop guard", () => {
    test("attaches stuck warning after 5 identical observations", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const ctrl = new AbortController();
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

      // First observation establishes the baseline (count = 0).
      const p0 = proxy.request(
        "app_control_observe",
        { tool: "observe", app: "com.example.editor" },
        "conv-1",
        ctrl.signal,
      );
      proxy.resolve(
        (sentMessages[0] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_A }),
      );
      const r0 = await p0;
      expect(r0.content).not.toContain("WARNING");
      expect(proxy.observationRepeatCount).toBe(0);

      // 3 additional identical observations bring the repeat count to 3 —
      // still below the threshold (4).
      for (let i = 0; i < 3; i++) {
        const p = proxy.request(
          "app_control_observe",
          { tool: "observe", app: "com.example.editor" },
          "conv-1",
          ctrl.signal,
        );
        const sent = sentMessages[i + 1] as Record<string, unknown>;
        proxy.resolve(sent.requestId as string, payload({ pngBase64: PNG_A }));
        const r = await p;
        expect(r.content).not.toContain("WARNING");
      }
      expect(proxy.observationRepeatCount).toBe(3);

      // 5th total identical observation — count reaches 4, warning fires.
      const pFinal = proxy.request(
        "app_control_observe",
        { tool: "observe", app: "com.example.editor" },
        "conv-1",
        ctrl.signal,
      );
      const sentFinal = sentMessages[4] as Record<string, unknown>;
      proxy.resolve(
        sentFinal.requestId as string,
        payload({ pngBase64: PNG_A }),
      );
      const rFinal = await pFinal;
      expect(rFinal.content).toContain("WARNING");
      expect(rFinal.content.toLowerCase()).toContain("stuck");
      expect(proxy.observationRepeatCount).toBe(4);

      proxy.dispose();
    });

    test("resets repeat count when the screenshot hash differs", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const ctrl = new AbortController();
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

      // Establish baseline at PNG_A.
      const p1 = proxy.request(
        "app_control_observe",
        { tool: "observe", app: "com.example.editor" },
        "conv-1",
        ctrl.signal,
      );
      proxy.resolve(
        (sentMessages[0] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_A }),
      );
      await p1;

      // Repeat 3 times to bring count to 3.
      for (let i = 0; i < 3; i++) {
        const p = proxy.request(
          "app_control_observe",
          { tool: "observe", app: "com.example.editor" },
          "conv-1",
          ctrl.signal,
        );
        const sent = sentMessages[i + 1] as Record<string, unknown>;
        proxy.resolve(sent.requestId as string, payload({ pngBase64: PNG_A }));
        await p;
      }
      expect(proxy.observationRepeatCount).toBe(3);

      // A different PNG resets the count to 0.
      const pDiff = proxy.request(
        "app_control_observe",
        { tool: "observe", app: "com.example.editor" },
        "conv-1",
        ctrl.signal,
      );
      const sentDiff = sentMessages[4] as Record<string, unknown>;
      proxy.resolve(
        sentDiff.requestId as string,
        payload({ pngBase64: PNG_B }),
      );
      const rDiff = await pDiff;
      expect(rDiff.content).not.toContain("WARNING");
      expect(proxy.observationRepeatCount).toBe(0);

      proxy.dispose();
    });

    test("non-running states do not feed the loop guard", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const ctrl = new AbortController();
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

      // Several observations with state != running (and identical PNGs)
      // should not increment the repeat count.
      for (let i = 0; i < 6; i++) {
        const p = proxy.request(
          "app_control_observe",
          { tool: "observe", app: "com.example.editor" },
          "conv-1",
          ctrl.signal,
        );
        const sent = sentMessages[i] as Record<string, unknown>;
        proxy.resolve(
          sent.requestId as string,
          payload({ state: "minimized", pngBase64: PNG_A }),
        );
        const r = await p;
        expect(r.content).not.toContain("WARNING");
      }
      expect(proxy.observationRepeatCount).toBe(0);

      proxy.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // (d) dispose releases the lock
  // -------------------------------------------------------------------------

  describe("dispose lock release", () => {
    test("releases singleton lock so a new conversation can start", async () => {
      const proxy1 = new HostAppControlProxy("conv-1");
      const ctrl1 = new AbortController();

      const p1 = proxy1.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-1",
        ctrl1.signal,
      );
      proxy1.resolve(
        (sentMessages[0] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_A }),
      );
      await p1;
      expect(_getActiveAppControlSession()?.conversationId).toBe("conv-1");

      proxy1.dispose();
      expect(_getActiveAppControlSession()).toBeUndefined();

      // Now a new conversation can acquire the lock.
      sentMessages.length = 0;
      const proxy2 = new HostAppControlProxy("conv-2");
      const ctrl2 = new AbortController();

      const p2 = proxy2.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-2",
        ctrl2.signal,
      );
      expect(sentMessages).toHaveLength(1); // Dispatch happened — not blocked
      proxy2.resolve(
        (sentMessages[0] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_B }),
      );
      const result = await p2;
      expect(result.isError).toBe(false);
      expect(_getActiveAppControlSession()?.conversationId).toBe("conv-2");

      proxy2.dispose();
    });

    test("dispose by a non-holder does not clear the lock", async () => {
      const proxyOwner = new HostAppControlProxy("conv-1");
      const ctrl = new AbortController();

      const pStart = proxyOwner.request(
        "app_control_start",
        { tool: "start", app: "com.example.editor" },
        "conv-1",
        ctrl.signal,
      );
      proxyOwner.resolve(
        (sentMessages[0] as Record<string, unknown>).requestId as string,
        payload({ pngBase64: PNG_A }),
      );
      await pStart;
      expect(_getActiveAppControlSession()?.conversationId).toBe("conv-1");

      // A different conversation's proxy disposes — the lock should remain
      // with conv-1.
      const proxyOther = new HostAppControlProxy("conv-2");
      proxyOther.dispose();
      expect(_getActiveAppControlSession()?.conversationId).toBe("conv-1");

      proxyOwner.dispose();
      expect(_getActiveAppControlSession()).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // (e) Abort
  // -------------------------------------------------------------------------

  describe("abort", () => {
    test("propagates abort and emits cancel envelope", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const controller = new AbortController();
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

      const resultPromise = proxy.request(
        "app_control_observe",
        { tool: "observe", app: "com.example.editor" },
        "conv-1",
        controller.signal,
      );

      expect(sentMessages).toHaveLength(1);
      const sent = sentMessages[0] as Record<string, unknown>;
      const requestId = sent.requestId as string;
      expect(proxy.hasPendingRequest(requestId)).toBe(true);

      controller.abort();

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Aborted");
      expect(proxy.hasPendingRequest(requestId)).toBe(false);

      // Cancel envelope was broadcast.
      expect(sentMessages).toHaveLength(2);
      const cancel = sentMessages[1] as Record<string, unknown>;
      expect(cancel.type).toBe("host_app_control_cancel");
      expect(cancel.requestId).toBe(requestId);
      expect(cancel.conversationId).toBe("conv-1");

      proxy.dispose();
    });

    test("returns immediately when signal is already aborted", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const controller = new AbortController();
      controller.abort();

      const result = await proxy.request(
        "app_control_observe",
        { tool: "observe", app: "com.example.editor" },
        "conv-1",
        controller.signal,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Aborted");
      expect(sentMessages).toHaveLength(0); // No envelope sent

      proxy.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // No 50-step cap (different policy from CU)
  // -------------------------------------------------------------------------

  describe("no step cap", () => {
    test("100 sequential requests dispatch without an artificial limit", async () => {
      const proxy = new HostAppControlProxy("conv-1");
      const ctrl = new AbortController();
      _setActiveAppControlSession({
        conversationId: "conv-1",
        app: "com.example.editor",
      });

      for (let i = 0; i < 100; i++) {
        const p = proxy.request(
          "app_control_observe",
          { tool: "observe", app: "com.example.editor" },
          "conv-1",
          ctrl.signal,
        );
        const sent = sentMessages[i] as Record<string, unknown>;
        // Alternate PNGs so the loop guard does not fire.
        proxy.resolve(
          sent.requestId as string,
          payload({ pngBase64: i % 2 === 0 ? PNG_A : PNG_B }),
        );
        const r = await p;
        expect(r.isError).toBe(false);
      }
      expect(sentMessages).toHaveLength(100);

      proxy.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // isAvailable
  // -------------------------------------------------------------------------

  describe("isAvailable", () => {
    test("returns false when no host_app_control client is connected", () => {
      const proxy = new HostAppControlProxy("conv-1");
      mockHasClient = false;
      expect(proxy.isAvailable()).toBe(false);
      proxy.dispose();
    });

    test("returns true when a host_app_control client is connected", () => {
      const proxy = new HostAppControlProxy("conv-1");
      mockHasClient = true;
      expect(proxy.isAvailable()).toBe(true);
      proxy.dispose();
    });
  });
});
