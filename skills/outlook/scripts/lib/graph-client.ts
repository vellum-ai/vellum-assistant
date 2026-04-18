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

/**
 * Execute an authenticated Microsoft Graph API request via `assistant oauth request`.
 */
export async function graphRequest<T = unknown>(
  opts: GraphRequestOptions,
): Promise<GraphResponse<T>> {
  const args: string[] = [
    "assistant",
    "oauth",
    "request",
    "--provider",
    "outlook",
  ];

  const method = opts.method ?? "GET";
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
    path += "?" + new URLSearchParams(opts.query).toString();
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

  // Always attempt to parse stdout JSON first, even on non-zero exit.
  // `assistant oauth request --json` emits structured { ok, status, body }
  // even for HTTP 4xx/5xx responses. Only throw if JSON parsing fails.
  let result: { ok: boolean; status: number; headers: unknown; body: unknown };
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

  return {
    ok: result.ok,
    status: result.status,
    data: result.body as T,
  };
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
