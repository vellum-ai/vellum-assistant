import { beforeEach, describe, expect, test } from "bun:test";

import type { ServerMessage } from "../../daemon/message-protocol.js";
import {
  __resetChromeExtensionRegistryForTests,
  type ChromeExtensionConnection,
  ChromeExtensionRegistry,
  getChromeExtensionRegistry,
} from "../chrome-extension-registry.js";

// Minimal structural stand-in for Bun's ServerWebSocket. Only the methods
// the registry touches (`send`, `close`) are modeled; the rest of the Bun
// ServerWebSocket API is out of scope for these unit tests.
interface FakeWs {
  send: (data: string) => number;
  close: (code?: number, reason?: string) => void;
  sent: string[];
  closed: { code?: number; reason?: string }[];
  sendShouldThrow?: boolean;
}

function makeFakeWs(): FakeWs {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const ws: FakeWs = {
    sent,
    closed,
    send(data: string) {
      if (ws.sendShouldThrow) {
        throw new Error("simulated ws.send failure");
      }
      sent.push(data);
      return data.length;
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
  };
  return ws;
}

function makeConnection(
  guardianId: string,
  id?: string,
  clientInstanceId?: string,
): { conn: ChromeExtensionConnection; fakeWs: FakeWs } {
  const fakeWs = makeFakeWs();
  const now = Date.now();
  const conn: ChromeExtensionConnection = {
    id: id ?? crypto.randomUUID(),
    guardianId,
    clientInstanceId,
    ws: fakeWs as unknown as ChromeExtensionConnection["ws"],
    connectedAt: now,
    lastActiveAt: now,
  };
  return { conn, fakeWs };
}

describe("ChromeExtensionRegistry", () => {
  beforeEach(() => {
    __resetChromeExtensionRegistryForTests();
  });

  test("register stores the connection under the guardianId", () => {
    const registry = new ChromeExtensionRegistry();
    const { conn } = makeConnection("guardian-alpha");
    registry.register(conn);
    expect(registry.get("guardian-alpha")).toBe(conn);
  });

  test("unregister removes the connection", () => {
    const registry = new ChromeExtensionRegistry();
    const { conn } = makeConnection("guardian-alpha");
    registry.register(conn);
    registry.unregister(conn.id);
    expect(registry.get("guardian-alpha")).toBeUndefined();
  });

  test("unregister is a no-op when the connectionId is unknown", () => {
    const registry = new ChromeExtensionRegistry();
    // Should not throw even though nothing is registered.
    expect(() => registry.unregister("unknown-connection")).not.toThrow();
  });

  test("registering a second connection for the same guardianId + instance closes the prior one", () => {
    const registry = new ChromeExtensionRegistry();
    const { conn: conn1, fakeWs: fakeWs1 } = makeConnection(
      "guardian-alpha",
      "conn-1",
      "install-A",
    );
    const { conn: conn2 } = makeConnection(
      "guardian-alpha",
      "conn-2",
      "install-A",
    );
    registry.register(conn1);
    registry.register(conn2);
    // Prior connection (same instance) should have been closed with code 1000.
    expect(fakeWs1.closed).toHaveLength(1);
    expect(fakeWs1.closed[0].code).toBe(1000);
    // Registry should hold the new connection for that instance.
    expect(registry.getInstance("guardian-alpha", "install-A")).toBe(conn2);
  });

  test("registering the same connection id twice is idempotent and does not close itself", () => {
    const registry = new ChromeExtensionRegistry();
    const { conn, fakeWs } = makeConnection("guardian-alpha", "conn-1");
    registry.register(conn);
    registry.register(conn);
    expect(fakeWs.closed).toHaveLength(0);
    expect(registry.get("guardian-alpha")).toBe(conn);
  });

  test("send returns false when no connection exists for the guardian", () => {
    const registry = new ChromeExtensionRegistry();
    const msg: ServerMessage = {
      type: "host_browser_cancel",
      requestId: "req-1",
    } as ServerMessage;
    expect(registry.send("missing-guardian", msg)).toBe(false);
  });

  test("send returns true and forwards the JSON-serialized message when a connection exists", () => {
    const registry = new ChromeExtensionRegistry();
    const { conn, fakeWs } = makeConnection("guardian-alpha");
    registry.register(conn);
    const msg: ServerMessage = {
      type: "host_browser_cancel",
      requestId: "req-1",
    } as ServerMessage;
    const ok = registry.send("guardian-alpha", msg);
    expect(ok).toBe(true);
    expect(fakeWs.sent).toHaveLength(1);
    const parsed = JSON.parse(fakeWs.sent[0]);
    expect(parsed.type).toBe("host_browser_cancel");
    expect(parsed.requestId).toBe("req-1");
  });

  test("send returns false when ws.send throws (best-effort delivery)", () => {
    const registry = new ChromeExtensionRegistry();
    const { conn, fakeWs } = makeConnection("guardian-alpha");
    fakeWs.sendShouldThrow = true;
    registry.register(conn);
    const msg: ServerMessage = {
      type: "host_browser_cancel",
      requestId: "req-1",
    } as ServerMessage;
    expect(registry.send("guardian-alpha", msg)).toBe(false);
  });

  test("getChromeExtensionRegistry returns a module-level singleton", () => {
    const first = getChromeExtensionRegistry();
    const second = getChromeExtensionRegistry();
    expect(first).toBe(second);
  });

  test("unregister after supersession does not remove the new connection", () => {
    // When a new connection supersedes an older one, the close handler for
    // the older socket will fire later and call unregister with the OLD id.
    // That must not clobber the newer registration.
    const registry = new ChromeExtensionRegistry();
    const { conn: old } = makeConnection(
      "guardian-alpha",
      "old-id",
      "install-A",
    );
    const { conn: fresh } = makeConnection(
      "guardian-alpha",
      "fresh-id",
      "install-A",
    );
    registry.register(old);
    registry.register(fresh);
    registry.unregister("old-id");
    expect(registry.getInstance("guardian-alpha", "install-A")).toBe(fresh);
  });

  // ── Multi-instance routing ──────────────────────────────────────────
  //
  // A single guardian may have multiple parallel extension installs
  // connected at once (two Chrome profiles, two desktops sharing a sync
  // identity). The registry keys inner entries by (guardianId,
  // clientInstanceId) so sibling installs don't evict each other on
  // register/unregister, and the default `send()` path routes to
  // whichever instance has the most recent activity.
  describe("multi-instance routing", () => {
    test("two concurrent instances under the same guardian coexist", () => {
      const registry = new ChromeExtensionRegistry();
      const { conn: connA } = makeConnection(
        "guardian-alpha",
        "conn-A",
        "install-A",
      );
      const { conn: connB } = makeConnection(
        "guardian-alpha",
        "conn-B",
        "install-B",
      );
      registry.register(connA);
      registry.register(connB);
      // Both instances remain registered — neither should have been
      // closed by the other's registration.
      expect(registry.getInstance("guardian-alpha", "install-A")).toBe(connA);
      expect(registry.getInstance("guardian-alpha", "install-B")).toBe(connB);
      expect(registry.listInstances("guardian-alpha")).toHaveLength(2);
    });

    test("registering a new instance does not close sibling instances", () => {
      const registry = new ChromeExtensionRegistry();
      const { conn: connA, fakeWs: fakeWsA } = makeConnection(
        "guardian-alpha",
        "conn-A",
        "install-A",
      );
      const { conn: connB, fakeWs: fakeWsB } = makeConnection(
        "guardian-alpha",
        "conn-B",
        "install-B",
      );
      registry.register(connA);
      registry.register(connB);
      // Neither socket should have been closed by the sibling's
      // registration.
      expect(fakeWsA.closed).toHaveLength(0);
      expect(fakeWsB.closed).toHaveLength(0);
    });

    test("unregister of one instance leaves the sibling in place", () => {
      const registry = new ChromeExtensionRegistry();
      const { conn: connA } = makeConnection(
        "guardian-alpha",
        "conn-A",
        "install-A",
      );
      const { conn: connB } = makeConnection(
        "guardian-alpha",
        "conn-B",
        "install-B",
      );
      registry.register(connA);
      registry.register(connB);
      registry.unregister("conn-A");
      expect(
        registry.getInstance("guardian-alpha", "install-A"),
      ).toBeUndefined();
      expect(registry.getInstance("guardian-alpha", "install-B")).toBe(connB);
      // Guardian bucket should still exist because install-B is active.
      expect(registry.listInstances("guardian-alpha")).toHaveLength(1);
    });

    test("default send routes to the most recently active instance", () => {
      const registry = new ChromeExtensionRegistry();
      const { conn: connA, fakeWs: fakeWsA } = makeConnection(
        "guardian-alpha",
        "conn-A",
        "install-A",
      );
      const { conn: connB, fakeWs: fakeWsB } = makeConnection(
        "guardian-alpha",
        "conn-B",
        "install-B",
      );
      // Use a fake clock so A's register timestamp is strictly less
      // than B's, ensuring B becomes the "most recently active"
      // instance regardless of host-clock resolution.
      const originalNow = Date.now;
      let fakeNow = originalNow();
      Date.now = () => fakeNow;
      try {
        registry.register(connA);
        fakeNow += 10;
        registry.register(connB);
        const msg: ServerMessage = {
          type: "host_browser_cancel",
          requestId: "req-1",
        } as ServerMessage;
        expect(registry.send("guardian-alpha", msg)).toBe(true);
      } finally {
        Date.now = originalNow;
      }
      // Default send should have landed on instance B, not A.
      expect(fakeWsA.sent).toHaveLength(0);
      expect(fakeWsB.sent).toHaveLength(1);
    });

    test("default send follows activity — later sendToInstance flips the default", () => {
      const registry = new ChromeExtensionRegistry();
      const { conn: connA, fakeWs: fakeWsA } = makeConnection(
        "guardian-alpha",
        "conn-A",
        "install-A",
      );
      const { conn: connB, fakeWs: fakeWsB } = makeConnection(
        "guardian-alpha",
        "conn-B",
        "install-B",
      );
      registry.register(connA);
      registry.register(connB);
      // B was registered last so it starts as the default. Force a
      // send to A via sendToInstance — that bumps A's lastActiveAt and
      // should make it the new default target.
      const msg: ServerMessage = {
        type: "host_browser_cancel",
        requestId: "req-1",
      } as ServerMessage;
      // Nudge the clock forward so A's lastActiveAt strictly exceeds
      // B's register-time stamp even on hosts where Date.now() has
      // millisecond resolution.
      const originalNow = Date.now;
      let fakeNow = originalNow() + 10;
      Date.now = () => fakeNow;
      try {
        expect(
          registry.sendToInstance("guardian-alpha", "install-A", msg),
        ).toBe(true);
        fakeNow += 10;
        // Default send should now route to A.
        expect(registry.send("guardian-alpha", msg)).toBe(true);
      } finally {
        Date.now = originalNow;
      }
      // A received one explicit send and one default send.
      expect(fakeWsA.sent).toHaveLength(2);
      // B only received the initial register (no sends).
      expect(fakeWsB.sent).toHaveLength(0);
    });

    test("sendToInstance returns false for an unknown instance", () => {
      const registry = new ChromeExtensionRegistry();
      const { conn } = makeConnection("guardian-alpha", "conn-A", "install-A");
      registry.register(conn);
      const msg: ServerMessage = {
        type: "host_browser_cancel",
        requestId: "req-1",
      } as ServerMessage;
      expect(
        registry.sendToInstance("guardian-alpha", "install-missing", msg),
      ).toBe(false);
      expect(
        registry.sendToInstance("guardian-missing", "install-A", msg),
      ).toBe(false);
    });

    test("get returns undefined after the last instance unregisters", () => {
      const registry = new ChromeExtensionRegistry();
      const { conn } = makeConnection("guardian-alpha", "conn-A", "install-A");
      registry.register(conn);
      registry.unregister("conn-A");
      expect(registry.get("guardian-alpha")).toBeUndefined();
      expect(registry.listInstances("guardian-alpha")).toHaveLength(0);
    });
  });

  // ── Backwards compatibility ─────────────────────────────────────────
  //
  // Connections without a clientInstanceId (older extension builds or
  // dev-bypass paths) synthesize a connection-scoped key so each one
  // lives in its own slot. This gives sibling instances for the same
  // guardian independent lifecycles even without explicit client ids.
  describe("backwards compatibility when clientInstanceId is absent", () => {
    test("two legacy connections under the same guardian coexist", () => {
      const registry = new ChromeExtensionRegistry();
      const { conn: connA } = makeConnection(
        "guardian-alpha",
        "conn-A",
        // clientInstanceId intentionally omitted
      );
      const { conn: connB } = makeConnection(
        "guardian-alpha",
        "conn-B",
        // clientInstanceId intentionally omitted
      );
      registry.register(connA);
      registry.register(connB);
      expect(registry.listInstances("guardian-alpha")).toHaveLength(2);
    });

    test("legacy unregister does not clobber a newer legacy sibling", () => {
      const registry = new ChromeExtensionRegistry();
      const { conn: oldConn } = makeConnection("guardian-alpha", "old-id");
      const { conn: freshConn } = makeConnection("guardian-alpha", "fresh-id");
      registry.register(oldConn);
      registry.register(freshConn);
      registry.unregister("old-id");
      expect(registry.listInstances("guardian-alpha")).toHaveLength(1);
      // The surviving entry is the newer connection.
      const remaining = registry.listInstances("guardian-alpha");
      expect(remaining[0]).toBe(freshConn);
    });

    test("legacy and instance-id connections can coexist under the same guardian", () => {
      const registry = new ChromeExtensionRegistry();
      const { conn: legacy } = makeConnection("guardian-alpha", "legacy-id");
      const { conn: modern } = makeConnection(
        "guardian-alpha",
        "modern-id",
        "install-A",
      );
      registry.register(legacy);
      registry.register(modern);
      expect(registry.listInstances("guardian-alpha")).toHaveLength(2);
      expect(registry.getInstance("guardian-alpha", "install-A")).toBe(modern);
    });
  });
});
