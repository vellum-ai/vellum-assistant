import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import { FakeChild } from "./test-helpers";

// --- Mocks ---
// Must be installed before the `await import` of the module under test so
// the mocked module graph is in place when `shell-path.ts` is evaluated.
// See `commands.test.ts` for the ordering rationale.

// Paths for which the mocked accessSync(X_OK) succeeds.
const executablePaths = new Set<string>();
// Paths whose stat (after following symlinks) reports a directory.
const directoryPaths = new Set<string>();

mock.module("node:fs", () => ({
  accessSync: (p: string) => {
    if (!executablePaths.has(p)) throw new Error(`EACCES: ${p}`);
  },
  statSync: (p: string) => ({ isFile: () => !directoryPaths.has(p) }),
  constants: { X_OK: 1 },
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
  isFishShell,
  _resetShellPathCache,
} = await import("./shell-path");

const originalShell = process.env.SHELL;

// Mirrors the internal sentinel in shell-path.ts (intentionally unexported).
const PATH_SENTINEL = "__VELLUM_PATH_7f3a__";

const wrap = (path: string) => `${PATH_SENTINEL}${path}${PATH_SENTINEL}`;

const POSIX_QUERY = `printf "${PATH_SENTINEL}%s${PATH_SENTINEL}" "$PATH"`;
const FISH_QUERY = `printf "${PATH_SENTINEL}%s${PATH_SENTINEL}" (string join : $PATH)`;

// Deterministic default regardless of the developer's real shell; individual
// tests override.
beforeEach(() => {
  process.env.SHELL = "/bin/zsh";
});

afterEach(() => {
  spawnCalls.length = 0;
  executablePaths.clear();
  directoryPaths.clear();
  _resetShellPathCache();
  setSystemTime();
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
});

// --- isFishShell ---

describe("isFishShell", () => {
  test("true for a fish $SHELL", () => {
    process.env.SHELL = "/opt/homebrew/bin/fish";
    expect(isFishShell()).toBe(true);
  });

  test("false for POSIX shells and when $SHELL is unset", () => {
    process.env.SHELL = "/bin/zsh";
    expect(isFishShell()).toBe(false);
    delete process.env.SHELL;
    expect(isFishShell()).toBe(false);
  });
});

// --- resolveShellPath ---

describe("resolveShellPath", () => {
  test("returns the shell's stdout PATH, using $SHELL with the POSIX query", async () => {
    process.env.SHELL = "/bin/bash";

    const promise = resolveShellPath();
    lastChild.stdout.emit(
      "data",
      Buffer.from(wrap("/Users/me/.local/bin:/usr/bin")),
    );
    lastChild.emit("close", 0);

    expect(await promise).toBe("/Users/me/.local/bin:/usr/bin");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0][0]).toBe("/bin/bash");
    expect(spawnCalls[0][1]).toEqual(["-ilc", POSIX_QUERY]);
  });

  test("uses a fish-native list join for fish shells", async () => {
    process.env.SHELL = "/opt/homebrew/bin/fish";

    const promise = resolveShellPath();
    lastChild.stdout.emit("data", Buffer.from(wrap("/usr/local/bin:/usr/bin")));
    lastChild.emit("close", 0);

    expect(await promise).toBe("/usr/local/bin:/usr/bin");
    expect(spawnCalls[0][0]).toBe("/opt/homebrew/bin/fish");
    expect(spawnCalls[0][1]).toEqual(["-ilc", FISH_QUERY]);
  });

  test("returns null without spawning for unrecognized shells", async () => {
    process.env.SHELL = "/usr/bin/tcsh";

    expect(await resolveShellPath()).toBeNull();
    expect(spawnCalls).toHaveLength(0);
  });

  test("ignores startup-file banner output before the sentinel pair", async () => {
    const promise = resolveShellPath();
    lastChild.stdout.emit(
      "data",
      Buffer.from(`Welcome to my shell!\nnvm warning\n${wrap("/usr/local/bin:/usr/bin")}`),
    );
    lastChild.emit("close", 0);

    expect(await promise).toBe("/usr/local/bin:/usr/bin");
  });

  test("returns null when sentinels are missing", async () => {
    const promise = resolveShellPath();
    lastChild.stdout.emit("data", Buffer.from("banner only, no sentinel"));
    lastChild.emit("close", 0);

    expect(await promise).toBeNull();
  });

  test("returns null for space-joined output that is not a plausible PATH", async () => {
    const promise = resolveShellPath();
    lastChild.stdout.emit(
      "data",
      Buffer.from(wrap("/usr/local/bin /usr/bin /bin")),
    );
    lastChild.emit("close", 0);

    expect(await promise).toBeNull();
  });

  test("accepts a single absolute directory without separators", async () => {
    const promise = resolveShellPath();
    lastChild.stdout.emit("data", Buffer.from(wrap("/usr/bin")));
    lastChild.emit("close", 0);

    expect(await promise).toBe("/usr/bin");
  });

  test("returns null for a single relative token", async () => {
    const promise = resolveShellPath();
    lastChild.stdout.emit("data", Buffer.from(wrap("garbage")));
    lastChild.emit("close", 0);

    expect(await promise).toBeNull();
  });

  test("falls back to /bin/zsh when $SHELL is unset", async () => {
    delete process.env.SHELL;

    const promise = resolveShellPath();
    lastChild.stdout.emit("data", Buffer.from(wrap("/usr/bin")));
    lastChild.emit("close", 0);

    await promise;
    expect(spawnCalls[0][0]).toBe("/bin/zsh");
  });

  test("returns null on non-zero exit", async () => {
    const promise = resolveShellPath();
    lastChild.stderr.emit("data", Buffer.from("zsh: bad rc file"));
    lastChild.emit("close", 1);

    expect(await promise).toBeNull();
  });

  test("returns null on empty output", async () => {
    const promise = resolveShellPath();
    lastChild.emit("close", 0);

    expect(await promise).toBeNull();
  });

  test("returns null on spawn error", async () => {
    const promise = resolveShellPath();
    lastChild.emit("error", new Error("ENOENT"));

    expect(await promise).toBeNull();
  });

  test("kills the child and returns null on timeout", async () => {
    const promise = resolveShellPath(10);

    expect(await promise).toBeNull();
    expect(lastChild.kill).toHaveBeenCalled();
  });

  test("late close after timeout does not override the null result", async () => {
    const promise = resolveShellPath(10);
    const result = await promise;

    lastChild.stdout.emit("data", Buffer.from(wrap("/late/bin")));
    lastChild.emit("close", 0);

    expect(result).toBeNull();
  });

  test("never caches null: the next call spawns a fresh query", async () => {
    const failed = resolveShellPath();
    lastChild.emit("close", 1);
    expect(await failed).toBeNull();

    const retry = resolveShellPath();
    expect(spawnCalls).toHaveLength(2);
    lastChild.stdout.emit("data", Buffer.from(wrap("/retry/bin")));
    lastChild.emit("close", 0);
    expect(await retry).toBe("/retry/bin");
  });

  test("caches a successful result; second call does not spawn again", async () => {
    const promise = resolveShellPath();
    lastChild.stdout.emit("data", Buffer.from(wrap("/cached/bin")));
    lastChild.emit("close", 0);
    await promise;

    expect(await resolveShellPath()).toBe("/cached/bin");
    expect(spawnCalls).toHaveLength(1);
  });

  test("re-queries after the cache TTL elapses", async () => {
    const start = new Date("2026-01-01T00:00:00Z");
    setSystemTime(start);

    const first = resolveShellPath();
    lastChild.stdout.emit("data", Buffer.from(wrap("/first/bin")));
    lastChild.emit("close", 0);
    expect(await first).toBe("/first/bin");

    setSystemTime(new Date(start.getTime() + 29_000));
    expect(await resolveShellPath()).toBe("/first/bin");
    expect(spawnCalls).toHaveLength(1);

    setSystemTime(new Date(start.getTime() + 31_000));
    const second = resolveShellPath();
    expect(spawnCalls).toHaveLength(2);
    lastChild.stdout.emit("data", Buffer.from(wrap("/second/bin")));
    lastChild.emit("close", 0);
    expect(await second).toBe("/second/bin");
  });

  test("concurrent first calls share a single spawn", async () => {
    const p1 = resolveShellPath();
    const p2 = resolveShellPath();
    expect(spawnCalls).toHaveLength(1);

    lastChild.stdout.emit("data", Buffer.from(wrap("/shared/bin")));
    lastChild.emit("close", 0);

    expect(await p1).toBe("/shared/bin");
    expect(await p2).toBe("/shared/bin");
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
    expect(await p2).toBe("/second/bin");
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

  test("skips directories even though they pass the X_OK probe", () => {
    executablePaths.add("/a/vellum");
    directoryPaths.add("/a/vellum");
    executablePaths.add("/b/vellum");

    expect(findExecutablesInPath("vellum", "/a:/b")).toEqual(["/b/vellum"]);
  });

  test("keeps symlinks that resolve to executable files (stat follows links)", () => {
    // Mocked statSync models the followed target: a link to a file.
    executablePaths.add("/a/vellum");

    expect(findExecutablesInPath("vellum", "/a")).toEqual(["/a/vellum"]);
  });

  test("skips symlinks that resolve to directories", () => {
    executablePaths.add("/a/vellum");
    directoryPaths.add("/a/vellum"); // link target is a directory

    expect(findExecutablesInPath("vellum", "/a")).toEqual([]);
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
