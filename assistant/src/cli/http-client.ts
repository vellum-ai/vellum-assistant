/**
 * HTTP client helpers for the built-in CLI.
 *
 * Provides authenticated HTTP communication with the daemon's HTTP server.
 * Patterns are adapted from `cli/src/lib/http-client.ts` (external CLI).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getRuntimeHttpPort } from "../config/env.js";
import { BOOTSTRAPPED_ACTOR_HTTP_TOKEN } from "../security/credential-key.js";
import { getSecureKey } from "../security/secure-keys.js";
import { getRootDir } from "../util/platform.js";

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/**
 * Read the bootstrapped actor HTTP token from the encrypted credential store.
 * Returns undefined if the token has not been persisted yet.
 */
export function readActorHttpToken(): string | undefined {
  const token = getSecureKey(BOOTSTRAPPED_ACTOR_HTTP_TOKEN);
  return token || undefined;
}

/**
 * Read the HTTP bearer token from `<rootDir>/http-token`.
 * Returns undefined if the token file doesn't exist or is empty.
 *
 * @deprecated Use {@link readActorHttpToken} instead, which reads from the
 * encrypted credential store rather than the flat file.
 */
export function readHttpToken(): string | undefined {
  const tokenPath = join(getRootDir(), "http-token");
  try {
    const token = readFileSync(tokenPath, "utf-8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------

/** Build the base URL for the daemon HTTP server. */
export function getHttpBaseUrl(): string {
  return `http://127.0.0.1:${getRuntimeHttpPort()}`;
}

// ---------------------------------------------------------------------------
// Authenticated fetch
// ---------------------------------------------------------------------------

/**
 * Make an authenticated HTTP request to the daemon.
 *
 * @param path   Request path (e.g. `/v1/messages` or `/healthz`)
 * @param init   Standard fetch RequestInit options
 * @returns      The fetch Response
 */
export async function httpSend(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = readActorHttpToken();
  const url = `${getHttpBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return fetch(url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Perform an HTTP health check against the daemon's `/healthz` endpoint.
 * Returns true if the daemon responds with HTTP 200, false otherwise.
 */
export async function httpHealthCheck(timeoutMs = 2000): Promise<boolean> {
  try {
    const url = `${getHttpBaseUrl()}/healthz`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}
