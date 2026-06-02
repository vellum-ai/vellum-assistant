import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `./local-mode` resolves the CLI command from `app` (packaged vs dev) and
// registers its handler on `ipcMain`, then spawns the CLI via
// `node:child_process`. Stub all three so the spawn + stdout-parsing logic
// can be exercised without Electron or a real CLI. Mocks must be installed
// before the `await import` below (see `commands.test.ts` for the ordering
// rationale).
const appState = { isPackaged: false, appPath: "/repo/apps/macos" };
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
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers[channel] = handler;
    },
  },
}));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = mock(() => true);
}

let lastChild: FakeChild;
const spawnArgs: Array<[string, string[]]> = [];
const spawnMock = mock((command: string, args: string[]) => {
  spawnArgs.push([command, args]);
  lastChild = new FakeChild();
  return lastChild;
});

mock.module("node:child_process", () => ({ spawn: spawnMock }));

// Point the lockfile transport at a throwaway dir so the lockfile handlers
// exercise the real shared read/write logic without touching a real config
// dir. Set before importing the module under test because `installLocalMode`
// captures the resolved paths once at registration time.
const lockfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-lockfile-"));
process.env.VELLUM_LOCKFILE_DIR = lockfileDir;
const lockfilePath = path.join(lockfileDir, ".vellum.lock.json");

const { installLocalMode } = await import("./local-mode");

beforeAll(() => {
  installLocalMode();
});

afterEach(() => {
  appState.isPackaged = false;
  appState.appPath = "/repo/apps/macos";
  spawnArgs.length = 0;
  spawnMock.mockClear();
});

const hatch = (species?: unknown): Promise<unknown> =>
  handlers["vellum:localMode:hatch"]({}, species) as Promise<unknown>;

describe("vellum:localMode:hatch handler", () => {
  test("dev: spawns `bun run <repo>/cli/src/index.ts hatch <species>` and parses the id from stdout", async () => {
    const pending = hatch("vellum");
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

  test("packaged: fails explicitly without spawning (Resources/bun is the daemon, not the CLI)", async () => {
    appState.isPackaged = true;

    const result = (await hatch("openclaw")) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "Local assistants aren't supported in the packaged app yet.",
    );
    expect(spawnArgs).toHaveLength(0);
  });

  test("coerces a missing or empty species to the default", async () => {
    const pending = hatch("");
    lastChild.emit("close", 0);
    await pending;
    expect(spawnArgs[0][1]).toContain("vellum");

    const pending2 = hatch(undefined);
    lastChild.emit("close", 0);
    await pending2;
    expect(spawnArgs[1][1]).toContain("vellum");
  });

  test("a non-zero exit resolves to a failure carrying the CLI's stderr", async () => {
    const pending = hatch("vellum");
    lastChild.stderr.emit("data", Buffer.from("daemon already running"));
    lastChild.emit("close", 1);

    expect(await pending).toEqual({ ok: false, error: "daemon already running" });
  });

  test("a non-zero exit with no output carries a descriptive fallback error", async () => {
    const pending = hatch("vellum");
    lastChild.emit("close", 1);

    const result = (await pending) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exited with code 1");
  });

  test("a spawn failure resolves to a failure rather than rejecting", async () => {
    const pending = hatch("vellum");
    lastChild.emit("error", new Error("ENOENT"));

    const result = (await pending) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  test("a zero exit whose stdout has no parseable id fails instead of returning a blank id", async () => {
    const pending = hatch("vellum");
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
  handlers["vellum:localMode:readLockfile"]({}) as Record<string, unknown>;
const saveLockfileAssistant = (
  assistant: unknown,
  activeAssistant?: unknown,
): WriteResult =>
  handlers["vellum:localMode:saveLockfileAssistant"](
    {},
    assistant,
    activeAssistant,
  ) as WriteResult;
const replacePlatformAssistants = (platformAssistants: unknown): WriteResult =>
  handlers["vellum:localMode:replacePlatformAssistants"](
    {},
    platformAssistants,
  ) as WriteResult;
const retire = (assistantId?: unknown): Promise<unknown> =>
  handlers["vellum:localMode:retire"]({}, assistantId) as Promise<unknown>;

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
    const result = saveLockfileAssistant(
      { assistantId: "asst-1", cloud: "local", runtimeUrl: "http://127.0.0.1:1" },
      "asst-1",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lockfile.activeAssistant).toBe("asst-1");
    expect(result.lockfile.assistants).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(lockfilePath, "utf-8"))).toEqual(
      result.lockfile,
    );
  });

  test("saveLockfileAssistant fails without mutating disk when the entry has no id", () => {
    const result = saveLockfileAssistant({ cloud: "local" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("assistantId");
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });

  test("replacePlatformAssistants swaps platform entries while preserving local ones", () => {
    saveLockfileAssistant(
      { assistantId: "local-1", cloud: "local", runtimeUrl: "http://127.0.0.1:1" },
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
    const ids = (result.lockfile.assistants as Array<{ assistantId: string }>).map(
      (a) => a.assistantId,
    );
    expect(ids).toEqual(["local-1", "new-platform"]);
  });

  test("replacePlatformAssistants coerces a non-array argument to an empty set", () => {
    saveLockfileAssistant(
      { assistantId: "local-1", cloud: "local", runtimeUrl: "http://127.0.0.1:1" },
      "local-1",
    );

    const result = replacePlatformAssistants("not-an-array");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = (result.lockfile.assistants as Array<{ assistantId: string }>).map(
      (a) => a.assistantId,
    );
    expect(ids).toEqual(["local-1"]);
  });
});

describe("vellum:localMode:retire handler", () => {
  test("dev: spawns `... retire <id> --yes` and reports success on a zero exit", async () => {
    const pending = retire("asst-1");
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
    lastChild.stderr.emit("data", Buffer.from("no such assistant"));
    lastChild.emit("close", 1);
    expect(await pending).toEqual({ ok: false, error: "no such assistant" });
  });

  test("rejects a missing assistant id without spawning", async () => {
    expect(await retire("")).toEqual({ ok: false, error: "Missing assistantId" });
    expect(await retire(undefined)).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
    expect(spawnArgs).toHaveLength(0);
  });

  test("packaged: fails explicitly without spawning", async () => {
    appState.isPackaged = true;
    const result = (await retire("asst-1")) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "Local assistants aren't supported in the packaged app yet.",
    );
    expect(spawnArgs).toHaveLength(0);
  });
});
