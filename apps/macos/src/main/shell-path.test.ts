import { afterEach, describe, expect, mock, test } from "bun:test";

import { FakeChild } from "./test-helpers";

// --- Mocks ---
// Must be installed before the `await import` of the module under test so
// the mocked module graph is in place when `shell-path.ts` (and its
// `cli-installer.ts` dependency) is evaluated. See `commands.test.ts` for
// the ordering rationale.

mock.module("electron", () => ({
  app: {
    getPath: () => "/mock/userData",
    isPackaged: true,
  },
}));

mock.module("./logger", () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));

// Paths for which the mocked accessSync(X_OK) succeeds.
const executablePaths = new Set<string>();

mock.module("node:fs", () => ({
  accessSync: (p: string) => {
    if (!executablePaths.has(p)) throw new Error(`EACCES: ${p}`);
  },
  constants: { X_OK: 1 },
  // Used by cli-installer's buildInstallEnv (nvm detection).
  chmodSync: () => {},
  copyFileSync: () => {},
  existsSync: () => false,
  mkdirSync: () => {},
  readdirSync: () => [],
  renameSync: () => {},
  rmSync: () => {},
  writeFileSync: () => {},
}));

let lastChild: FakeChild;
const spawnCalls: Array<[string, string[]]> = [];

mock.module("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => {
    spawnCalls.push([cmd, args]);
    lastChild = new FakeChild();
    return lastChild;
  },
}));

const {
  resolveShellPath,
  findExecutablesInPath,
  splitPathEntries,
  _resetShellPathCache,
} = await import("./shell-path");
const { buildInstallEnv } = await import("./cli-installer");

const originalShell = process.env.SHELL;

// Mirrors the internal sentinel in shell-path.ts (intentionally unexported).
const PATH_SENTINEL = "__VELLUM_PATH_7f3a__";

const wrap = (path: string) => `${PATH_SENTINEL}${path}${PATH_SENTINEL}`;

const fallbackResult = () => ({
  path: buildInstallEnv().PATH ?? "",
  reliable: false,
});

afterEach(() => {
  spawnCalls.length = 0;
  executablePaths.clear();
  _resetShellPathCache();
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
});

// --- resolveShellPath ---

describe("resolveShellPath", () => {
  test("returns the shell's stdout PATH as reliable, using $SHELL", async () => {
    process.env.SHELL = "/bin/bash";

    const promise = resolveShellPath();
    lastChild.stdout.emit(
      "data",
      Buffer.from(wrap("/Users/me/.local/bin:/usr/bin")),
    );
    lastChild.emit("close", 0);

    expect(await promise).toEqual({
      path: "/Users/me/.local/bin:/usr/bin",
      reliable: true,
    });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0][0]).toBe("/bin/bash");
    expect(spawnCalls[0][1]).toEqual([
      "-ilc",
      `printf "${PATH_SENTINEL}%s${PATH_SENTINEL}" "$PATH"`,
    ]);
  });

  test("ignores startup-file banner output before the sentinel pair", async () => {
    const promise = resolveShellPath();
    lastChild.stdout.emit(
      "data",
      Buffer.from(`Welcome to my shell!\nnvm warning\n${wrap("/usr/local/bin:/usr/bin")}`),
    );
    lastChild.emit("close", 0);

    expect(await promise).toEqual({
      path: "/usr/local/bin:/usr/bin",
      reliable: true,
    });
  });

  test("falls back to unreliable buildInstallEnv PATH when sentinels are missing", async () => {
    const promise = resolveShellPath();
    lastChild.stdout.emit("data", Buffer.from("banner only, no sentinel"));
    lastChild.emit("close", 0);

    expect(await promise).toEqual(fallbackResult());
  });

  test("falls back to /bin/zsh when $SHELL is unset", async () => {
    delete process.env.SHELL;

    const promise = resolveShellPath();
    lastChild.stdout.emit("data", Buffer.from(wrap("/usr/bin")));
    lastChild.emit("close", 0);

    await promise;
    expect(spawnCalls[0][0]).toBe("/bin/zsh");
  });

  test("falls back to unreliable buildInstallEnv PATH on non-zero exit", async () => {
    const promise = resolveShellPath();
    lastChild.stderr.emit("data", Buffer.from("zsh: bad rc file"));
    lastChild.emit("close", 1);

    expect(await promise).toEqual(fallbackResult());
  });

  test("falls back to unreliable buildInstallEnv PATH on empty output", async () => {
    const promise = resolveShellPath();
    lastChild.emit("close", 0);

    expect(await promise).toEqual(fallbackResult());
  });

  test("falls back to unreliable buildInstallEnv PATH on spawn error", async () => {
    const promise = resolveShellPath();
    lastChild.emit("error", new Error("ENOENT"));

    expect(await promise).toEqual(fallbackResult());
  });

  test("kills the child and falls back on timeout", async () => {
    const promise = resolveShellPath(10);

    expect(await promise).toEqual(fallbackResult());
    expect(lastChild.kill).toHaveBeenCalled();
  });

  test("late close after timeout does not override the fallback", async () => {
    const promise = resolveShellPath(10);
    const result = await promise;

    lastChild.stdout.emit("data", Buffer.from(wrap("/late/bin")));
    lastChild.emit("close", 0);

    expect(result).toEqual(fallbackResult());
    expect(await resolveShellPath()).toEqual(result);
  });

  test("caches the result; second call does not spawn again", async () => {
    const promise = resolveShellPath();
    lastChild.stdout.emit("data", Buffer.from(wrap("/cached/bin")));
    lastChild.emit("close", 0);
    await promise;

    expect(await resolveShellPath()).toEqual({
      path: "/cached/bin",
      reliable: true,
    });
    expect(spawnCalls).toHaveLength(1);
  });

  test("concurrent first calls share a single spawn", async () => {
    const p1 = resolveShellPath();
    const p2 = resolveShellPath();
    expect(spawnCalls).toHaveLength(1);

    lastChild.stdout.emit("data", Buffer.from(wrap("/shared/bin")));
    lastChild.emit("close", 0);

    expect((await p1).path).toBe("/shared/bin");
    expect((await p2).path).toBe("/shared/bin");
  });

  test("_resetShellPathCache clears the cache", async () => {
    const p1 = resolveShellPath();
    lastChild.stdout.emit("data", Buffer.from(wrap("/first/bin")));
    lastChild.emit("close", 0);
    await p1;

    _resetShellPathCache();

    const p2 = resolveShellPath();
    expect(spawnCalls).toHaveLength(2);
    lastChild.stdout.emit("data", Buffer.from(wrap("/second/bin")));
    lastChild.emit("close", 0);
    expect((await p2).path).toBe("/second/bin");
  });
});

// --- splitPathEntries ---

describe("splitPathEntries", () => {
  test("splits on colons preserving order", () => {
    expect(splitPathEntries("/a:/b:/c")).toEqual(["/a", "/b", "/c"]);
  });

  test("strips trailing slashes", () => {
    expect(splitPathEntries("/a/:/b//")).toEqual(["/a", "/b"]);
  });

  test("skips empty entries", () => {
    expect(splitPathEntries(":/a::")).toEqual(["/a"]);
  });

  test("dedupes entries, including slash variants", () => {
    expect(splitPathEntries("/a:/a/:/b:/a")).toEqual(["/a", "/b"]);
  });

  test("returns empty array for an empty value", () => {
    expect(splitPathEntries("")).toEqual([]);
  });
});

// --- findExecutablesInPath ---

describe("findExecutablesInPath", () => {
  test("returns hits in PATH precedence order", () => {
    executablePaths.add("/a/vellum");
    executablePaths.add("/c/vellum");

    expect(findExecutablesInPath("vellum", "/a:/b:/c")).toEqual([
      "/a/vellum",
      "/c/vellum",
    ]);
  });

  test("skips missing and non-executable entries", () => {
    executablePaths.add("/b/vellum");

    expect(findExecutablesInPath("vellum", "/a:/b")).toEqual(["/b/vellum"]);
  });

  test("skips empty and duplicate PATH entries", () => {
    executablePaths.add("/a/vellum");

    expect(findExecutablesInPath("vellum", ":/a::/a:/a:")).toEqual([
      "/a/vellum",
    ]);
  });

  test("normalizes trailing-slash entries to the same hit", () => {
    executablePaths.add("/a/vellum");

    expect(findExecutablesInPath("vellum", "/a/:/a")).toEqual(["/a/vellum"]);
  });

  test("returns empty array when nothing matches", () => {
    expect(findExecutablesInPath("vellum", "/a:/b")).toEqual([]);
  });
});
