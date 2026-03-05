/**
 * Shared cookie-session persistence primitive.
 * Provides session CRUD, cookie header building, and recording import
 * logic reusable across providers (Amazon, Twitter, etc.).
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
import { getDataDir } from "./platform.js";

export interface CookieSession {
  cookies: ExtractedCredential[];
  importedAt: string;
  recordingId?: string;
}

export interface CookieSessionStore {
  loadSession(): CookieSession | null;
  saveSession(session: CookieSession): void;
  clearSession(): void;
  getCookieHeader(session: CookieSession): string;
}

/**
 * Factory that returns session CRUD operations scoped to a provider-specific
 * data directory (e.g. `~/.vellum/workspace/data/<providerKey>/session.json`).
 */
export function createSessionStore(providerKey: string): CookieSessionStore {
  function getSessionDir(): string {
    return join(getDataDir(), providerKey);
  }

  function getSessionPath(): string {
    return join(getSessionDir(), "session.json");
  }

  function loadSession(): CookieSession | null {
    const path = getSessionPath();
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as CookieSession;
    } catch {
      return null;
    }
  }

  function saveSession(session: CookieSession): void {
    const dir = getSessionDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(getSessionPath(), JSON.stringify(session, null, 2));
  }

  function clearSession(): void {
    const path = getSessionPath();
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  function getCookieHeader(session: CookieSession): string {
    return session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  return { loadSession, saveSession, clearSession, getCookieHeader };
}

/**
 * Parse a Ride Shotgun recording file and build a CookieSession,
 * delegating provider-specific cookie validation to the caller.
 *
 * Does NOT call saveSession — the caller saves after wrapping errors
 * with provider-specific error types if needed.
 */
export function importFromRecordingBase(
  recordingPath: string,
  validate: (cookieNames: Set<string>) => void,
): CookieSession {
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
  validate(cookieNames);

  return {
    cookies: recording.cookies,
    importedAt: new Date().toISOString(),
    recordingId: recording.id,
  };
}
