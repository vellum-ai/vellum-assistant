/**
 * Shared Slack Web API transport: the single implementation of request
 * dispatch, rate-limit/5xx retries, envelope checking, and error
 * classification used by both Slack feature surfaces (`api.ts` for
 * streaming/uploads/channel info, `client.ts` for the typed messaging
 * wrappers). Not to be confused with `transport.ts`, the outbound
 * `ChannelTransport` delivery seam.
 *
 * There is exactly ONE `SlackApiError` class, defined here. Callers branch on
 * three fields, all always present:
 *   - `slackError`: Slack's error code (`"channel_not_found"`, ...), or
 *     `"http_<status>"` for HTTP-level failures, or `"unknown_error"`.
 *   - `category`: coarse classification for policy decisions
 *     (`auth` / `rate_limit` / `permission` / ...).
 *   - `status`: HTTP-shaped status for OAuth-refresh compatibility:
 *     explicit HTTP status when the failure was HTTP-level, otherwise derived
 *     from the category (`auth` → 401, `rate_limit` → 429, else 400).
 *     `oauth/connection.js` retry logic and the adapter's user→bot fallback
 *     key on `status === 401`.
 */

import type { OAuthConnection } from "../../../oauth/connection.js";
import { getLogger } from "../../../util/logger.js";
import type { SlackApiResponse } from "./types.js";

const log = getLogger("slack-web-api");

export const SLACK_API_BASE = "https://slack.com/api";
const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_AFTER_S = 1;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type SlackErrorCategory =
  | "auth"
  | "rate_limit"
  | "not_found"
  | "permission"
  | "channel_not_found"
  | "client_error"
  | "transient"
  | "unknown";

const SLACK_ERROR_CODE_MAP: Record<string, SlackErrorCategory> = {
  invalid_auth: "auth",
  token_expired: "auth",
  token_revoked: "auth",
  not_authed: "auth",
  account_inactive: "auth",
  org_login_required: "auth",
  rate_limited: "rate_limit",
  ratelimited: "rate_limit",
  channel_not_found: "channel_not_found",
  is_archived: "channel_not_found",
  not_in_channel: "permission",
  missing_scope: "permission",
  ekm_access_denied: "permission",
  not_allowed_token_type: "permission",
  restricted_action: "permission",
  cannot_dm_bot: "permission",
  user_not_found: "not_found",
  message_not_found: "not_found",
  thread_not_found: "not_found",
  invalid_blocks: "client_error",
};

export function classifySlackError(
  errorCode: string | undefined,
): SlackErrorCategory {
  if (!errorCode) {
    return "unknown";
  }
  return SLACK_ERROR_CODE_MAP[errorCode] ?? "unknown";
}

function deriveStatus(category: SlackErrorCategory): number {
  switch (category) {
    case "auth":
      return 401;
    case "rate_limit":
      return 429;
    default:
      return 400;
  }
}

export class SlackApiError extends Error {
  readonly slackError: string;
  readonly category: SlackErrorCategory;
  readonly status: number;

  constructor(
    slackError: string | undefined,
    opts: { status?: number; message?: string } = {},
  ) {
    const code = slackError ?? "unknown_error";
    super(opts.message ?? `Slack API error: ${code}`);
    this.name = "SlackApiError";
    this.slackError = code;
    this.category = classifySlackError(slackError);
    this.status = opts.status ?? deriveStatus(this.category);
  }
}

// ---------------------------------------------------------------------------
// Envelope checking
// ---------------------------------------------------------------------------

/**
 * Check a Slack API response envelope and throw a classified `SlackApiError`
 * when `ok` is false. Slack reports most failures as HTTP 200 with an error
 * code in the body, so this runs on every successful HTTP exchange.
 */
export function checkSlackEnvelope<T extends SlackApiResponse>(data: T): T {
  if (!data.ok) {
    throw new SlackApiError(data.error);
  }
  return data;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterSeconds(header: string | null): number {
  return parseInt(header ?? "", 10) || DEFAULT_RETRY_AFTER_S;
}

// ---------------------------------------------------------------------------
// Raw-token requests
// ---------------------------------------------------------------------------

export interface SlackRequestOptions {
  /** Query parameters; presence selects GET (unless `body`/`form` is set). */
  query?: Record<string, string | undefined>;
  /** JSON body; presence selects POST with a JSON content type. */
  body?: Record<string, unknown>;
  /** Form body; presence selects POST with form encoding. */
  form?: URLSearchParams;
}

function buildRequest(
  token: string,
  method: string,
  opts: SlackRequestOptions,
): { url: string; init: RequestInit } {
  let url = `${SLACK_API_BASE}/${method}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  if (opts.body) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    return {
      url,
      init: { method: "POST", headers, body: JSON.stringify(opts.body) },
    };
  }
  if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    return { url, init: { method: "POST", headers, body: opts.form } };
  }

  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) {
      searchParams.set(k, v);
    }
  }
  const query = searchParams.toString();
  if (query) {
    url += `?${query}`;
  }
  return { url, init: { method: "GET", headers } };
}

/**
 * Execute a raw-token Slack Web API request with the shared retry policy:
 * HTTP 429 honors `Retry-After`, 5xx retries with fixed backoff, and
 * body-level rate-limit errors (Slack sometimes returns HTTP 200 +
 * `rate_limited`/`ratelimited`) retry via their classified category. All
 * failures throw the unified `SlackApiError`.
 */
export async function rawSlackRequest<T extends SlackApiResponse>(
  token: string,
  method: string,
  opts: SlackRequestOptions = {},
): Promise<T> {
  const { url, init } = buildRequest(token, method, opts);

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const resp = await fetch(url, init);

    if (resp.status === 429) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new SlackApiError("rate_limited", {
          status: 429,
          message: "Slack API rate limited",
        });
      }
      const retryAfter = retryAfterSeconds(resp.headers.get("Retry-After"));
      log.warn({ method, retryAfter, attempt }, "Slack rate limited, retrying");
      await sleepMs(retryAfter * 1000);
      continue;
    }

    if (resp.status >= 500) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new SlackApiError(`http_${resp.status}`, {
          status: resp.status,
          message: `Slack ${method} failed with status ${resp.status} after retries`,
        });
      }
      log.warn(
        { method, status: resp.status, attempt },
        "Slack 5xx error, retrying",
      );
      await sleepMs(DEFAULT_RETRY_AFTER_S * 1000);
      continue;
    }

    if (!resp.ok) {
      throw new SlackApiError(`http_${resp.status}`, {
        status: resp.status,
        message: `Slack API HTTP ${resp.status}`,
      });
    }

    const data = (await resp.json()) as T;

    if (
      !data.ok &&
      classifySlackError(data.error) === "rate_limit" &&
      attempt < MAX_RATE_LIMIT_RETRIES
    ) {
      log.warn(
        { method, slackError: data.error, attempt },
        "Slack rate limited (body), retrying",
      );
      await sleepMs(DEFAULT_RETRY_AFTER_S * 1000);
      continue;
    }

    return checkSlackEnvelope(data);
  }

  // Unreachable: every loop exit path above either returns or throws.
  throw new SlackApiError("rate_limited", {
    status: 429,
    message: "Slack API rate limited",
  });
}

// ---------------------------------------------------------------------------
// OAuth-connection requests
// ---------------------------------------------------------------------------

/**
 * Execute a Slack API request via a refreshing `OAuthConnection`.
 *
 * Slack returns HTTP 200 with `{ ok: false, error: "invalid_auth" }` for auth
 * errors. Because `connection.request()` delegates to `withValidToken`, which
 * only retries HTTP-level 401s, envelope auth errors (classified to
 * `status === 401`) are caught here and retried once via
 * `connection.withToken()`, which forces a token refresh first.
 */
async function connectionSlackRequest<T extends SlackApiResponse>(
  connection: OAuthConnection,
  method: string,
  opts: SlackRequestOptions,
): Promise<T> {
  // `connection.request()` carries only query/body; silently dropping a form
  // payload would send Slack a parameterless request that fails with a
  // misleading Slack-side error. Fail fast instead: form-encoded methods are
  // only reachable on Socket Mode installs, whose auth is a raw token.
  if (opts.form) {
    throw new SlackApiError("form_unsupported_over_oauth", {
      message:
        `Slack ${method} uses a form-encoded body, which is not supported ` +
        "over a legacy OAuth connection; a Socket Mode bot token is required",
    });
  }

  const query: Record<string, string> | undefined = opts.query
    ? Object.fromEntries(
        Object.entries(opts.query).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
    : undefined;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const resp = await connection.request({
      method: opts.body ? "POST" : "GET",
      path: `/${method}`,
      query: query && Object.keys(query).length > 0 ? query : undefined,
      body: opts.body,
    });

    if (resp.status === 429) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new SlackApiError("rate_limited", {
          status: 429,
          message: "Slack API rate limited",
        });
      }
      const retryAfter = retryAfterSeconds(
        resp.headers["retry-after"] ?? resp.headers["Retry-After"] ?? null,
      );
      await sleepMs(retryAfter * 1000);
      continue;
    }

    if (resp.status >= 400) {
      throw new SlackApiError(`http_${resp.status}`, {
        status: resp.status,
        message: `Slack API HTTP ${resp.status}`,
      });
    }

    const data = resp.body as T;

    if (
      !data.ok &&
      classifySlackError(data.error) === "rate_limit" &&
      attempt < MAX_RATE_LIMIT_RETRIES
    ) {
      await sleepMs(DEFAULT_RETRY_AFTER_S * 1000);
      continue;
    }

    try {
      return checkSlackEnvelope(data);
    } catch (err) {
      if (err instanceof SlackApiError && err.status === 401) {
        return connection.withToken((freshToken) =>
          rawSlackRequest<T>(freshToken, method, opts),
        );
      }
      throw err;
    }
  }

  // Unreachable: every loop exit path above either returns or throws.
  throw new SlackApiError("rate_limited", {
    status: 429,
    message: "Slack API rate limited",
  });
}

/**
 * Dispatch a Slack Web API request on whichever auth form the caller holds:
 * a raw token (Socket Mode installs) or a refreshing `OAuthConnection`
 * (legacy OAuth installs).
 */
export async function slackRequest<T extends SlackApiResponse>(
  auth: OAuthConnection | string,
  method: string,
  opts: SlackRequestOptions = {},
): Promise<T> {
  if (typeof auth === "string") {
    return rawSlackRequest<T>(auth, method, opts);
  }
  return connectionSlackRequest<T>(auth, method, opts);
}
