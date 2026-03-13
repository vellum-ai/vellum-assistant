import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  type DoorDashSession,
  getCookieHeader,
  getCsrfToken,
  loadSession,
  saveSession,
} from "../lib/session.js";

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
  describe("session persistence", () => {
    it("writes session directory and file with restrictive permissions", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "doordash-session-"));
      const previousDataDir = process.env.VELLUM_DATA_DIR;
      process.env.VELLUM_DATA_DIR = tempDir;

      try {
        saveSession(makeSession());

        const sessionDir = join(tempDir, "doordash");
        const sessionPath = join(sessionDir, "session.json");

        expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
        expect(statSync(sessionPath).mode & 0o777).toBe(0o600);
        expect(loadSession()).not.toBeNull();
      } finally {
        if (previousDataDir === undefined) delete process.env.VELLUM_DATA_DIR;
        else process.env.VELLUM_DATA_DIR = previousDataDir;
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("enforces restrictive permissions when overwriting an existing world-readable file", () => {
      const tempDir = mkdtempSync(
        join(tmpdir(), "doordash-session-overwrite-"),
      );
      const previousDataDir = process.env.VELLUM_DATA_DIR;
      process.env.VELLUM_DATA_DIR = tempDir;

      try {
        // First save creates the file correctly
        saveSession(makeSession());
        // Simulate a pre-existing file with insecure permissions (e.g. created before this fix)
        const sessionPath = join(tempDir, "doordash", "session.json");
        chmodSync(sessionPath, 0o644);
        expect(statSync(sessionPath).mode & 0o777).toBe(0o644);

        // Second save must re-enforce permissions even on overwrite
        saveSession(makeSession());
        expect(statSync(sessionPath).mode & 0o777).toBe(0o600);
      } finally {
        if (previousDataDir === undefined) delete process.env.VELLUM_DATA_DIR;
        else process.env.VELLUM_DATA_DIR = previousDataDir;
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

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
