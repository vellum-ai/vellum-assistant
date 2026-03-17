/**
 * Amazon session persistence.
 * Delegates cookie CRUD to the `assistant credentials` CLI subprocess;
 * keeps Amazon-specific cookie validation and CSRF extraction.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ExtractedCredential } from "./client.js";

const execFileAsync = promisify(execFile);

export interface AmazonSession {
  cookies: ExtractedCredential[];
}

export async function loadSession(): Promise<AmazonSession | null> {
  try {
    const { stdout } = await execFileAsync("assistant", [
      "credentials",
      "reveal",
      "--service",
      "amazon",
      "--field",
      "session:cookies",
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
      "--service",
      "amazon",
      "--field",
      "session:cookies",
      JSON.stringify(session.cookies),
    ]);
  } catch (err) {
    throw new Error(
      `Failed to save Amazon session: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export async function clearSession(): Promise<void> {
  try {
    await execFileAsync("assistant", [
      "credentials",
      "delete",
      "--service",
      "amazon",
      "--field",
      "session:cookies",
    ]);
  } catch {
    // Clearing a non-existent session is fine - no-op
  }
}

/**
 * Import cookies that the assistant saved to the credential store under the
 * target domain key. Validates Amazon-specific required cookies, then
 * copies them to the canonical amazon:session:cookies key.
 */
export async function importFromCredentialStore(
  targetDomain: string,
): Promise<AmazonSession> {
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
    throw new Error("No cookies found in credential store");
  }

  const cookieNames = new Set(cookies.map((c) => c.name));
  if (!cookieNames.has("session-id")) {
    throw new Error(
      "Credential store cookies are missing required Amazon cookie: session-id.",
    );
  }
  if (!cookieNames.has("ubid-main")) {
    throw new Error(
      "Credential store cookies are missing required Amazon cookie: ubid-main.",
    );
  }
  if (!cookieNames.has("at-main") && !cookieNames.has("x-main")) {
    throw new Error(
      "Credential store cookies are missing required Amazon auth cookie (at-main or x-main).",
    );
  }

  const session: AmazonSession = { cookies };
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
