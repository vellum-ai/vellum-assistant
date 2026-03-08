import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  type DoorDashSession,
  getCookieHeader,
  getCsrfToken,
  importFromRecording,
} from "../lib/session.js";

// Override getDataDir to use a temp directory during tests
const TEST_DIR = join(tmpdir(), `vellum-dd-test-${process.pid}`);
let originalDataDir: string | undefined;

// We mock getDataDir by patching the module at the fs level:
// session.ts calls getSessionDir() -> join(getDataDir(), 'doordash')
// We'll test session.ts helpers that don't depend on getDataDir directly,
// and test the persistence functions via the actual file system with a known path.

function makeCookie(
  name: string,
  value: string,
): {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
} {
  return {
    name,
    value,
    domain: ".doordash.com",
    path: "/",
    httpOnly: false,
    secure: false,
  };
}

function makeSession(overrides?: Partial<DoorDashSession>): DoorDashSession {
  return {
    cookies: [
      makeCookie("dd_session", "abc123"),
      makeCookie("csrf_token", "tok456"),
    ],
    importedAt: "2025-01-15T12:00:00.000Z",
    recordingId: "rec-001",
    ...overrides,
  };
}

describe("DoorDash session helpers", () => {
  describe("getCookieHeader", () => {
    it("joins all cookies into a single header string", () => {
      const session = makeSession();
      const header = getCookieHeader(session);
      expect(header).toBe("dd_session=abc123; csrf_token=tok456");
    });

    it("returns empty string for a session with no cookies", () => {
      const session = makeSession({ cookies: [] });
      expect(getCookieHeader(session)).toBe("");
    });

    it("handles a single cookie without trailing semicolons", () => {
      const session = makeSession({ cookies: [makeCookie("a", "1")] });
      expect(getCookieHeader(session)).toBe("a=1");
    });
  });

  describe("getCsrfToken", () => {
    it("extracts the csrf_token value when present", () => {
      const session = makeSession();
      expect(getCsrfToken(session)).toBe("tok456");
    });

    it("returns undefined when csrf_token is absent", () => {
      const session = makeSession({
        cookies: [makeCookie("dd_session", "abc123")],
      });
      expect(getCsrfToken(session)).toBeUndefined();
    });
  });
});

describe("DoorDash session persistence", () => {
  // These tests exercise the real loadSession/saveSession/clearSession
  // by writing to the actual session path. We need to mock getDataDir.
  // Since the module uses a private function we can't easily mock,
  // we test via importFromRecording which exercises save+load.

  beforeEach(() => {
    originalDataDir = process.env.BASE_DATA_DIR;
    process.env.BASE_DATA_DIR = TEST_DIR;
    // Ensure test dir exists
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Restore original BASE_DATA_DIR
    if (originalDataDir === undefined) {
      delete process.env.BASE_DATA_DIR;
    } else {
      process.env.BASE_DATA_DIR = originalDataDir;
    }
    // Clean up test dir
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("importFromRecording", () => {
    it("throws when the recording file does not exist", () => {
      expect(() => importFromRecording("/nonexistent/recording.json")).toThrow(
        "Recording not found",
      );
    });

    it("throws when the recording contains no cookies", () => {
      const recordingPath = join(TEST_DIR, "empty-recording.json");
      writeFileSync(
        recordingPath,
        JSON.stringify({
          id: "rec-empty",
          startedAt: 0,
          endedAt: 1,
          targetDomain: "doordash.com",
          networkEntries: [],
          cookies: [],
          observations: [],
        }),
      );
      expect(() => importFromRecording(recordingPath)).toThrow(
        "Recording contains no cookies",
      );
    });

    it("successfully imports a recording with cookies", () => {
      const recordingPath = join(TEST_DIR, "valid-recording.json");
      writeFileSync(
        recordingPath,
        JSON.stringify({
          id: "rec-valid",
          startedAt: 0,
          endedAt: 1,
          targetDomain: "doordash.com",
          networkEntries: [],
          cookies: [makeCookie("session_id", "xyz")],
          observations: [],
        }),
      );
      const session = importFromRecording(recordingPath);
      expect(session.cookies).toHaveLength(1);
      expect(session.cookies[0].name).toBe("session_id");
      expect(session.cookies[0].value).toBe("xyz");
      expect(session.recordingId).toBe("rec-valid");
      expect(session.importedAt).toBeTruthy();
    });
  });
});
