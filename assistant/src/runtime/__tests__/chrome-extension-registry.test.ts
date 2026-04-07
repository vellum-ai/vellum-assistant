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
): { conn: ChromeExtensionConnection; fakeWs: FakeWs } {
  const fakeWs = makeFakeWs();
  const conn: ChromeExtensionConnection = {
    id: id ?? crypto.randomUUID(),
    guardianId,
    ws: fakeWs as unknown as ChromeExtensionConnection["ws"],
    connectedAt: Date.now(),
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

  test("registering a second connection for the same guardianId closes the prior one", () => {
    const registry = new ChromeExtensionRegistry();
    const { conn: conn1, fakeWs: fakeWs1 } = makeConnection(
      "guardian-alpha",
      "conn-1",
    );
    const { conn: conn2 } = makeConnection("guardian-alpha", "conn-2");
    registry.register(conn1);
    registry.register(conn2);
    // Prior connection should have been closed with code 1000.
    expect(fakeWs1.closed).toHaveLength(1);
    expect(fakeWs1.closed[0].code).toBe(1000);
    // Registry should hold the new connection.
    expect(registry.get("guardian-alpha")).toBe(conn2);
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
    const { conn: old } = makeConnection("guardian-alpha", "old-id");
    const { conn: fresh } = makeConnection("guardian-alpha", "fresh-id");
    registry.register(old);
    registry.register(fresh);
    registry.unregister("old-id");
    expect(registry.get("guardian-alpha")).toBe(fresh);
  });
});
