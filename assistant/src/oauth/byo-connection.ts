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
  provider: string;
  baseUrl: string;
  accountInfo: string | null;
}

export class BYOOAuthConnection implements OAuthConnection {
  readonly id: string;
  readonly provider: string;
  readonly accountInfo: string | null;

  private readonly baseUrl: string;

  constructor(opts: BYOOAuthConnectionOptions) {
    this.id = opts.id;
    this.provider = opts.provider;
    this.baseUrl = opts.baseUrl;
    this.accountInfo = opts.accountInfo;
  }

  async request(req: OAuthConnectionRequest): Promise<OAuthConnectionResponse> {
    return withValidToken(
      this.provider,
      async (token) => {
        const effectiveBaseUrl = req.baseUrl ?? this.baseUrl;
        const isTelegram = this.provider === "telegram";
        const requestPath = isTelegram
          ? buildTelegramBotApiPath(req.path, token)
          : req.path;
        let fullUrl = `${effectiveBaseUrl}${requestPath}`;

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

        const logUrl = isTelegram
          ? redactTelegramBotTokenFromUrl(fullUrl, token)
          : fullUrl;

        log.debug(
          { method: req.method, url: logUrl, provider: this.provider },
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
        if (!isTelegram) {
          headers.set("Authorization", `Bearer ${token}`);
        }

        const resp = await fetch(fullUrl, {
          method: req.method,
          headers,
          body: req.body ? JSON.stringify(req.body) : undefined,
          signal: req.signal
            ? AbortSignal.any([
                req.signal,
                AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              ])
            : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (resp.status === 401 && !isTelegram) {
          // Throw with a status property so withValidToken detects the 401
          // and triggers its refresh-and-retry logic.
          const err = new Error(`HTTP 401 from ${this.provider}`);
          (err as Error & { status: number }).status = 401;
          throw err;
        }

        return buildResponse(resp);
      },
      { connectionId: this.id },
    );
  }

  async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    return withValidToken(this.provider, fn, {
      connectionId: this.id,
    });
  }
}

function buildTelegramBotApiPath(path: string, token: string): string {
  if (path.startsWith("/bot")) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `/bot${token}${normalizedPath}`;
}

function redactTelegramBotTokenFromUrl(url: string, token: string): string {
  const redactedStoredToken = url.split(token).join("[REDACTED]");
  return redactedStoredToken.replace(
    /\/bot[^/?#]+(?=\/|[?#]|$)/g,
    "/bot[REDACTED]",
  );
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
