import { describe, expect, it } from "bun:test";

import {
  type DoorDashSession,
  getCookieHeader,
  getCsrfToken,
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
