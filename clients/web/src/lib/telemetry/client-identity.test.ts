/**
 * Unit tests for `getClientId` / `getClientRegistrationHeaders`.
 *
 * The id is in-memory only: stable within one page load, fresh for each
 * new module initialization (which the runtime gives us on initial nav,
 * reload, duplicated tab, or bfcache restore).
 */

import { describe, expect, test } from "bun:test";

const MODULE_PATH = "@/lib/telemetry/client-identity";
const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

async function freshImport(): Promise<typeof import("./client-identity")> {
  // Bust the module cache so the in-module `cached` singleton starts fresh.
  // Each test that wants a fresh id calls this.
  const mod = await import(`${MODULE_PATH}?t=${Math.random()}`);
  return mod as typeof import("./client-identity");
}

function withNavigatorValues<T>(
  values: {
    userAgent?: string;
    platform?: string;
    maxTouchPoints?: number;
  },
  callback: () => T,
): T {
  const descriptors = Object.fromEntries(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(Navigator.prototype, key) ??
        Object.getOwnPropertyDescriptor(navigator, key),
    ]),
  );

  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(navigator, key, {
        configurable: true,
        value,
      });
    }
    return callback();
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) {
        Object.defineProperty(navigator, key, descriptor);
      } else {
        delete (navigator as unknown as Record<string, unknown>)[key];
      }
    }
  }
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

  test("getClientRegistrationHeaders returns identity and client metadata headers", async () => {
    const mod = await freshImport();
    const headers = withNavigatorValues(
      {
        userAgent: IOS_SAFARI_UA,
        platform: "iPhone",
        maxTouchPoints: 5,
      },
      () => mod.getClientRegistrationHeaders(),
    );

    expect(headers["X-Vellum-Client-Id"]).toBe(mod.getClientId());
    expect(headers["X-Vellum-Interface-Id"]).toBe("vellum");
    expect(headers["X-Vellum-Browser-Family"]).toBe("safari");
    expect(headers["X-Vellum-Browser-Version"]).toBe("17");
    expect(headers["X-Vellum-Client-OS"]).toBe("ios");
    expect(JSON.stringify(headers)).not.toContain("Mozilla");
  });
});
