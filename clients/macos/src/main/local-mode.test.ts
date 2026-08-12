import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `./local-mode` resolves the CLI command from `app` (packaged vs dev) and
// registers its handler on `ipcMain`, then spawns the CLI via
// `node:child_process`. Stub all three so the spawn + stdout-parsing logic
// can be exercised without Electron or a real CLI. Mocks must be installed
// before the `await import` below (see `commands.test.ts` for the ordering
// rationale).
const appState = { isPackaged: false, appPath: "/repo/clients/macos" };
const handlers: Record<
  string,
  (event: unknown, ...args: unknown[]) => unknown
> = {};

mock.module("electron", () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged;
    },
    getAppPath: () => appState.appPath,
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      handlers[channel] = handler;
    },
  },
}));

import { FakeChild } from "./test-helpers";

let lastChild: FakeChild;
const spawnArgs: Array<[string, string[]]> = [];
const spawnOptions: unknown[] = [];
const spawnMock = mock((command: string, args: string[], options?: unknown) => {
  spawnArgs.push([command, args]);
  spawnOptions.push(options);
  lastChild = new FakeChild();
  return lastChild;
});

mock.module("node:child_process", () => ({ spawn: spawnMock }));

// Mock cli-installer with controllable stubs. Defaults: CLI is not installed,
// install succeeds, paths return fixed values.
const cliInstallerState = {
  isInstalled: false,
  installError: null as Error | null,
  cliBinPath: "/fake/userData/cli/0.8.6/node_modules/.bin/vellum",
  bundledBunPath: "/fake/resources/bun",
};
const ensureCliInstalledMock = mock(async () => {
  if (cliInstallerState.installError) throw cliInstallerState.installError;
});

mock.module("./cli-installer", () => ({
  ensureCliInstalled: ensureCliInstalledMock,
  isCliInstalled: () => cliInstallerState.isInstalled,
  getCliBinPath: () => cliInstallerState.cliBinPath,
  getBundledBunPath: () => cliInstallerState.bundledBunPath,
}));

// The module under test imports { existsSync } from "node:fs" to check
// whether the dev source tree exists. Wrap the real implementation so
// dev-mode tests hit an existing path while the lockfile helpers (which
// import `fs` directly above) still use real I/O.
const realExistsSync = fs.existsSync.bind(fs);
const existsSyncOverrides: Record<string, boolean> = {};

mock.module("node:fs", () => ({
  ...fs,
  existsSync: (p: string) =>
    p in existsSyncOverrides ? existsSyncOverrides[p] : realExistsSync(p),
}));

// Point the lockfile transport at a throwaway dir so the lockfile handlers
// exercise the real shared read/write logic without touching a real config
// dir. Set before importing the module under test because `installLocalMode`
// captures the resolved paths once at registration time.
const previousEnvironment = process.env.VELLUM_ENVIRONMENT;
const previousLockfileDir = process.env.VELLUM_LOCKFILE_DIR;
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const lockfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-lockfile-"));
const configHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-config-"));
process.env.VELLUM_ENVIRONMENT = "production";
process.env.VELLUM_LOCKFILE_DIR = lockfileDir;
process.env.XDG_CONFIG_HOME = configHomeDir;
const lockfilePath = path.join(lockfileDir, ".vellum.lock.json");

// Matches the module's `resolveConfigDir(process.env)` under the
// production + XDG_CONFIG_HOME environment pinned above.
const configDir = path.join(configHomeDir, "vellum");

let mockSessionToken: string | null = null;
mock.module("./session-token-store", () => ({
  getSessionToken: () => mockSessionToken,
}));

// The unpair handler refreshes the lockfile watcher so the paired-gateway
// allowlist reflects the removal immediately. Stub the watcher module so
// the test asserts the hook fires without installing a real poller.
const refreshLockfileNowMock = mock(() => {});
mock.module("./lockfile-watcher", () => ({
  refreshLockfileNow: refreshLockfileNowMock,
}));

const { getPairedGuardianAccessToken, installLocalMode } =
  await import("./local-mode");
const { resolveAllowedOrigin } = await import("./app-origin");
const { guardianTokenPath } = await import("@vellumai/local-mode");

// The IPC wrappers reject any sender whose frame origin isn't the build's
// renderer origin. Tests drive the registered handlers directly, so they
// must present a frame at that origin; deriving it from the guard's own
// resolver keeps the fake sender correct across the dev/packaged toggle
// (`appState.isPackaged`) without hard-coding either origin here.
const allowedEvent = {
  get senderFrame() {
    const { protocol, host } = resolveAllowedOrigin();
    return { origin: `${protocol}//${host}` };
  },
};

beforeAll(() => {
  installLocalMode();
});

afterAll(() => {
  if (previousEnvironment === undefined) {
    delete process.env.VELLUM_ENVIRONMENT;
  } else {
    process.env.VELLUM_ENVIRONMENT = previousEnvironment;
  }

  if (previousLockfileDir === undefined) {
    delete process.env.VELLUM_LOCKFILE_DIR;
  } else {
    process.env.VELLUM_LOCKFILE_DIR = previousLockfileDir;
  }

  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }

  fs.rmSync(lockfileDir, { recursive: true, force: true });
  fs.rmSync(configHomeDir, { recursive: true, force: true });
});

// The dev CLI entry resolved from the default appPath.
const devCliEntry = path.join("/repo", "cli", "src", "index.ts");

beforeEach(() => {
  // Default: dev source tree "exists" so dev-mode tests pass without
  // a real filesystem.
  existsSyncOverrides[devCliEntry] = true;
});

afterEach(() => {
  appState.isPackaged = false;
  appState.appPath = "/repo/clients/macos";
  spawnArgs.length = 0;
  spawnOptions.length = 0;
  spawnMock.mockClear();
  ensureCliInstalledMock.mockClear();
  cliInstallerState.isInstalled = false;
  cliInstallerState.installError = null;
  mockSessionToken = null;
  refreshLockfileNowMock.mockClear();
  delete process.env.VELLUM_CLI_PATH;
  for (const key of Object.keys(existsSyncOverrides)) {
    delete existsSyncOverrides[key];
  }
});

// resolveCliInvocation is async, so there is at least one microtask tick
// between calling hatch()/retire() and the point where `spawn` is invoked.
// Yield enough ticks for the async chain to settle before emitting events
// on the fake child process.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const hatch = (species?: unknown): Promise<unknown> =>
  handlers["vellum:localMode:hatch"](allowedEvent, species) as Promise<unknown>;

describe("vellum:localMode:hatch handler", () => {
  test("dev: spawns `bun run <repo>/cli/src/index.ts hatch <species>` and parses the id from stdout", async () => {
    const pending = hatch("vellum");
    await tick();
    lastChild.stdout.emit(
      "data",
      Buffer.from("Hatching local assistant: asst-42\n"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, assistantId: "asst-42" });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", path.join("/repo", "cli", "src", "index.ts"), "hatch", "vellum"],
    ]);
  });

  test("packaged: uses installed CLI when already present", async () => {
    appState.isPackaged = true;
    cliInstallerState.isInstalled = true;

    const pending = hatch("openclaw");
    await tick();
    lastChild.stdout.emit(
      "data",
      Buffer.from("Hatching local assistant: asst-pkg\n"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, assistantId: "asst-pkg" });
    expect(spawnArgs[0]).toEqual([
      cliInstallerState.bundledBunPath,
      ["run", cliInstallerState.cliBinPath, "hatch", "openclaw"],
    ]);
    expect(ensureCliInstalledMock).toHaveBeenCalledTimes(1);
  });

  test("packaged: triggers install when CLI not found, then uses installed path", async () => {
    appState.isPackaged = true;
    cliInstallerState.isInstalled = false;

    const pending = hatch("openclaw");
    await tick();
    lastChild.stdout.emit(
      "data",
      Buffer.from("Hatching local assistant: asst-new\n"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, assistantId: "asst-new" });
    expect(ensureCliInstalledMock).toHaveBeenCalledTimes(1);
    expect(spawnArgs[0]).toEqual([
      cliInstallerState.bundledBunPath,
      ["run", cliInstallerState.cliBinPath, "hatch", "openclaw"],
    ]);
  });

  test("packaged: returns error when install fails", async () => {
    appState.isPackaged = true;
    cliInstallerState.isInstalled = false;
    cliInstallerState.installError = new Error("network timeout");

    const result = (await hatch("openclaw")) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("network timeout");
    expect(spawnArgs).toHaveLength(0);
  });

  test("VELLUM_CLI_PATH env override takes precedence", async () => {
    process.env.VELLUM_CLI_PATH = "/custom/cli/index.ts";

    const pending = hatch("vellum");
    await tick();
    lastChild.stdout.emit(
      "data",
      Buffer.from("Hatching local assistant: asst-env\n"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, assistantId: "asst-env" });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", "/custom/cli/index.ts", "hatch", "vellum"],
    ]);
  });

  test("coerces a missing or empty species to the default", async () => {
    const pending = hatch("");
    await tick();
    lastChild.emit("close", 0);
    await pending;
    expect(spawnArgs[0][1]).toContain("vellum");

    const pending2 = hatch(undefined);
    await tick();
    lastChild.emit("close", 0);
    await pending2;
    expect(spawnArgs[1][1]).toContain("vellum");
  });

  test("a non-zero exit resolves to a failure carrying the CLI's stderr", async () => {
    const pending = hatch("vellum");
    await tick();
    lastChild.stderr.emit("data", Buffer.from("daemon already running"));
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      error: "daemon already running",
    });
  });

  test("a non-zero exit with no output carries a descriptive fallback error", async () => {
    const pending = hatch("vellum");
    await tick();
    lastChild.emit("close", 1);

    const result = (await pending) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exited with code 1");
  });

  test("a spawn failure resolves to a failure rather than rejecting", async () => {
    const pending = hatch("vellum");
    await tick();
    lastChild.emit("error", new Error("ENOENT"));

    const result = (await pending) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  test("parses the assistant id from a Docker hatch banner", async () => {
    const pending = hatch("vellum");
    await tick();
    lastChild.stdout.emit(
      "data",
      Buffer.from("🥚 Hatching Docker assistant: asst-docker\n"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, assistantId: "asst-docker" });
  });

  test("a zero exit whose stdout has no parseable id fails instead of returning a blank id", async () => {
    const pending = hatch("vellum");
    await tick();
    lastChild.stdout.emit("data", Buffer.from("done, but no id line\n"));
    lastChild.emit("close", 0);

    const result = (await pending) as {
      ok: boolean;
      assistantId?: string;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.assistantId).toBeUndefined();
    expect(result.error).toContain("no assistant id");
  });
});

type WriteResult =
  | { ok: true; lockfile: Record<string, unknown> }
  | { ok: false; error: string };

const readLockfile = (): Record<string, unknown> =>
  handlers["vellum:localMode:readLockfile"](allowedEvent) as Record<
    string,
    unknown
  >;
const saveLockfileAssistant = (
  assistant: unknown,
  activeAssistant?: unknown,
): WriteResult =>
  handlers["vellum:localMode:saveLockfileAssistant"](
    allowedEvent,
    assistant,
    activeAssistant,
  ) as WriteResult;
const writePairedLockfileAssistant = (assistantId: string): void => {
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({
      assistants: [
        {
          assistantId,
          cloud: "paired",
          paired: true,
          runtimeUrl: "https://h",
        },
      ],
      activeAssistant: assistantId,
    }),
  );
};
const replacePlatformAssistants = (platformAssistants: unknown): WriteResult =>
  handlers["vellum:localMode:replacePlatformAssistants"](
    allowedEvent,
    platformAssistants,
  ) as WriteResult;
const retire = (assistantId?: unknown): Promise<unknown> =>
  handlers["vellum:localMode:retire"](
    allowedEvent,
    assistantId,
  ) as Promise<unknown>;
const unpair = (assistantId?: unknown): WriteResult =>
  handlers["vellum:localMode:unpair"](allowedEvent, assistantId) as WriteResult;
const wake = (assistantId?: unknown, options?: unknown): Promise<unknown> =>
  handlers["vellum:localMode:wake"](
    allowedEvent,
    assistantId,
    options,
  ) as Promise<unknown>;
const upgrade = (assistantId?: unknown, options?: unknown): Promise<unknown> =>
  handlers["vellum:localMode:upgrade"](
    allowedEvent,
    assistantId,
    options,
  ) as Promise<unknown>;
const guardianToken = (assistantId?: unknown): Promise<unknown> =>
  handlers["vellum:localMode:guardianToken"](
    allowedEvent,
    assistantId,
  ) as Promise<unknown>;

describe("lockfile IPC handlers", () => {
  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
  });

  test("readLockfile returns an empty lockfile when none exists yet", () => {
    expect(readLockfile()).toEqual({ assistants: [], activeAssistant: null });
  });

  test("readLockfile returns the parsed contents written to disk", () => {
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify({
        assistants: [{ assistantId: "asst-1", cloud: "local" }],
        activeAssistant: "asst-1",
      }),
    );
    expect(readLockfile()).toEqual({
      assistants: [{ assistantId: "asst-1", cloud: "local" }],
      activeAssistant: "asst-1",
    });
  });

  test("readLockfile throws when the lockfile on disk is corrupt", () => {
    fs.writeFileSync(lockfilePath, "{ not json");
    expect(() => readLockfile()).toThrow();
  });

  test("saveLockfileAssistant persists the assistant and makes it active", () => {
    // An unmodeled field pins the split between the two representations: the
    // on-disk file preserves everything the caller wrote (so a newer writer's
    // fields survive a round-trip through an older build), while the validated
    // wire value the bridge returns carries only the modeled shape. The two are
    // deliberately not equal.
    const result = saveLockfileAssistant(
      {
        assistantId: "asst-1",
        cloud: "local",
        runtimeUrl: "http://127.0.0.1:1",
        futureField: "keep-me",
      },
      "asst-1",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lockfile.activeAssistant).toBe("asst-1");
    expect(result.lockfile.assistants).toEqual([
      {
        assistantId: "asst-1",
        cloud: "local",
        runtimeUrl: "http://127.0.0.1:1",
      },
    ]);

    const onDisk = JSON.parse(fs.readFileSync(lockfilePath, "utf-8")) as {
      assistants: Array<Record<string, unknown>>;
    };
    expect(onDisk.assistants[0]).toEqual({
      assistantId: "asst-1",
      cloud: "local",
      runtimeUrl: "http://127.0.0.1:1",
      futureField: "keep-me",
    });
  });

  test("saveLockfileAssistant fails without mutating disk when the entry has no id", () => {
    const result = saveLockfileAssistant({ cloud: "local" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("assistantId");
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });

  test("saveLockfileAssistant cannot create or retarget a paired entry", () => {
    expect(
      saveLockfileAssistant({
        assistantId: "paired-1",
        cloud: "paired",
        runtimeUrl: "https://h",
      }).ok,
    ).toBe(false);

    writePairedLockfileAssistant("paired-1");
    expect(
      saveLockfileAssistant({
        assistantId: "paired-1",
        runtimeUrl: "https://attacker.example.com",
      }).ok,
    ).toBe(false);
    expect(readLockfile().assistants).toEqual([
      {
        assistantId: "paired-1",
        cloud: "paired",
        runtimeUrl: "https://h",
      },
    ]);
  });

  test("replacePlatformAssistants swaps platform entries while preserving local ones", () => {
    saveLockfileAssistant(
      {
        assistantId: "local-1",
        cloud: "local",
        runtimeUrl: "http://127.0.0.1:1",
      },
      "local-1",
    );
    saveLockfileAssistant(
      { assistantId: "old-platform", cloud: "vellum", runtimeUrl: "http://x" },
      "local-1",
    );

    const result = replacePlatformAssistants([
      { assistantId: "new-platform", cloud: "vellum", runtimeUrl: "http://y" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = (
      result.lockfile.assistants as Array<{ assistantId: string }>
    ).map((a) => a.assistantId);
    expect(ids).toEqual(["local-1", "new-platform"]);
  });

  test("replacePlatformAssistants rejects a non-array argument without touching disk", () => {
    saveLockfileAssistant(
      {
        assistantId: "local-1",
        cloud: "local",
        runtimeUrl: "http://127.0.0.1:1",
      },
      "local-1",
    );

    // The renderer's typed bridge only ever sends an array. A non-array is a
    // programming error or a hostile sender, so the schema rejects it rather
    // than coercing to an empty set — coercion would silently wipe every
    // platform assistant from the lockfile, a far worse outcome than failing.
    expect(() => replacePlatformAssistants("not-an-array")).toThrow();

    const onDisk = JSON.parse(fs.readFileSync(lockfilePath, "utf-8")) as {
      assistants: Array<{ assistantId: string }>;
    };
    expect(onDisk.assistants.map((a) => a.assistantId)).toEqual(["local-1"]);
  });

  test("replacePlatformAssistants cannot create a paired entry", () => {
    const result = replacePlatformAssistants([
      {
        assistantId: "paired-1",
        cloud: "paired",
        paired: true,
        runtimeUrl: "https://attacker.example.com",
      },
    ]);

    expect(result.ok).toBe(false);
    expect(readLockfile().assistants).toEqual([]);
  });
});

describe("vellum:localMode:retire handler", () => {
  test("dev: spawns `... retire <id> --yes` and reports success on a zero exit", async () => {
    const pending = retire("asst-1");
    await tick();
    expect(spawnArgs[0]).toEqual([
      "bun",
      [
        "run",
        path.join("/repo", "cli", "src", "index.ts"),
        "retire",
        "asst-1",
        "--yes",
      ],
    ]);
    lastChild.emit("close", 0);
    expect(await pending).toEqual({ ok: true });
  });

  test("a non-zero exit resolves to a failure carrying the CLI's stderr", async () => {
    const pending = retire("asst-1");
    await tick();
    lastChild.stderr.emit("data", Buffer.from("no such assistant"));
    lastChild.emit("close", 1);
    expect(await pending).toEqual({ ok: false, error: "no such assistant" });
  });

  test("passes the current session token through the shared retire invocation", async () => {
    mockSessionToken = "tok-electron";
    const previousPlatformToken = process.env.VELLUM_PLATFORM_TOKEN;
    process.env.VELLUM_PLATFORM_TOKEN = "parent-token";
    try {
      const pending = retire("asst-1");
      await tick();
      lastChild.emit("close", 0);

      expect(await pending).toEqual({ ok: true });
      expect(
        (spawnOptions[0] as { env?: NodeJS.ProcessEnv }).env
          ?.VELLUM_PLATFORM_TOKEN,
      ).toBe("tok-electron");
      expect(process.env.VELLUM_PLATFORM_TOKEN).toBe("parent-token");
    } finally {
      if (previousPlatformToken === undefined) {
        delete process.env.VELLUM_PLATFORM_TOKEN;
      } else {
        process.env.VELLUM_PLATFORM_TOKEN = previousPlatformToken;
      }
    }
  });

  test("rejects a missing assistant id without spawning", async () => {
    expect(await retire("")).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
    expect(await retire(undefined)).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
    expect(spawnArgs).toHaveLength(0);
  });

  test("packaged: uses installed CLI for retire", async () => {
    appState.isPackaged = true;
    cliInstallerState.isInstalled = true;

    const pending = retire("asst-1");
    await tick();
    expect(spawnArgs[0]).toEqual([
      cliInstallerState.bundledBunPath,
      ["run", cliInstallerState.cliBinPath, "retire", "asst-1", "--yes"],
    ]);
    lastChild.emit("close", 0);
    expect(await pending).toEqual({ ok: true });
  });

  test("packaged: returns error when install fails during retire", async () => {
    appState.isPackaged = true;
    cliInstallerState.isInstalled = false;
    cliInstallerState.installError = new Error("disk full");

    const result = (await retire("asst-1")) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("disk full");
    expect(spawnArgs).toHaveLength(0);
  });
});

describe("vellum:localMode:unpair handler", () => {
  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
    fs.rmSync(path.join(configDir, "assistants"), {
      recursive: true,
      force: true,
    });
  });

  test("removes a paired entry and deletes its guardian token", () => {
    writePairedLockfileAssistant("paired-1");
    fs.mkdirSync(path.dirname(guardianTokenPath(configDir, "paired-1")), {
      recursive: true,
    });
    fs.writeFileSync(guardianTokenPath(configDir, "paired-1"), "{}");

    const result = unpair("paired-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.lockfile.activeAssistant).toBeNull();
    expect(result.lockfile.assistants).toEqual([]);
    expect(fs.existsSync(guardianTokenPath(configDir, "paired-1"))).toBe(false);
    expect(spawnArgs).toHaveLength(0);
  });

  test("a successful unpair refreshes the lockfile watcher in the same tick", () => {
    writePairedLockfileAssistant("paired-1");
    refreshLockfileNowMock.mockClear();

    const result = unpair("paired-1");

    expect(result.ok).toBe(true);
    expect(refreshLockfileNowMock).toHaveBeenCalledTimes(1);
  });

  test("a failed unpair does not refresh the lockfile watcher", () => {
    saveLockfileAssistant(
      { assistantId: "local-1", cloud: "local" },
      "local-1",
    );
    refreshLockfileNowMock.mockClear();

    const result = unpair("local-1");

    expect(result.ok).toBe(false);
    expect(refreshLockfileNowMock).not.toHaveBeenCalled();
  });

  test("refuses a non-paired entry", () => {
    saveLockfileAssistant(
      { assistantId: "local-1", cloud: "local" },
      "local-1",
    );

    const result = unpair("local-1");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("paired");
  });

  test("rejects a missing assistant id with a structured error", () => {
    expect(unpair("")).toEqual({ ok: false, error: "Missing assistantId" });
    expect(unpair(undefined)).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
  });
});

describe("vellum:localMode:connectImport handler", () => {
  type ConnectImportResult = {
    ok: boolean;
    assistantId?: string;
    accessOnly?: boolean;
    error?: string;
  };
  const connectImport = (
    bundle?: unknown,
    name?: unknown,
  ): ConnectImportResult =>
    handlers["vellum:localMode:connectImport"](
      allowedEvent,
      bundle,
      name,
    ) as ConnectImportResult;

  const encodeBundle = (bundle: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(bundle)).toString("base64");

  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
    fs.rmSync(path.join(configDir, "assistants"), {
      recursive: true,
      force: true,
    });
  });

  test("registers a paired entry and writes its guardian token without spawning", () => {
    const result = connectImport(
      encodeBundle({
        gatewayUrl: "https://gw.example.com",
        token: "tok-access",
        deviceId: "dev-1",
      }),
      "desk",
    );

    expect(result).toEqual({ ok: true, assistantId: "desk", accessOnly: true });
    expect(refreshLockfileNowMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(guardianTokenPath(configDir, "desk"))).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(lockfilePath, "utf-8")) as {
      assistants: Array<Record<string, unknown>>;
    };
    expect(onDisk.assistants[0]).toMatchObject({
      assistantId: "desk",
      cloud: "paired",
      paired: true,
      runtimeUrl: "https://gw.example.com",
    });
    expect(spawnArgs).toHaveLength(0);
  });

  test("a malformed bundle resolves to a structured error", () => {
    const result = connectImport("not-base64-json!!!");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("base64");
    expect(refreshLockfileNowMock).not.toHaveBeenCalled();
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });

  test("refuses to overwrite an existing non-paired assistant", () => {
    saveLockfileAssistant(
      { assistantId: "local-1", cloud: "local" },
      "local-1",
    );

    const result = connectImport(
      encodeBundle({ gatewayUrl: "https://gw.example.com", token: "tok" }),
      "local-1",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("already exists");
    expect(fs.existsSync(guardianTokenPath(configDir, "local-1"))).toBe(false);
  });

  test("rejects a missing or oversized bundle with a structured error", () => {
    expect(connectImport(undefined)).toEqual({
      ok: false,
      error: "Missing pairing bundle",
    });
    expect(connectImport("")).toEqual({
      ok: false,
      error: "Missing pairing bundle",
    });
    expect(connectImport("a".repeat(64 * 1024 + 1))).toEqual({
      ok: false,
      error: "Pairing bundle is too large",
    });
  });
});

describe("vellum:localMode:wake handler", () => {
  test("forwards repairGuardian to runWake, appending --repair-guardian", async () => {
    const pending = wake("asst-1", { repairGuardian: true });
    await tick();
    expect(spawnArgs[0]).toEqual([
      "bun",
      [
        "run",
        path.join("/repo", "cli", "src", "index.ts"),
        "wake",
        "asst-1",
        "--repair-guardian",
      ],
    ]);
    lastChild.emit("close", 0);
    expect(await pending).toEqual({ ok: true });
  });

  test("a single-argument invoke still resolves ok with no options forwarded", async () => {
    const pending = handlers["vellum:localMode:wake"](
      allowedEvent,
      "asst-1",
    ) as Promise<unknown>;
    await tick();
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", path.join("/repo", "cli", "src", "index.ts"), "wake", "asst-1"],
    ]);
    lastChild.emit("close", 0);
    expect(await pending).toEqual({ ok: true });
  });

  test("rejects malformed options without spawning", async () => {
    expect(() => wake("asst-1", "repair-please")).toThrow();
    expect(spawnArgs).toHaveLength(0);
  });

  test("rejects a missing assistant id without spawning", async () => {
    expect(await wake(undefined, { repairGuardian: true })).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
    expect(spawnArgs).toHaveLength(0);
  });
});

describe("vellum:localMode:upgrade handler", () => {
  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
    saveLockfileAssistant(
      {
        assistantId: "asst-active",
        cloud: "local",
        runtimeUrl: "http://127.0.0.1:1",
      },
      "asst-active",
    );
    spawnArgs.length = 0;
  });

  test("rejects a non-active assistant without spawning the CLI", async () => {
    await expect(upgrade("asst-inactive", { latest: true })).resolves.toEqual({
      ok: false,
      error: "Can only upgrade the active local assistant",
    });
    expect(spawnArgs).toHaveLength(0);
  });

  test("deduplicates concurrent requests before resolving the CLI invocation", async () => {
    const pending = upgrade("asst-active", { latest: true });
    const duplicate = upgrade("asst-active", { latest: true });

    await expect(duplicate).resolves.toEqual({
      ok: false,
      error: "An upgrade is already in progress for this assistant.",
    });

    await tick();
    expect(spawnArgs).toHaveLength(1);
    expect(spawnArgs[0]).toEqual([
      "bun",
      [
        "run",
        path.join("/repo", "cli", "src", "index.ts"),
        "upgrade",
        "asst-active",
        "--latest",
      ],
    ]);

    lastChild.stdout.emit("data", Buffer.from("upgraded to v1.2.3\n"));
    lastChild.emit("close", 0);

    await expect(pending).resolves.toEqual({ ok: true, version: "v1.2.3" });
  });
});

describe("vellum:localMode:guardianToken handler", () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const PAST = new Date(Date.now() - 60_000).toISOString();

  const writeToken = (
    assistantId: string,
    over: Record<string, unknown>,
  ): void => {
    fs.mkdirSync(path.dirname(guardianTokenPath(configDir, assistantId)), {
      recursive: true,
    });
    fs.writeFileSync(
      guardianTokenPath(configDir, assistantId),
      JSON.stringify({
        guardianPrincipalId: "principal",
        accessToken: "stored-token",
        accessTokenExpiresAt: FUTURE,
        refreshToken: "refresh",
        refreshTokenExpiresAt: FUTURE,
        refreshAfter: FUTURE,
        isNew: false,
        deviceId: "device",
        leasedAt: new Date().toISOString(),
        ...over,
      }),
    );
  };

  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
    fs.rmSync(path.join(configDir, "assistants"), {
      recursive: true,
      force: true,
    });
  });

  test("returns a fresh token from the file without spawning the CLI", async () => {
    writeToken("asst-g", {});

    expect(await guardianToken("asst-g")).toEqual({
      ok: true,
      accessToken: "stored-token",
    });
    expect(spawnArgs).toHaveLength(0);
  });

  test("expired access token spawns `... gateway token refresh <id>` with the pinned env", async () => {
    writeToken("asst-g", { accessTokenExpiresAt: PAST });

    const pending = guardianToken("asst-g");
    await tick();
    expect(spawnArgs[0]).toEqual([
      "bun",
      [
        "run",
        path.join("/repo", "cli", "src", "index.ts"),
        "gateway",
        "token",
        "refresh",
        "asst-g",
      ],
    ]);
    expect(
      (spawnOptions[0] as { env?: NodeJS.ProcessEnv }).env?.VELLUM_ENVIRONMENT,
    ).toBe("production");

    lastChild.stdout.emit("data", Buffer.from("refreshed-token\n"));
    lastChild.emit("close", 0);
    expect(await pending).toEqual({ ok: true, accessToken: "refreshed-token" });
  });

  test("deduplicates concurrent refreshes for the same credential", async () => {
    writeToken("asst-g", { accessTokenExpiresAt: PAST });

    const first = guardianToken("asst-g");
    const second = guardianToken("asst-g");
    await tick();
    expect(spawnArgs).toHaveLength(1);

    lastChild.stdout.emit("data", Buffer.from("refreshed-token\n"));
    lastChild.emit("close", 0);

    await expect(first).resolves.toEqual({
      ok: true,
      accessToken: "refreshed-token",
    });
    await expect(second).resolves.toEqual({
      ok: true,
      accessToken: "refreshed-token",
    });
  });

  test("expired refresh token resolves a structured 401 with hatch/wake guidance", async () => {
    writeToken("asst-g", {
      accessTokenExpiresAt: PAST,
      refreshTokenExpiresAt: PAST,
    });

    const result = (await guardianToken("asst-g")) as {
      ok: boolean;
      status: number;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("vellum hatch");
    expect(result.error).not.toContain("vellum pair");
    expect(spawnArgs).toHaveLength(0);
  });

  test("does not expose a paired credential through renderer IPC", async () => {
    writePairedLockfileAssistant("paired-g");
    writeToken("paired-g", {});

    const result = (await guardianToken("paired-g")) as {
      ok: boolean;
      status: number;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toContain("paired gateway proxy");
    expect(spawnArgs).toHaveLength(0);
  });

  test("the trusted proxy helper can read a paired credential", async () => {
    writeToken("paired-g", {});

    expect(await getPairedGuardianAccessToken("paired-g", "https://h")).toEqual(
      {
        ok: true,
        accessToken: "stored-token",
      },
    );
  });

  test("missing token file resolves a structured 404 without spawning", async () => {
    expect(await guardianToken("asst-missing")).toEqual({
      ok: false,
      status: 404,
      error: "Guardian token not found",
    });
    expect(spawnArgs).toHaveLength(0);
  });

  test("rejects a missing assistant id with a structured error", async () => {
    expect(await guardianToken("")).toEqual({
      ok: false,
      status: 400,
      error: "Missing assistantId",
    });
    expect(await guardianToken(undefined)).toEqual({
      ok: false,
      status: 400,
      error: "Missing assistantId",
    });
    expect(spawnArgs).toHaveLength(0);
  });
});
