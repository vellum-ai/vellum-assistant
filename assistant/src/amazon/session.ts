/**
 * Amazon session persistence.
 * Stores/loads auth cookies from a recording or manual login.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type {
  ExtractedCredential,
  SessionRecording,
} from "../tools/browser/network-recording-types.js";
import { getDataDir } from "../util/platform.js";

export interface AmazonSession {
  cookies: ExtractedCredential[];
  importedAt: string;
  recordingId?: string;
}

function getSessionDir(): string {
  return join(getDataDir(), "amazon");
}

function getSessionPath(): string {
  return join(getSessionDir(), "session.json");
}

export function loadSession(): AmazonSession | null {
  const path = getSessionPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AmazonSession;
  } catch {
    return null;
  }
}

export function saveSession(session: AmazonSession): void {
  const dir = getSessionDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getSessionPath(), JSON.stringify(session, null, 2));
}

export function clearSession(): void {
  const path = getSessionPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * Import cookies from a Ride Shotgun recording file.
 * Validates that the recording contains Amazon's required auth cookies.
 */
export function importFromRecording(recordingPath: string): AmazonSession {
  if (!existsSync(recordingPath)) {
    throw new Error(`Recording not found: ${recordingPath}`);
  }
  const recording = JSON.parse(
    readFileSync(recordingPath, "utf-8"),
  ) as SessionRecording;
  if (!recording.cookies?.length) {
    throw new Error("Recording contains no cookies");
  }

  const cookieNames = new Set(recording.cookies.map((c) => c.name));

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

  const session: AmazonSession = {
    cookies: recording.cookies,
    importedAt: new Date().toISOString(),
    recordingId: recording.id,
  };
  saveSession(session);
  return session;
}

/**
 * Build a Cookie header string from the session.
 */
export function getCookieHeader(session: AmazonSession): string {
  return session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
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
