/**
 * Shared cookie-session persistence primitive.
 * Provides session CRUD and recording import logic reusable across
 * providers (Amazon, Twitter, etc.).
 *
 * Sessions are stored in the encrypted credential store under keys of the
 * form `credential:<providerKey>:session:cookies`.
 */

import { existsSync, readFileSync } from "node:fs";

import {
  deleteSecureKey,
  getSecureKey,
  setSecureKey,
} from "../security/secure-keys.js";
import type {
  ExtractedCredential,
  SessionRecording,
} from "../tools/browser/network-recording-types.js";
import { ConfigError } from "./errors.js";

export interface CookieSession {
  cookies: ExtractedCredential[];
}

/**
 * Factory that returns session CRUD operations scoped to a provider-specific
 * credential store key (`credential:<providerKey>:session:cookies`).
 */
export function createSessionStore(providerKey: string): {
  loadSession(): CookieSession | null;
  saveSession(session: CookieSession): void;
  clearSession(): void;
} {
  const credentialKey = `credential:${providerKey}:session:cookies`;

  function loadSession(): CookieSession | null {
    const raw = getSecureKey(credentialKey);
    if (raw === undefined) return null;
    try {
      const parsed = JSON.parse(raw) as ExtractedCredential[];
      return { cookies: parsed };
    } catch {
      return null;
    }
  }

  function saveSession(session: CookieSession): void {
    const ok = setSecureKey(credentialKey, JSON.stringify(session.cookies));
    if (!ok) {
      throw new ConfigError(
        `Failed to save session for provider "${providerKey}"`,
      );
    }
  }

  function clearSession(): void {
    const result = deleteSecureKey(credentialKey);
    // No-op if result is "not-found" — clearing a non-existent session is fine
    if (result === "error") {
      throw new ConfigError(
        `Failed to clear session for provider "${providerKey}"`,
      );
    }
  }

  return { loadSession, saveSession, clearSession };
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
    throw new ConfigError(`Recording not found: ${recordingPath}`);
  }
  const recording = JSON.parse(
    readFileSync(recordingPath, "utf-8"),
  ) as SessionRecording;
  if (!recording.cookies?.length) {
    throw new ConfigError("Recording contains no cookies");
  }

  const cookieNames = new Set(recording.cookies.map((c) => c.name));
  validate(cookieNames);

  return {
    cookies: recording.cookies,
  };
}
