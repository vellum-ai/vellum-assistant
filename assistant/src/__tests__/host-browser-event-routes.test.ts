/**
 * Unit tests for the PR10 client-message envelopes:
 *   - `host_browser_event`
 *   - `host_browser_session_invalidated`
 *
 * The resolvers exported from `host-browser-routes.ts` are the single
 * entry point for both the WS and any future HTTP transport. These
 * tests drive them directly (bypassing the WS upgrade + frame parse
 * machinery) so we can assert:
 *
 *   1. A well-formed `host_browser_event` frame fans out to the
 *      browser-session event bus — a listener subscribed via
 *      `onCdpEvent` observes the forwarded event with method + params
 *      + sessionId preserved.
 *
 *   2. A well-formed `host_browser_session_invalidated` frame marks
 *      the target as invalidated in the runtime-side registry. The
 *      next `BrowserSessionManager.send()` against a session with
 *      that targetId evicts the session and throws, forcing the
 *      owning tool to create a fresh one (which, on the extension
 *      side, triggers a reattach).
 *
 *   3. Malformed frames return a well-typed `BAD_REQUEST` resolution
 *      so the WS dispatcher in `http-server.ts` can log them without
 *      tearing down the socket.
 *
 * The invalidated-target set is consumed on first lookup (see
 * `consumeInvalidatedTargetId`), so every test that touches it calls
 * `__resetBrowserSessionEventsForTests()` in `beforeEach` to start
 * from a clean slate.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  __resetBrowserSessionEventsForTests,
  type BrowserBackend,
  BrowserSessionManager,
  consumeInvalidatedTargetId,
  createExtensionBackend,
  type ForwardedCdpEvent,
  isTargetInvalidated,
  onCdpEvent,
} from "../browser-session/index.js";
import {
  resolveHostBrowserEvent,
  resolveHostBrowserSessionInvalidated,
} from "../runtime/routes/host-browser-routes.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeBackend(): BrowserBackend {
  return createExtensionBackend({
    isAvailable: () => true,
    sendCdp: async () => ({ result: { ok: true } }),
    dispose: () => {},
  });
}

describe("resolveHostBrowserEvent", () => {
  beforeEach(() => {
    __resetBrowserSessionEventsForTests();
  });

  test("publishes well-formed frames to subscribers", () => {
    const observed: ForwardedCdpEvent[] = [];
    const unsubscribe = onCdpEvent((event) => observed.push(event));

    const resolution = resolveHostBrowserEvent({
      method: "Page.frameNavigated",
      params: { frame: { id: "frame-1", url: "https://example.com" } },
      cdpSessionId: "target-abc",
    });

    expect(resolution.ok).toBe(true);
    expect(observed).toHaveLength(1);
    expect(observed[0].method).toBe("Page.frameNavigated");
    expect(observed[0].params).toEqual({
      frame: { id: "frame-1", url: "https://example.com" },
    });
    expect(observed[0].cdpSessionId).toBe("target-abc");

    unsubscribe();
  });

  test("tolerates missing params — publishes with params undefined", () => {
    const observed: ForwardedCdpEvent[] = [];
    const unsubscribe = onCdpEvent((event) => observed.push(event));

    const resolution = resolveHostBrowserEvent({
      method: "Target.targetDestroyed",
    });

    expect(resolution.ok).toBe(true);
    expect(observed).toHaveLength(1);
    expect(observed[0].method).toBe("Target.targetDestroyed");
    expect(observed[0].params).toBeUndefined();
    expect(observed[0].cdpSessionId).toBeUndefined();

    unsubscribe();
  });

  test("treats empty-string cdpSessionId as absent", () => {
    const observed: ForwardedCdpEvent[] = [];
    const unsubscribe = onCdpEvent((event) => observed.push(event));

    resolveHostBrowserEvent({
      method: "Runtime.consoleAPICalled",
      cdpSessionId: "",
    });

    expect(observed[0].cdpSessionId).toBeUndefined();
    unsubscribe();
  });

  test("rejects frames missing a method", () => {
    const observed: ForwardedCdpEvent[] = [];
    const unsubscribe = onCdpEvent((event) => observed.push(event));

    const resolution = resolveHostBrowserEvent({});

    expect(resolution.ok).toBe(false);
    expect(observed).toHaveLength(0);

    unsubscribe();
  });

  test("rejects frames with a non-string method", () => {
    const resolution = resolveHostBrowserEvent({ method: 42 });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.code).toBe("BAD_REQUEST");
      expect(resolution.status).toBe(400);
    }
  });

  test("multiple subscribers all receive the event", () => {
    const a: ForwardedCdpEvent[] = [];
    const b: ForwardedCdpEvent[] = [];
    const unsubA = onCdpEvent((event) => a.push(event));
    const unsubB = onCdpEvent((event) => b.push(event));

    resolveHostBrowserEvent({
      method: "Network.responseReceived",
      params: { requestId: "r1" },
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].method).toBe("Network.responseReceived");
    expect(b[0].method).toBe("Network.responseReceived");

    unsubA();
    unsubB();
  });

  test("unsubscribe stops delivery", () => {
    const observed: ForwardedCdpEvent[] = [];
    const unsubscribe = onCdpEvent((event) => observed.push(event));

    resolveHostBrowserEvent({ method: "Page.loadEventFired" });
    expect(observed).toHaveLength(1);

    unsubscribe();
    resolveHostBrowserEvent({ method: "Page.loadEventFired" });
    expect(observed).toHaveLength(1);
  });

  test("a throwing listener does not block subsequent listeners", () => {
    const observed: ForwardedCdpEvent[] = [];
    const unsubA = onCdpEvent(() => {
      throw new Error("listener exploded");
    });
    const unsubB = onCdpEvent((event) => observed.push(event));

    // Must not throw
    const resolution = resolveHostBrowserEvent({
      method: "Page.frameNavigated",
    });

    expect(resolution.ok).toBe(true);
    expect(observed).toHaveLength(1);

    unsubA();
    unsubB();
  });
});

describe("resolveHostBrowserSessionInvalidated", () => {
  beforeEach(() => {
    __resetBrowserSessionEventsForTests();
  });

  test("marks the target as invalidated in the registry", () => {
    const resolution = resolveHostBrowserSessionInvalidated({
      targetId: "tab-42",
      reason: "target_closed",
    });

    expect(resolution.ok).toBe(true);
    expect(isTargetInvalidated("tab-42")).toBe(true);
  });

  test("tolerates frames with no targetId (advisory only)", () => {
    const resolution = resolveHostBrowserSessionInvalidated({
      reason: "canceled_by_user",
    });

    expect(resolution.ok).toBe(true);
  });

  test("rejects frames whose targetId is not a string", () => {
    const resolution = resolveHostBrowserSessionInvalidated({
      targetId: 42 as unknown as string,
    });

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.code).toBe("BAD_REQUEST");
    }
  });

  test("BrowserSessionManager evicts a session whose targetId was invalidated and next send forces reattach", async () => {
    // Track every CDP command the backend sees so we can assert that
    // the first send (post-invalidation) never reached the backend
    // while the second send (after reattach) did.
    const sent: Array<{ method: string }> = [];
    const backend = createExtensionBackend({
      isAvailable: () => true,
      sendCdp: async (command) => {
        sent.push({ method: command.method });
        return { result: { ok: true } };
      },
      dispose: () => {},
    });

    const manager = new BrowserSessionManager({ backends: [backend] });
    const session = manager.createSession();
    // Tag the session with a targetId — this is how a real tool
    // invocation would bind its runtime-side session to the
    // extension's debuggee target.
    session.targetId = "tab-42";

    // Fire the invalidation envelope as if the extension just
    // forwarded a detach over the relay WebSocket.
    const resolution = resolveHostBrowserSessionInvalidated({
      targetId: "tab-42",
      reason: "target_closed",
    });
    expect(resolution.ok).toBe(true);

    // The next send against the invalidated session MUST throw —
    // the manager consumes the invalidation flag, evicts the
    // session, and rejects the command so the caller can create a
    // fresh session (which triggers a reattach on the extension
    // side).
    await expect(
      manager.send(session.id, { method: "Page.navigate" }),
    ).rejects.toThrow(/invalidated/);

    // Sanity: the backend never saw the doomed command.
    expect(sent).toHaveLength(0);

    // The evicted session is gone — sending again throws
    // "Unknown browser session".
    await expect(
      manager.send(session.id, { method: "Page.navigate" }),
    ).rejects.toThrow(/Unknown browser session/);

    // Creating a fresh session proves the reattach path works: the
    // caller bounces through `createSession` and a subsequent send
    // dispatches normally through the backend.
    const fresh = manager.createSession();
    const result = await manager.send(fresh.id, { method: "Page.navigate" });
    expect(result.result).toEqual({ ok: true });
    expect(sent).toEqual([{ method: "Page.navigate" }]);
  });

  test("invalidation is consumed on first lookup (set never grows unbounded)", async () => {
    // Registering the invalidation once should affect only the next
    // send against that target. A second send against a brand-new
    // session with the same targetId must NOT be evicted — the entry
    // was already consumed by the first eviction.
    const sent: Array<{ method: string }> = [];
    const backend = createExtensionBackend({
      isAvailable: () => true,
      sendCdp: async (command) => {
        sent.push({ method: command.method });
        return { result: { ok: true } };
      },
      dispose: () => {},
    });
    const manager = new BrowserSessionManager({ backends: [backend] });

    resolveHostBrowserSessionInvalidated({ targetId: "tab-99" });

    const first = manager.createSession();
    first.targetId = "tab-99";
    await expect(
      manager.send(first.id, { method: "Page.navigate" }),
    ).rejects.toThrow(/invalidated/);

    // Second session bound to the same targetId — should dispatch
    // normally because the registry entry was consumed.
    const second = manager.createSession();
    second.targetId = "tab-99";
    const result = await manager.send(second.id, {
      method: "Page.navigate",
    });
    expect(result.result).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });

  test("consumeInvalidatedTargetId drains the entry", () => {
    resolveHostBrowserSessionInvalidated({ targetId: "tab-1" });
    expect(consumeInvalidatedTargetId("tab-1")).toBe(true);
    // Second consume is a no-op — the entry was already drained.
    expect(consumeInvalidatedTargetId("tab-1")).toBe(false);
  });

  test("invalidateSession on BrowserSessionManager evicts by id", () => {
    const manager = new BrowserSessionManager({ backends: [makeBackend()] });
    const session = manager.createSession();
    expect(manager.getSession(session.id)).toBeDefined();
    expect(manager.invalidateSession(session.id)).toBe(true);
    expect(manager.getSession(session.id)).toBeUndefined();
    // Second invalidate returns false — nothing to remove.
    expect(manager.invalidateSession(session.id)).toBe(false);
  });

  test("invalidateByTargetId evicts every session matching the target", () => {
    const manager = new BrowserSessionManager({ backends: [makeBackend()] });
    const a = manager.createSession();
    a.targetId = "tab-7";
    const b = manager.createSession();
    b.targetId = "tab-7";
    const c = manager.createSession();
    c.targetId = "tab-8";

    expect(manager.invalidateByTargetId("tab-7")).toBe(2);
    expect(manager.getSession(a.id)).toBeUndefined();
    expect(manager.getSession(b.id)).toBeUndefined();
    expect(manager.getSession(c.id)).toBeDefined();

    // Second invalidate returns 0 — both matching sessions are gone.
    expect(manager.invalidateByTargetId("tab-7")).toBe(0);
  });
});
