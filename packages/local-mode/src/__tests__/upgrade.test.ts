import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { CliInvocation } from "../util";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = mock(() => true);
}

let lastChild: FakeChild;
const spawnArgs: Array<
  [string, string[], { env?: NodeJS.ProcessEnv; stdio?: unknown }]
> = [];
const spawnMock = mock(
  (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; stdio?: unknown },
  ) => {
    spawnArgs.push([command, args, options]);
    lastChild = new FakeChild();
    return lastChild;
  },
);

mock.module("node:child_process", () => ({ spawn: spawnMock }));

let runUpgrade: typeof import("../upgrade").runUpgrade;
let isValidReleaseVersion: typeof import("../upgrade").isValidReleaseVersion;

beforeAll(async () => {
  ({ runUpgrade, isValidReleaseVersion } = await import("../upgrade"));
});

afterEach(() => {
  spawnArgs.length = 0;
  spawnMock.mockClear();
});

const invocation: CliInvocation = { command: "bun", baseArgs: ["run", "cli"] };

describe("isValidReleaseVersion", () => {
  test("accepts trusted release identifiers", () => {
    for (const version of [
      "latest",
      "v1.2.3",
      "1.2.3",
      "0.6.0-staging.5",
      "1.2.3-rc.1+build.7",
    ]) {
      expect(isValidReleaseVersion(version)).toBe(true);
    }
  });

  test("rejects package specs, traversal, and malformed semver", () => {
    for (const version of [
      "npm:@attacker/evil@1.0.0",
      "https://evil.example/x.tgz",
      "git+https://evil.example/x.git",
      "../../../../tmp/evil",
      "1.2.3-..",
      "1.2.3-a..b", // empty pre-release identifier
      "1.2.3+build.", // trailing empty build identifier
      "1.2.3-", // empty pre-release
      "",
      "vellum@1.2.3",
    ]) {
      expect(isValidReleaseVersion(version)).toBe(false);
    }
  });
});

describe("runUpgrade", () => {
  test("spawns the CLI upgrade command for a release tag", async () => {
    const pending = runUpgrade(invocation, "asst-42", { version: "v1.2.3" });
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", "cli", "upgrade", "asst-42", "--version", "v1.2.3"],
      { stdio: ["ignore", "pipe", "pipe"] },
    ]);
  });

  test("spawns the CLI upgrade command for --latest", async () => {
    const pending = runUpgrade(invocation, "asst-42", { latest: true });
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]?.[1]).toEqual([
      "run",
      "cli",
      "upgrade",
      "asst-42",
      "--latest",
    ]);
  });

  test("rejects a malicious version without spawning", async () => {
    const result = await runUpgrade(invocation, "asst-42", {
      version: "npm:@attacker/evil@1.0.0",
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      error:
        "Invalid upgrade version 'npm:@attacker/evil@1.0.0': expected a release tag like v1.2.3 or 'latest'.",
    });
    expect(spawnArgs.length).toBe(0);
  });

  test("rejects a path-traversal version without spawning", async () => {
    const result = await runUpgrade(invocation, "asst-42", {
      version: "../../../../tmp/evil",
    });

    expect(result.ok).toBe(false);
    expect(spawnArgs.length).toBe(0);
  });
});
