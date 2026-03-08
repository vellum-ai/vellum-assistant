/**
 * Twitter session persistence.
 * Delegates to the shared cookie-session primitive for CRUD and cookie header
 * logic; keeps Twitter-specific cookie validation and CSRF extraction.
 */

import type { CookieSession } from "../../../util/cookie-session.js";
import {
  createSessionStore,
  importFromRecordingBase,
} from "../../../util/cookie-session.js";
import { ConfigError } from "../../../util/errors.js";

export type TwitterSession = CookieSession;

const store = createSessionStore("twitter");

export const loadSession: () => TwitterSession | null = store.loadSession;
export const saveSession: (session: TwitterSession) => void = store.saveSession;
export const clearSession: () => void = store.clearSession;
export const getCookieHeader: (session: TwitterSession) => string =
  store.getCookieHeader;

/**
 * Import cookies from a Ride Shotgun recording file.
 */
export function importFromRecording(recordingPath: string): TwitterSession {
  try {
    const session = importFromRecordingBase(recordingPath, (cookieNames) => {
      // Require the two cookies that prove a logged-in Twitter session:
      // the auth session cookie and the ct0 CSRF cookie.
      if (!cookieNames.has("ct0") || !cookieNames.has(`auth_${"token"}`)) {
        throw new ConfigError(
          "Recording is missing required Twitter session cookies. " +
            "Make sure you are logged in to x.com before recording.",
        );
      }
    });
    saveSession(session);
    return session;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Get the CSRF token from session cookies (ct0 cookie).
 */
export function getCsrfToken(session: TwitterSession): string | undefined {
  return session.cookies.find((c) => c.name === "ct0")?.value;
}
