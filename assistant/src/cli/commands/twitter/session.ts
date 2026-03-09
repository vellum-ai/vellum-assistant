/**
 * Twitter session persistence.
 * Delegates to the `assistant credentials` CLI for CRUD;
 * keeps Twitter-specific cookie validation and CSRF extraction.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface TwitterSession {
  cookies: ExtractedCredential[];
}

interface SessionRecording {
  cookies?: ExtractedCredential[];
  targetDomain?: string;
}

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

    const cookieNames = new Set(recording.cookies.map((c) => c.name));

    if (!cookieNames.has("ct0") || !cookieNames.has(`auth_${"token"}`)) {
      throw new ConfigError(
        "Recording is missing required Twitter session cookies. " +
          "Make sure you are logged in to x.com before recording.",
      );
    }

    const session: TwitterSession = { cookies: recording.cookies };
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
 * Import cookies that the daemon saved to the credential store under the
 * target domain key. Validates Twitter-specific required cookies, then
 * copies them to the canonical twitter:session:cookies key.
 */
export async function importFromCredentialStore(
  targetDomain: string,
): Promise<TwitterSession> {
  const { stdout } = await execFileAsync("assistant", [
    "credentials",
    "reveal",
    `${targetDomain}:session:cookies`,
  ]);
  const cookies = JSON.parse(stdout.trim()) as ExtractedCredential[];
  if (!cookies.length) {
    throw new ConfigError("No cookies found in credential store");
  }

  const cookieNames = new Set(cookies.map((c) => c.name));
  if (!cookieNames.has("ct0") || !cookieNames.has(`auth_${"token"}`)) {
    throw new ConfigError(
      "Credential store cookies are missing required Twitter session cookies. " +
        "Make sure you are logged in to x.com before recording.",
    );
  }

  const session: TwitterSession = { cookies };
  await saveSession(session);
  return session;
}

/**
 * Get the CSRF token from session cookies (ct0 cookie).
 */
export function getCsrfToken(session: TwitterSession): string | undefined {
  return session.cookies.find((c) => c.name === "ct0")?.value;
}
