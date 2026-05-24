/**
 * Unit tests for `getClientId` / `getClientRegistrationHeaders`.
 *
 * These pin the per-tab storage contract that ATL-703 self-echo suppression
 * depends on. If any of these break, the daemon side will start treating
 * sibling tabs as the same client and `sync_changed` invalidations will
 * stop reaching the tabs that need them.
 *
 * @jest-environment happy-dom
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const MODULE_PATH = "@/lib/telemetry/client-identity.js";

async function freshImport(): Promise<typeof import("./client-identity.js")> {
  // Bust the module cache so the in-module `cached` singleton starts fresh.
  // Each test that wants a clean cache calls this; tests that share state
  // import normally.
  const mod = await import(`${MODULE_PATH}?t=${Math.random()}`);
  return mod as typeof import("./client-identity.js");
}

describe("client-identity", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  test("getClientId generates and persists a UUID in sessionStorage", async () => {
    const mod = await freshImport();
    const id = mod.getClientId();

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(sessionStorage.getItem("vellum_client_id")).toBe(id);
  });

  test("getClientId returns the same value on repeated calls within the tab", async () => {
    const mod = await freshImport();
    const first = mod.getClientId();
    const second = mod.getClientId();
    const third = mod.getClientId();

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("getClientId reuses a previously stored sessionStorage value", async () => {
    sessionStorage.setItem("vellum_client_id", "pre-existing-id");
    const mod = await freshImport();

    expect(mod.getClientId()).toBe("pre-existing-id");
  });

  test("getClientId ignores legacy localStorage values (silent migration)", async () => {
    localStorage.setItem("vellum_client_id", "legacy-localstorage-id");
    const mod = await freshImport();

    const id = mod.getClientId();
    expect(id).not.toBe("legacy-localstorage-id");
    expect(sessionStorage.getItem("vellum_client_id")).toBe(id);
  });

  test("getClientRegistrationHeaders returns both client + interface headers", async () => {
    const mod = await freshImport();
    const headers = mod.getClientRegistrationHeaders();

    expect(Object.keys(headers).sort()).toEqual([
      "X-Vellum-Client-Id",
      "X-Vellum-Interface-Id",
    ]);
    expect(headers["X-Vellum-Client-Id"]).toBe(mod.getClientId());
    expect(headers["X-Vellum-Interface-Id"]).toBe("vellum");
  });

  test("client id values follow the UUID format", async () => {
    const mod = await freshImport();
    const id = mod.getClientId();
    // crypto.randomUUID() in happy-dom returns canonical RFC 4122 v4 form.
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
