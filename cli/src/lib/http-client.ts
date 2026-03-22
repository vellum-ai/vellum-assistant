/**
 * Build the base URL for the daemon HTTP server.
 */
export function buildDaemonUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
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
 * Poll the gateway's `/readyz` endpoint until it responds with 200 or the
 * timeout is reached.
 *
 * Returns true if the gateway became ready within the timeout, false otherwise.
 */
export async function waitForGatewayReady(
  port: number,
  timeoutMs = 60000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
