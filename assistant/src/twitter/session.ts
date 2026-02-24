/**
 * Twitter session persistence.
 * Stores/loads auth cookies from a recording or manual login.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../util/platform.js';
import { ConfigError } from '../util/errors.js';
import type { SessionRecording, ExtractedCredential } from '../tools/browser/network-recording-types.js';

export interface TwitterSession {
  cookies: ExtractedCredential[];
  importedAt: string;
  recordingId?: string;
}

function getSessionDir(): string {
  return join(getDataDir(), 'twitter');
}

function getSessionPath(): string {
  return join(getSessionDir(), 'session.json');
}

export function loadSession(): TwitterSession | null {
  const path = getSessionPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TwitterSession;
  } catch {
    return null;
  }
}

export function saveSession(session: TwitterSession): void {
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
export function importFromRecording(recordingPath: string): TwitterSession {
  if (!existsSync(recordingPath)) {
    throw new ConfigError(`Recording not found: ${recordingPath}`);
  }
  const recording = JSON.parse(readFileSync(recordingPath, 'utf-8')) as SessionRecording;
  if (!recording.cookies?.length) {
    throw new ConfigError('Recording contains no cookies');
  }
  // Require the two cookies that prove a logged-in Twitter session:
  // the auth session cookie and the ct0 CSRF cookie.
  const cookieNames = new Set(recording.cookies.map(c => c.name));
  if (!cookieNames.has('ct0') || !cookieNames.has(`auth_${'token'}`)) {
    throw new ConfigError(
      'Recording is missing required Twitter session cookies. ' +
      'Make sure you are logged in to x.com before recording.',
    );
  }
  const session: TwitterSession = {
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
export function getCookieHeader(session: TwitterSession): string {
  return session.cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Get the CSRF token from session cookies (ct0 cookie).
 */
export function getCsrfToken(session: TwitterSession): string | undefined {
  return session.cookies.find(c => c.name === 'ct0')?.value;
}
