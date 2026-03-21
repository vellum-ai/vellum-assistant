import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const isAvailableFn = mock((): boolean => true);
const brokerSetFn = mock(
  async (
    _account: string,
    _value: string,
  ): Promise<{ status: string; code?: string; message?: string }> => ({
    status: "ok",
  }),
);
const createBrokerClientFn = mock(() => ({
  isAvailable: isAvailableFn,
  set: brokerSetFn,
}));

const listKeysFn = mock((): string[] => []);
const getKeyFn = mock((_account: string): string | undefined => undefined);
const deleteKeyFn = mock(
  (_account: string): "deleted" | "not-found" | "error" => "deleted",
);

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
//
// The logger is mocked with a silent Proxy to suppress pino output in tests.
// The broker client and encrypted store are mocked to control migration
// behavior without touching real keychain or filesystem state.
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../security/keychain-broker-client.js", () => ({
  createBrokerClient: createBrokerClientFn,
}));

mock.module("../security/encrypted-store.js", () => ({
  listKeys: listKeysFn,
  getKey: getKeyFn,
  deleteKey: deleteKeyFn,
}));

// Import after mocking
import { migrateCredentialsToKeychainMigration } from "../workspace/migrations/015-migrate-credentials-to-keychain.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/mock-home/.vellum/workspace";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("015-migrate-credentials-to-keychain migration", () => {
  beforeEach(() => {
    isAvailableFn.mockClear();
    brokerSetFn.mockClear();
    createBrokerClientFn.mockClear();
    listKeysFn.mockClear();
    getKeyFn.mockClear();
    deleteKeyFn.mockClear();

    // Defaults: mac production build
    process.env.VELLUM_DESKTOP_APP = "1";
    delete process.env.VELLUM_DEV;

    isAvailableFn.mockReturnValue(true);
    brokerSetFn.mockResolvedValue({ status: "ok" });
    listKeysFn.mockReturnValue([]);
    getKeyFn.mockReturnValue(undefined);
    deleteKeyFn.mockReturnValue("deleted");
  });

  test("has correct migration id", () => {
    expect(migrateCredentialsToKeychainMigration.id).toBe(
      "015-migrate-credentials-to-keychain",
    );
  });

  test("skips when VELLUM_DESKTOP_APP is not set", async () => {
    delete process.env.VELLUM_DESKTOP_APP;

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    expect(createBrokerClientFn).not.toHaveBeenCalled();
    expect(listKeysFn).not.toHaveBeenCalled();
  });

  test("skips when VELLUM_DESKTOP_APP is not '1'", async () => {
    process.env.VELLUM_DESKTOP_APP = "0";

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    expect(createBrokerClientFn).not.toHaveBeenCalled();
  });

  test("skips when VELLUM_DEV=1", async () => {
    process.env.VELLUM_DEV = "1";

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    expect(createBrokerClientFn).not.toHaveBeenCalled();
    expect(listKeysFn).not.toHaveBeenCalled();
  });

  test("throws when broker is not available after max retry attempts", async () => {
    isAvailableFn.mockReturnValue(false);

    await expect(
      migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR),
    ).rejects.toThrow(
      "Keychain broker not available after waiting — credential migration will be retried on next startup",
    );

    // Should have retried isAvailable multiple times
    expect(isAvailableFn.mock.calls.length).toBeGreaterThan(1);

    // Should not proceed to list or migrate keys
    expect(listKeysFn).not.toHaveBeenCalled();
    expect(brokerSetFn).not.toHaveBeenCalled();
  });

  test("succeeds when broker becomes available after retry", async () => {
    // Broker unavailable for first 3 calls, then available
    let callCount = 0;
    isAvailableFn.mockImplementation(() => {
      callCount++;
      return callCount > 3;
    });
    listKeysFn.mockReturnValue(["retry-key"]);
    getKeyFn.mockReturnValue("retry-secret");
    brokerSetFn.mockResolvedValue({ status: "ok" });

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    // Should have called isAvailable 4 times (3 false + 1 true)
    expect(isAvailableFn).toHaveBeenCalledTimes(4);

    // Should have proceeded with migration
    expect(brokerSetFn).toHaveBeenCalledWith("retry-key", "retry-secret");
    expect(deleteKeyFn).toHaveBeenCalledWith("retry-key");
  });

  test("no-ops when encrypted store has no keys", async () => {
    listKeysFn.mockReturnValue([]);

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    expect(brokerSetFn).not.toHaveBeenCalled();
    expect(deleteKeyFn).not.toHaveBeenCalled();
  });

  test("successfully migrates keys from encrypted store to keychain", async () => {
    listKeysFn.mockReturnValue(["account-a", "account-b"]);
    getKeyFn.mockImplementation((account: string) => {
      if (account === "account-a") return "secret-a";
      if (account === "account-b") return "secret-b";
      return undefined;
    });
    brokerSetFn.mockResolvedValue({ status: "ok" });

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    // Should have called broker.set for each key
    expect(brokerSetFn).toHaveBeenCalledTimes(2);
    expect(brokerSetFn).toHaveBeenCalledWith("account-a", "secret-a");
    expect(brokerSetFn).toHaveBeenCalledWith("account-b", "secret-b");

    // Should have deleted each key from encrypted store after successful migration
    expect(deleteKeyFn).toHaveBeenCalledTimes(2);
    expect(deleteKeyFn).toHaveBeenCalledWith("account-a");
    expect(deleteKeyFn).toHaveBeenCalledWith("account-b");
  });

  test("continues on individual key failure and migrates others", async () => {
    listKeysFn.mockReturnValue(["fail-key", "ok-key"]);
    getKeyFn.mockImplementation((account: string) => {
      if (account === "fail-key") return "fail-secret";
      if (account === "ok-key") return "ok-secret";
      return undefined;
    });
    brokerSetFn.mockImplementation(async (account: string) => {
      if (account === "fail-key") {
        return {
          status: "rejected" as const,
          code: "UNKNOWN",
          message: "broker rejected",
        };
      }
      return { status: "ok" as const };
    });

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    // fail-key should NOT have been deleted (broker rejected it)
    expect(deleteKeyFn).not.toHaveBeenCalledWith("fail-key");

    // ok-key should have been migrated and deleted
    expect(brokerSetFn).toHaveBeenCalledWith("ok-key", "ok-secret");
    expect(deleteKeyFn).toHaveBeenCalledWith("ok-key");
    expect(deleteKeyFn).toHaveBeenCalledTimes(1);
  });

  test("handles getKey returning undefined for a listed key", async () => {
    listKeysFn.mockReturnValue(["ghost-key", "real-key"]);
    getKeyFn.mockImplementation((account: string) => {
      if (account === "ghost-key") return undefined;
      if (account === "real-key") return "real-secret";
      return undefined;
    });
    brokerSetFn.mockResolvedValue({ status: "ok" });

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    // ghost-key should not be sent to broker or deleted
    expect(brokerSetFn).not.toHaveBeenCalledWith(
      "ghost-key",
      expect.anything(),
    );
    expect(deleteKeyFn).not.toHaveBeenCalledWith("ghost-key");

    // real-key should be migrated
    expect(brokerSetFn).toHaveBeenCalledWith("real-key", "real-secret");
    expect(deleteKeyFn).toHaveBeenCalledWith("real-key");
  });

  test("handles broker unreachable status for individual keys", async () => {
    listKeysFn.mockReturnValue(["key-1"]);
    getKeyFn.mockReturnValue("secret-1");
    brokerSetFn.mockResolvedValue({ status: "unreachable" });

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    // Should not delete when broker is unreachable
    expect(deleteKeyFn).not.toHaveBeenCalled();
  });
});
