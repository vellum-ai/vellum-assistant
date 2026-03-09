/**
 * Amazon session persistence.
 * Delegates cookie CRUD to the `assistant credentials` CLI subprocess;
 * keeps Amazon-specific cookie validation and CSRF extraction.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  type CookieSession,
  importFromRecordingBase,
} from "../../../util/cookie-session.js";
import type { ExtractedCredential } from "./client.js";

const execFileAsync = promisify(execFile);

export type AmazonSession = CookieSession;

export async function loadSession(): Promise<AmazonSession | null> {
  try {
    const { stdout } = await execFileAsync("assistant", [
      "credentials",
      "reveal",
      "amazon:session:cookies",
    ]);
    const cookies = JSON.parse(stdout.trim()) as ExtractedCredential[];
    return { cookies };
  } catch {
    return null;
  }
}

export async function saveSession(session: AmazonSession): Promise<void> {
  try {
    await execFileAsync("assistant", [
      "credentials",
      "set",
      "amazon:session:cookies",
      JSON.stringify(session.cookies),
    ]);
  } catch (err) {
    throw new Error(
      `Failed to save Amazon session: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function clearSession(): Promise<void> {
  try {
    await execFileAsync("assistant", [
      "credentials",
      "delete",
      "amazon:session:cookies",
    ]);
  } catch {
    // Clearing a non-existent session is fine — no-op
  }
}

/**
 * Import cookies from a Ride Shotgun recording file.
 * Validates that the recording contains Amazon's required auth cookies.
 */
export async function importFromRecording(
  recordingPath: string,
): Promise<AmazonSession> {
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
  await saveSession(session);
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
