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

let runRetire: typeof import("../retire").runRetire;

beforeAll(async () => {
  ({ runRetire } = await import("../retire"));
});

afterEach(() => {
  spawnArgs.length = 0;
  spawnMock.mockClear();
  delete process.env.VELLUM_PLATFORM_TOKEN;
});

const invocation: CliInvocation = { command: "bun", baseArgs: ["run", "cli"] };

describe("runRetire", () => {
  test("spawns the CLI retire command", async () => {
    const pending = runRetire(invocation, "asst-42");
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", "cli", "retire", "asst-42", "--yes"],
      { stdio: ["ignore", "pipe", "pipe"] },
    ]);
  });

  test("passes a host platform token to the CLI subprocess", async () => {
    const pending = runRetire(invocation, "asst-42", {
      platformToken: "session-token",
    });
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]?.[2].env?.VELLUM_PLATFORM_TOKEN).toBe("session-token");
    expect(process.env.VELLUM_PLATFORM_TOKEN).toBeUndefined();
  });

  test("a non-zero exit resolves to a failure carrying the CLI output", async () => {
    const pending = runRetire(invocation, "asst-42");
    lastChild.stderr.emit("data", Buffer.from("retire failed"));
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      status: 500,
      error: "retire failed",
    });
  });
});
