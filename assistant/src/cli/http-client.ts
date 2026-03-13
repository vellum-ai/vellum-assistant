/**
 * HTTP client helpers for the built-in CLI.
 *
 * Provides authenticated HTTP communication with the daemon's HTTP server.
 * Patterns are adapted from `cli/src/lib/http-client.ts` (external CLI).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getRuntimeHttpPort } from "../config/env.js";
import { getRootDir } from "../util/platform.js";

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/**
 * Read the HTTP bearer token from `<rootDir>/http-token`.
 * Returns undefined if the token file doesn't exist or is empty.
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
  const token = readHttpToken();
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
