/**
 * Unit tests for `getClientId` / `getClientRegistrationHeaders`.
 *
 * The id is in-memory only: stable within one page load, fresh for each
 * new module initialization (which the runtime gives us on initial nav,
 * reload, duplicated tab, or bfcache restore).
 */

import { describe, expect, test } from "bun:test";

const MODULE_PATH = "@/lib/telemetry/client-identity";

async function freshImport(): Promise<typeof import("./client-identity")> {
  // Bust the module cache so the in-module `cached` singleton starts fresh.
  // Each test that wants a fresh id calls this.
  const mod = await import(`${MODULE_PATH}?t=${Math.random()}`);
  return mod as typeof import("./client-identity");
}

describe("client-identity", () => {
  test("getClientId returns a UUID", async () => {
    const mod = await freshImport();
    const id = mod.getClientId();

    expect(typeof id).toBe("string");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test("getClientId is stable across repeated calls within one module load", async () => {
    const mod = await freshImport();
    const first = mod.getClientId();
    const second = mod.getClientId();
    const third = mod.getClientId();

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("fresh module loads produce different ids", async () => {
    const a = await freshImport();
    const b = await freshImport();

    expect(a.getClientId()).not.toBe(b.getClientId());
  });

  test("does not read from sessionStorage", async () => {
    sessionStorage.setItem("vellum_client_id", "stale-session-value");
    const mod = await freshImport();

    expect(mod.getClientId()).not.toBe("stale-session-value");
    sessionStorage.clear();
  });

  test("does not read from localStorage", async () => {
    localStorage.setItem("vellum_client_id", "stale-local-value");
    const mod = await freshImport();

    expect(mod.getClientId()).not.toBe("stale-local-value");
    localStorage.clear();
  });

  test("does not write to any browser storage", async () => {
    sessionStorage.clear();
    localStorage.clear();
    const mod = await freshImport();

    mod.getClientId();

    expect(sessionStorage.getItem("vellum_client_id")).toBeNull();
    expect(localStorage.getItem("vellum_client_id")).toBeNull();
  });

  test("getClientRegistrationHeaders returns both client + interface headers", async () => {
    const mod = await freshImport();
    const headers = mod.getClientRegistrationHeaders();

    expect(Object.keys(headers).sort()).toEqual([
      "X-Vellum-Client-Id",
      "X-Vellum-Interface-Id",
    ]);
    expect(headers["X-Vellum-Client-Id"]).toBe(mod.getClientId());
    // The registration interface is intentionally a constant "web" on every
    // platform — it must NOT reflect the real OS, since the daemon derives
    // host-proxy capabilities from this id and the web renderer is never a
    // host provider (see the comment in `client-identity.ts`). Platform
    // awareness flows through the message body instead.
    expect(headers["X-Vellum-Interface-Id"]).toBe("web");
  });
});
