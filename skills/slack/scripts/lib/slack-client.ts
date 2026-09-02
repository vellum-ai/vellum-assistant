#!/usr/bin/env bun

/**
 * Authenticated Slack API client.
 * Uses `assistant oauth request` under the hood for portable OAuth.
 */

export interface SlackRequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  account?: string;
  headers?: Record<string, string>;
}

export interface SlackResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

/** A Slack channel (public or private). */
export interface SlackChannel {
  id: string;
  name: string;
  type: string;
  isPrivate: boolean;
}

/** A Slack user. */
export interface SlackUser {
  id: string;
  name: string;
  displayName?: string;
  email?: string;
}

/** A Slack message. */
export interface SlackMessage {
  ts: string;
  user?: string;
  text: string;
  threadTs?: string;
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;
const IDEMPOTENT_METHODS = new Set([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
  "PATCH",
]);

/**
 * Providers holding a Slack credential, widest reach first.
 *
 * `slack_channel` is the bot and the common case. `slack` is an OAuth
 * connection the user authorized, which is all a workspace has when Slack was
 * connected as an integration without running the setup wizard. Reads and
 * lookups work through either.
 */
const PROVIDERS = ["slack_channel", "slack"] as const;

type SlackProvider = (typeof PROVIDERS)[number];

/**
 * Which provider answered, remembered for the life of the process.
 *
 * Whether a workspace has a bot is an install-level fact, so it is worth
 * settling once rather than paying a failed subprocess on every lookup.
 */
let resolvedProvider: SlackProvider | null = null;

/**
 * Execute an authenticated Slack API request.
 *
 * The first call tries each provider in turn: a request naming one the
 * workspace holds no credential for fails at the CLI rather than coming back
 * as a Slack error, so trying is how this finds out. Later calls go straight
 * to whichever answered.
 */
export async function slackRequest<T = unknown>(
  opts: SlackRequestOptions,
): Promise<SlackResponse<T>> {
  const candidates: readonly SlackProvider[] = resolvedProvider
    ? [resolvedProvider]
    : PROVIDERS;
  let firstError: unknown;
  for (const provider of candidates) {
    try {
      const result = await requestWithProvider<T>(opts, provider);
      resolvedProvider = provider;
      return result;
    } catch (err) {
      // Keep the first failure. A bot-configured workspace needs to see that
      // one; the fallback's "no credential" error would only bury it.
      if (firstError === undefined) {
        firstError = err;
      }
    }
  }
  throw firstError;
}

/**
 * Retries 429 and 5xx errors with exponential backoff for idempotent methods.
 */
async function requestWithProvider<T>(
  opts: SlackRequestOptions,
  provider: SlackProvider,
): Promise<SlackResponse<T>> {
  const method = (opts.method ?? "GET").toUpperCase();
  const canRetry = IDEMPOTENT_METHODS.has(method);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const args: string[] = [
      "assistant",
      "oauth",
      "request",
      "--provider",
      provider,
    ];

    args.push("-X", method);

    if (opts.body !== undefined) {
      args.push("-d", JSON.stringify(opts.body));
      args.push("-H", "Content-Type: application/json");
    }

    if (opts.headers) {
      for (const [key, value] of Object.entries(opts.headers)) {
        args.push("-H", `${key}: ${value}`);
      }
    }

    if (opts.account) {
      args.push("--account", opts.account);
    }

    let path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
    if (opts.query && Object.keys(opts.query).length > 0) {
      const qs = new URLSearchParams(opts.query).toString();
      path += "?" + qs;
    }

    args.push(path);
    args.push("--json");

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, {
        windowsHide: true,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      throw new Error(
        `Failed to spawn assistant oauth request: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    let result: {
      ok: boolean;
      status: number;
      headers: Record<string, string>;
      body: unknown;
    };
    try {
      result = JSON.parse(stdout);
    } catch (err) {
      if (exitCode !== 0) {
        throw new Error(
          `assistant oauth request failed (exit ${exitCode}): ${stderr || stdout}`,
        );
      }
      throw new Error(
        `Failed to parse assistant oauth request output: ${err instanceof Error ? err.message : String(err)}. stdout: ${stdout}`,
      );
    }

    // Retry on 429 (rate limit) and 5xx (server error) for idempotent methods
    const isRetryable =
      result.status === 429 || (result.status >= 500 && result.status < 600);
    if (canRetry && isRetryable && attempt < MAX_RETRIES) {
      const retryAfter = result.headers?.["retry-after"];
      const delayMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    return {
      ok: result.ok,
      status: result.status,
      data: result.body as T,
    };
  }

  // Should not be reached, but satisfy TypeScript
  throw new Error("Retry loop exhausted without returning");
}

/** Convenience wrapper for GET requests. */
export async function slackGet<T = unknown>(
  path: string,
  query?: Record<string, string>,
  account?: string,
): Promise<SlackResponse<T>> {
  return slackRequest<T>({ method: "GET", path, query, account });
}

/** Convenience wrapper for POST requests. */
export async function slackPost<T = unknown>(
  path: string,
  body: unknown,
  account?: string,
): Promise<SlackResponse<T>> {
  return slackRequest<T>({ method: "POST", path, body, account });
}
