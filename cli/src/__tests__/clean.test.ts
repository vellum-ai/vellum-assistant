import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import type { OrphanedProcess } from "../lib/orphan-detection.js";

// ── Module mocks (must be set up before importing the command) ───────────────

const detectOrphansMock = mock(async (): Promise<OrphanedProcess[]> => []);
const stopProcessMock = mock(
  async (_pid: number, _label: string): Promise<boolean> => true,
);

beforeAll(() => {
  mock.module("../lib/orphan-detection.js", () => ({
    detectOrphanedProcesses: detectOrphansMock,
  }));
  mock.module("../lib/process.js", () => ({
    stopProcess: stopProcessMock,
  }));
});

import { clean } from "../commands/clean.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOrphan(
  name: string,
  pid: string,
  source = "process table",
): OrphanedProcess {
  return { name, pid, source };
}

const originalArgv = [...process.argv];

let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  exitSpy = spyOn(process, "exit").mockImplementation((_code?: number) => {
    throw new Error(`process.exit(${_code})`);
  });
  detectOrphansMock.mockClear();
  stopProcessMock.mockClear();
});

afterEach(() => {
  process.argv = [...originalArgv];
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
});

afterAll(() => {
  process.argv = [...originalArgv];
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("vellum clean --help", () => {
  test("prints usage and exits 0", async () => {
    process.argv = ["bun", "vellum", "clean", "--help"];
    await expect(clean()).rejects.toThrow("process.exit(0)");
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Usage: vellum clean");
    expect(output).toContain("orphaned");
  });

  test("-h is accepted as an alias for --help", async () => {
    process.argv = ["bun", "vellum", "clean", "-h"];
    await expect(clean()).rejects.toThrow("process.exit(0)");
  });
});

describe("vellum clean — no orphans", () => {
  test("prints nothing-to-do message when no orphans are found", async () => {
    detectOrphansMock.mockResolvedValueOnce([]);
    process.argv = ["bun", "vellum", "clean"];
    await clean();
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("No orphaned processes found.");
    expect(stopProcessMock).not.toHaveBeenCalled();
  });
});

describe("vellum clean — single orphan", () => {
  test("kills the orphan and prints singular 'process'", async () => {
    detectOrphansMock.mockResolvedValueOnce([makeOrphan("assistant", "12345")]);
    stopProcessMock.mockResolvedValueOnce(true);
    process.argv = ["bun", "vellum", "clean"];
    await clean();

    expect(stopProcessMock).toHaveBeenCalledTimes(1);
    expect(stopProcessMock).toHaveBeenCalledWith(
      12345,
      "assistant (PID 12345)",
    );

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Found 1 orphaned process");
    expect(output).not.toContain("processes");
    expect(output).toContain("Cleaned up 1 process.");
    expect(output).not.toContain("processes.");
  });

  test("reports 0 cleaned when stopProcess returns false", async () => {
    detectOrphansMock.mockResolvedValueOnce([makeOrphan("gateway", "99999")]);
    stopProcessMock.mockResolvedValueOnce(false);
    process.argv = ["bun", "vellum", "clean"];
    await clean();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Cleaned up 0 process");
  });
});

describe("vellum clean — multiple orphans", () => {
  test("uses plural 'processes' with multiple orphans", async () => {
    detectOrphansMock.mockResolvedValueOnce([
      makeOrphan("assistant", "1001"),
      makeOrphan("gateway", "1002"),
      makeOrphan("qdrant", "1003"),
    ]);
    stopProcessMock.mockResolvedValue(true);
    process.argv = ["bun", "vellum", "clean"];
    await clean();

    expect(stopProcessMock).toHaveBeenCalledTimes(3);

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Found 3 orphaned processes");
    expect(output).toContain("Cleaned up 3 processes.");
  });

  test("counts only successfully stopped processes in the total", async () => {
    detectOrphansMock.mockResolvedValueOnce([
      makeOrphan("assistant", "2001"),
      makeOrphan("qdrant", "2002"),
      makeOrphan("gateway", "2003"),
    ]);
    // Only the first and third succeed
    stopProcessMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    process.argv = ["bun", "vellum", "clean"];
    await clean();

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Found 3 orphaned processes");
    expect(output).toContain("Cleaned up 2 processes.");
  });

  test("passes the correct PID and label to stopProcess for each orphan", async () => {
    detectOrphansMock.mockResolvedValueOnce([
      makeOrphan("assistant", "3001"),
      makeOrphan("gateway", "3002"),
    ]);
    stopProcessMock.mockResolvedValue(true);
    process.argv = ["bun", "vellum", "clean"];
    await clean();

    const calls = stopProcessMock.mock.calls as [number, string][];
    expect(calls[0]).toEqual([3001, "assistant (PID 3001)"]);
    expect(calls[1]).toEqual([3002, "gateway (PID 3002)"]);
  });
});
