import { beforeEach, describe, expect, test } from "bun:test";

import {
  __resetClientRegistryForTests,
  ClientRegistry,
  getClientRegistry,
} from "../client-registry.js";

describe("ClientRegistry", () => {
  beforeEach(() => {
    __resetClientRegistryForTests();
  });

  // ── register ──────────────────────────────────────────────────────────────

  test("register creates a new entry with derived capabilities", () => {
    const registry = new ClientRegistry();
    const entry = registry.register({
      clientId: "mac-1",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    });

    expect(entry.clientId).toBe("mac-1");
    expect(entry.interfaceId).toBe("macos");
    expect(entry.capabilities).toContain("host_bash");
    expect(entry.capabilities).toContain("host_file");
    expect(entry.capabilities).toContain("host_cu");
    expect(entry.capabilities).toContain("host_browser");
    expect(entry.hostHomeDir).toBe("/Users/alice");
    expect(entry.hostUsername).toBe("alice");
    expect(entry.connectedAt).toBeGreaterThan(0);
    expect(entry.lastActiveAt).toBeGreaterThanOrEqual(entry.connectedAt);
  });

  test("register derives empty capabilities for web interface", () => {
    const registry = new ClientRegistry();
    const entry = registry.register({
      clientId: "web-1",
      interfaceId: "cli",
    });

    expect(entry.capabilities).toEqual([]);
  });

  test("register derives host_browser capability for chrome-extension", () => {
    const registry = new ClientRegistry();
    const entry = registry.register({
      clientId: "ext-1",
      interfaceId: "chrome-extension",
    });

    expect(entry.capabilities).toEqual(["host_browser"]);
  });

  test("register refreshes lastActiveAt on re-register with same clientId", () => {
    const registry = new ClientRegistry();
    const first = registry.register({
      clientId: "mac-1",
      interfaceId: "macos",
    });
    const firstActive = first.lastActiveAt;

    // Advance time slightly
    const second = registry.register({
      clientId: "mac-1",
      interfaceId: "macos",
      hostHomeDir: "/Users/bob",
    });

    // Same object reference — refreshed in place
    expect(second).toBe(first);
    expect(second.lastActiveAt).toBeGreaterThanOrEqual(firstActive);
    expect(second.hostHomeDir).toBe("/Users/bob");
    // connectedAt should NOT change on refresh
    expect(second.connectedAt).toBe(first.connectedAt);
  });

  test("register does not increase size on re-register", () => {
    const registry = new ClientRegistry();
    registry.register({ clientId: "mac-1", interfaceId: "macos" });
    registry.register({ clientId: "mac-1", interfaceId: "macos" });
    expect(registry.size).toBe(1);
  });

  // ── unregister ────────────────────────────────────────────────────────────

  test("unregister removes the entry", () => {
    const registry = new ClientRegistry();
    registry.register({ clientId: "mac-1", interfaceId: "macos" });
    expect(registry.size).toBe(1);

    registry.unregister("mac-1");
    expect(registry.size).toBe(0);
    expect(registry.get("mac-1")).toBeUndefined();
  });

  test("unregister is a no-op for unknown clientId", () => {
    const registry = new ClientRegistry();
    registry.register({ clientId: "mac-1", interfaceId: "macos" });
    registry.unregister("unknown");
    expect(registry.size).toBe(1);
  });

  // ── touch ─────────────────────────────────────────────────────────────────

  test("touch updates lastActiveAt", () => {
    const registry = new ClientRegistry();
    const entry = registry.register({
      clientId: "mac-1",
      interfaceId: "macos",
    });
    const before = entry.lastActiveAt;
    registry.touch("mac-1");
    expect(entry.lastActiveAt).toBeGreaterThanOrEqual(before);
  });

  test("touch is a no-op for unknown clientId", () => {
    const registry = new ClientRegistry();
    // Should not throw
    registry.touch("unknown");
  });

  // ── get ───────────────────────────────────────────────────────────────────

  test("get returns the entry for a registered clientId", () => {
    const registry = new ClientRegistry();
    const entry = registry.register({
      clientId: "mac-1",
      interfaceId: "macos",
    });
    expect(registry.get("mac-1")).toBe(entry);
  });

  test("get returns undefined for unknown clientId", () => {
    const registry = new ClientRegistry();
    expect(registry.get("unknown")).toBeUndefined();
  });

  // ── listAll ───────────────────────────────────────────────────────────────

  test("listAll returns entries sorted by lastActiveAt descending", () => {
    const registry = new ClientRegistry();
    registry.register({ clientId: "old", interfaceId: "cli" });
    // Touch the second one to make it most recent
    registry.register({ clientId: "new", interfaceId: "macos" });

    const all = registry.listAll();
    expect(all.length).toBe(2);
    expect(all[0].lastActiveAt).toBeGreaterThanOrEqual(all[1].lastActiveAt);
  });

  test("listAll returns empty array when no clients registered", () => {
    const registry = new ClientRegistry();
    expect(registry.listAll()).toEqual([]);
  });

  // ── listByCapability ──────────────────────────────────────────────────────

  test("listByCapability filters to clients with matching capability", () => {
    const registry = new ClientRegistry();
    registry.register({ clientId: "mac-1", interfaceId: "macos" });
    registry.register({ clientId: "web-1", interfaceId: "cli" });
    registry.register({ clientId: "ext-1", interfaceId: "chrome-extension" });

    const bashCapable = registry.listByCapability("host_bash");
    expect(bashCapable.length).toBe(1);
    expect(bashCapable[0].clientId).toBe("mac-1");

    const browserCapable = registry.listByCapability("host_browser");
    expect(browserCapable.length).toBe(2);
    // macOS now supports host_browser too
    const ids = browserCapable.map((e) => e.clientId).sort();
    expect(ids).toEqual(["ext-1", "mac-1"]);
  });

  test("listByCapability returns empty when no clients match", () => {
    const registry = new ClientRegistry();
    registry.register({ clientId: "web-1", interfaceId: "cli" });
    expect(registry.listByCapability("host_bash")).toEqual([]);
  });

  // ── getMostRecentByCapability ─────────────────────────────────────────────

  test("getMostRecentByCapability returns the most recently active client", () => {
    const registry = new ClientRegistry();
    registry.register({ clientId: "mac-1", interfaceId: "macos" });
    registry.register({ clientId: "mac-2", interfaceId: "macos" });

    // mac-2 was registered last, so it should be most recent
    const best = registry.getMostRecentByCapability("host_bash");
    expect(best).toBeDefined();
    expect(best!.clientId).toBe("mac-2");
  });

  test("getMostRecentByCapability returns undefined when no clients match", () => {
    const registry = new ClientRegistry();
    registry.register({ clientId: "web-1", interfaceId: "cli" });
    expect(registry.getMostRecentByCapability("host_bash")).toBeUndefined();
  });

  // ── toJSON ────────────────────────────────────────────────────────────────

  test("toJSON serializes with ISO timestamps", () => {
    const registry = new ClientRegistry();
    const entry = registry.register({
      clientId: "mac-1",
      interfaceId: "macos",
      hostHomeDir: "/Users/alice",
      hostUsername: "alice",
    });

    const json = ClientRegistry.toJSON(entry);
    expect(json.clientId).toBe("mac-1");
    expect(json.interfaceId).toBe("macos");
    expect(json.capabilities).toContain("host_bash");
    expect(json.connectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(json.lastActiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(json.hostHomeDir).toBe("/Users/alice");
    expect(json.hostUsername).toBe("alice");
  });

  test("toJSON omits host fields when not present", () => {
    const registry = new ClientRegistry();
    const entry = registry.register({
      clientId: "web-1",
      interfaceId: "cli",
    });

    const json = ClientRegistry.toJSON(entry);
    expect(json.hostHomeDir).toBeUndefined();
    expect(json.hostUsername).toBeUndefined();
  });

  // ── singleton ─────────────────────────────────────────────────────────────

  test("getClientRegistry returns a singleton", () => {
    const a = getClientRegistry();
    const b = getClientRegistry();
    expect(a).toBe(b);
  });

  test("__resetClientRegistryForTests clears the singleton", () => {
    const a = getClientRegistry();
    __resetClientRegistryForTests();
    const b = getClientRegistry();
    expect(a).not.toBe(b);
  });
});
