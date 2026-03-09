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

// Override VELLUM_DATA_DIR to use a temp directory during tests.
// session.ts reads process.env.VELLUM_DATA_DIR directly.
const TEST_DIR = join(tmpdir(), `vellum-dd-test-${process.pid}`);
let originalDataDir: string | undefined;

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
  // by pointing VELLUM_DATA_DIR at a temp directory and testing via
  // importFromRecording which exercises save+load.

  beforeEach(() => {
    originalDataDir = process.env.VELLUM_DATA_DIR;
    process.env.VELLUM_DATA_DIR = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.VELLUM_DATA_DIR;
    } else {
      process.env.VELLUM_DATA_DIR = originalDataDir;
    }
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe("importFromRecording", () => {
    it("throws when the recording file does not exist", async () => {
      await expect(
        importFromRecording("/nonexistent/recording.json"),
      ).rejects.toThrow("Recording not found");
    });

    it("throws when the recording contains no cookies and no targetDomain", async () => {
      const recordingPath = join(TEST_DIR, "empty-recording.json");
      writeFileSync(
        recordingPath,
        JSON.stringify({
          id: "rec-empty",
          startedAt: 0,
          endedAt: 1,
          networkEntries: [],
          cookies: [],
          observations: [],
        }),
      );
      await expect(importFromRecording(recordingPath)).rejects.toThrow(
        "Recording contains no cookies",
      );
    });

    it("successfully imports a recording with cookies", async () => {
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
      const session = await importFromRecording(recordingPath);
      expect(session.cookies).toHaveLength(1);
      expect(session.cookies[0].name).toBe("session_id");
      expect(session.cookies[0].value).toBe("xyz");
      expect(session.recordingId).toBe("rec-valid");
      expect(session.importedAt).toBeTruthy();
    });
  });
});
