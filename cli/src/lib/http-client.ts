import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { DEFAULT_DAEMON_PORT } from "./constants.js";

/**
 * Resolve the HTTP port for the daemon runtime server.
 * Uses RUNTIME_HTTP_PORT env var, or the default (7821).
 */
export function resolveDaemonPort(overridePort?: number): number {
  if (overridePort !== undefined) return overridePort;
  const envPort = process.env.RUNTIME_HTTP_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return DEFAULT_DAEMON_PORT;
}

/**
 * Build the base URL for the daemon HTTP server.
 */
export function buildDaemonUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Read the HTTP bearer token from `<vellumDir>/http-token`.
 * Respects BASE_DATA_DIR for named instances.
 * Returns undefined if the token file doesn't exist or is empty.
 */
export function readHttpToken(instanceDir?: string): string | undefined {
  const baseDataDir =
    instanceDir ?? (process.env.BASE_DATA_DIR?.trim() || homedir());
  const tokenPath = join(baseDataDir, ".vellum", "http-token");
  try {
    const token = readFileSync(tokenPath, "utf-8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Perform an HTTP health check against the daemon's `/healthz` endpoint.
 * Returns true if the daemon responds with HTTP 200, false otherwise.
 *
 * This replaces the socket-based `isSocketResponsive()` check.
 */
export async function httpHealthCheck(
  port: number,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    const url = `${buildDaemonUrl(port)}/healthz`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Poll the daemon's `/healthz` endpoint until it responds with 200 or the
 * timeout is reached. This replaces `waitForSocketFile()`.
 *
 * Returns true if the daemon became healthy within the timeout, false otherwise.
 */
export async function waitForDaemonReady(
  port: number,
  timeoutMs = 60000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await httpHealthCheck(port)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Make an authenticated HTTP request to the daemon.
 *
 * @param port - The daemon's HTTP port
 * @param path - The request path (e.g. `/v1/sessions`)
 * @param options - Fetch options (method, body, etc.)
 * @param bearerToken - The bearer token for authentication
 * @returns The fetch Response
 */
export async function httpSend(
  port: number,
  path: string,
  options: RequestInit = {},
  bearerToken?: string,
): Promise<Response> {
  const url = `${buildDaemonUrl(port)}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  }
  return fetch(url, {
    ...options,
    headers,
  });
}
