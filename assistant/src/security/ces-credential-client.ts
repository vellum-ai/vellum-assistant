/**
 * HTTP client for CES credential CRUD endpoints.
 *
 * Delegates to `@vellumai/ces-client/http-credentials` for the actual
 * HTTP transport and adapts its interface to the assistant's internal
 * `CredentialBackend` contract used by `secure-keys.ts`.
 *
 * In containerized mode the assistant cannot access `keys.enc` directly.
 * Instead, the CES sidecar exposes credential management over HTTP and the
 * assistant talks to it via this client.
 *
 * Auth: Bearer token from `CES_SERVICE_TOKEN` env var.
 * Base URL: `CES_CREDENTIAL_URL` env var (e.g. `http://ces-container:8090`).
 */

import {
  type CesHttpCredentialClient,
  createCesHttpCredentialClient,
} from "@vellumai/ces-client/http-credentials";

import { getLogger } from "../util/logger.js";
import type {
  CredentialBackend,
  CredentialGetResult,
  CredentialListResult,
  DeleteResult,
} from "./credential-backend.js";

const log = getLogger("ces-credential-client");

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
// CesCredentialBackend
// ---------------------------------------------------------------------------

class CesCredentialBackend implements CredentialBackend {
  readonly name = "ces-http";

  private getClient(): CesHttpCredentialClient | undefined {
    const baseUrl = getBaseUrl();
    const serviceToken = getServiceToken();
    if (!baseUrl || !serviceToken) return undefined;
    return createCesHttpCredentialClient({ baseUrl, serviceToken }, log);
  }

  isAvailable(): boolean {
    return !!getBaseUrl() && !!getServiceToken();
  }

  async get(account: string): Promise<CredentialGetResult> {
    const client = this.getClient();
    if (!client) return { value: undefined, unreachable: true };
    return client.get(account);
  }

  async set(account: string, value: string): Promise<boolean> {
    const client = this.getClient();
    if (!client) return false;
    return client.set(account, value);
  }

  async delete(account: string): Promise<DeleteResult> {
    const client = this.getClient();
    if (!client) return "error";
    return client.delete(account);
  }

  async bulkSet(
    credentials: Array<{ account: string; value: string }>,
  ): Promise<Array<{ account: string; ok: boolean }>> {
    const client = this.getClient();
    if (!client) {
      return credentials.map((c) => ({ account: c.account, ok: false }));
    }
    return client.bulkSet(credentials);
  }

  async list(): Promise<CredentialListResult> {
    const client = this.getClient();
    if (!client) return { accounts: [], unreachable: true };
    return client.list();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCesCredentialBackend(): CesCredentialBackend {
  return new CesCredentialBackend();
}
