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

let runHatch: typeof import("../hatch").runHatch;

beforeAll(async () => {
  ({ runHatch } = await import("../hatch"));
});

afterEach(() => {
  spawnArgs.length = 0;
  spawnMock.mockClear();
});

const invocation: CliInvocation = { command: "bun", baseArgs: ["run", "cli"] };

describe("runHatch", () => {
  test("spawns the CLI and parses the assistant id from stdout", async () => {
    const pending = runHatch(invocation, "vellum");
    lastChild.stdout.emit(
      "data",
      Buffer.from("Hatching local assistant: asst-42\n"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, assistantId: "asst-42" });
    expect(spawnArgs[0]).toEqual(["bun", ["run", "cli", "hatch", "vellum"]]);
  });

  test("parses the assistant id from a Docker hatch banner", async () => {
    const pending = runHatch(invocation, "vellum", { remote: "docker" });
    lastChild.stdout.emit(
      "data",
      Buffer.from("🥚 Hatching Docker assistant: asst-docker\n"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, assistantId: "asst-docker" });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", "cli", "hatch", "vellum", "--remote", "docker"],
    ]);
  });

  test("a non-zero exit resolves to a failure carrying the CLI's output", async () => {
    const pending = runHatch(invocation, "vellum");
    lastChild.stderr.emit("data", Buffer.from("daemon already running"));
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      status: 500,
      error: "daemon already running",
    });
  });

  test("a non-zero exit with no output carries a descriptive fallback error", async () => {
    const pending = runHatch(invocation, "vellum");
    lastChild.emit("close", 1);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exited with code 1");
    }
  });

  test("a zero exit whose stdout has no parseable id fails instead of returning a blank id", async () => {
    const pending = runHatch(invocation, "vellum");
    lastChild.stdout.emit("data", Buffer.from("done, but no id line\n"));
    lastChild.emit("close", 0);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no assistant id");
    }
  });

  test("a spawn failure resolves to a failure rather than rejecting", async () => {
    const pending = runHatch(invocation, "vellum");
    lastChild.emit("error", new Error("ENOENT"));

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ENOENT");
    }
  });
});
