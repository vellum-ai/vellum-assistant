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

// ---------------------------------------------------------------------------
// Temp directory for lockfile isolation
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "cli-ps-platform-status-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

// ---------------------------------------------------------------------------
// Mocks — set up before importing the command under test. All spies are
// restored in afterAll so we don't leak module state to neighbouring suites.
// ---------------------------------------------------------------------------

import * as assistantConfig from "../lib/assistant-config.js";
import * as healthCheck from "../lib/health-check.js";
import * as orphanDetection from "../lib/orphan-detection.js";
import * as platformClient from "../lib/platform-client.js";

const loadAllAssistantsMock = spyOn(
  assistantConfig,
  "loadAllAssistants",
).mockReturnValue([]);
const getActiveAssistantMock = spyOn(
  assistantConfig,
  "getActiveAssistant",
).mockReturnValue(null);
const detectOrphanedProcessesMock = spyOn(
  orphanDetection,
  "detectOrphanedProcesses",
).mockResolvedValue([]);
const getPlatformUrlMock = spyOn(
  platformClient,
  "getPlatformUrl",
).mockReturnValue("http://platform.test");

// Per-test toggle for `readPlatformToken`.
const readPlatformTokenMock = spyOn(
  platformClient,
  "readPlatformToken",
).mockReturnValue(null);

// `fetchCurrentUser` + `fetchPlatformAssistants` are spied so we can assert
// they're never invoked on the no-token path, and re-shaped per-test for the
// token-but-unreachable path.
const fetchCurrentUserMock = spyOn(
  platformClient,
  "fetchCurrentUser",
).mockResolvedValue({
  id: "u1",
  email: "test@example.com",
  display: "Test",
});
const fetchPlatformAssistantsMock = spyOn(
  platformClient,
  "fetchPlatformAssistants",
).mockResolvedValue([]);
const checkManagedHealthMock = spyOn(
  healthCheck,
  "checkManagedHealth",
).mockResolvedValue({ status: "healthy", detail: null });

// ---------------------------------------------------------------------------
// stdout / stderr capture
// ---------------------------------------------------------------------------

let stdout: string[];
let stderr: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalStdoutWrite: typeof process.stdout.write;

beforeEach(() => {
  stdout = [];
  stderr = [];
  originalLog = console.log;
  originalError = console.error;
  originalStdoutWrite = process.stdout.write;
  console.log = ((...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.stdout.write = originalStdoutWrite;
  loadAllAssistantsMock.mockReturnValue([]);
  getActiveAssistantMock.mockReturnValue(null);
  readPlatformTokenMock.mockReturnValue(null);
  fetchCurrentUserMock.mockReset();
  fetchCurrentUserMock.mockResolvedValue({
    id: "u1",
    email: "test@example.com",
    display: "Test",
  });
  fetchPlatformAssistantsMock.mockReset();
  fetchPlatformAssistantsMock.mockResolvedValue([]);
  checkManagedHealthMock.mockReset();
  checkManagedHealthMock.mockResolvedValue({ status: "healthy", detail: null });
});

afterAll(() => {
  loadAllAssistantsMock.mockRestore();
  getActiveAssistantMock.mockRestore();
  detectOrphanedProcessesMock.mockRestore();
  getPlatformUrlMock.mockRestore();
  readPlatformTokenMock.mockRestore();
  fetchCurrentUserMock.mockRestore();
  fetchPlatformAssistantsMock.mockRestore();
  checkManagedHealthMock.mockRestore();
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Import the command under test AFTER mocks are wired up
// ---------------------------------------------------------------------------

import { listAllAssistants } from "../commands/ps.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("vellum ps — platform status line", () => {
  test("no local token: prints 'Platform: not logged in' and skips ALL network fetches", async () => {
    readPlatformTokenMock.mockReturnValue(null);

    await listAllAssistants(false);

    // The status line is present, exactly once, with no redundant error log.
    expect(stdout.filter((l) => l.startsWith("Platform:"))).toEqual([
      "Platform: not logged in",
    ]);
    expect(stderr.some((l) => l.includes("Failed to fetch organization"))).toBe(
      false,
    );
    expect(stdout.some((l) => l.includes("Failed to fetch organization"))).toBe(
      false,
    );

    // Structural guarantee: we never even tried to talk to the platform.
    expect(fetchCurrentUserMock).not.toHaveBeenCalled();
    expect(fetchPlatformAssistantsMock).not.toHaveBeenCalled();
  });

  test("local token present but platform is unreachable: still shows 'Platform: not logged in' with no leaked org-fetch error", async () => {
    readPlatformTokenMock.mockReturnValue("session_abc123");
    // Simulate the exact Bun connect failure the user reported:
    //   "Unable to connect. Is the computer able to access the url?"
    const connectError = new Error(
      "Unable to connect. Is the computer able to access the url?",
    );
    fetchCurrentUserMock.mockRejectedValue(connectError);
    fetchPlatformAssistantsMock.mockRejectedValue(connectError);

    await listAllAssistants(false);

    expect(stdout.filter((l) => l.startsWith("Platform:"))).toEqual([
      "Platform: not logged in",
    ]);
    expect(stderr.some((l) => l.includes("Failed to fetch organization"))).toBe(
      false,
    );
    expect(stdout.some((l) => l.includes("Failed to fetch organization"))).toBe(
      false,
    );
    expect(stderr.some((l) => l.includes("Unable to connect"))).toBe(false);
  });

  test("local token present and platform reachable: prints 'Platform: logged in as <email>'", async () => {
    readPlatformTokenMock.mockReturnValue("session_abc123");
    fetchCurrentUserMock.mockResolvedValue({
      id: "u1",
      email: "user@example.com",
      display: "Example User",
    });
    fetchPlatformAssistantsMock.mockResolvedValue([]);

    await listAllAssistants(false);

    expect(stdout).toContain("Platform: logged in as user@example.com");
    expect(stderr.some((l) => l.includes("Failed to fetch organization"))).toBe(
      false,
    );
  });

  test("assistant rows use display name as primary label and keep id visible", async () => {
    loadAllAssistantsMock.mockReturnValue([
      {
        assistantId: "assistant-123",
        name: "Alice",
        runtimeUrl: "https://platform.example",
        cloud: "vellum",
        species: "vellum",
      },
    ]);
    getActiveAssistantMock.mockReturnValue("assistant-123");

    await listAllAssistants(false);

    const output = stdout.join("\n");
    expect(output).toContain("* Alice");
    expect(output).toContain("id: assistant-123");
    expect(output).toContain("https://platform.example");
    expect(output).not.toContain("* assistant-123");
  });

  test("assistant list renders one stable final row per assistant", async () => {
    loadAllAssistantsMock.mockReturnValue([
      {
        assistantId: "assistant-123",
        name: "Alice",
        runtimeUrl: "https://platform.example/a",
        cloud: "vellum",
        species: "vellum",
      },
      {
        assistantId: "assistant-456",
        name: "Bob",
        runtimeUrl: "https://platform.example/b",
        cloud: "vellum",
        species: "vellum",
      },
    ]);
    getActiveAssistantMock.mockReturnValue("assistant-123");
    checkManagedHealthMock.mockImplementation(async (_runtimeUrl, id) => ({
      status: id === "assistant-123" ? "healthy" : "sleeping",
      detail: null,
    }));

    await listAllAssistants(false);

    const output = stdout.join("\n");
    expect(output).not.toContain("\x1b[");
    expect(output).not.toContain("checking...");
    expect(output.match(/Alice/g)).toHaveLength(1);
    expect(output.match(/Bob/g)).toHaveLength(1);
    expect(output).toContain("healthy");
    expect(output).toContain("sleeping");
  });
});
