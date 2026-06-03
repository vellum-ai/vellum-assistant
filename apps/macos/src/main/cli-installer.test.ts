import { afterEach, describe, expect, mock, test } from "bun:test";

import { FakeChild } from "./test-helpers";

// --- Mocks ---
// Must be installed before the `await import` of the module under test so
// the mocked module graph is in place when `cli-installer.ts` is evaluated.
// See `commands.test.ts` for the ordering rationale.

const userDataPath = "/mock/userData";
const mockResourcesPath = "/mock/resources";

// `process.resourcesPath` is only defined inside a packaged Electron app.
// Set a known value so `path.join(process.resourcesPath, "bun")` works.
Object.defineProperty(process, "resourcesPath", { value: mockResourcesPath, writable: true });

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return userDataPath;
      return "/tmp";
    },
    isPackaged: true,
  },
}));

// Track fs calls so tests can assert on them.
let existsSyncReturn = false;
let readdirSyncReturn: Array<{ name: string; isDirectory: () => boolean }> = [];
let readdirSyncError: Error | null = null;
const mkdirSyncCalls: Array<[string, object]> = [];
const rmSyncCalls: Array<[string, object]> = [];

mock.module("node:fs", () => ({
  existsSync: () => existsSyncReturn,
  mkdirSync: (p: string, opts: object) => {
    mkdirSyncCalls.push([p, opts]);
  },
  readdirSync: (_p: string, _opts?: object) => {
    if (readdirSyncError) throw readdirSyncError;
    return readdirSyncReturn;
  },
  rmSync: (p: string, opts: object) => {
    rmSyncCalls.push([p, opts]);
  },
}));

let lastChild: FakeChild;
const spawnCalls: Array<[string, string[], object]> = [];

mock.module("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: object) => {
    spawnCalls.push([cmd, args, opts]);
    lastChild = new FakeChild();
    return lastChild;
  },
}));

/** Helper to build fake Dirent entries for the readdirSync mock. */
const dirEntry = (name: string) => ({ name, isDirectory: () => true });

const {
  PINNED_CLI_VERSION,
  getCliInstallDir,
  getCliBinPath,
  getBundledBunPath,
  isCliInstalled,
  ensureCliInstalled,
  cleanupOldVersions,
  _resetInstallLock,
} = await import("./cli-installer");

afterEach(() => {
  existsSyncReturn = false;
  readdirSyncReturn.length = 0;
  readdirSyncError = null;
  mkdirSyncCalls.length = 0;
  rmSyncCalls.length = 0;
  spawnCalls.length = 0;
  _resetInstallLock();
});

// --- Path helpers ---

describe("getCliInstallDir", () => {
  test("returns <userData>/cli/<version>", () => {
    expect(getCliInstallDir()).toBe(
      `${userDataPath}/cli/${PINNED_CLI_VERSION}`,
    );
  });
});

describe("getCliBinPath", () => {
  test("returns <installDir>/node_modules/.bin/vellum", () => {
    expect(getCliBinPath()).toBe(
      `${userDataPath}/cli/${PINNED_CLI_VERSION}/node_modules/.bin/vellum`,
    );
  });
});

describe("getBundledBunPath", () => {
  test("returns <resourcesPath>/bun", () => {
    expect(getBundledBunPath()).toBe(`${mockResourcesPath}/bun`);
  });
});

// --- isCliInstalled ---

describe("isCliInstalled", () => {
  test("returns true when the bin path exists", () => {
    existsSyncReturn = true;
    expect(isCliInstalled()).toBe(true);
  });

  test("returns false when the bin path is missing", () => {
    existsSyncReturn = false;
    expect(isCliInstalled()).toBe(false);
  });
});

// --- ensureCliInstalled ---

describe("ensureCliInstalled", () => {
  test("skips install when already installed", async () => {
    existsSyncReturn = true;
    await ensureCliInstalled();
    expect(spawnCalls).toHaveLength(0);
  });

  test("spawns bun add with correct args and cwd", async () => {
    existsSyncReturn = false;

    const promise = ensureCliInstalled();

    // Let the spawn resolve successfully.
    lastChild.emit("close", 0);
    await promise;

    expect(spawnCalls).toHaveLength(1);
    const [cmd, args, opts] = spawnCalls[0];
    expect(cmd).toBe(`${mockResourcesPath}/bun`);
    expect(args).toEqual(["add", `vellum@${PINNED_CLI_VERSION}`]);
    expect(opts).toEqual({
      cwd: `${userDataPath}/cli/${PINNED_CLI_VERSION}`,
    });
  });

  test("creates the install directory before spawning", async () => {
    existsSyncReturn = false;

    const promise = ensureCliInstalled();
    lastChild.emit("close", 0);
    await promise;

    expect(mkdirSyncCalls).toHaveLength(1);
    const [dir, opts] = mkdirSyncCalls[0];
    expect(dir).toBe(`${userDataPath}/cli/${PINNED_CLI_VERSION}`);
    expect(opts).toEqual({ recursive: true });
  });

  test("throws on non-zero exit code", async () => {
    existsSyncReturn = false;

    const promise = ensureCliInstalled();
    lastChild.stderr.emit("data", Buffer.from("install failed"));
    lastChild.emit("close", 1);

    await expect(promise).rejects.toThrow(/CLI install failed/);
    await expect(promise).rejects.toThrow(/exit code 1/);
  });

  test("throws on spawn error", async () => {
    existsSyncReturn = false;

    const promise = ensureCliInstalled();
    lastChild.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toThrow(/Failed to spawn bun/);
    await expect(promise).rejects.toThrow(/ENOENT/);
  });

  test("calls cleanupOldVersions after successful install", async () => {
    existsSyncReturn = false;
    readdirSyncReturn = [dirEntry("0.8.5"), dirEntry(PINNED_CLI_VERSION)];

    const promise = ensureCliInstalled();
    lastChild.emit("close", 0);
    await promise;

    // cleanupOldVersions should have been called — verify it tried to
    // remove 0.8.5 but not the pinned version.
    expect(rmSyncCalls.length).toBeGreaterThanOrEqual(1);
    const removedPaths = rmSyncCalls.map(([p]) => p);
    expect(removedPaths).toContain(`${userDataPath}/cli/0.8.5`);
    const pinnedPath = `${userDataPath}/cli/${PINNED_CLI_VERSION}`;
    expect(removedPaths).not.toContain(pinnedPath);
  });

  test("concurrent calls share a single install", async () => {
    existsSyncReturn = false;

    const p1 = ensureCliInstalled();
    const p2 = ensureCliInstalled();

    // Only one spawn should have occurred.
    expect(spawnCalls).toHaveLength(1);

    lastChild.emit("close", 0);
    await Promise.all([p1, p2]);
  });

  test("failed install resets the lock so retries are possible", async () => {
    existsSyncReturn = false;

    const p1 = ensureCliInstalled();
    lastChild.stderr.emit("data", Buffer.from("disk full"));
    lastChild.emit("close", 1);

    await expect(p1).rejects.toThrow(/CLI install failed/);

    // Second attempt should spawn a new process.
    const p2 = ensureCliInstalled();
    expect(spawnCalls).toHaveLength(2);
    lastChild.emit("close", 0);
    await p2;
  });
});

// --- cleanupOldVersions ---

describe("cleanupOldVersions", () => {
  test("deletes sibling directories that are not the pinned version", () => {
    readdirSyncReturn = [dirEntry("0.8.5"), dirEntry(PINNED_CLI_VERSION)];

    cleanupOldVersions();

    const removedPaths = rmSyncCalls.map(([p]) => p);
    expect(removedPaths).toContain(`${userDataPath}/cli/0.8.5`);
    expect(removedPaths).not.toContain(
      `${userDataPath}/cli/${PINNED_CLI_VERSION}`,
    );
  });

  test("passes recursive and force options to rmSync", () => {
    readdirSyncReturn = [dirEntry("0.8.5")];

    cleanupOldVersions();

    expect(rmSyncCalls).toHaveLength(1);
    expect(rmSyncCalls[0][1]).toEqual({ recursive: true, force: true });
  });

  test("tolerates a missing cli directory (ENOENT)", () => {
    const enoent = new Error("ENOENT: no such file or directory");
    (enoent as NodeJS.ErrnoException).code = "ENOENT";
    readdirSyncError = enoent;

    // Should not throw.
    expect(() => cleanupOldVersions()).not.toThrow();
  });

  test("tolerates other read errors without propagating", () => {
    readdirSyncError = new Error("EPERM: permission denied");

    expect(() => cleanupOldVersions()).not.toThrow();
  });
});
