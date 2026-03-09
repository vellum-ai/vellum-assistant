/**
 * Amazon session persistence.
 * Delegates cookie CRUD to the shared cookie-session primitive;
 * keeps Amazon-specific cookie validation and CSRF extraction.
 */

import {
  type CookieSession,
  createSessionStore,
  importFromRecordingBase,
} from "../../../util/cookie-session.js";

export type AmazonSession = CookieSession;

const store = createSessionStore("amazon");

export const { loadSession, saveSession, clearSession } = store;

/**
 * Import cookies from a Ride Shotgun recording file.
 * Validates that the recording contains Amazon's required auth cookies.
 */
export function importFromRecording(recordingPath: string): AmazonSession {
  const session = importFromRecordingBase(recordingPath, (cookieNames) => {
    if (!cookieNames.has("session-id")) {
      throw new Error(
        "Recording is missing required Amazon cookie: session-id. " +
          "Make sure you are logged in to Amazon.",
      );
    }
    if (!cookieNames.has("ubid-main")) {
      throw new Error(
        "Recording is missing required Amazon cookie: ubid-main. " +
          "Make sure you are logged in to Amazon.",
      );
    }
    if (!cookieNames.has("at-main") && !cookieNames.has("x-main")) {
      throw new Error(
        "Recording is missing required Amazon auth cookie (at-main or x-main). " +
          "Make sure you are fully logged in to Amazon.",
      );
    }
  });
  saveSession(session);
  return session;
}

/**
 * Get the anti-CSRF token from session cookies.
 * Amazon uses anti-csrftoken-a2z or csrf-main for cart POST requests.
 */
export function getAntiCsrfToken(session: AmazonSession): string | undefined {
  return (
    session.cookies.find((c) => c.name === "anti-csrftoken-a2z")?.value ??
    session.cookies.find((c) => c.name === "csrf-main")?.value
  );
}
