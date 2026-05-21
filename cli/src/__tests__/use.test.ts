import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getActiveAssistant,
  type AssistantEntry,
} from "../lib/assistant-config.js";
import { use } from "../commands/use.js";

const testDir = mkdtempSync(join(tmpdir(), "cli-use-test-"));
const originalArgv = [...process.argv];
const originalExit = process.exit;
const originalLockfileDir = process.env.VELLUM_LOCKFILE_DIR;

let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;

function makeEntry(
  assistantId: string,
  extra: Partial<AssistantEntry> = {},
): AssistantEntry {
  return {
    assistantId,
    runtimeUrl: `http://localhost:${7800 + assistantId.length}`,
    cloud: "local",
    ...extra,
  };
}

function writeLockfile(
  entries: AssistantEntry[],
  activeAssistant?: string,
): void {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify(
      {
        assistants: entries,
        ...(activeAssistant ? { activeAssistant } : {}),
      },
      null,
      2,
    ),
  );
}

describe("vellum use", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    rmSync(join(testDir, ".vellum.lock.json"), { force: true });
    process.argv = ["bun", "vellum", "use"];
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit;
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  afterAll(() => {
    if (originalLockfileDir === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = originalLockfileDir;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("sets active assistant by unique display name", async () => {
    writeLockfile([
      makeEntry("assistant-1", { name: "Alice" }),
      makeEntry("assistant-2", { name: "Bob" }),
    ]);
    process.argv = ["bun", "vellum", "use", "Alice"];

    await use();

    expect(getActiveAssistant()).toBe("assistant-1");
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "Active assistant set to Alice (assistant-1).",
    );
  });

  test("sets active assistant by unquoted multi-word display name", async () => {
    writeLockfile([
      makeEntry("assistant-1", { name: "Example Assistant" }),
      makeEntry("assistant-2", { name: "Bob" }),
    ]);
    process.argv = ["bun", "vellum", "use", "Example", "Assistant"];

    await use();

    expect(getActiveAssistant()).toBe("assistant-1");
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "Active assistant set to Example Assistant (assistant-1).",
    );
  });

  test("prints active assistant with display name and id", async () => {
    writeLockfile([makeEntry("assistant-1", { name: "Alice" })], "assistant-1");

    await use();

    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain(
      "Active assistant: Alice (assistant-1)",
    );
  });

  test("rejects ambiguous display names without changing active assistant", async () => {
    writeLockfile(
      [
        makeEntry("assistant-1", { name: "Alice" }),
        makeEntry("assistant-2", { name: "Alice" }),
      ],
      "assistant-2",
    );
    process.argv = ["bun", "vellum", "use", "Alice"];

    await expect(use()).rejects.toThrow("process.exit:1");

    expect(getActiveAssistant()).toBe("assistant-2");
    const output = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Multiple assistants match 'Alice'");
    expect(output).toContain("assistant-1");
    expect(output).toContain("assistant-2");
  });
});
