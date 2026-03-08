/**
 * DoorDash session persistence.
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

import { ConfigError } from "./shared/errors.js";
import { getDataDir } from "./shared/platform.js";
import type {
  ExtractedCredential,
  SessionRecording,
} from "./shared/recording-types.js";

export interface DoorDashSession {
  cookies: ExtractedCredential[];
  importedAt: string;
  recordingId?: string;
}

function getSessionDir(): string {
  return join(getDataDir(), "doordash");
}

function getSessionPath(): string {
  return join(getSessionDir(), "session.json");
}

export function loadSession(): DoorDashSession | null {
  const path = getSessionPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DoorDashSession;
  } catch {
    return null;
  }
}

export function saveSession(session: DoorDashSession): void {
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
 */
export function importFromRecording(recordingPath: string): DoorDashSession {
  if (!existsSync(recordingPath)) {
    throw new ConfigError(`Recording not found: ${recordingPath}`);
  }
  const recording = JSON.parse(
    readFileSync(recordingPath, "utf-8"),
  ) as SessionRecording;
  if (!recording.cookies?.length) {
    throw new ConfigError("Recording contains no cookies");
  }
  const session: DoorDashSession = {
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
export function getCookieHeader(session: DoorDashSession): string {
  return session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Get the CSRF token from session cookies.
 */
export function getCsrfToken(session: DoorDashSession): string | undefined {
  return session.cookies.find((c) => c.name === "csrf_token")?.value;
}
