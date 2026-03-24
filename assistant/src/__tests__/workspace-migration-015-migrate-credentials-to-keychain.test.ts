import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const execFileSyncFn = mock(
  (
    _file: string,
    _args?: readonly string[],
    _options?: object,
  ): string | Buffer => "",
);

const listKeysFn = mock((): string[] => []);
const getKeyFn = mock((_account: string): string | undefined => undefined);
const setKeyFn = mock((_account: string, _value: string): boolean => true);
const deleteKeyFn = mock(
  (_account: string): "deleted" | "not-found" | "error" => "deleted",
);

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
//
// The logger is mocked with a silent Proxy to suppress pino output in tests.
// node:child_process is mocked to control security CLI calls without touching
// the real keychain. The encrypted store is mocked to avoid filesystem state.
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("node:child_process", () => ({
  execFileSync: execFileSyncFn,
}));

mock.module("../security/encrypted-store.js", () => ({
  listKeys: listKeysFn,
  getKey: getKeyFn,
  setKey: setKeyFn,
  deleteKey: deleteKeyFn,
}));

// Import after mocking
import { migrateCredentialsToKeychainMigration } from "../workspace/migrations/015-migrate-credentials-to-keychain.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/mock-home/.vellum/workspace";

const originalPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", {
    value,
    writable: true,
    configurable: true,
  });
}

function restorePlatform(): void {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("015-migrate-credentials-to-keychain migration", () => {
  beforeEach(() => {
    execFileSyncFn.mockClear();
    listKeysFn.mockClear();
    getKeyFn.mockClear();
    setKeyFn.mockClear();
    deleteKeyFn.mockClear();

    // Defaults: mac production build
    process.env.VELLUM_DESKTOP_APP = "1";
    delete process.env.VELLUM_DEV;

    // Ensure tests run as if on macOS, even when CI is Linux
    setPlatform("darwin");
    listKeysFn.mockReturnValue([]);
    getKeyFn.mockReturnValue(undefined);
    setKeyFn.mockReturnValue(true);
    deleteKeyFn.mockReturnValue("deleted");
  });

  afterEach(() => {
    restorePlatform();
  });

  test("has correct migration id", () => {
    expect(migrateCredentialsToKeychainMigration.id).toBe(
      "015-migrate-credentials-to-keychain",
    );
  });

  test("skips when VELLUM_DESKTOP_APP is not set", async () => {
    delete process.env.VELLUM_DESKTOP_APP;

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    expect(execFileSyncFn).not.toHaveBeenCalled();
    expect(listKeysFn).not.toHaveBeenCalled();
  });

  test("skips when VELLUM_DESKTOP_APP is not '1'", async () => {
    process.env.VELLUM_DESKTOP_APP = "0";

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    expect(execFileSyncFn).not.toHaveBeenCalled();
  });

  test("skips when VELLUM_DEV=1", async () => {
    process.env.VELLUM_DEV = "1";

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    expect(execFileSyncFn).not.toHaveBeenCalled();
    expect(listKeysFn).not.toHaveBeenCalled();
  });

  test("no-ops when not on macOS", async () => {
    setPlatform("linux");

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    // Should not invoke the security CLI or touch encrypted store
    expect(execFileSyncFn).not.toHaveBeenCalled();
    expect(listKeysFn).not.toHaveBeenCalled();
  });

  test("no-ops when encrypted store has no keys", async () => {
    listKeysFn.mockReturnValue([]);

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    expect(execFileSyncFn).not.toHaveBeenCalled();
    expect(deleteKeyFn).not.toHaveBeenCalled();
  });

  test("successfully migrates keys from encrypted store to keychain", async () => {
    listKeysFn.mockReturnValue(["account-a", "account-b"]);
    getKeyFn.mockImplementation((account: string) => {
      if (account === "account-a") return "secret-a";
      if (account === "account-b") return "secret-b";
      return undefined;
    });
    // execFileSync succeeds (no throw) for add-generic-password
    execFileSyncFn.mockReturnValue("");

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    // Should have called security CLI add-generic-password for each key
    expect(execFileSyncFn).toHaveBeenCalledTimes(2);
    expect(execFileSyncFn).toHaveBeenCalledWith(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-s",
        "vellum-assistant",
        "-a",
        "account-a",
        "-w",
        "secret-a",
        "-U",
      ],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(execFileSyncFn).toHaveBeenCalledWith(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-s",
        "vellum-assistant",
        "-a",
        "account-b",
        "-w",
        "secret-b",
        "-U",
      ],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );

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
    execFileSyncFn.mockImplementation(
      (_file: string, args?: readonly string[]) => {
        if (args && args.includes("fail-key")) {
          throw new Error("security CLI error");
        }
        return "";
      },
    );

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    // fail-key should NOT have been deleted (security CLI failed)
    expect(deleteKeyFn).not.toHaveBeenCalledWith("fail-key");

    // ok-key should have been migrated and deleted
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
    execFileSyncFn.mockReturnValue("");

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    // ghost-key should not trigger security CLI or be deleted
    expect(deleteKeyFn).not.toHaveBeenCalledWith("ghost-key");

    // real-key should be migrated
    expect(deleteKeyFn).toHaveBeenCalledWith("real-key");
  });

  test("handles security CLI failure for individual keys", async () => {
    listKeysFn.mockReturnValue(["key-1"]);
    getKeyFn.mockReturnValue("secret-1");
    execFileSyncFn.mockImplementation(() => {
      throw new Error("security: SecKeychainItemCopyAccess: error");
    });

    await migrateCredentialsToKeychainMigration.run(WORKSPACE_DIR);

    // Should not delete when security CLI fails
    expect(deleteKeyFn).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // down() tests
  // ---------------------------------------------------------------------------

  describe("down()", () => {
    test("no-ops when not on macOS", async () => {
      setPlatform("linux");

      await migrateCredentialsToKeychainMigration.down!(WORKSPACE_DIR);

      expect(execFileSyncFn).not.toHaveBeenCalled();
      expect(setKeyFn).not.toHaveBeenCalled();
    });

    test("rolls back keychain credentials to encrypted store", async () => {
      // Mock dump-keychain to list accounts
      const dumpOutput = [
        'keychain: "/Users/test/Library/Keychains/login.keychain-db"',
        'class: "genp"',
        '    "svce"<blob>="vellum-assistant"',
        '    "acct"<blob>="cred-x"',
        'class: "genp"',
        '    "svce"<blob>="vellum-assistant"',
        '    "acct"<blob>="cred-y"',
        'class: "genp"',
        '    "svce"<blob>="other-service"',
        '    "acct"<blob>="unrelated"',
      ].join("\n");

      execFileSyncFn.mockImplementation(
        (_file: string, args?: readonly string[]) => {
          if (args && args[0] === "dump-keychain") {
            return dumpOutput;
          }
          if (args && args[0] === "find-generic-password") {
            const accountIdx = args.indexOf("-a");
            const account = accountIdx >= 0 ? args[accountIdx + 1] : "";
            if (account === "cred-x") return "value-x\n";
            if (account === "cred-y") return "value-y\n";
            throw new Error("not found");
          }
          // delete-generic-password succeeds
          return "";
        },
      );

      setKeyFn.mockReturnValue(true);

      await migrateCredentialsToKeychainMigration.down!(WORKSPACE_DIR);

      // Should have written both credentials to encrypted store
      expect(setKeyFn).toHaveBeenCalledTimes(2);
      expect(setKeyFn).toHaveBeenCalledWith("cred-x", "value-x");
      expect(setKeyFn).toHaveBeenCalledWith("cred-y", "value-y");

      // Should have called delete-generic-password for both
      const deleteCalls = execFileSyncFn.mock.calls.filter(
        (call) =>
          Array.isArray(call[1]) && call[1][0] === "delete-generic-password",
      );
      expect(deleteCalls.length).toBe(2);
    });

    test("continues on individual key failure during rollback", async () => {
      const dumpOutput = [
        'class: "genp"',
        '    "svce"<blob>="vellum-assistant"',
        '    "acct"<blob>="fail-cred"',
        'class: "genp"',
        '    "svce"<blob>="vellum-assistant"',
        '    "acct"<blob>="ok-cred"',
      ].join("\n");

      execFileSyncFn.mockImplementation(
        (_file: string, args?: readonly string[]) => {
          if (args && args[0] === "dump-keychain") {
            return dumpOutput;
          }
          if (args && args[0] === "find-generic-password") {
            const accountIdx = args.indexOf("-a");
            const account = accountIdx >= 0 ? args[accountIdx + 1] : "";
            if (account === "fail-cred") {
              throw new Error("keychain item not found");
            }
            if (account === "ok-cred") return "ok-value\n";
            throw new Error("not found");
          }
          return "";
        },
      );

      setKeyFn.mockReturnValue(true);

      await migrateCredentialsToKeychainMigration.down!(WORKSPACE_DIR);

      // fail-cred should NOT have been written to encrypted store
      expect(setKeyFn).not.toHaveBeenCalledWith("fail-cred", expect.anything());

      // ok-cred should have been rolled back
      expect(setKeyFn).toHaveBeenCalledWith("ok-cred", "ok-value");
    });
  });
});
