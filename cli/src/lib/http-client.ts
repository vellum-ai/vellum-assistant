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

/**
 * Migration-aware daemon readiness, derived from the `/readyz` BODY rather
 * than its status code. The status code is the k8s contract — 200 while
 * migrations run so the pod stays in service, 503 only on migration failure —
 * so `response.ok` alone cannot distinguish "ready" from "still migrating".
 */
export type DaemonReadiness = "ready" | "migrating" | "failed" | "unreachable";

/**
 * Classify a `/readyz` response (daemon-direct or proxied through the
 * gateway, which forwards the assistant's readiness body). Shared by the
 * local daemon probe and the docker upgrade/hatch readiness waits so there is
 * exactly one reader of the readiness wire shape.
 *
 * Any HTTP-answered response proves the daemon is alive, so a non-ready
 * answer without a failed-migrations body classifies as "migrating" — this
 * covers legacy daemons whose strict `/readyz` returns 503 with a `notReady`
 * body throughout startup. "unreachable" is reserved for the no-answer case
 * (the caller's fetch threw).
 */
export function classifyReadyzResponse(
  ok: boolean,
  body: unknown,
): Exclude<DaemonReadiness, "unreachable"> {
  const readiness = body as {
    ready?: boolean;
    dbMigrations?: { state?: string };
  } | null;
  if (readiness?.dbMigrations?.state === "failed") return "failed";
  // A 200 with no explicit `ready: false` counts as ready — this also
  // covers daemons that predate the migration-state body.
  if (ok && readiness?.ready !== false) return "ready";
  return "migrating";
}

/** Single `/readyz` probe, classified from the response body. */
export async function probeDaemonReadiness(
  port: number,
  timeoutMs = 1500,
): Promise<DaemonReadiness> {
  try {
    const response = await loopbackSafeFetch(`${buildDaemonUrl(port)}/readyz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    return classifyReadyzResponse(response.ok, body);
  } catch {
    return "unreachable";
  }
}

/**
 * Poll `/readyz` until the daemon is ready, its migrations have terminally
 * FAILED (returned immediately — failed never recovers without a restart, so
 * waiting out the deadline would be pure delay), or `deadlineMs` passes.
 * Returns the last observed readiness.
 */
export async function waitForDaemonMigrationsReady(
  port: number,
  deadlineMs: number,
): Promise<DaemonReadiness> {
  let last: DaemonReadiness = "unreachable";
  for (;;) {
    last = await probeDaemonReadiness(port);
    if (last === "ready" || last === "failed") return last;
    if (Date.now() >= deadlineMs) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
}
