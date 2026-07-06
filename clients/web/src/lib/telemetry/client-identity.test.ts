/**
 * Unit tests for `getClientId` / `getClientRegistrationHeaders`.
 *
 * The id is in-memory only: stable within one page load, fresh for each
 * new module initialization (which the runtime gives us on initial nav,
 * reload, duplicated tab, or bfcache restore).
 */

import { describe, expect, mock, test } from "bun:test";

// `getClientMetadataHeaders` reaches `detectClientOs`, whose Electron /
// Capacitor shell probes are irrelevant to header shape — pin both to the
// plain-browser branch (the platform-detection.test.ts pattern) so the OS
// header is driven purely by the `navigator` overrides below.
mock.module("@/runtime/is-electron", () => ({ isElectron: () => false }));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
}));

const MODULE_PATH = "@/lib/telemetry/client-identity";

async function freshImport(): Promise<typeof import("./client-identity")> {
  // Bust the module cache so the in-module `cached` singleton starts fresh.
  // Each test that wants a fresh id calls this.
  const mod = await import(`${MODULE_PATH}?t=${Math.random()}`);
  return mod as typeof import("./client-identity");
}

const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/**
 * Override `navigator` properties for the duration of `callback`, restoring
 * the original descriptors (or deleting instance-own overrides) afterwards.
 */
function withNavigatorValues<T>(
  values: Record<string, unknown>,
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

  test("getClientRegistrationHeaders returns exactly the identity + metadata header set", async () => {
    const mod = await freshImport();
    process.env.VITE_APP_VERSION = "1.2.3";
    try {
      const headers = withNavigatorValues(
        {
          userAgent: IOS_SAFARI_UA,
          platform: "iPhone",
          maxTouchPoints: 5,
          userAgentData: undefined,
        },
        () => mod.getClientRegistrationHeaders(),
      );

      // Exact key-set assertion: any header beyond this allowlist (e.g. a
      // future change leaking raw UA or locale data) must fail this test.
      expect(Object.keys(headers).sort()).toEqual([
        "X-Vellum-Client-Id",
        "X-Vellum-Interface-Id",
        "x-vellum-browser-family",
        "x-vellum-browser-version",
        "x-vellum-client-os",
        "x-vellum-interface-version",
      ]);
      expect(headers["X-Vellum-Client-Id"]).toBe(mod.getClientId());
      // The registration interface is intentionally a constant "web" on every
      // platform — it must NOT reflect the real OS, since the daemon derives
      // host-proxy capabilities from this id and the web renderer is never a
      // host provider (see the comment in `client-identity.ts`). Platform
      // awareness flows through the message body and the analytics-only
      // metadata headers instead.
      expect(headers["X-Vellum-Interface-Id"]).toBe("web");
      expect(headers["x-vellum-browser-family"]).toBe("safari");
      expect(headers["x-vellum-browser-version"]).toBe("17");
      expect(headers["x-vellum-client-os"]).toBe("ios");
      expect(headers["x-vellum-interface-version"]).toBe("1.2.3");
      // Never the raw user-agent string, in any header.
      expect(JSON.stringify(headers)).not.toContain("Mozilla");
    } finally {
      delete process.env.VITE_APP_VERSION;
    }
  });

  test("metadata headers degrade to the identity set + OS when nothing is detectable", async () => {
    const mod = await freshImport();
    delete process.env.VITE_APP_VERSION;
    const headers = withNavigatorValues(
      {
        userAgent: "",
        platform: "",
        maxTouchPoints: 0,
        userAgentData: undefined,
      },
      () => mod.getClientRegistrationHeaders(),
    );

    // No browser match and no build version → those headers are omitted
    // entirely (never sent empty). The OS surface always resolves — an
    // unrecognizable browser environment reports the "web" fallback.
    expect(Object.keys(headers).sort()).toEqual([
      "X-Vellum-Client-Id",
      "X-Vellum-Interface-Id",
      "x-vellum-client-os",
    ]);
    expect(headers["x-vellum-client-os"]).toBe("web");
  });

  test("browser detection prefers userAgentData brands over the UA string", async () => {
    const mod = await freshImport();
    const headers = withNavigatorValues(
      {
        // Chrome-style UA that would also match the UA fallback — the brands
        // entry must win and GREASE entries must not match.
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        platform: "MacIntel",
        maxTouchPoints: 0,
        userAgentData: {
          brands: [
            { brand: "Not_A Brand", version: "99" },
            { brand: "Google Chrome", version: "126" },
            { brand: "Chromium", version: "126" },
          ],
        },
      },
      () => mod.getClientRegistrationHeaders(),
    );

    expect(headers["x-vellum-browser-family"]).toBe("chrome");
    expect(headers["x-vellum-browser-version"]).toBe("126");
  });
});
