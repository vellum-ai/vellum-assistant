import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Temp directory for lockfile isolation
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "cli-ps-platform-status-test-"));
process.env.VELLUM_LOCKFILE_DIR = testDir;

// ---------------------------------------------------------------------------
// Mocks — set up before importing the command under test
// ---------------------------------------------------------------------------

import * as assistantConfig from "../lib/assistant-config.js";
import * as orphanDetection from "../lib/orphan-detection.js";
import * as platformClient from "../lib/platform-client.js";

// Empty lockfile keeps the test focused on the "Platform: …" status line; we
// don't care about any per-assistant rendering here.
spyOn(assistantConfig, "loadAllAssistants").mockReturnValue([]);
spyOn(assistantConfig, "getActiveAssistant").mockReturnValue(null);
spyOn(orphanDetection, "detectOrphanedProcesses").mockResolvedValue([]);
spyOn(platformClient, "getPlatformUrl").mockReturnValue(
  "http://platform.test",
);

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

// ---------------------------------------------------------------------------
// stdout / stderr capture
// ---------------------------------------------------------------------------

let stdout: string[];
let stderr: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(() => {
  stdout = [];
  stderr = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = ((...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.error;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  readPlatformTokenMock.mockReturnValue(null);
  fetchCurrentUserMock.mockReset();
  fetchCurrentUserMock.mockResolvedValue({
    id: "u1",
    email: "test@example.com",
    display: "Test",
  });
  fetchPlatformAssistantsMock.mockReset();
  fetchPlatformAssistantsMock.mockResolvedValue([]);
});

afterAll(() => {
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
    expect(
      stderr.some((l) => l.includes("Failed to fetch organization")),
    ).toBe(false);
    expect(
      stdout.some((l) => l.includes("Failed to fetch organization")),
    ).toBe(false);

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
    expect(
      stderr.some((l) => l.includes("Failed to fetch organization")),
    ).toBe(false);
    expect(
      stdout.some((l) => l.includes("Failed to fetch organization")),
    ).toBe(false);
    expect(
      stderr.some((l) => l.includes("Unable to connect")),
    ).toBe(false);
  });

  test("local token present and platform reachable: prints 'Platform: logged in as <email>'", async () => {
    readPlatformTokenMock.mockReturnValue("session_abc123");
    fetchCurrentUserMock.mockResolvedValue({
      id: "u1",
      email: "vargas@vellum.ai",
      display: "Vargas",
    });
    fetchPlatformAssistantsMock.mockResolvedValue([]);

    await listAllAssistants(false);

    expect(stdout).toContain("Platform: logged in as vargas@vellum.ai");
    expect(
      stderr.some((l) => l.includes("Failed to fetch organization")),
    ).toBe(false);
  });
});
