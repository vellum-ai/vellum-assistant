#!/usr/bin/env bun

/**
 * Authenticated Microsoft Graph API client.
 * Uses `assistant oauth request` under the hood for portable OAuth.
 */

export interface GraphRequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  account?: string;
  headers?: Record<string, string>;
}

export interface GraphResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
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
 * Execute an authenticated Microsoft Graph API request via `assistant oauth request`.
 * Retries 429 and 5xx errors with exponential backoff for idempotent methods.
 */
export async function graphRequest<T = unknown>(
  opts: GraphRequestOptions,
): Promise<GraphResponse<T>> {
  const method = (opts.method ?? "GET").toUpperCase();
  const canRetry = IDEMPOTENT_METHODS.has(method);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const args: string[] = [
      "assistant",
      "oauth",
      "request",
      "--provider",
      "outlook",
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
      // Build query string manually to preserve OData $ prefixes.
      // URLSearchParams encodes $ as %24, which breaks Graph API OData params.
      const qs = Object.entries(opts.query)
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k).replace(/%24/gi, "$")}=${encodeURIComponent(v)}`,
        )
        .join("&");
      path += "?" + qs;
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
export async function graphGet<T = unknown>(
  path: string,
  query?: Record<string, string>,
  account?: string,
): Promise<GraphResponse<T>> {
  return graphRequest<T>({ method: "GET", path, query, account });
}

/** Convenience wrapper for POST requests. */
export async function graphPost<T = unknown>(
  path: string,
  body: unknown,
  account?: string,
): Promise<GraphResponse<T>> {
  return graphRequest<T>({ method: "POST", path, body, account });
}

/** Convenience wrapper for PATCH requests. */
export async function graphPatch<T = unknown>(
  path: string,
  body: unknown,
  account?: string,
): Promise<GraphResponse<T>> {
  return graphRequest<T>({ method: "PATCH", path, body, account });
}

/** Convenience wrapper for DELETE requests. */
export async function graphDelete(
  path: string,
  account?: string,
): Promise<GraphResponse<void>> {
  return graphRequest<void>({ method: "DELETE", path, account });
}

export type { GraphResponse, GraphRequestOptions };
