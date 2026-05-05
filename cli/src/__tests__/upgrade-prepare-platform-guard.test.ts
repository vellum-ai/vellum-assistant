import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Temp directory for lockfile isolation
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "cli-upgrade-prepare-guard-test-"));
const savedLockfileDir = process.env.VELLUM_LOCKFILE_DIR;
process.env.VELLUM_LOCKFILE_DIR = testDir;

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

import * as assistantConfig from "../lib/assistant-config.js";
import * as platformClient from "../lib/platform-client.js";

const findAssistantByNameMock = spyOn(
  assistantConfig,
  "findAssistantByName",
).mockReturnValue(null);

const loadAllAssistantsMock = spyOn(
  assistantConfig,
  "loadAllAssistants",
).mockReturnValue([]);

const getActiveAssistantMock = spyOn(
  assistantConfig,
  "getActiveAssistant",
).mockReturnValue(null);

const getPlatformUrlMock = spyOn(
  platformClient,
  "getPlatformUrl",
).mockReturnValue("https://platform.test");

import { upgrade } from "../commands/upgrade.js";

describe("upgrade() rejects --prepare/--finalize for platform-managed entries", () => {
  let savedArgv: string[];

  beforeEach(() => {
    savedArgv = process.argv;
    findAssistantByNameMock.mockReset();
    loadAllAssistantsMock.mockReset();
    loadAllAssistantsMock.mockReturnValue([]);
    getActiveAssistantMock.mockReset();
    getActiveAssistantMock.mockReturnValue(null);
    getPlatformUrlMock.mockReset();
    getPlatformUrlMock.mockReturnValue("https://platform.test");
  });

  function runWithArgv(
    argv: string[],
  ): Promise<{ exitCode: number | undefined; stderr: string[] }> {
    process.argv = ["bun", "vellum", ...argv];
    const stderrWrites: string[] = [];
    const stderrWriteMock = spyOn(process.stderr, "write").mockImplementation(
      (chunk: unknown) => {
        stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      },
    );

    let capturedExit: number | undefined;
    const mockExit = mock((code?: number) => {
      capturedExit = code;
      throw new Error("process.exit called");
    });
    const origExit = process.exit;
    process.exit = mockExit as unknown as typeof process.exit;

    return upgrade()
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === "process.exit called") {
          return;
        }
        throw err;
      })
      .then(() => {
        process.exit = origExit;
        stderrWriteMock.mockRestore();
        process.argv = savedArgv;
        return { exitCode: capturedExit, stderr: stderrWrites };
      });
  }

  test("--prepare against cloud=vellum entry emits UNSUPPORTED_TOPOLOGY and exits 1", async () => {
    findAssistantByNameMock.mockReturnValue({
      assistantId: "platform-uuid",
      cloud: "vellum",
      runtimeUrl: "https://platform.test",
    });

    const { exitCode, stderr } = await runWithArgv([
      "upgrade",
      "platform-uuid",
      "--prepare",
    ]);

    expect(exitCode).toBe(1);
    const cliErrorLine = stderr.find((s) => s.startsWith("CLI_ERROR:"));
    expect(cliErrorLine).toBeDefined();
    const payload = JSON.parse(
      (cliErrorLine ?? "").slice("CLI_ERROR:".length).trim(),
    );
    expect(payload.error).toBe("UNSUPPORTED_TOPOLOGY");
    expect(payload.message).toContain("--prepare");
  });

  test("--finalize against cloud=vellum entry emits UNSUPPORTED_TOPOLOGY and exits 1", async () => {
    findAssistantByNameMock.mockReturnValue({
      assistantId: "platform-uuid",
      cloud: "vellum",
      runtimeUrl: "https://platform.test",
    });

    const { exitCode, stderr } = await runWithArgv([
      "upgrade",
      "platform-uuid",
      "--finalize",
      "--version",
      "v1.0.0",
    ]);

    expect(exitCode).toBe(1);
    const cliErrorLine = stderr.find((s) => s.startsWith("CLI_ERROR:"));
    expect(cliErrorLine).toBeDefined();
    const payload = JSON.parse(
      (cliErrorLine ?? "").slice("CLI_ERROR:".length).trim(),
    );
    expect(payload.error).toBe("UNSUPPORTED_TOPOLOGY");
    expect(payload.message).toContain("--finalize");
  });
});

afterAll(() => {
  findAssistantByNameMock.mockRestore();
  loadAllAssistantsMock.mockRestore();
  getActiveAssistantMock.mockRestore();
  getPlatformUrlMock.mockRestore();
  rmSync(testDir, { recursive: true, force: true });
  if (savedLockfileDir === undefined) {
    delete process.env.VELLUM_LOCKFILE_DIR;
  } else {
    process.env.VELLUM_LOCKFILE_DIR = savedLockfileDir;
  }
});
