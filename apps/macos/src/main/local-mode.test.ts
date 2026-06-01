import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
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
