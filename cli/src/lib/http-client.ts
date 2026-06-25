import { loopbackSafeFetch } from "./loopback-fetch.js";

export type HttpProbeEndpoint = "healthz" | "readyz";

/**
 * Build the base URL for the daemon HTTP server.
 */
export function buildDaemonUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function httpProbe(
  port: number,
  endpoint: HttpProbeEndpoint,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const url = `${buildDaemonUrl(port)}/${endpoint}`;
    const response = await loopbackSafeFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Perform an HTTP health check against the daemon's `/healthz` endpoint.
 * Returns true if the daemon responds with HTTP 200, false otherwise.
 */
export async function httpHealthCheck(
  port: number,
  timeoutMs = 1500,
): Promise<boolean> {
  return httpProbe(port, "healthz", timeoutMs);
}

/**
 * Poll a daemon probe endpoint until it responds with 200 or the timeout is
 * reached.
 *
 * Returns true if the daemon became ready within the timeout, false otherwise.
 */
export async function waitForDaemonReady(
  port: number,
  timeoutMs = 60000,
  endpoint: HttpProbeEndpoint = "healthz",
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await httpProbe(port, endpoint, 1500)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
