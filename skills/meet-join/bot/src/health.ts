/**
 * Real health probe for the meet-bot container.
 *
 * Invoked by the Dockerfile's HEALTHCHECK directive. Hits the bot's
 * in-process `/health` endpoint on loopback and exits 0 iff the response
 * is HTTP 200 with `{ ok: true }`. Any other outcome (non-2xx, body
 * missing `ok: true`, network error, timeout) exits 1 so Docker marks the
 * container unhealthy.
 *
 * The target port defaults to 3000 (the in-container port the bot binds
 * to) and can be overridden via `HEALTH_PORT` for local runs.
 *
 * This probe deliberately reads its own Bearer token from the
 * `BOT_API_TOKEN` env — the HTTP server requires auth on every route so
 * the daemon can trust the control plane even inside the container.
 */

async function main(): Promise<void> {
  const port = Number(process.env.HEALTH_PORT ?? 3000);
  const token = process.env.BOT_API_TOKEN ?? "";
  const url = `http://127.0.0.1:${port}/health`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status !== 200) {
      process.exit(1);
    }
    const body = (await res.json().catch(() => null)) as {
      ok?: unknown;
    } | null;
    if (!body || body.ok !== true) {
      process.exit(1);
    }
    process.exit(0);
  } catch {
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}

void main();
