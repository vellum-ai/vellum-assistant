/**
 * Discord REST client for direct outbound messaging.
 *
 * Calls the Discord HTTP API directly using the `discord_channel:bot_token`
 * credential, the same token the gateway's Discord Gateway client identifies
 * with, read from the secure store rather than passed across the process
 * boundary. Retry and error classification mirror the sibling Telegram client
 * so delivery behaviour is consistent across channels.
 *
 * Wire shapes verified against the official docs:
 *   https://docs.discord.com/developers/resources/message
 *   https://docs.discord.com/developers/topics/rate-limits
 *   https://docs.discord.com/developers/reference
 */

import { credentialKey } from "../../../security/credential-key.js";
import { getSecureKeyResultAsync } from "../../../security/secure-keys.js";
import { BackendUnavailableError, ConfigError } from "../../../util/errors.js";
import { getLogger } from "../../../util/logger.js";
import { computeRetryDelayMs, isRetryableStatus } from "../retry-policy.js";

const log = getLogger("discord-api");

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

/**
 * Discord requires HTTP API clients to identify themselves with a User-Agent
 * of this documented form (`https://docs.discord.com/developers/reference`).
 */
const DISCORD_USER_AGENT =
  "DiscordBot (https://github.com/vellum-ai/vellum-assistant, 1.0)";

const DISCORD_DEFAULT_MAX_RETRIES = 3;
const DISCORD_DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DISCORD_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Cap on a server-advertised `retry_after`. Discord can hand back a multi-hour
 * wait when a bot is globally limited; sleeping that long inside a delivery
 * would hold the per-conversation single-flight open indefinitely. Past this
 * bound the call fails and the channel retry sweep owns the redelivery.
 */
const DISCORD_MAX_RETRY_AFTER_MS = 60_000;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * A Discord REST call that returned a non-retryable client error: a 4xx that
 * is not a 429. The request itself is the problem (the channel, the
 * permissions, or the payload), so retrying the same call is pointless.
 *
 * Callers branch on this type to degrade gracefully, e.g. an attachment that
 * Discord refuses is reported to the channel instead of retried. Branch on the
 * type rather than on Discord's numeric error code: the docs treat that code
 * list as open, and new codes are added without notice.
 */
export class DiscordNonRetryableError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DiscordNonRetryableError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface DiscordErrorBody {
  message?: string;
  retry_after?: number;
  global?: boolean;
}

function parseErrorBody(body: string): DiscordErrorBody {
  try {
    return JSON.parse(body) as DiscordErrorBody;
  } catch {
    return {};
  }
}

/**
 * The wait Discord asked for, as a `Retry-After` seconds value.
 *
 * Discord carries it in the 429 JSON body as well as the header, in seconds
 * (fractional) either way, and the body is the more precise of the two.
 */
function retryAfterFrom(
  response: Response,
  body: DiscordErrorBody,
): string | null {
  if (typeof body.retry_after === "number" && body.retry_after > 0) {
    return String(body.retry_after);
  }
  return response.headers.get("retry-after");
}

/**
 * Run a Discord REST call with retries.
 *
 * Retryable: 429 (rate limited) and 5xx, plus transport failures. Everything
 * else surfaces as {@link DiscordNonRetryableError}.
 *
 * `T | undefined` because an endpoint may answer 204 with no body; callers
 * that need a response shape assert on it themselves.
 */
async function retryableFetch<T>(
  route: string,
  doFetch: () => Promise<Response>,
): Promise<T | undefined> {
  let lastError: Error | null = null;
  let retryAfter: string | null = null;

  for (let attempt = 0; attempt <= DISCORD_DEFAULT_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = computeRetryDelayMs(
        attempt,
        DISCORD_DEFAULT_INITIAL_BACKOFF_MS,
        retryAfter,
        DISCORD_MAX_RETRY_AFTER_MS,
      );
      log.debug({ attempt, delay, route }, "Retrying Discord API call");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    retryAfter = null;

    let response: Response;
    try {
      response = await doFetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = new Error(`Discord ${route} request failed: ${message}`);
      log.warn({ error: message, attempt, route }, "Discord API fetch failed");
      continue;
    }

    if (response.ok) {
      const body = await response.text().catch(() => "");
      // A 204 or any empty body is success with nothing to decode.
      if (!body) {
        return undefined;
      }
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new Error(
          `Discord ${route} returned an unparseable response body`,
        );
      }
    }

    const body = await response.text().catch(() => "");
    const parsed = parseErrorBody(body);
    const detail = parsed.message ?? body;

    if (isRetryableStatus(response.status)) {
      retryAfter = retryAfterFrom(response, parsed);
      lastError = new Error(
        detail
          ? `Discord ${route} failed with status ${response.status}: ${detail}`
          : `Discord ${route} failed with status ${response.status}`,
      );
      log.warn(
        {
          status: response.status,
          attempt,
          route,
          retryAfter,
          global: parsed.global,
        },
        "Discord API returned retryable error",
      );
      continue;
    }

    throw new DiscordNonRetryableError(
      response.status,
      detail
        ? `Discord ${route} failed with status ${response.status}: ${detail}`
        : `Discord ${route} failed with status ${response.status}`,
    );
  }

  throw lastError ?? new Error(`Discord ${route} failed after retries`);
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

async function resolveBotToken(): Promise<string> {
  const result = await getSecureKeyResultAsync(
    credentialKey("discord_channel", "bot_token"),
  );
  if (result.value) {
    return result.value;
  }
  // Distinguish a transient credential-store outage from a token that was
  // genuinely never set. Both surface as an absent value, but only the latter
  // is an operator misconfiguration; the former is retryable infrastructure
  // unavailability that callers should not treat as "not configured".
  if (result.unreachable) {
    throw new BackendUnavailableError("Discord credential store unreachable");
  }
  throw new ConfigError("Discord bot token not configured");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The subset of Discord's message object that delivery reads back. */
export interface DiscordMessage {
  id: string;
}

/** Call a Discord REST route with a JSON body. */
export async function callDiscordApi<T>(
  method: "POST" | "PATCH",
  route: string,
  body: Record<string, unknown>,
): Promise<T | undefined> {
  const botToken = await resolveBotToken();
  return retryableFetch<T>(route, () =>
    fetch(`${DISCORD_API_BASE_URL}${route}`, {
      method,
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
        "User-Agent": DISCORD_USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DISCORD_DEFAULT_TIMEOUT_MS),
    }),
  );
}

/**
 * Call a Discord REST route with a `multipart/form-data` body.
 *
 * Discord's documented upload shape: files ride as `files[n]` parts and the
 * JSON body moves to a `payload_json` part.
 */
export async function callDiscordApiMultipart<T>(
  route: string,
  form: FormData,
): Promise<T | undefined> {
  const botToken = await resolveBotToken();
  return retryableFetch<T>(route, () =>
    fetch(`${DISCORD_API_BASE_URL}${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        // Content-Type is deliberately unset so fetch derives the multipart
        // boundary from the FormData body.
        "User-Agent": DISCORD_USER_AGENT,
      },
      body: form,
      signal: AbortSignal.timeout(DISCORD_DEFAULT_TIMEOUT_MS),
    }),
  );
}
