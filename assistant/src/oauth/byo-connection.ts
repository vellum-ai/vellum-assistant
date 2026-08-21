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
  OAuthCallerAuthScheme,
  OAuthDirectCallerPlan,
} from "./caller-plan.js";
import type {
  OAuthConnection,
  OAuthConnectionRequest,
  OAuthConnectionResponse,
  OAuthPrepareCallerOptions,
} from "./connection.js";
import {
  OAUTH_REQUEST_TIMEOUT_MS,
  parseOAuthFetchResponse,
} from "./oauth-fetch-response.js";

const log = getLogger("byo-oauth-connection");

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
        const built = buildDirectRequest(this.provider, this.baseUrl, req, token);
        log.debug(
          { method: req.method, url: built.logUrl, provider: this.provider },
          "Making authenticated request",
        );

        const resp = await fetch(built.url, {
          method: req.method,
          headers: built.headers,
          body: req.body ? JSON.stringify(req.body) : undefined,
          signal: req.signal
            ? AbortSignal.any([
                req.signal,
                AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
              ])
            : AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
        });

        if (resp.status === 401 && built.authScheme !== "none") {
          // Throw with a status property so withValidToken detects the 401
          // and triggers its refresh-and-retry logic.
          const err = new Error(`HTTP 401 from ${this.provider}`);
          (err as Error & { status: number }).status = 401;
          throw err;
        }

        return parseOAuthFetchResponse(resp);
      },
      { connectionId: this.id },
    );
  }

  async prepareCallerExecution(
    req: OAuthConnectionRequest,
    options?: OAuthPrepareCallerOptions,
  ): Promise<OAuthDirectCallerPlan> {
    return withValidToken(
      this.provider,
      async (token) => {
        const built = buildDirectRequest(this.provider, this.baseUrl, req, token);
        const headers: Record<string, string> = {};
        built.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return {
          mode: "direct",
          method: req.method,
          url: built.url,
          headers,
          ...(req.body ? { body: req.body } : {}),
          authScheme: built.authScheme,
          account: this.accountInfo,
        };
      },
      { connectionId: this.id, forceRefresh: options?.forceRefresh },
    );
  }

  async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    return withValidToken(this.provider, fn, {
      connectionId: this.id,
    });
  }
}

function buildDirectRequest(
  provider: string,
  connectionBaseUrl: string,
  req: OAuthConnectionRequest,
  token: string,
): {
  url: string;
  logUrl: string;
  headers: Headers;
  authScheme: OAuthCallerAuthScheme;
} {
  const effectiveBaseUrl = req.baseUrl ?? connectionBaseUrl;
  const isTelegram = provider === "telegram";
  // Discord bot tokens authenticate with the `Bot ` scheme, not
  // `Bearer`. Sending Bearer here reaches Discord as an unusable
  // credential and comes back 401, which reads as a revoked token.
  const authScheme: OAuthCallerAuthScheme = isTelegram
    ? "none"
    : provider === "discord_channel"
      ? "Bot"
      : "Bearer";
  const requestPath = isTelegram
    ? buildTelegramBotApiPath(req.path, token)
    : req.path;
  let fullUrl = `${effectiveBaseUrl}${requestPath}`;

  if (req.query && Object.keys(req.query).length > 0) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          params.append(key, v);
        }
      } else {
        params.append(key, value);
      }
    }
    fullUrl += `?${params.toString()}`;
  }

  const logUrl = isTelegram
    ? redactTelegramBotTokenFromUrl(fullUrl, token)
    : fullUrl;

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
    headers.set("Authorization", `${authScheme} ${token}`);
  }

  return { url: fullUrl, logUrl, headers, authScheme };
}

function buildTelegramBotApiPath(path: string, token: string): string {
  if (path.startsWith("/bot")) {
    return path;
  }
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
