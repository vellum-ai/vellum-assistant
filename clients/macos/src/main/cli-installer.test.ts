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

mock.module("./logger", () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));

// Track fs calls so tests can assert on them.
// Per-path overrides for existsSync. Falls back to `existsSyncDefault`.
let existsSyncDefault = false;
const existsSyncByPath: Record<string, boolean> = {};
let readdirSyncReturn: Array<{ name: string; isDirectory: () => boolean }> = [];
let readdirSyncError: Error | null = null;
let writeFileSyncError: Error | null = null;
let renameSyncError: Error | null = null;
const chmodSyncCalls: Array<[string, number]> = [];
const mkdirSyncCalls: Array<[string, object]> = [];
const rmSyncCalls: Array<[string, object]> = [];
const copyFileSyncCalls: Array<[string, string]> = [];
const writeFileSyncCalls: Array<[string, string]> = [];
const renameSyncCalls: Array<[string, string]> = [];
// Interleaved fs call log for ordering assertions across mocks.
const fsCallOrder: string[] = [];

mock.module("node:fs", () => ({
  chmodSync: (p: string, mode: number) => {
    chmodSyncCalls.push([p, mode]);
    fsCallOrder.push(`chmodSync:${p}`);
  },
  copyFileSync: (src: string, dst: string) => {
    copyFileSyncCalls.push([src, dst]);
  },
  existsSync: (p: string) =>
    p in existsSyncByPath ? existsSyncByPath[p] : existsSyncDefault,
  mkdirSync: (p: string, opts: object) => {
    mkdirSyncCalls.push([p, opts]);
  },
  readdirSync: (_p: string, _opts?: object) => {
    if (readdirSyncError) throw readdirSyncError;
    return readdirSyncReturn;
  },
  renameSync: (src: string, dst: string) => {
    if (renameSyncError) throw renameSyncError;
    renameSyncCalls.push([src, dst]);
    fsCallOrder.push(`renameSync:${dst}`);
  },
  rmSync: (p: string, opts: object) => {
    rmSyncCalls.push([p, opts]);
    fsCallOrder.push(`rmSync:${p}`);
  },
  writeFileSync: (p: string, content: string) => {
    if (writeFileSyncError) throw writeFileSyncError;
    writeFileSyncCalls.push([p, content]);
    fsCallOrder.push(`writeFileSync:${p}`);
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
  getCliLocatorPath,
  shQuote,
  writeFileAtomicSync,
  writeCliLocator,
  migrateStaleInstallDir,
  buildInstallEnv,
  isCliInstalled,
  ensureCliInstalled,
  cleanupOldVersions,
  _resetInstallLock,
} = await import("./cli-installer");

const seedPkgPath = `${mockResourcesPath}/cli-lockfile/package.json`;
const seedLockPath = `${mockResourcesPath}/cli-lockfile/bun.lock`;
const locatorPath = `${userDataPath}/cli/locator.sh`;
// Default (unpinned) install dir when nothing exists yet.
const latestInstallDir = `${userDataPath}/cli/latest`;
const cliBinPath = `${latestInstallDir}/node_modules/.bin/vellum`;
/** Bin path for an install dir under `cli/`. */
const binPathFor = (name: string) =>
  `${userDataPath}/cli/${name}/node_modules/.bin/vellum`;

afterEach(() => {
  existsSyncDefault = false;
  for (const key of Object.keys(existsSyncByPath)) delete existsSyncByPath[key];
  readdirSyncReturn.length = 0;
  readdirSyncError = null;
  writeFileSyncError = null;
  renameSyncError = null;
  chmodSyncCalls.length = 0;
  mkdirSyncCalls.length = 0;
  rmSyncCalls.length = 0;
  copyFileSyncCalls.length = 0;
  writeFileSyncCalls.length = 0;
  renameSyncCalls.length = 0;
  fsCallOrder.length = 0;
  spawnCalls.length = 0;
  _resetInstallLock();
});

// --- Path helpers ---

describe("PINNED_CLI_VERSION", () => {
  test("is empty by default (unpinned: float to latest)", () => {
    expect(PINNED_CLI_VERSION).toBe("");
  });
});

describe("getCliInstallDir", () => {
  test("unpinned with no existing install → cli/latest", () => {
    readdirSyncReturn = [];
    expect(getCliInstallDir()).toBe(latestInstallDir);
  });

  test("unpinned adopts the newest existing install", () => {
    readdirSyncReturn = [dirEntry("0.8.5"), dirEntry("0.10.0")];
    existsSyncByPath[binPathFor("0.8.5")] = true;
    existsSyncByPath[binPathFor("0.10.0")] = true;

    expect(getCliInstallDir()).toBe(`${userDataPath}/cli/0.10.0`);
  });

  test("unpinned prefers an existing cli/latest over a versioned dir", () => {
    readdirSyncReturn = [dirEntry("0.9.0"), dirEntry("latest")];
    existsSyncByPath[binPathFor("0.9.0")] = true;
    existsSyncByPath[cliBinPath] = true;

    expect(getCliInstallDir()).toBe(latestInstallDir);
  });
});

describe("getCliBinPath", () => {
  test("returns <installDir>/node_modules/.bin/vellum", () => {
    readdirSyncReturn = [];
    expect(getCliBinPath()).toBe(cliBinPath);
  });
});

describe("getBundledBunPath", () => {
  test("returns <resourcesPath>/bun", () => {
    expect(getBundledBunPath()).toBe(`${mockResourcesPath}/bun`);
  });
});

describe("getCliLocatorPath", () => {
  test("returns <userData>/cli/locator.sh", () => {
    expect(getCliLocatorPath()).toBe(locatorPath);
  });
});

// --- shQuote ---

describe("shQuote", () => {
  test("wraps a plain value in single quotes", () => {
    expect(shQuote("/usr/local/bin/bun")).toBe("'/usr/local/bin/bun'");
  });

  test("escapes embedded single quotes", () => {
    expect(shQuote("/Users/o'brien/bin")).toBe("'/Users/o'\\''brien/bin'");
  });
});

// --- writeFileAtomicSync ---

describe("writeFileAtomicSync", () => {
  test("writes the temp file then renames it into place", () => {
    writeFileAtomicSync("/x/file", "content");

    expect(writeFileSyncCalls).toEqual([["/x/file.tmp", "content"]]);
    expect(renameSyncCalls).toEqual([["/x/file.tmp", "/x/file"]]);
    expect(chmodSyncCalls).toHaveLength(0);
  });

  test("chmods the temp file before the rename when a mode is given", () => {
    writeFileAtomicSync("/x/file", "content", 0o755);

    expect(chmodSyncCalls).toEqual([["/x/file.tmp", 0o755]]);
    expect(fsCallOrder).toEqual([
      "writeFileSync:/x/file.tmp",
      "chmodSync:/x/file.tmp",
      "renameSync:/x/file",
    ]);
  });
});

// --- writeCliLocator ---

describe("writeCliLocator", () => {
  test("writes the temp file then renames it over locator.sh", () => {
    existsSyncByPath[cliBinPath] = true;

    writeCliLocator();

    expect(mkdirSyncCalls).toContainEqual([
      `${userDataPath}/cli`,
      { recursive: true },
    ]);
    expect(writeFileSyncCalls).toHaveLength(1);
    expect(writeFileSyncCalls[0][0]).toBe(`${locatorPath}.tmp`);
    expect(renameSyncCalls).toEqual([[`${locatorPath}.tmp`, locatorPath]]);
  });

  test("content contains both single-quoted paths", () => {
    existsSyncByPath[cliBinPath] = true;

    writeCliLocator();

    const content = writeFileSyncCalls[0][1];
    expect(content).toContain(`VELLUM_BUN='${mockResourcesPath}/bun'\n`);
    expect(content).toContain(`VELLUM_CLI_BIN='${cliBinPath}'\n`);
    expect(content.endsWith("\n")).toBe(true);
    expect(content.startsWith("#!")).toBe(false);
  });

  test("swallows write errors", () => {
    existsSyncByPath[cliBinPath] = true;
    writeFileSyncError = new Error("EACCES: permission denied");

    expect(() => writeCliLocator()).not.toThrow();
    expect(renameSyncCalls).toHaveLength(0);
  });

  test("no-ops when the CLI bin is not installed", () => {
    existsSyncDefault = false;

    writeCliLocator();

    expect(writeFileSyncCalls).toHaveLength(0);
    expect(renameSyncCalls).toHaveLength(0);
  });
});

// --- migrateStaleInstallDir ---

describe("migrateStaleInstallDir", () => {
  test("renames an adopted versioned dir to cli/latest", () => {
    readdirSyncReturn = [dirEntry("0.9.0")];
    existsSyncByPath[binPathFor("0.9.0")] = true;

    migrateStaleInstallDir();

    // Clears any partial cli/latest, then renames the stale dir into place.
    expect(rmSyncCalls.map(([p]) => p)).toContain(latestInstallDir);
    expect(renameSyncCalls).toContainEqual([
      `${userDataPath}/cli/0.9.0`,
      latestInstallDir,
    ]);
  });

  test("no-ops when cli/latest already holds the install", () => {
    readdirSyncReturn = [dirEntry("0.9.0"), dirEntry("latest")];
    existsSyncByPath[binPathFor("0.9.0")] = true;
    existsSyncByPath[cliBinPath] = true;

    migrateStaleInstallDir();

    expect(renameSyncCalls).toHaveLength(0);
    expect(rmSyncCalls).toHaveLength(0);
  });

  test("no-ops when nothing is installed", () => {
    readdirSyncReturn = [];

    migrateStaleInstallDir();

    expect(renameSyncCalls).toHaveLength(0);
    expect(rmSyncCalls).toHaveLength(0);
  });

  test("swallows rename errors", () => {
    readdirSyncReturn = [dirEntry("0.9.0")];
    existsSyncByPath[binPathFor("0.9.0")] = true;
    renameSyncError = new Error("EXDEV: cross-device link");

    expect(() => migrateStaleInstallDir()).not.toThrow();
  });
});

// --- isCliInstalled ---

describe("isCliInstalled", () => {
  test("returns true when the bin path exists", () => {
    existsSyncDefault = true;
    expect(isCliInstalled()).toBe(true);
  });

  test("returns false when the bin path is missing", () => {
    existsSyncDefault = false;
    expect(isCliInstalled()).toBe(false);
  });
});

// --- ensureCliInstalled ---

describe("ensureCliInstalled", () => {
  test("skips install but refreshes the locator when already installed", async () => {
    existsSyncDefault = true;

    await ensureCliInstalled();

    expect(spawnCalls).toHaveLength(0);
    expect(renameSyncCalls).toEqual([[`${locatorPath}.tmp`, locatorPath]]);
  });

  test("a throwing locator write does not reject", async () => {
    existsSyncDefault = true;
    writeFileSyncError = new Error("EROFS: read-only file system");

    await expect(ensureCliInstalled()).resolves.toBeUndefined();
  });

  test("adopts an existing install and heals its stale versioned name", async () => {
    existsSyncDefault = false;
    readdirSyncReturn = [dirEntry("0.9.0")];
    existsSyncByPath[binPathFor("0.9.0")] = true;

    await ensureCliInstalled();

    // No reinstall — the contents are already bumped; only the name is stale.
    expect(spawnCalls).toHaveLength(0);
    // The stale versioned dir is renamed to the canonical cli/latest so the
    // locator path stops misleading debugging (LUM-2648)...
    expect(renameSyncCalls).toContainEqual([
      `${userDataPath}/cli/0.9.0`,
      latestInstallDir,
    ]);
    // ...and the locator is still refreshed.
    expect(renameSyncCalls).toContainEqual([`${locatorPath}.tmp`, locatorPath]);
  });

  test("fresh unpinned install spawns bun add vellum@latest", async () => {
    existsSyncDefault = false;

    const promise = ensureCliInstalled();

    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);
    await promise;

    expect(spawnCalls).toHaveLength(1);
    const [cmd, args, opts] = spawnCalls[0];
    expect(cmd).toBe(`${mockResourcesPath}/bun`);
    expect(args).toEqual(["add", "vellum@latest", "--ignore-scripts"]);
    expect((opts as { cwd: string }).cwd).toBe(latestInstallDir);
    const env = (opts as { env: NodeJS.ProcessEnv }).env;
    expect(env).toBeDefined();
    expect(env!.PATH).toContain("/opt/homebrew/bin");
    expect(env!.PATH).toContain("/usr/local/bin");
  });

  test("offline fallback: latest fails → seeded frozen-lockfile retry", async () => {
    existsSyncDefault = false;
    existsSyncByPath[seedPkgPath] = true;
    existsSyncByPath[seedLockPath] = true;

    const promise = ensureCliInstalled();

    // `bun add vellum@latest` fails (e.g. registry unreachable).
    lastChild.stderr.emit("data", Buffer.from("network error"));
    lastChild.emit("close", 1);
    // The retry spawns against the seeded frozen lockfile.
    await Promise.resolve();
    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);
    await promise;

    expect(copyFileSyncCalls).toHaveLength(2);
    expect(copyFileSyncCalls[0][0]).toBe(seedPkgPath);
    expect(copyFileSyncCalls[1][0]).toBe(seedLockPath);

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0][1]).toEqual(["add", "vellum@latest", "--ignore-scripts"]);
    expect(spawnCalls[1][1]).toEqual([
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
  });

  test("offline fallback rethrows when no seed lockfile is available", async () => {
    existsSyncDefault = false;

    const promise = ensureCliInstalled();
    lastChild.stderr.emit("data", Buffer.from("network error"));
    lastChild.emit("close", 1);

    await expect(promise).rejects.toThrow(/Package install failed/);
    // No seed → no frozen-lockfile retry.
    expect(spawnCalls).toHaveLength(1);
  });

  test("creates the install directory before spawning", async () => {
    existsSyncDefault = false;

    const promise = ensureCliInstalled();
    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);
    await promise;

    const [dir, opts] = mkdirSyncCalls[0];
    expect(dir).toBe(latestInstallDir);
    expect(opts).toEqual({ recursive: true });
  });

  test("fresh install writes the locator before cleanupOldVersions", async () => {
    existsSyncDefault = false;
    readdirSyncReturn = [dirEntry("0.8.5")];

    const promise = ensureCliInstalled();
    // Simulate bun creating the bin so the locator write proceeds.
    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);
    await promise;

    const renameIndex = fsCallOrder.indexOf(`renameSync:${locatorPath}`);
    const rmIndex = fsCallOrder.indexOf(`rmSync:${userDataPath}/cli/0.8.5`);
    expect(renameIndex).toBeGreaterThanOrEqual(0);
    expect(rmIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeLessThan(rmIndex);
  });

  test("a throwing locator write does not reject a fresh install", async () => {
    existsSyncDefault = false;
    writeFileSyncError = new Error("EACCES: permission denied");

    const promise = ensureCliInstalled();
    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);

    await expect(promise).resolves.toBeUndefined();
  });

  test("throws on non-zero exit code", async () => {
    existsSyncDefault = false;

    const promise = ensureCliInstalled();
    lastChild.stderr.emit("data", Buffer.from("install failed"));
    lastChild.emit("close", 1);

    await expect(promise).rejects.toThrow(/Package install failed/);
    await expect(promise).rejects.toThrow(/exit code 1/);
  });

  test("throws on spawn error", async () => {
    existsSyncDefault = false;

    const promise = ensureCliInstalled();
    lastChild.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toThrow(/Failed to spawn bun/);
    await expect(promise).rejects.toThrow(/ENOENT/);
  });

  test("calls cleanupOldVersions after successful install", async () => {
    existsSyncDefault = false;
    readdirSyncReturn = [dirEntry("0.8.5"), dirEntry("latest")];

    const promise = ensureCliInstalled();
    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);
    await promise;

    // cleanupOldVersions should have been called — verify it tried to
    // remove 0.8.5 but not the current (latest) install dir.
    expect(rmSyncCalls.length).toBeGreaterThanOrEqual(1);
    const removedPaths = rmSyncCalls.map(([p]) => p);
    expect(removedPaths).toContain(`${userDataPath}/cli/0.8.5`);
    expect(removedPaths).not.toContain(latestInstallDir);
  });

  test("concurrent calls share a single install", async () => {
    existsSyncDefault = false;

    const p1 = ensureCliInstalled();
    const p2 = ensureCliInstalled();

    // Only one spawn should have occurred.
    expect(spawnCalls).toHaveLength(1);

    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);
    await Promise.all([p1, p2]);
  });

  test("failed install resets the lock so retries are possible", async () => {
    existsSyncDefault = false;

    const p1 = ensureCliInstalled();
    lastChild.stderr.emit("data", Buffer.from("disk full"));
    lastChild.emit("close", 1);

    await expect(p1).rejects.toThrow(/Package install failed/);

    // Second attempt should spawn a new process.
    const p2 = ensureCliInstalled();
    expect(spawnCalls).toHaveLength(2);
    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);
    await p2;
  });

  test("self-heals when the installed bin disappears mid-session", async () => {
    existsSyncDefault = false;

    // First install succeeds and links the bin.
    const p1 = ensureCliInstalled();
    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);
    await p1;
    expect(spawnCalls).toHaveLength(1);

    // node_modules gets clobbered mid-session — the bin is gone again.
    delete existsSyncByPath[cliBinPath];

    // A later call must reinstall rather than short-circuit on the resolved
    // promise from the first install.
    const p2 = ensureCliInstalled();
    expect(spawnCalls).toHaveLength(2);
    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);
    await p2;
  });

  test("wipes a stale node_modules without a bin before reinstalling", async () => {
    // Upgrade left a partial install: node_modules exists but the bin is gone.
    // `bun add` would no-op against the satisfied lockfile, so the installer
    // must clear the tree first to force a clean re-link.
    existsSyncDefault = false;
    const nodeModulesDir = `${latestInstallDir}/node_modules`;
    existsSyncByPath[nodeModulesDir] = true;

    const promise = ensureCliInstalled();

    // The wipe happens before the spawn; the reinstall then links the bin.
    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);
    await promise;

    const removedPaths = rmSyncCalls.map(([p]) => p);
    expect(removedPaths).toContain(nodeModulesDir);
    expect(removedPaths).toContain(`${latestInstallDir}/bun.lock`);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0][1]).toEqual(["add", "vellum@latest", "--ignore-scripts"]);
  });

  test("does not wipe when node_modules is absent (fresh install)", async () => {
    existsSyncDefault = false;

    const promise = ensureCliInstalled();
    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);
    await promise;

    // No stale tree to clear — only cleanupOldVersions may rm sibling dirs,
    // and there are none here.
    expect(rmSyncCalls).toHaveLength(0);
  });

  test("throws when the install completes but links no bin", async () => {
    existsSyncDefault = false;

    const promise = ensureCliInstalled();
    // bun exits 0 without ever creating node_modules/.bin/vellum.
    lastChild.emit("close", 0);

    await expect(promise).rejects.toThrow(/no vellum binary was found/);

    // The lock is cleared, so a subsequent attempt reinstalls from scratch.
    const retry = ensureCliInstalled();
    expect(spawnCalls).toHaveLength(2);
    existsSyncByPath[cliBinPath] = true;
    lastChild.emit("close", 0);
    await retry;
  });
});

// --- buildInstallEnv ---

describe("buildInstallEnv", () => {
  test("includes /opt/homebrew/bin and /usr/local/bin in PATH", () => {
    const env = buildInstallEnv();
    expect(env.PATH).toContain("/opt/homebrew/bin");
    expect(env.PATH).toContain("/usr/local/bin");
  });

  test("includes ~/.bun/bin and ~/.volta/bin in PATH", () => {
    const env = buildInstallEnv();
    expect(env.PATH).toContain(".bun/bin");
    expect(env.PATH).toContain(".volta/bin");
  });

  test("preserves existing process.env entries", () => {
    const env = buildInstallEnv();
    expect(env.HOME).toBeDefined();
  });
});

// --- cleanupOldVersions ---

describe("cleanupOldVersions", () => {
  test("deletes sibling directories that are not the current install dir", () => {
    readdirSyncReturn = [dirEntry("0.8.5"), dirEntry("latest")];

    cleanupOldVersions();

    const removedPaths = rmSyncCalls.map(([p]) => p);
    expect(removedPaths).toContain(`${userDataPath}/cli/0.8.5`);
    expect(removedPaths).not.toContain(latestInstallDir);
  });

  test("keeps an adopted versioned install dir", () => {
    readdirSyncReturn = [dirEntry("0.9.0"), dirEntry("0.8.5")];
    existsSyncByPath[binPathFor("0.9.0")] = true;

    cleanupOldVersions();

    const removedPaths = rmSyncCalls.map(([p]) => p);
    expect(removedPaths).toContain(`${userDataPath}/cli/0.8.5`);
    expect(removedPaths).not.toContain(`${userDataPath}/cli/0.9.0`);
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
