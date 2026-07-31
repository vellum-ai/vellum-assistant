import { describe, expect, it } from "bun:test";
import type { Logger } from "pino";
import type { CredentialCache } from "../credential-cache.js";
import {
  resolveCredentialWithRefresh,
  verifySecretWithRefresh,
} from "../credential-refresh.js";

const silentLog = { info: () => {} } as unknown as Logger;

/**
 * Fake CredentialCache returning the given values in call order and
 * recording whether each read was forced.
 */
function fakeCache(reads: Array<string | undefined>): {
  cache: CredentialCache;
  calls: Array<{ force: boolean }>;
} {
  const calls: Array<{ force: boolean }> = [];
  const cache = {
    get: async (_key: string, opts?: { force?: boolean }) => {
      calls.push({ force: opts?.force ?? false });
      return reads[calls.length - 1];
    },
  } as unknown as CredentialCache;
  return { cache, calls };
}

describe("resolveCredentialWithRefresh", () => {
  it("returns undefined without a credential cache", async () => {
    expect(await resolveCredentialWithRefresh(undefined, "k")).toBeUndefined();
  });

  it("returns the cached value without forcing", async () => {
    const { cache, calls } = fakeCache(["secret"]);
    expect(await resolveCredentialWithRefresh(cache, "k")).toBe("secret");
    expect(calls).toEqual([{ force: false }]);
  });

  it("force-refreshes once when the cached read is empty", async () => {
    const { cache, calls } = fakeCache([undefined, "late"]);
    expect(await resolveCredentialWithRefresh(cache, "k")).toBe("late");
    expect(calls).toEqual([{ force: false }, { force: true }]);
  });

  it("returns undefined when the forced read is empty too", async () => {
    const { cache, calls } = fakeCache([undefined, undefined]);
    expect(await resolveCredentialWithRefresh(cache, "k")).toBeUndefined();
    expect(calls).toEqual([{ force: false }, { force: true }]);
  });
});

describe("verifySecretWithRefresh", () => {
  const opts = (cache: CredentialCache | undefined, valid: Set<string>) => ({
    credentials: cache,
    key: "k",
    verify: (secret: string) => valid.has(secret),
    log: silentLog,
    label: "Test webhook secret",
  });

  it("returns false without a credential cache", async () => {
    expect(
      await verifySecretWithRefresh(opts(undefined, new Set(["s1"]))),
    ).toBe(false);
  });

  it("verifies against the cached secret without forcing", async () => {
    const { cache, calls } = fakeCache(["s1"]);
    expect(await verifySecretWithRefresh(opts(cache, new Set(["s1"])))).toBe(
      true,
    );
    expect(calls).toEqual([{ force: false }]);
  });

  it("force-refreshes and retries once when verification fails", async () => {
    const { cache, calls } = fakeCache(["stale", "fresh"]);
    expect(await verifySecretWithRefresh(opts(cache, new Set(["fresh"])))).toBe(
      true,
    );
    expect(calls).toEqual([{ force: false }, { force: true }]);
  });

  it("force-refreshes when the cached secret is missing", async () => {
    const { cache, calls } = fakeCache([undefined, "fresh"]);
    expect(await verifySecretWithRefresh(opts(cache, new Set(["fresh"])))).toBe(
      true,
    );
    expect(calls).toEqual([{ force: false }, { force: true }]);
  });

  it("returns false when the refreshed secret also fails", async () => {
    const { cache } = fakeCache(["stale", "still-stale"]);
    expect(await verifySecretWithRefresh(opts(cache, new Set(["other"])))).toBe(
      false,
    );
  });

  it("returns false when the forced refresh returns nothing", async () => {
    const { cache } = fakeCache(["stale", undefined]);
    expect(await verifySecretWithRefresh(opts(cache, new Set(["other"])))).toBe(
      false,
    );
  });
});
