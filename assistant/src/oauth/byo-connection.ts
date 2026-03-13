/**
 * BYO (Bring-Your-Own) OAuth connection implementation.
 *
 * Wraps the existing `withValidToken` token management infrastructure to
 * provide the OAuthConnection interface. Delegates all token resolution,
 * proactive refresh, circuit breaker, and retry-on-401 logic to
 * `withValidToken` from `token-manager.ts`.
 */

import { withValidToken } from "../security/token-manager.js";
import { getLogger } from "../util/logger.js";
import type {
  OAuthConnection,
  OAuthConnectionRequest,
  OAuthConnectionResponse,
} from "./connection.js";

const log = getLogger("byo-oauth-connection");

/** Default per-request timeout to prevent hung requests from blocking indefinitely. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface BYOOAuthConnectionOptions {
  id: string;
  providerKey: string;
  baseUrl: string;
  accountInfo: string | null;
  grantedScopes: string[];
  credentialService: string;
}

export class BYOOAuthConnection implements OAuthConnection {
  readonly id: string;
  readonly providerKey: string;
  readonly accountInfo: string | null;
  readonly grantedScopes: string[];

  private readonly baseUrl: string;
  private readonly credentialService: string;

  constructor(opts: BYOOAuthConnectionOptions) {
    this.id = opts.id;
    this.providerKey = opts.providerKey;
    this.baseUrl = opts.baseUrl;
    this.accountInfo = opts.accountInfo;
    this.grantedScopes = opts.grantedScopes;
    this.credentialService = opts.credentialService;
  }

  async request(req: OAuthConnectionRequest): Promise<OAuthConnectionResponse> {
    return withValidToken(this.credentialService, async (token) => {
      const effectiveBaseUrl = req.baseUrl ?? this.baseUrl;
      let fullUrl = `${effectiveBaseUrl}${req.path}`;

      if (req.query && Object.keys(req.query).length > 0) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(req.query)) {
          if (Array.isArray(value)) {
            for (const v of value) params.append(key, v);
          } else {
            params.append(key, value);
          }
        }
        fullUrl += `?${params.toString()}`;
      }

      log.debug(
        { method: req.method, url: fullUrl, provider: this.providerKey },
        "Making authenticated request",
      );

      // Use the Headers API for case-insensitive merging. Set defaults
      // first so caller-supplied headers (in any casing) override them.
      const headers = new Headers();
      if (req.body) {
        headers.set("Content-Type", "application/json");
      }
      if (req.headers) {
        for (const [key, value] of Object.entries(req.headers)) {
          headers.set(key, value);
        }
      }
      headers.set("Authorization", `Bearer ${token}`);

      const resp = await fetch(fullUrl, {
        method: req.method,
        headers,
        body: req.body ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (resp.status === 401) {
        // Throw with a status property so withValidToken detects the 401
        // and triggers its refresh-and-retry logic.
        const err = new Error(`HTTP 401 from ${this.providerKey}`);
        (err as Error & { status: number }).status = 401;
        throw err;
      }

      return buildResponse(resp);
    });
  }

  async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    return withValidToken(this.credentialService, fn);
  }
}

async function buildResponse(resp: Response): Promise<OAuthConnectionResponse> {
  const headers: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let body: unknown;
  const text = await resp.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } else {
    body = null;
  }

  return { status: resp.status, headers, body };
}
