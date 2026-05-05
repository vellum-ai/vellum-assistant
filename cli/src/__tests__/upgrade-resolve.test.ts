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

const testDir = mkdtempSync(join(tmpdir(), "cli-upgrade-resolve-test-"));
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

const readPlatformTokenMock = spyOn(
  platformClient,
  "readPlatformToken",
).mockReturnValue(null);

const fetchAssistantByIdFromPlatformMock = spyOn(
  platformClient,
  "fetchAssistantByIdFromPlatform",
).mockResolvedValue(null);

import { resolveTargetAssistant } from "../commands/upgrade.js";

describe("resolveTargetAssistant platform fallback", () => {
  beforeEach(() => {
    findAssistantByNameMock.mockReset();
    findAssistantByNameMock.mockReturnValue(null);
    loadAllAssistantsMock.mockReset();
    loadAllAssistantsMock.mockReturnValue([]);
    getActiveAssistantMock.mockReset();
    getActiveAssistantMock.mockReturnValue(null);
    getPlatformUrlMock.mockReset();
    getPlatformUrlMock.mockReturnValue("https://platform.test");
    readPlatformTokenMock.mockReset();
    readPlatformTokenMock.mockReturnValue(null);
    fetchAssistantByIdFromPlatformMock.mockReset();
    fetchAssistantByIdFromPlatformMock.mockResolvedValue(null);
  });

  test("name not in lockfile + token present + platform returns assistant → synthetic entry", async () => {
    readPlatformTokenMock.mockReturnValue("platform-token");
    fetchAssistantByIdFromPlatformMock.mockResolvedValueOnce({
      id: "uuid-1",
      name: "uuid-1",
      status: "active",
    });

    const entry = await resolveTargetAssistant("uuid-1");

    expect(entry).toEqual({
      assistantId: "uuid-1",
      cloud: "vellum",
      runtimeUrl: "https://platform.test",
    });
    expect(fetchAssistantByIdFromPlatformMock).toHaveBeenCalledWith(
      "platform-token",
      "uuid-1",
    );
  });

  test("name not in lockfile + token present + platform returns null → exits ASSISTANT_NOT_FOUND", async () => {
    readPlatformTokenMock.mockReturnValue("platform-token");
    fetchAssistantByIdFromPlatformMock.mockResolvedValueOnce(null);

    const stderrWrites: string[] = [];
    const stderrWriteMock = spyOn(process.stderr, "write").mockImplementation(
      (chunk: unknown) => {
        stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      },
    );

    const mockExit = mock((_code?: number) => {
      throw new Error("process.exit called");
    });
    const origExit = process.exit;
    process.exit = mockExit as unknown as typeof process.exit;
    try {
      await expect(resolveTargetAssistant("uuid-2")).rejects.toThrow(
        "process.exit called",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      const cliErrorLine = stderrWrites.find((s) => s.startsWith("CLI_ERROR:"));
      expect(cliErrorLine).toBeDefined();
      const payload = JSON.parse(
        (cliErrorLine ?? "").slice("CLI_ERROR:".length).trim(),
      );
      expect(payload.error).toBe("ASSISTANT_NOT_FOUND");
    } finally {
      process.exit = origExit;
      stderrWriteMock.mockRestore();
    }
  });

  test("platform fetch throws auth error → exits AUTH_FAILED", async () => {
    readPlatformTokenMock.mockReturnValue("platform-token");
    fetchAssistantByIdFromPlatformMock.mockRejectedValueOnce(
      new Error("Authentication failed. Run 'vellum login' to refresh."),
    );

    const stderrWrites: string[] = [];
    const stderrWriteMock = spyOn(process.stderr, "write").mockImplementation(
      (chunk: unknown) => {
        stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      },
    );

    const mockExit = mock((_code?: number) => {
      throw new Error("process.exit called");
    });
    const origExit = process.exit;
    process.exit = mockExit as unknown as typeof process.exit;
    try {
      await expect(resolveTargetAssistant("uuid-auth")).rejects.toThrow(
        "process.exit called",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      const cliErrorLine = stderrWrites.find((s) => s.startsWith("CLI_ERROR:"));
      expect(cliErrorLine).toBeDefined();
      const payload = JSON.parse(
        (cliErrorLine ?? "").slice("CLI_ERROR:".length).trim(),
      );
      expect(payload.error).toBe("AUTH_FAILED");
    } finally {
      process.exit = origExit;
      stderrWriteMock.mockRestore();
    }
  });

  test("platform fetch throws other error → exits PLATFORM_API_ERROR", async () => {
    readPlatformTokenMock.mockReturnValue("platform-token");
    fetchAssistantByIdFromPlatformMock.mockRejectedValueOnce(
      new Error("Failed to fetch assistant uuid-1: 500 Internal Server Error"),
    );

    const stderrWrites: string[] = [];
    const stderrWriteMock = spyOn(process.stderr, "write").mockImplementation(
      (chunk: unknown) => {
        stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      },
    );

    const mockExit = mock((_code?: number) => {
      throw new Error("process.exit called");
    });
    const origExit = process.exit;
    process.exit = mockExit as unknown as typeof process.exit;
    try {
      await expect(resolveTargetAssistant("uuid-500")).rejects.toThrow(
        "process.exit called",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      const cliErrorLine = stderrWrites.find((s) => s.startsWith("CLI_ERROR:"));
      expect(cliErrorLine).toBeDefined();
      const payload = JSON.parse(
        (cliErrorLine ?? "").slice("CLI_ERROR:".length).trim(),
      );
      expect(payload.error).toBe("PLATFORM_API_ERROR");
    } finally {
      process.exit = origExit;
      stderrWriteMock.mockRestore();
    }
  });

  test("name not in lockfile + no platform token → exits ASSISTANT_NOT_FOUND, no platform call", async () => {
    readPlatformTokenMock.mockReturnValue(null);

    const mockExit = mock((_code?: number) => {
      throw new Error("process.exit called");
    });
    const origExit = process.exit;
    process.exit = mockExit as unknown as typeof process.exit;
    try {
      await expect(resolveTargetAssistant("uuid-3")).rejects.toThrow(
        "process.exit called",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(fetchAssistantByIdFromPlatformMock).not.toHaveBeenCalled();
    } finally {
      process.exit = origExit;
    }
  });
});

afterAll(() => {
  findAssistantByNameMock.mockRestore();
  loadAllAssistantsMock.mockRestore();
  getActiveAssistantMock.mockRestore();
  getPlatformUrlMock.mockRestore();
  readPlatformTokenMock.mockRestore();
  fetchAssistantByIdFromPlatformMock.mockRestore();
  rmSync(testDir, { recursive: true, force: true });
  if (savedLockfileDir === undefined) {
    delete process.env.VELLUM_LOCKFILE_DIR;
  } else {
    process.env.VELLUM_LOCKFILE_DIR = savedLockfileDir;
  }
});
