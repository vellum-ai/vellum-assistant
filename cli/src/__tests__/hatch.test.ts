import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "cli-hatch-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

import * as assistantConfig from "../lib/assistant-config.js";
import * as platformClient from "../lib/platform-client.js";

const readPlatformTokenMock = spyOn(
  platformClient,
  "readPlatformToken",
).mockReturnValue("platform-token");
const hatchAssistantMock = spyOn(
  platformClient,
  "hatchAssistant",
).mockResolvedValue({
  assistant: {
    id: "platform-assistant-id",
    name: "Platform Assistant",
    status: "active",
  },
  reusedExisting: false,
});
const getPlatformUrlMock = spyOn(
  platformClient,
  "getPlatformUrl",
).mockReturnValue("https://platform.test");
const saveAssistantEntryMock = spyOn(
  assistantConfig,
  "saveAssistantEntry",
).mockImplementation(() => {});
const setActiveAssistantMock = spyOn(
  assistantConfig,
  "setActiveAssistant",
).mockImplementation(() => {});

import { hatch } from "../commands/hatch.js";

let originalArgv: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExit: typeof process.exit;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  originalArgv = process.argv;
  originalLog = console.log;
  originalError = console.error;
  originalExit = process.exit;
  stdout = [];
  stderr = [];
  console.log = ((...args: unknown[]) => {
    stdout.push(args.map((arg) => String(arg)).join(" "));
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    stderr.push(args.map((arg) => String(arg)).join(" "));
  }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;

  readPlatformTokenMock.mockReturnValue("platform-token");
  hatchAssistantMock.mockReset();
  hatchAssistantMock.mockResolvedValue({
    assistant: {
      id: "platform-assistant-id",
      name: "Platform Assistant",
      status: "active",
    },
    reusedExisting: false,
  });
  getPlatformUrlMock.mockReturnValue("https://platform.test");
  saveAssistantEntryMock.mockClear();
  setActiveAssistantMock.mockClear();
});

afterEach(() => {
  process.argv = originalArgv;
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
});

afterAll(() => {
  readPlatformTokenMock.mockRestore();
  hatchAssistantMock.mockRestore();
  getPlatformUrlMock.mockRestore();
  saveAssistantEntryMock.mockRestore();
  setActiveAssistantMock.mockRestore();
  rmSync(testDir, { recursive: true, force: true });
});

describe("vellum hatch --remote vellum", () => {
  test("defaults to ensure mode", async () => {
    process.argv = ["bun", "vellum", "hatch", "--remote", "vellum"];

    await hatch();

    expect(hatchAssistantMock).toHaveBeenCalledWith(
      "platform-token",
      undefined,
      {
        mode: "ensure",
      },
    );
    expect(saveAssistantEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: "platform-assistant-id",
        runtimeUrl: "https://platform.test",
        cloud: "vellum",
      }),
    );
    expect(setActiveAssistantMock).toHaveBeenCalledWith(
      "platform-assistant-id",
    );
    expect(stdout).toContain("   Result: created new assistant");
  });

  test("passes create mode to the platform hatch endpoint", async () => {
    process.argv = [
      "bun",
      "vellum",
      "hatch",
      "--remote",
      "vellum",
      "--mode",
      "create",
    ];

    await hatch();

    expect(hatchAssistantMock).toHaveBeenCalledWith(
      "platform-token",
      undefined,
      {
        mode: "create",
      },
    );
  });

  test("rejects platform mode for non-platform hatches", async () => {
    process.argv = [
      "bun",
      "vellum",
      "hatch",
      "--remote",
      "local",
      "--mode",
      "create",
    ];

    await expect(hatch()).rejects.toThrow("process.exit:1");

    expect(stderr).toContain(
      "Error: --mode is only supported with --remote vellum.",
    );
    expect(hatchAssistantMock).not.toHaveBeenCalled();
  });
});
