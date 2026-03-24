import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

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

const setKeyFn = mock((_account: string, _value: string): boolean => true);

const listKeysFn = mock((): string[] => []);
const getKeyFn = mock((_account: string): string | undefined => undefined);
const deleteKeyFn = mock(
  (_account: string): "deleted" | "not-found" | "error" => "deleted",
);

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
//
// The logger is mocked with a silent Proxy to suppress pino output in tests.
// node:child_process is mocked to control security CLI behavior.
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
  setKey: setKeyFn,
  listKeys: listKeysFn,
  getKey: getKeyFn,
  deleteKey: deleteKeyFn,
}));

// Import after mocking
import { migrateCredentialsFromKeychainMigration } from "../workspace/migrations/016-migrate-credentials-from-keychain.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/mock-home/.vellum/workspace";

/**
 * Build a dump-keychain output block for the given accounts.
 */
function buildDumpKeychainOutput(accounts: string[]): string {
  return accounts
    .map(
      (acct) =>
        `class: "genp"\n    0x00000007 <blob>="vellum-assistant"\n    "svce"<blob>="vellum-assistant"\n    "acct"<blob>="${acct}"`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("016-migrate-credentials-from-keychain migration", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    execFileSyncFn.mockClear();
    setKeyFn.mockClear();
    listKeysFn.mockClear();
    getKeyFn.mockClear();
    deleteKeyFn.mockClear();

    // Defaults: mac production build
    process.env.VELLUM_DESKTOP_APP = "1";
    delete process.env.VELLUM_DEV;

    // Ensure platform is darwin for keychain availability
    Object.defineProperty(process, "platform", { value: "darwin" });

    setKeyFn.mockReturnValue(true);
    listKeysFn.mockReturnValue([]);
    getKeyFn.mockReturnValue(undefined);
    deleteKeyFn.mockReturnValue("deleted");
  });

  // Restore platform after all tests
  afterAll(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  test("has correct migration id", () => {
    expect(migrateCredentialsFromKeychainMigration.id).toBe(
      "016-migrate-credentials-from-keychain",
    );
  });

  test("skips when VELLUM_DESKTOP_APP is not set", async () => {
    delete process.env.VELLUM_DESKTOP_APP;

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    expect(execFileSyncFn).not.toHaveBeenCalled();
    expect(setKeyFn).not.toHaveBeenCalled();
  });

  test("skips when VELLUM_DESKTOP_APP is not '1'", async () => {
    process.env.VELLUM_DESKTOP_APP = "0";

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    expect(execFileSyncFn).not.toHaveBeenCalled();
  });

  test("skips when VELLUM_DEV=1", async () => {
    process.env.VELLUM_DEV = "1";

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    expect(execFileSyncFn).not.toHaveBeenCalled();
    expect(setKeyFn).not.toHaveBeenCalled();
  });

  test("no-ops when not on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    expect(execFileSyncFn).not.toHaveBeenCalled();
    expect(setKeyFn).not.toHaveBeenCalled();
  });

  test("no-ops when keychain has no accounts", async () => {
    // dump-keychain returns empty output (no vellum-assistant entries)
    execFileSyncFn.mockReturnValue("");

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    expect(setKeyFn).not.toHaveBeenCalled();
  });

  test("copies credentials from keychain to encrypted store and deletes from keychain", async () => {
    execFileSyncFn.mockImplementation(
      (file: string, args?: readonly string[]) => {
        const cmd = args?.[0];

        if (cmd === "dump-keychain") {
          return buildDumpKeychainOutput(["account-a", "account-b"]);
        }

        if (cmd === "find-generic-password") {
          const accountIdx = args?.indexOf("-a");
          const account =
            accountIdx !== undefined && accountIdx >= 0
              ? args?.[accountIdx + 1]
              : undefined;
          if (account === "account-a") return "secret-a\n";
          if (account === "account-b") return "secret-b\n";
          throw new Error("not found");
        }

        if (cmd === "delete-generic-password") {
          return "";
        }

        return "";
      },
    );
    setKeyFn.mockReturnValue(true);

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    // Should have written each key to encrypted store
    expect(setKeyFn).toHaveBeenCalledTimes(2);
    expect(setKeyFn).toHaveBeenCalledWith("account-a", "secret-a");
    expect(setKeyFn).toHaveBeenCalledWith("account-b", "secret-b");

    // Should have called delete-generic-password for each key
    const deleteCalls = execFileSyncFn.mock.calls.filter(
      (call) => (call[1] as string[])?.[0] === "delete-generic-password",
    );
    expect(deleteCalls).toHaveLength(2);
  });

  test("skips key when security CLI returns nothing", async () => {
    execFileSyncFn.mockImplementation(
      (file: string, args?: readonly string[]) => {
        const cmd = args?.[0];

        if (cmd === "dump-keychain") {
          return buildDumpKeychainOutput(["ghost-key", "real-key"]);
        }

        if (cmd === "find-generic-password") {
          const accountIdx = args?.indexOf("-a");
          const account =
            accountIdx !== undefined && accountIdx >= 0
              ? args?.[accountIdx + 1]
              : undefined;
          if (account === "ghost-key") throw new Error("not found");
          if (account === "real-key") return "real-secret\n";
          throw new Error("not found");
        }

        if (cmd === "delete-generic-password") {
          return "";
        }

        return "";
      },
    );

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    // ghost-key should not be written
    expect(setKeyFn).not.toHaveBeenCalledWith("ghost-key", expect.anything());

    // real-key should be migrated
    expect(setKeyFn).toHaveBeenCalledWith("real-key", "real-secret");
  });

  test("skips key when setKey fails and does not delete from keychain", async () => {
    execFileSyncFn.mockImplementation(
      (file: string, args?: readonly string[]) => {
        const cmd = args?.[0];

        if (cmd === "dump-keychain") {
          return buildDumpKeychainOutput(["fail-key", "ok-key"]);
        }

        if (cmd === "find-generic-password") {
          const accountIdx = args?.indexOf("-a");
          const account =
            accountIdx !== undefined && accountIdx >= 0
              ? args?.[accountIdx + 1]
              : undefined;
          if (account === "fail-key") return "fail-secret\n";
          if (account === "ok-key") return "ok-secret\n";
          throw new Error("not found");
        }

        if (cmd === "delete-generic-password") {
          return "";
        }

        return "";
      },
    );
    setKeyFn.mockImplementation((account: string) => {
      if (account === "fail-key") return false;
      return true;
    });

    await migrateCredentialsFromKeychainMigration.run(WORKSPACE_DIR);

    // fail-key should NOT have triggered delete (setKey failed)
    const deleteCalls = execFileSyncFn.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return (
        args?.[0] === "delete-generic-password" && args?.includes("fail-key")
      );
    });
    expect(deleteCalls).toHaveLength(0);

    // ok-key should have been migrated and deleted
    expect(setKeyFn).toHaveBeenCalledWith("ok-key", "ok-secret");
    const okDeleteCalls = execFileSyncFn.mock.calls.filter((call) => {
      const args = call[1] as string[] | undefined;
      return (
        args?.[0] === "delete-generic-password" && args?.includes("ok-key")
      );
    });
    expect(okDeleteCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // down() path — encrypted store -> keychain rollback
  // -------------------------------------------------------------------------

  describe("down()", () => {
    test("skips when VELLUM_DESKTOP_APP is not set", async () => {
      delete process.env.VELLUM_DESKTOP_APP;

      await migrateCredentialsFromKeychainMigration.down!(WORKSPACE_DIR);

      expect(execFileSyncFn).not.toHaveBeenCalled();
    });

    test("skips when VELLUM_DEV=1", async () => {
      process.env.VELLUM_DEV = "1";

      await migrateCredentialsFromKeychainMigration.down!(WORKSPACE_DIR);

      expect(execFileSyncFn).not.toHaveBeenCalled();
    });

    test("no-ops when not on macOS", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });

      await migrateCredentialsFromKeychainMigration.down!(WORKSPACE_DIR);

      expect(execFileSyncFn).not.toHaveBeenCalled();
    });

    test("rolls back credentials from encrypted store to keychain", async () => {
      listKeysFn.mockReturnValue(["key-a", "key-b"]);
      getKeyFn.mockImplementation((account: string) => {
        if (account === "key-a") return "secret-a";
        if (account === "key-b") return "secret-b";
        return undefined;
      });

      // Mock keychainSet (add-generic-password) to succeed
      execFileSyncFn.mockReturnValue("");

      await migrateCredentialsFromKeychainMigration.down!(WORKSPACE_DIR);

      // Should have called add-generic-password for each key
      const setCalls = execFileSyncFn.mock.calls.filter(
        (call) => (call[1] as string[])?.[0] === "add-generic-password",
      );
      expect(setCalls).toHaveLength(2);

      // Should have deleted each key from encrypted store
      expect(deleteKeyFn).toHaveBeenCalledTimes(2);
      expect(deleteKeyFn).toHaveBeenCalledWith("key-a");
      expect(deleteKeyFn).toHaveBeenCalledWith("key-b");
    });

    test("skips key when getKey returns undefined during rollback", async () => {
      listKeysFn.mockReturnValue(["missing-key", "good-key"]);
      getKeyFn.mockImplementation((account: string) => {
        if (account === "missing-key") return undefined;
        if (account === "good-key") return "good-secret";
        return undefined;
      });
      execFileSyncFn.mockReturnValue("");

      await migrateCredentialsFromKeychainMigration.down!(WORKSPACE_DIR);

      // missing-key should not trigger add-generic-password
      // good-key should be rolled back
      const setCalls = execFileSyncFn.mock.calls.filter(
        (call) => (call[1] as string[])?.[0] === "add-generic-password",
      );
      expect(setCalls).toHaveLength(1);
      expect(deleteKeyFn).toHaveBeenCalledWith("good-key");
      expect(deleteKeyFn).not.toHaveBeenCalledWith("missing-key");
    });

    test("skips key when keychainSet fails during rollback", async () => {
      listKeysFn.mockReturnValue(["fail-key", "ok-key"]);
      getKeyFn.mockImplementation((account: string) => {
        if (account === "fail-key") return "fail-secret";
        if (account === "ok-key") return "ok-secret";
        return undefined;
      });

      execFileSyncFn.mockImplementation(
        (file: string, args?: readonly string[]) => {
          const cmd = args?.[0];
          if (cmd === "add-generic-password") {
            const accountIdx = args?.indexOf("-a");
            const account =
              accountIdx !== undefined && accountIdx >= 0
                ? args?.[accountIdx + 1]
                : undefined;
            if (account === "fail-key")
              throw new Error("keychain write failed");
            return "";
          }
          return "";
        },
      );

      await migrateCredentialsFromKeychainMigration.down!(WORKSPACE_DIR);

      // fail-key should NOT have been deleted from encrypted store
      expect(deleteKeyFn).not.toHaveBeenCalledWith("fail-key");

      // ok-key should have been rolled back
      expect(deleteKeyFn).toHaveBeenCalledWith("ok-key");
      expect(deleteKeyFn).toHaveBeenCalledTimes(1);
    });
  });
});
