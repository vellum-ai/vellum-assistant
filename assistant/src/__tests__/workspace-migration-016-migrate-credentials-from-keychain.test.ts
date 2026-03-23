import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const isAvailableFn = mock((): boolean => true);
const brokerGetFn = mock(
  async (
    _account: string,
  ): Promise<{ found: boolean; value?: string } | null> => ({
    found: true,
    value: "secret",
  }),
);
const brokerDelFn = mock(async (_account: string): Promise<boolean> => true);
const brokerListFn = mock(async (): Promise<string[]> => []);
const createBrokerClientFn = mock(() => ({
  isAvailable: isAvailableFn,
  get: brokerGetFn,
  del: brokerDelFn,
  list: brokerListFn,
}));

const setKeyFn = mock(
  (_account: string, _value: string): boolean => true,
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
  setKey: setKeyFn,
}));

// Import after mocking
import { migrateCredentialsFromKeychainMigration } from "../workspace/migrations/016-migrate-credentials-from-keychain.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/mock-home/.vellum/workspace";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("016-migrate-credentials-from-keychain migration", () => {
  beforeEach(() => {
    isAvailableFn.mockClear();
    brokerGetFn.mockClear();
    brokerDelFn.mockClear();
    brokerListFn.mockClear();
    createBrokerClientFn.mockClear();
    setKeyFn.mockClear();

    // Defaults: mac production build
    process.env.VELLUM_DESKTOP_APP = "1";
    delete process.env.VELLUM_DEV;

    isAvailableFn.mockReturnValue(true);
    brokerGetFn.mockResolvedValue({ found: true, value: "secret" });
    brokerDelFn.mockResolvedValue(true);
    brokerListFn.mockResolvedValue([]);
    setKeyFn.mockReturnValue(true);
  });

  test("has correct migration id", () => {
    expect(migrateCredentialsFromKeychainMigration.id).toBe(
      "016-migrate-credentials-from-keychain",
    );
  });

  test("skips when VELLUM_DESKTOP_APP is not set", async () => {
    delete process.env.VELLUM_DESKTOP_APP;

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    expect(createBrokerClientFn).not.toHaveBeenCalled();
    expect(brokerListFn).not.toHaveBeenCalled();
  });

  test("skips when VELLUM_DESKTOP_APP is not '1'", async () => {
    process.env.VELLUM_DESKTOP_APP = "0";

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    expect(createBrokerClientFn).not.toHaveBeenCalled();
  });

  test("skips when VELLUM_DEV=1", async () => {
    process.env.VELLUM_DEV = "1";

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    expect(createBrokerClientFn).not.toHaveBeenCalled();
    expect(brokerListFn).not.toHaveBeenCalled();
  });

  test(
    "throws when broker is not available (skips checkpoint for retry)",
    async () => {
      isAvailableFn.mockReturnValue(false);

      // Throwing skips the checkpoint so the migration retries on next startup
      await expect(
        migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR),
      ).rejects.toThrow("Keychain broker not available after waiting");

      // Should not proceed to list or migrate keys
      expect(brokerListFn).not.toHaveBeenCalled();
      expect(setKeyFn).not.toHaveBeenCalled();
    },
    { timeout: 10_000 },
  );

  test("no-ops when keychain has no accounts", async () => {
    brokerListFn.mockResolvedValue([]);

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    expect(setKeyFn).not.toHaveBeenCalled();
    expect(brokerDelFn).not.toHaveBeenCalled();
  });

  test("copies credentials from keychain to encrypted store and deletes from keychain", async () => {
    brokerListFn.mockResolvedValue(["account-a", "account-b"]);
    brokerGetFn.mockImplementation(async (account: string) => {
      if (account === "account-a") return { found: true, value: "secret-a" };
      if (account === "account-b") return { found: true, value: "secret-b" };
      return null;
    });
    setKeyFn.mockReturnValue(true);

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    // Should have written each key to encrypted store
    expect(setKeyFn).toHaveBeenCalledTimes(2);
    expect(setKeyFn).toHaveBeenCalledWith("account-a", "secret-a");
    expect(setKeyFn).toHaveBeenCalledWith("account-b", "secret-b");

    // Should have deleted each key from keychain after successful migration
    expect(brokerDelFn).toHaveBeenCalledTimes(2);
    expect(brokerDelFn).toHaveBeenCalledWith("account-a");
    expect(brokerDelFn).toHaveBeenCalledWith("account-b");
  });

  test("skips key when broker.get returns null", async () => {
    brokerListFn.mockResolvedValue(["ghost-key", "real-key"]);
    brokerGetFn.mockImplementation(async (account: string) => {
      if (account === "ghost-key") return null;
      if (account === "real-key") return { found: true, value: "real-secret" };
      return null;
    });

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    // ghost-key should not be written or deleted
    expect(setKeyFn).not.toHaveBeenCalledWith(
      "ghost-key",
      expect.anything(),
    );
    expect(brokerDelFn).not.toHaveBeenCalledWith("ghost-key");

    // real-key should be migrated
    expect(setKeyFn).toHaveBeenCalledWith("real-key", "real-secret");
    expect(brokerDelFn).toHaveBeenCalledWith("real-key");
  });

  test("skips key when broker.get returns not found", async () => {
    brokerListFn.mockResolvedValue(["missing-key"]);
    brokerGetFn.mockResolvedValue({ found: false });

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    expect(setKeyFn).not.toHaveBeenCalled();
    expect(brokerDelFn).not.toHaveBeenCalled();
  });

  test("skips key when setKey fails and does not delete from keychain", async () => {
    brokerListFn.mockResolvedValue(["fail-key", "ok-key"]);
    brokerGetFn.mockImplementation(async (account: string) => {
      if (account === "fail-key")
        return { found: true, value: "fail-secret" };
      if (account === "ok-key") return { found: true, value: "ok-secret" };
      return null;
    });
    setKeyFn.mockImplementation((account: string) => {
      if (account === "fail-key") return false;
      return true;
    });

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    // fail-key should NOT have been deleted from keychain (setKey failed)
    expect(brokerDelFn).not.toHaveBeenCalledWith("fail-key");

    // ok-key should have been migrated and deleted
    expect(setKeyFn).toHaveBeenCalledWith("ok-key", "ok-secret");
    expect(brokerDelFn).toHaveBeenCalledWith("ok-key");
    expect(brokerDelFn).toHaveBeenCalledTimes(1);
  });
});
