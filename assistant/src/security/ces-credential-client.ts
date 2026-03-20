/**
 * HTTP client for CES credential CRUD endpoints.
 *
 * In containerized mode the assistant cannot access `keys.enc` directly.
 * Instead, the CES sidecar exposes credential management over HTTP and the
 * assistant talks to it via this client.
 *
 * Endpoints (served by `credential-executor/src/http/credential-routes.ts`):
 * - GET  /v1/credentials           → { accounts: string[] }
 * - GET  /v1/credentials/:account  → { account, value } | 404
 * - POST /v1/credentials/:account  → { ok: true, account }
 * - DELETE /v1/credentials/:account → { ok: true, account } | 404 | 500
 *
 * Auth: Bearer token from `CES_SERVICE_TOKEN` env var.
 * Base URL: `CES_CREDENTIAL_URL` env var (e.g. `http://ces-container:8090`).
 */

import { getLogger } from "../util/logger.js";
import type { CredentialBackend, DeleteResult } from "./credential-backend.js";

const log = getLogger("ces-credential-client");

const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function getBaseUrl(): string | undefined {
  return process.env.CES_CREDENTIAL_URL;
}

function getServiceToken(): string | undefined {
  return process.env.CES_SERVICE_TOKEN;
}

// ---------------------------------------------------------------------------
// Internal fetch wrapper
// ---------------------------------------------------------------------------

async function cesRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | null> {
  const baseUrl = getBaseUrl();
  const token = getServiceToken();
  if (!baseUrl || !token) return null;

  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  try {
    return await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn({ err, method, path }, "CES credential request failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// CesCredentialBackend
// ---------------------------------------------------------------------------

export class CesCredentialBackend implements CredentialBackend {
  readonly name = "ces-http";

  isAvailable(): boolean {
    return !!getBaseUrl() && !!getServiceToken();
  }

  async get(account: string): Promise<string | undefined> {
    try {
      const res = await cesRequest(
        "GET",
        `/v1/credentials/${encodeURIComponent(account)}`,
      );
      if (!res) return undefined;
      if (res.status === 404) return undefined;
      if (!res.ok) {
        log.warn(
          { account, status: res.status },
          "CES credential get returned non-OK status",
        );
        return undefined;
      }
      const data = (await res.json()) as { value?: string };
      return data.value;
    } catch (err) {
      log.warn({ err, account }, "CES credential get threw unexpectedly");
      return undefined;
    }
  }

  async set(account: string, value: string): Promise<boolean> {
    try {
      const res = await cesRequest(
        "POST",
        `/v1/credentials/${encodeURIComponent(account)}`,
        { value },
      );
      if (!res) return false;
      if (!res.ok) {
        log.warn(
          { account, status: res.status },
          "CES credential set returned non-OK status",
        );
        return false;
      }
      return true;
    } catch (err) {
      log.warn({ err, account }, "CES credential set threw unexpectedly");
      return false;
    }
  }

  async delete(account: string): Promise<DeleteResult> {
    try {
      const res = await cesRequest(
        "DELETE",
        `/v1/credentials/${encodeURIComponent(account)}`,
      );
      if (!res) return "error";
      if (res.status === 404) return "not-found";
      if (!res.ok) {
        log.warn(
          { account, status: res.status },
          "CES credential delete returned non-OK status",
        );
        return "error";
      }
      return "deleted";
    } catch (err) {
      log.warn({ err, account }, "CES credential delete threw unexpectedly");
      return "error";
    }
  }

  async list(): Promise<string[]> {
    try {
      const res = await cesRequest("GET", "/v1/credentials");
      if (!res) return [];
      if (!res.ok) {
        log.warn(
          { status: res.status },
          "CES credential list returned non-OK status",
        );
        return [];
      }
      const data = (await res.json()) as { accounts?: string[] };
      return data.accounts ?? [];
    } catch (err) {
      log.warn({ err }, "CES credential list threw unexpectedly");
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCesCredentialBackend(): CesCredentialBackend {
  return new CesCredentialBackend();
}
