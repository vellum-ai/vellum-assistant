/**
 * HTTP client for CES credential CRUD endpoints.
 *
 * Provides a transport-agnostic HTTP client for communicating with the
 * CES credential management API. Consumers supply a logger and
 * configuration; the module handles auth headers, timeouts, retries,
 * and status mapping.
 *
 * Endpoints (served by `credential-executor/src/http/credential-routes.ts`):
 * - GET    /v1/credentials            -> { accounts: string[] }
 * - GET    /v1/credentials/:account   -> { account, value } | 404
 * - POST   /v1/credentials/:account   -> { ok: true, account }
 * - POST   /v1/credentials/bulk       -> { results: [{ account, ok }] }
 * - DELETE /v1/credentials/:account   -> { ok: true, account } | 404 | 500
 *
 * Auth: Bearer token from a caller-supplied config.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a credential get operation. */
export interface CesCredentialGetResult {
  value: string | undefined;
  unreachable: boolean;
}

/** Result of a credential list operation. */
export interface CesCredentialListResult {
  accounts: string[];
  unreachable: boolean;
}

/** Result of a credential delete operation. */
export type CesDeleteResult = "deleted" | "not-found" | "error";

/** Configuration for the CES HTTP credential client. */
export interface CesHttpCredentialConfig {
  /** Base URL of the CES HTTP API (e.g. `http://ces-container:8090`). */
  baseUrl: string;
  /** Bearer token for authenticating with CES. */
  serviceToken: string;
}

/** Minimal logger interface — callers can supply pino, console, etc. */
export interface CesHttpLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;
const SET_MAX_RETRIES = 3;
const SET_RETRY_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// Internal fetch wrapper
// ---------------------------------------------------------------------------

async function cesRequest(
  config: CesHttpCredentialConfig,
  logger: CesHttpLogger,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | null> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.serviceToken}`,
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
    logger.warn({ err, method, path }, "CES credential request failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// CesHttpCredentialClient
// ---------------------------------------------------------------------------

export interface CesHttpCredentialClient {
  /** Whether the underlying config is present and usable. */
  isAvailable(): boolean;

  /** Retrieve a credential by account name. */
  get(account: string): Promise<CesCredentialGetResult>;

  /** Store or update a credential (retries on transient failures). */
  set(account: string, value: string): Promise<boolean>;

  /** Delete a credential by account name. */
  delete(account: string): Promise<CesDeleteResult>;

  /** Bulk-set multiple credentials in a single request. */
  bulkSet(
    credentials: Array<{ account: string; value: string }>,
  ): Promise<Array<{ account: string; ok: boolean }>>;

  /** List all credential account names. */
  list(): Promise<CesCredentialListResult>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCesHttpCredentialClient(
  config: CesHttpCredentialConfig,
  logger: CesHttpLogger,
): CesHttpCredentialClient {
  return {
    isAvailable(): boolean {
      return !!config.baseUrl && !!config.serviceToken;
    },

    async get(account: string): Promise<CesCredentialGetResult> {
      try {
        const res = await cesRequest(
          config,
          logger,
          "GET",
          `/v1/credentials/${encodeURIComponent(account)}`,
        );
        if (!res) return { value: undefined, unreachable: true };
        if (res.status === 404) return { value: undefined, unreachable: false };
        if (!res.ok) {
          logger.warn(
            { account, status: res.status },
            "CES credential get returned non-OK status",
          );
          return { value: undefined, unreachable: true };
        }
        const data = (await res.json()) as { value?: string };
        return { value: data.value, unreachable: false };
      } catch (err) {
        logger.warn(
          { err, account } as Record<string, unknown>,
          "CES credential get threw unexpectedly",
        );
        return { value: undefined, unreachable: true };
      }
    },

    async set(account: string, value: string): Promise<boolean> {
      for (let attempt = 0; attempt < SET_MAX_RETRIES; attempt++) {
        try {
          const res = await cesRequest(
            config,
            logger,
            "POST",
            `/v1/credentials/${encodeURIComponent(account)}`,
            { value },
          );
          if (!res) {
            if (attempt < SET_MAX_RETRIES - 1) {
              logger.warn(
                { account, attempt },
                "CES credential set got no response, retrying",
              );
              await new Promise((r) => setTimeout(r, SET_RETRY_DELAY_MS));
              continue;
            }
            return false;
          }
          if (!res.ok) {
            const detail = await res.text().catch(() => "");
            if (attempt < SET_MAX_RETRIES - 1) {
              logger.warn(
                { account, status: res.status, detail, attempt },
                "CES credential set returned non-OK status, retrying",
              );
              await new Promise((r) => setTimeout(r, SET_RETRY_DELAY_MS));
              continue;
            }
            logger.warn(
              { account, status: res.status, detail },
              "CES credential set returned non-OK status",
            );
            return false;
          }
          return true;
        } catch (err) {
          if (attempt < SET_MAX_RETRIES - 1) {
            logger.warn(
              { err, account, attempt } as Record<string, unknown>,
              "CES credential set threw, retrying",
            );
            await new Promise((r) => setTimeout(r, SET_RETRY_DELAY_MS));
            continue;
          }
          logger.warn(
            { err, account } as Record<string, unknown>,
            "CES credential set threw unexpectedly",
          );
          return false;
        }
      }
      return false;
    },

    async delete(account: string): Promise<CesDeleteResult> {
      try {
        const res = await cesRequest(
          config,
          logger,
          "DELETE",
          `/v1/credentials/${encodeURIComponent(account)}`,
        );
        if (!res) return "error";
        if (res.status === 404) return "not-found";
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          logger.warn(
            { account, status: res.status, detail },
            "CES credential delete returned non-OK status",
          );
          return "error";
        }
        return "deleted";
      } catch (err) {
        logger.warn(
          { err, account } as Record<string, unknown>,
          "CES credential delete threw unexpectedly",
        );
        return "error";
      }
    },

    async bulkSet(
      credentials: Array<{ account: string; value: string }>,
    ): Promise<Array<{ account: string; ok: boolean }>> {
      try {
        const res = await cesRequest(
          config,
          logger,
          "POST",
          "/v1/credentials/bulk",
          { credentials },
        );
        if (!res?.ok) {
          return credentials.map((c) => ({ account: c.account, ok: false }));
        }
        const data = (await res.json()) as {
          results: Array<{ account: string; ok: boolean }>;
        };
        return data.results;
      } catch (err) {
        logger.warn(
          { err } as Record<string, unknown>,
          "CES credential bulk set threw unexpectedly",
        );
        return credentials.map((c) => ({ account: c.account, ok: false }));
      }
    },

    async list(): Promise<CesCredentialListResult> {
      try {
        const res = await cesRequest(
          config,
          logger,
          "GET",
          "/v1/credentials",
        );
        if (!res) return { accounts: [], unreachable: true };
        if (!res.ok) {
          logger.warn(
            { status: res.status },
            "CES credential list returned non-OK status",
          );
          return { accounts: [], unreachable: true };
        }
        const data = (await res.json()) as { accounts?: string[] };
        return { accounts: data.accounts ?? [], unreachable: false };
      } catch (err) {
        logger.warn(
          { err } as Record<string, unknown>,
          "CES credential list threw unexpectedly",
        );
        return { accounts: [], unreachable: true };
      }
    },
  };
}
