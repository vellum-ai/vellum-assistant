import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must precede migration import
// ---------------------------------------------------------------------------

// In-memory credential store. Using `let` so tests can reset between runs.
let store = new Map<string, string>();
let storeUnreachable = false;

mock.module("../security/secure-keys.js", () => ({
  listSecureKeysAsync: async () => ({
    accounts: [...store.keys()],
    unreachable: storeUnreachable,
  }),
  getSecureKeyAsync: async (key: string) => store.get(key),
  setSecureKeyAsync: async (key: string, value: string) => {
    store.set(key, value);
    return true;
  },
  deleteSecureKeyAsync: async (key: string) => {
    store.delete(key);
  },
}));

import { rekeyCompoundCredentialKeysMigration } from "../workspace/migrations/018-rekey-compound-credential-keys.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(entries: Record<string, string> = {}): void {
  store = new Map(Object.entries(entries));
  storeUnreachable = false;
}

function storeEntries(): Record<string, string> {
  return Object.fromEntries(store);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("018-rekey-compound-credential-keys migration", () => {
  test("has correct migration id", () => {
    expect(rekeyCompoundCredentialKeysMigration.id).toBe(
      "018-rekey-compound-credential-keys",
    );
  });

  test("run() re-keys compound credential from indexOf to lastIndexOf format", async () => {
    resetStore({
      "credential/integration/google:access_token": "my-token",
    });

    await rekeyCompoundCredentialKeysMigration.run("/fake");

    expect(storeEntries()).toEqual({
      "credential/integration:google/access_token": "my-token",
    });
  });

  test("run() leaves simple single-colon keys unchanged", async () => {
    resetStore({
      "credential/github/token": "gh-token",
    });

    await rekeyCompoundCredentialKeysMigration.run("/fake");

    expect(storeEntries()).toEqual({
      "credential/github/token": "gh-token",
    });
  });

  test("run() ignores non-credential keys", async () => {
    resetStore({
      "other/integration/google:access_token": "my-token",
    });

    await rekeyCompoundCredentialKeysMigration.run("/fake");

    expect(storeEntries()).toEqual({
      "other/integration/google:access_token": "my-token",
    });
  });

  test("run() is idempotent — second run is a no-op", async () => {
    resetStore({
      "credential/integration/google:access_token": "my-token",
    });

    await rekeyCompoundCredentialKeysMigration.run("/fake");
    const afterFirst = storeEntries();

    await rekeyCompoundCredentialKeysMigration.run("/fake");

    expect(storeEntries()).toEqual(afterFirst);
  });

  test("run() deletes orphaned old key when new key already exists", async () => {
    resetStore({
      "credential/integration/google:access_token": "old-token",
      "credential/integration:google/access_token": "new-token",
    });

    await rekeyCompoundCredentialKeysMigration.run("/fake");

    // Old key removed; new key (already present) wins
    expect(storeEntries()).toEqual({
      "credential/integration:google/access_token": "new-token",
    });
  });

  test("run() throws when credential store is unreachable", async () => {
    resetStore();
    storeUnreachable = true;

    await expect(
      rekeyCompoundCredentialKeysMigration.run("/fake"),
    ).rejects.toThrow("Credential store unreachable");
  });

  test("down() reverses run() — re-keys from lastIndexOf back to indexOf format", async () => {
    resetStore({
      "credential/integration:google/access_token": "my-token",
    });

    await rekeyCompoundCredentialKeysMigration.down("/fake");

    expect(storeEntries()).toEqual({
      "credential/integration/google:access_token": "my-token",
    });
  });

  test("down() leaves simple keys unchanged", async () => {
    resetStore({
      "credential/github/token": "gh-token",
    });

    await rekeyCompoundCredentialKeysMigration.down("/fake");

    expect(storeEntries()).toEqual({
      "credential/github/token": "gh-token",
    });
  });

  test("down() is idempotent — second down() is a no-op", async () => {
    resetStore({
      "credential/integration:google/access_token": "my-token",
    });

    await rekeyCompoundCredentialKeysMigration.down("/fake");
    const afterFirst = storeEntries();

    await rekeyCompoundCredentialKeysMigration.down("/fake");

    expect(storeEntries()).toEqual(afterFirst);
  });

  test("run() then down() restores original state", async () => {
    const original = {
      "credential/integration/google:access_token": "my-token",
    };
    resetStore(original);

    await rekeyCompoundCredentialKeysMigration.run("/fake");
    await rekeyCompoundCredentialKeysMigration.down("/fake");

    expect(storeEntries()).toEqual(original);
  });

  test("down() throws when credential store is unreachable", async () => {
    resetStore();
    storeUnreachable = true;

    await expect(
      rekeyCompoundCredentialKeysMigration.down("/fake"),
    ).rejects.toThrow("Credential store unreachable");
  });
});
