import { afterEach, describe, expect, test } from "bun:test";

import {
  __resetForTesting,
  getElectronSessionToken,
  primeElectronSessionToken,
} from "@/runtime/session-token";

function setBridge(token: string | null, calls?: { count: number }): void {
  (window as unknown as { vellum?: unknown }).vellum = {
    platform: "electron",
    auth: {
      getSessionToken: () => {
        if (calls) calls.count += 1;
        return token;
      },
    },
  };
}

afterEach(() => {
  delete (window as unknown as { vellum?: unknown }).vellum;
  __resetForTesting();
});

describe("getElectronSessionToken", () => {
  test("returns null on web (no Electron bridge)", () => {
    expect(getElectronSessionToken()).toBeNull();
  });

  test("seeds from the bridge once and caches the value", () => {
    const calls = { count: 0 };
    setBridge("tok", calls);

    expect(getElectronSessionToken()).toBe("tok");
    expect(getElectronSessionToken()).toBe("tok");
    expect(calls.count).toBe(1);
  });

  test("returns null when the bridge reports no token", () => {
    setBridge(null);
    expect(getElectronSessionToken()).toBeNull();
  });

  test("caches a null seed without re-reading the bridge", () => {
    const calls = { count: 0 };
    setBridge(null, calls);

    expect(getElectronSessionToken()).toBeNull();
    expect(getElectronSessionToken()).toBeNull();
    expect(calls.count).toBe(1);
  });

  test("priming replaces a stale signed-out seed", () => {
    setBridge(null);
    expect(getElectronSessionToken()).toBeNull();

    primeElectronSessionToken("tok");
    expect(getElectronSessionToken()).toBe("tok");
  });
});
