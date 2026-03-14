/**
 * HTTP client helpers for the built-in CLI.
 *
 * Provides authenticated HTTP communication with the daemon's HTTP server.
 * Patterns are adapted from `cli/src/lib/http-client.ts` (external CLI).
 */

import { getRuntimeHttpPort } from "../config/env.js";
import { CURRENT_POLICY_EPOCH } from "../runtime/auth/policy.js";
import {
  initAuthSigningKey,
  isSigningKeyInitialized,
  loadOrCreateSigningKey,
  mintToken,
} from "../runtime/auth/token-service.js";

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/**
 * Mint a short-lived CLI JWT from the signing key on disk.
 * Returns undefined if the signing key cannot be loaded.
 */
function mintCliToken(): string | undefined {
  try {
    if (!isSigningKeyInitialized()) {
      initAuthSigningKey(loadOrCreateSigningKey());
    }
    return mintToken({
      aud: "vellum-gateway",
      sub: "local:cli:cli",
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 300,
    });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------

/** Build the base URL for the daemon HTTP server. */
function getHttpBaseUrl(): string {
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
  const token = mintCliToken();
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
