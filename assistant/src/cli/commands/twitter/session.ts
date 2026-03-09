/**
 * Twitter session persistence.
 * Delegates to the `assistant credentials` CLI for CRUD;
 * keeps Twitter-specific cookie validation and CSRF extraction.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import type { CookieSession } from "../../../util/cookie-session.js";
import { importFromRecordingBase } from "../../../util/cookie-session.js";

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type TwitterSession = CookieSession;

interface ExtractedCredential {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  expires?: number;
}

export async function loadSession(): Promise<TwitterSession | null> {
  try {
    const { stdout } = await execFileAsync("assistant", [
      "credentials",
      "reveal",
      "twitter:session:cookies",
    ]);
    const cookies = JSON.parse(stdout.trim()) as ExtractedCredential[];
    return { cookies };
  } catch {
    return null;
  }
}

export async function saveSession(session: TwitterSession): Promise<void> {
  try {
    await execFileAsync("assistant", [
      "credentials",
      "set",
      "twitter:session:cookies",
      JSON.stringify(session.cookies),
    ]);
  } catch (err) {
    throw new ConfigError(
      `Failed to save Twitter session: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function clearSession(): Promise<void> {
  try {
    await execFileAsync("assistant", [
      "credentials",
      "delete",
      "twitter:session:cookies",
    ]);
  } catch {
    // Clearing a non-existent session is fine — no-op
  }
}

/**
 * Import cookies from a Ride Shotgun recording file.
 */
export async function importFromRecording(
  recordingPath: string,
): Promise<TwitterSession> {
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
    await saveSession(session);
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
