import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { CliInvocation } from "../util";

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

let runWake: typeof import("../wake").runWake;

beforeAll(async () => {
  ({ runWake } = await import("../wake"));
});

afterEach(() => {
  spawnArgs.length = 0;
  spawnMock.mockClear();
});

const invocation: CliInvocation = { command: "bun", baseArgs: ["run", "cli"] };

describe("runWake", () => {
  test("spawns the CLI wake command for the assistant and resolves ok on exit 0", async () => {
    const pending = runWake(invocation, "asst-42");
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual(["bun", ["run", "cli", "wake", "asst-42"]]);
  });

  test("repairGuardian: true appends --repair-guardian to the CLI args", async () => {
    const pending = runWake(invocation, "asst-42", { repairGuardian: true });
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", "cli", "wake", "asst-42", "--repair-guardian"],
    ]);
  });

  test("repairGuardian: false omits the flag", async () => {
    const pending = runWake(invocation, "asst-42", { repairGuardian: false });
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true });
    expect(spawnArgs[0]).toEqual(["bun", ["run", "cli", "wake", "asst-42"]]);
  });

  test("a non-zero exit resolves to a failure carrying the CLI's output", async () => {
    const pending = runWake(invocation, "asst-42");
    lastChild.stderr.emit("data", Buffer.from("no sibling environment to seed from"));
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      status: 500,
      error: "no sibling environment to seed from",
    });
  });

  test("a spawn failure resolves to a failure rather than rejecting", async () => {
    const pending = runWake(invocation, "asst-42");
    lastChild.emit("error", new Error("ENOENT"));

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ENOENT");
    }
  });
});
