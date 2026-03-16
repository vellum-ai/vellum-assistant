/**
 * DoorDash session persistence.
 * Stores/loads auth cookies via the credential store.
 */

import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { ConfigError } from "./shared/errors.js";
import type { ExtractedCredential } from "./shared/recording-types.js";

const execFileAsync = promisify(execFile);
const SESSION_DIR_MODE = 0o700;
const SESSION_FILE_MODE = 0o600;

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
    chmodSync(path, SESSION_FILE_MODE);
    return JSON.parse(readFileSync(path, "utf-8")) as DoorDashSession;
  } catch {
    return null;
  }
}

export function saveSession(session: DoorDashSession): void {
  const dir = getSessionDir();
  if (!existsSync(dir))
    mkdirSync(dir, { recursive: true, mode: SESSION_DIR_MODE });
  else chmodSync(dir, SESSION_DIR_MODE);
  writeFileSync(getSessionPath(), JSON.stringify(session, null, 2), {
    mode: SESSION_FILE_MODE,
  });
  chmodSync(getSessionPath(), SESSION_FILE_MODE);
}

export function clearSession(): void {
  const path = getSessionPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * Import cookies that the daemon saved to the credential store under the
 * target domain key. Copies them into the local DoorDash session file.
 *
 * NOTE: This depends on the daemon having already written cookies to the
 * credential store before this function is called. The daemon writes cookies
 * asynchronously during the learn session, so callers should only invoke this
 * after the learn session has completed (status === "completed").
 */
export async function importFromCredentialStore(
  targetDomain: string,
  opts?: { recordingId?: string },
): Promise<DoorDashSession> {
  const { stdout } = await execFileAsync("assistant", [
    "credentials",
    "reveal",
    "--service",
    targetDomain,
    "--field",
    "session:cookies",
  ]);
  const cookies = JSON.parse(stdout.trim()) as ExtractedCredential[];
  if (!cookies.length) {
    throw new ConfigError("No cookies found in credential store");
  }

  const session: DoorDashSession = {
    cookies,
    importedAt: new Date().toISOString(),
    recordingId: opts?.recordingId,
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
