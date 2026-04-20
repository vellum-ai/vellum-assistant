#!/usr/bin/env bun

/**
 * Authenticated Gmail API client.
 * Uses `assistant oauth request` under the hood for portable OAuth.
 */

export interface GmailRequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  account?: string;
  headers?: Record<string, string>;
  /** Raw query string to append after the standard query params (e.g. repeated params). */
  pathSuffix?: string;
}

export interface GmailResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    parts?: GmailMessagePart[];
    body?: { data?: string; attachmentId?: string; size?: number };
  };
  labelIds?: string[];
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailMessagePart[];
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
const BATCH_CONCURRENCY = 10;

/**
 * Execute an authenticated Gmail API request via `assistant oauth request`.
 * Retries 429 and 5xx errors with exponential backoff for idempotent methods.
 */
export async function gmailRequest<T = unknown>(
  opts: GmailRequestOptions,
): Promise<GmailResponse<T>> {
  const method = (opts.method ?? "GET").toUpperCase();
  const canRetry = IDEMPOTENT_METHODS.has(method);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const args: string[] = [
      "assistant",
      "oauth",
      "request",
      "--provider",
      "google",
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

    let path = opts.path;
    if (opts.query && Object.keys(opts.query).length > 0) {
      const qs = new URLSearchParams(opts.query).toString();
      path += "?" + qs;
    }
    if (opts.pathSuffix) {
      path += path.includes("?")
        ? opts.pathSuffix
        : "?" + opts.pathSuffix.replace(/^&/, "");
    }

    args.push(path);
    args.push("--json");

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
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
export async function gmailGet<T = unknown>(
  path: string,
  query?: Record<string, string>,
  account?: string,
): Promise<GmailResponse<T>> {
  return gmailRequest<T>({ method: "GET", path, query, account });
}

/** Convenience wrapper for POST requests. */
export async function gmailPost<T = unknown>(
  path: string,
  body: unknown,
  account?: string,
): Promise<GmailResponse<T>> {
  return gmailRequest<T>({ method: "POST", path, body, account });
}

/** Convenience wrapper for PUT requests. */
export async function gmailPut<T = unknown>(
  path: string,
  body: unknown,
  account?: string,
): Promise<GmailResponse<T>> {
  return gmailRequest<T>({ method: "PUT", path, body, account });
}

/** Convenience wrapper for DELETE requests. */
export async function gmailDelete(
  path: string,
  account?: string,
): Promise<GmailResponse<void>> {
  return gmailRequest<void>({ method: "DELETE", path, account });
}

/**
 * Fetch multiple messages individually with bounded concurrency.
 * Processes messages in waves of BATCH_CONCURRENCY (10) at a time.
 * Supports AbortSignal for cancellation between waves.
 */
export async function batchFetchMessages(
  messageIds: string[],
  format: string,
  metadataHeaders?: string[],
  account?: string,
  signal?: AbortSignal,
  fields?: string,
): Promise<GmailMessage[]> {
  const results: GmailMessage[] = [];

  for (let i = 0; i < messageIds.length; i += BATCH_CONCURRENCY) {
    if (signal?.aborted) break;

    const wave = messageIds.slice(i, i + BATCH_CONCURRENCY);
    const waveResults = await Promise.all(
      wave.map(async (id) => {
        const query: Record<string, string> = { format };
        if (fields) {
          query.fields = fields;
        }

        // Build metadataHeaders as repeated query params to avoid
        // URL-encoding issues with comma-separated values.
        // Gmail API expects: metadataHeaders=From&metadataHeaders=Subject
        // NOT: metadataHeaders=From%2CSubject
        let pathSuffix = "";
        if (metadataHeaders && metadataHeaders.length > 0) {
          pathSuffix = metadataHeaders
            .map((h) => `&metadataHeaders=${encodeURIComponent(h)}`)
            .join("");
        }

        const response = await gmailRequest<GmailMessage>({
          method: "GET",
          path: `/messages/${id}`,
          query,
          account,
          pathSuffix,
        });
        return response.ok ? response.data : null;
      }),
    );

    for (const msg of waveResults) {
      if (msg) results.push(msg);
    }
  }

  return results;
}
