/**
 * DoorDash session persistence.
 * Stores/loads auth cookies from a recording or manual login.
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { ConfigError } from "./shared/errors.js";
import type {
  ExtractedCredential,
  SessionRecording,
} from "./shared/recording-types.js";

const execFileAsync = promisify(execFile);

export interface DoorDashSession {
  cookies: ExtractedCredential[];
  importedAt: string;
  recordingId?: string;
}

function getSessionDir(): string {
  return join(process.env.VELLUM_DATA_DIR!, "doordash");
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
export async function importFromRecording(
  recordingPath: string,
): Promise<DoorDashSession> {
  if (!existsSync(recordingPath)) {
    throw new ConfigError(`Recording not found: ${recordingPath}`);
  }
  const recording = JSON.parse(
    readFileSync(recordingPath, "utf-8"),
  ) as SessionRecording;
  if (!recording.cookies?.length) {
    if (recording.targetDomain) {
      return importFromCredentialStore(recording.targetDomain);
    }
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
 * Import cookies that the daemon saved to the credential store under the
 * target domain key. Copies them into the local DoorDash session file.
 */
export async function importFromCredentialStore(
  targetDomain: string,
): Promise<DoorDashSession> {
  const { stdout } = await execFileAsync("assistant", [
    "credentials",
    "reveal",
    `${targetDomain}:session:cookies`,
  ]);
  const cookies = JSON.parse(stdout.trim()) as ExtractedCredential[];
  if (!cookies.length) {
    throw new ConfigError("No cookies found in credential store");
  }

  const session: DoorDashSession = {
    cookies,
    importedAt: new Date().toISOString(),
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
