/**
 * Platform-managed Twitter proxy client.
 *
 * Proxies Twitter API calls through the platform instead of calling the
 * Twitter API directly. Used when the Twitter integration is in "managed"
 * mode — the platform holds the OAuth credentials and forwards requests
 * on behalf of the assistant.
 *
 * Prerequisites:
 * - Platform base URL (env `PLATFORM_BASE_URL` or config `platform.baseUrl`)
 * - Auth token (secure key `credential:vellum:assistant_api_key`)
 * - Platform assistant ID (env `PLATFORM_ASSISTANT_ID`)
 */

import { getPlatformAssistantId, getPlatformBaseUrl } from "../config/env.js";
import { getConfig } from "../config/loader.js";
import { getSecureKey } from "../security/secure-keys.js";
import { BackendError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("twitter-proxy");

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class TwitterProxyError extends BackendError {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly statusCode: number = 0,
  ) {
    super(message);
    this.name = "TwitterProxyError";
  }
}

// ---------------------------------------------------------------------------
// Prerequisite resolution
// ---------------------------------------------------------------------------

export interface TwitterProxyPrerequisites {
  platformBaseUrl: string;
  authToken: string;
  platformAssistantId: string;
}

/**
 * Resolve the platform base URL from config or environment.
 * Config `platform.baseUrl` takes precedence over `PLATFORM_BASE_URL` env.
 */
export function resolvePlatformBaseUrl(): string {
  const configUrl = getConfig().platform.baseUrl;
  const envUrl = getPlatformBaseUrl();
  return (configUrl || envUrl).replace(/\/+$/, "");
}

/**
 * Resolve the assistant auth token from secure storage.
 */
export function resolveAuthToken(): string | undefined {
  return getSecureKey("credential:vellum:assistant_api_key");
}

/**
 * Resolve the platform assistant ID from environment.
 */
export function resolvePlatformAssistantId(): string {
  return getPlatformAssistantId();
}

/**
 * Resolve all prerequisites for managed Twitter proxy calls.
 * Throws a descriptive `TwitterProxyError` if any prerequisite is missing.
 */
export function resolvePrerequisites(): TwitterProxyPrerequisites {
  const platformAssistantId = resolvePlatformAssistantId();
  if (!platformAssistantId) {
    throw new TwitterProxyError(
      "Local assistant not registered with platform",
      "missing_platform_assistant_id",
      false,
    );
  }

  const authToken = resolveAuthToken();
  if (!authToken) {
    throw new TwitterProxyError(
      "Assistant not bootstrapped — run setup",
      "missing_assistant_api_key",
      false,
    );
  }

  const platformBaseUrl = resolvePlatformBaseUrl();
  if (!platformBaseUrl) {
    throw new TwitterProxyError(
      "Platform base URL is not configured",
      "missing_platform_base_url",
      false,
    );
  }

  return { platformBaseUrl, authToken, platformAssistantId };
}

// ---------------------------------------------------------------------------
// Proxy request/response types
// ---------------------------------------------------------------------------

export interface TwitterProxyRequest {
  /** HTTP method for the underlying Twitter API call. */
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Twitter API path (e.g. "/2/tweets", "/2/users/me"). */
  path: string;
  /** JSON body for POST/PUT requests. */
  body?: Record<string, unknown>;
  /** Query parameters for GET-style requests. */
  query?: Record<string, string>;
}

export interface TwitterProxyResponse<T = unknown> {
  /** Parsed response data from the Twitter API. */
  data: T;
  /** HTTP status code from the proxy response. */
  status: number;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

export function mapProxyError(
  status: number,
  body: unknown,
): TwitterProxyError {
  const obj =
    typeof body === "object" && body
      ? (body as Record<string, unknown>)
      : undefined;
  const detail = obj?.detail ?? obj?.message ?? obj?.error;
  const detailStr = detail ? String(detail) : `HTTP ${status}`;

  if (status === 424) {
    return new TwitterProxyError(
      "Connect Twitter in Settings — no active credential",
      "credential_required",
      false,
      status,
    );
  }

  if (status === 403) {
    const msg = String(detailStr).toLowerCase();
    if (msg.includes("owner") && msg.includes("credential")) {
      return new TwitterProxyError(
        "Connect Twitter in Settings as the assistant owner",
        "owner_credential_required",
        false,
        status,
      );
    }
    if (msg.includes("owner")) {
      return new TwitterProxyError(
        "Sign in as the assistant owner",
        "owner_only",
        false,
        status,
      );
    }
    return new TwitterProxyError(
      `Forbidden: ${detailStr}`,
      "forbidden",
      false,
      status,
    );
  }

  if (status === 401) {
    return new TwitterProxyError(
      "Reconnect Twitter or retry",
      "auth_failure",
      true,
      status,
    );
  }

  if (status === 502 || status === 503 || status === 504) {
    return new TwitterProxyError(
      "Reconnect Twitter or retry",
      "upstream_failure",
      true,
      status,
    );
  }

  if (status === 429) {
    return new TwitterProxyError(
      "Rate limit exceeded — retry later",
      "rate_limit",
      true,
      status,
    );
  }

  if (status >= 500) {
    return new TwitterProxyError(
      `Platform error: ${detailStr}`,
      "platform_error",
      true,
      status,
    );
  }

  return new TwitterProxyError(
    `Proxy request failed: ${detailStr}`,
    "proxy_error",
    false,
    status,
  );
}

// ---------------------------------------------------------------------------
// Proxy call
// ---------------------------------------------------------------------------

/**
 * Send a Twitter API call through the platform proxy.
 *
 * The proxy endpoint is:
 *   POST {platformBaseURL}/v1/assistants/{platform_assistant_id}/external-provider-proxy/twitter/
 *
 * The request body wraps the Twitter API call in an envelope:
 *   { request: { method, path, body?, query?, headers? }, on_behalf_of_user_id? }
 *
 * The response is an envelope: { status, headers, body } where body is the Twitter payload.
 *
 * Auth uses `Authorization: Api-Key {auth_token}` (the assistant API key).
 */
export async function proxyTwitterCall<T = unknown>(
  request: TwitterProxyRequest,
): Promise<TwitterProxyResponse<T>> {
  const { platformBaseUrl, authToken, platformAssistantId } =
    resolvePrerequisites();

  const url = `${platformBaseUrl}/v1/assistants/${platformAssistantId}/external-provider-proxy/twitter/`;

  const headers: Record<string, string> = {
    Authorization: `Api-Key ${authToken}`,
    "Content-Type": "application/json",
  };

  log.debug(
    { method: request.method, path: request.path },
    "Proxying Twitter API call through platform",
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ request }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const isTimeout =
      err instanceof DOMException && err.name === "TimeoutError";
    throw new TwitterProxyError(
      isTimeout
        ? "Platform proxy request timed out"
        : `Network error: ${err instanceof Error ? err.message : String(err)}`,
      isTimeout ? "timeout" : "network_error",
      true,
    );
  }

  // Platform-level errors (proxy endpoint itself returned non-200)
  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = undefined;
    }
    throw mapProxyError(response.status, errorBody);
  }

  // Parse the proxy envelope
  let envelope: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  try {
    envelope = (await response.json()) as typeof envelope;
  } catch (err) {
    throw new TwitterProxyError(
      `Failed to parse proxy response: ${err instanceof Error ? err.message : String(err)}`,
      "unparseable_response",
      false,
      response.status,
    );
  }

  // Check upstream status from the envelope
  if (envelope.status >= 400) {
    throw mapProxyError(envelope.status, envelope.body);
  }

  return { data: envelope.body as T, status: envelope.status };
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Post a tweet through the platform proxy.
 */
export async function postTweet(
  text: string,
  options?: { replyToId?: string },
): Promise<TwitterProxyResponse> {
  const body: Record<string, unknown> = { text };
  if (options?.replyToId) {
    body.reply = { in_reply_to_tweet_id: options.replyToId };
  }

  return proxyTwitterCall({
    method: "POST",
    path: "/2/tweets",
    body,
  });
}

/**
 * Read the authenticated user's profile through the platform proxy.
 */
export async function getMe(
  query?: Record<string, string>,
): Promise<TwitterProxyResponse> {
  return proxyTwitterCall({
    method: "GET",
    path: "/2/users/me",
    query,
  });
}

/**
 * Look up a user by screen name through the platform proxy.
 */
export async function getUserByUsername(
  username: string,
  query?: Record<string, string>,
): Promise<TwitterProxyResponse> {
  return proxyTwitterCall({
    method: "GET",
    path: `/2/users/by/username/${encodeURIComponent(username)}`,
    query,
  });
}

/**
 * Fetch a user's tweets through the platform proxy.
 */
export async function getUserTweets(
  userId: string,
  query?: Record<string, string>,
): Promise<TwitterProxyResponse> {
  return proxyTwitterCall({
    method: "GET",
    path: `/2/users/${encodeURIComponent(userId)}/tweets`,
    query,
  });
}

/**
 * Fetch a single tweet by ID through the platform proxy.
 */
export async function getTweet(
  tweetId: string,
  query?: Record<string, string>,
): Promise<TwitterProxyResponse> {
  return proxyTwitterCall({
    method: "GET",
    path: `/2/tweets/${encodeURIComponent(tweetId)}`,
    query,
  });
}

/**
 * Search recent tweets through the platform proxy.
 */
export async function searchRecentTweets(
  queryStr: string,
  query?: Record<string, string>,
): Promise<TwitterProxyResponse> {
  return proxyTwitterCall({
    method: "GET",
    path: "/2/tweets/search/recent",
    query: { ...query, query: queryStr },
  });
}
