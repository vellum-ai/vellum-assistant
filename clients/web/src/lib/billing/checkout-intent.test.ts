import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearCheckoutIntent,
  readCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";

const STORAGE_KEY = "vellum.pro-checkout-intent";

beforeEach(() => {
  sessionStorage.clear();
  // Reset the module-level in-memory mirror so it can't leak across tests.
  clearCheckoutIntent();
});

describe("saveCheckoutIntent / readCheckoutIntent", () => {
  test("round-trips a package intent and stamps savedAt", () => {
    const before = Date.now();
    saveCheckoutIntent({ kind: "package", packageKey: "super" });

    const intent = readCheckoutIntent();
    expect(intent).not.toBeNull();
    expect(intent!.kind).toBe("package");
    if (intent!.kind === "package") {
      expect(intent!.packageKey).toBe("super");
    }
    expect(intent!.savedAt).toBeGreaterThanOrEqual(before);
    expect(intent!.savedAt).toBeLessThanOrEqual(Date.now());
  });

  test("round-trips a custom intent, including null tiers", () => {
    saveCheckoutIntent({
      kind: "custom",
      machineTier: "large",
      storageTier: "m",
      creditTier: null,
    });

    expect(readCheckoutIntent()).toMatchObject({
      kind: "custom",
      machineTier: "large",
      storageTier: "m",
      creditTier: null,
    });
  });

  test("returns null when nothing is stashed", () => {
    expect(readCheckoutIntent()).toBeNull();
  });

  test("a stash older than 30 minutes reads as null and self-clears", () => {
    const stale = {
      kind: "package",
      packageKey: "super",
      savedAt: Date.now() - 31 * 60 * 1000,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stale));

    expect(readCheckoutIntent()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a stash just inside the TTL still reads", () => {
    const fresh = {
      kind: "package",
      packageKey: "mighty",
      savedAt: Date.now() - 29 * 60 * 1000,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));

    expect(readCheckoutIntent()).toMatchObject({
      kind: "package",
      packageKey: "mighty",
    });
  });

  test("corrupt JSON reads as null and self-clears", () => {
    sessionStorage.setItem(STORAGE_KEY, "{not json");

    expect(readCheckoutIntent()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a parseable but malformed stash reads as null and self-clears", () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ kind: "package", savedAt: "not-a-number" }),
    );

    expect(readCheckoutIntent()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("clearCheckoutIntent", () => {
  test("removes the stash", () => {
    saveCheckoutIntent({ kind: "package", packageKey: "ultra" });
    clearCheckoutIntent();

    expect(readCheckoutIntent()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("in-memory fallback when sessionStorage is unavailable", () => {
  test("save then read round-trips via memory, and clear removes it", () => {
    const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
    const originalGetItem = sessionStorage.getItem.bind(sessionStorage);
    // Simulate storage disabled (private mode / quota / blocked): both the
    // write and the read throw, so only the in-memory mirror can carry the
    // stash across a same-tab signup → privacy hop.
    sessionStorage.setItem = () => {
      throw new Error("sessionStorage unavailable");
    };
    sessionStorage.getItem = () => {
      throw new Error("sessionStorage unavailable");
    };
    try {
      saveCheckoutIntent({ kind: "package", packageKey: "super" });

      expect(readCheckoutIntent()).toMatchObject({
        kind: "package",
        packageKey: "super",
      });

      clearCheckoutIntent();
      expect(readCheckoutIntent()).toBeNull();
    } finally {
      sessionStorage.setItem = originalSetItem;
      sessionStorage.getItem = originalGetItem;
    }
  });

  test("an in-memory mirror older than the TTL reads as null", () => {
    saveCheckoutIntent({ kind: "package", packageKey: "super" });
    // Drop the sessionStorage copy so the read falls back to memory, then age
    // the read past the TTL so the stale mirror can't resurface.
    sessionStorage.clear();
    const originalNow = Date.now;
    Date.now = () => originalNow() + 31 * 60 * 1000;
    try {
      expect(readCheckoutIntent()).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });
});
