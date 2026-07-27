/**
 * Drain phase for `vellum sleep --wait`.
 *
 * Arms the assistant's quiesce lease (pausing the START of new background
 * work — heartbeats, schedule claims, memory-job claims), then polls the
 * drain-status endpoint until nothing is in flight. The lease is TTL-bound
 * and refreshed while polling, so a killed CLI can never leave background
 * work paused. The wait narrates what it is waiting on — background jobs can
 * legitimately run for many minutes, and a silent wait is indistinguishable
 * from a hang.
 */

import { loopbackSafeFetch } from "./loopback-fetch.js";

const QUIESCE_TTL_MS = 60_000;
const QUIESCE_REFRESH_INTERVAL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 2_500;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const NARRATE_HEARTBEAT_MS = 15_000;
/** Consecutive failed polls before giving up on the drain. Transient
 * failures (a brief daemon event-loop stall) recover; a wall of failures
 * means the assistant cannot report status and waiting is pointless. */
const MAX_CONSECUTIVE_FAILURES = 10;
/** Consecutive failed lease arms/refreshes before giving up. Without a live
 * lease the claim gates are open and an idle snapshot proves nothing, so an
 * unmaintainable lease makes the drain unsound. */
const MAX_LEASE_FAILURES = 3;

export type DrainOutcome =
  | "drained"
  | "timeout"
  | "unsupported"
  | "unreachable"
  | "cancelled";

interface DrainStatusResponse {
  quiescedUntil: number | null;
  idle: boolean;
  activeConversations: Array<{
    conversationId: string;
    title: string | null;
    originChannel: string | null;
    originInterface: string | null;
    processingStartedAt: number;
  }>;
  memoryJobs: Array<{
    id: string;
    type: string;
    startedAt: number | null;
  }>;
  scheduleRuns: Array<{
    runId: string;
    scheduleName: string | null;
    startedAt: number;
  }>;
  workflowRuns?: Array<{
    runId: string;
    name: string | null;
    startedAt: number | null;
  }>;
  heartbeatRuns?: Array<{
    runId: string;
    startedAt: number;
  }>;
}

export interface DrainOptions {
  baseUrl: string;
  token: string;
  /** Epoch ms to stop waiting at, or null to wait as long as it takes. */
  deadlineAt: number | null;
  /** Aborted on Ctrl-C — releases the lease and returns "cancelled". */
  signal?: AbortSignal;
  pollIntervalMs?: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
}

/**
 * Parse a `--wait` duration: bare seconds (`90`), seconds (`90s`), or
 * minutes (`10m`). Returns milliseconds, or null when not a valid duration.
 */
export function parseWaitDuration(raw: string): number | null {
  const match = /^(\d+)(s|m)?$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(value) || value < 1) {
    return null;
  }
  return match[2] === "m" ? value * 60_000 : value * 1_000;
}

function formatElapsed(sinceMs: number | null, now: number): string {
  if (sinceMs == null) {
    return "just started";
  }
  const totalSeconds = Math.max(0, Math.floor((now - sinceMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

function describeBusyWork(status: DrainStatusResponse, now: number): string[] {
  const items: string[] = [];
  for (const conv of status.activeConversations) {
    const label =
      conv.title != null && conv.title.length > 0
        ? `conversation "${conv.title}"`
        : `background turn (${conv.originInterface ?? conv.originChannel ?? "unknown origin"})`;
    items.push(`${label} (${formatElapsed(conv.processingStartedAt, now)})`);
  }
  for (const job of status.memoryJobs) {
    items.push(`memory ${job.type} (${formatElapsed(job.startedAt, now)})`);
  }
  for (const run of status.scheduleRuns) {
    const label = run.scheduleName ?? run.runId.slice(0, 8);
    items.push(`schedule "${label}" (${formatElapsed(run.startedAt, now)})`);
  }
  for (const run of status.workflowRuns ?? []) {
    const label = run.name ?? run.runId.slice(0, 8);
    items.push(`workflow "${label}" (${formatElapsed(run.startedAt, now)})`);
  }
  for (const run of status.heartbeatRuns ?? []) {
    items.push(`heartbeat (${formatElapsed(run.startedAt, now)})`);
  }
  return items;
}

function busySignature(status: DrainStatusResponse): string {
  return [
    ...status.activeConversations.map((c) => c.conversationId),
    ...status.memoryJobs.map((j) => j.id),
    ...status.scheduleRuns.map((r) => r.runId),
    ...(status.workflowRuns ?? []).map((r) => r.runId),
    ...(status.heartbeatRuns ?? []).map((r) => r.runId),
  ].join("|");
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Wait for the assistant's in-flight background work to finish.
 *
 * Never throws: every failure mode maps onto a {@link DrainOutcome} so the
 * caller can decide how to proceed with the stop.
 */
export async function drainAssistant(
  opts: DrainOptions,
): Promise<DrainOutcome> {
  const fetchImpl = opts.fetchImpl ?? loopbackSafeFetch;
  const log = opts.log ?? console.log;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const base = opts.baseUrl.replace(/\/+$/, "");

  const request = async (
    path: string,
    init: { method: string; body?: string },
  ): Promise<Response> => {
    // Per-request controller aborted by either the request timeout or the
    // caller's cancel signal; listeners are removed per request so a long
    // wait never accumulates them on the shared cancel signal.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onOuterAbort = (): void => controller.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      return await fetchImpl(`${base}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
        },
        ...(init.body !== undefined && { body: init.body }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  };

  const armLease = () =>
    request("/v1/lifecycle/quiesce", {
      method: "POST",
      body: JSON.stringify({ ttlMs: QUIESCE_TTL_MS }),
    });

  const releaseLease = async (): Promise<void> => {
    try {
      await request("/v1/lifecycle/quiesce", { method: "DELETE" });
    } catch {
      // Best-effort — the lease self-expires.
    }
  };

  // Arm the lease before anything else: without it a busy queue keeps
  // claiming new work and the wait never converges.
  let response: Response;
  try {
    response = await armLease();
  } catch {
    if (opts.signal?.aborted) {
      // The abort may have landed after the server persisted the lease, so
      // its outcome is ambiguous — release best-effort rather than leaving
      // background work paused for a TTL on a cancelled sleep.
      await releaseLease();
      return "cancelled";
    }
    return "unreachable";
  }
  if (response.status === 404 || response.status === 405) {
    return "unsupported";
  }
  if (!response.ok) {
    return "unreachable";
  }

  let lastLeaseAt = Date.now();
  let consecutiveFailures = 0;
  let leaseFailureStreak = 0;
  let lastSignature: string | null = null;
  let lastNarratedAt = 0;
  let idleStreak = 0;

  for (;;) {
    if (opts.signal?.aborted) {
      await releaseLease();
      return "cancelled";
    }
    if (opts.deadlineAt != null && Date.now() >= opts.deadlineAt) {
      return "timeout";
    }

    try {
      const statusResponse = await request("/v1/lifecycle/drain-status", {
        method: "GET",
      });
      if (!statusResponse.ok) {
        throw new Error(`drain-status returned ${statusResponse.status}`);
      }
      const status = (await statusResponse.json()) as DrainStatusResponse;
      consecutiveFailures = 0;

      if (status.idle) {
        // Idle only counts under a LIVE lease: with the lease expired the
        // claim gates are open again, so new work invisible to this snapshot
        // could be starting. Re-arm and retry rather than trusting the read.
        const leaseActive =
          status.quiescedUntil != null && status.quiescedUntil > Date.now();
        if (!leaseActive) {
          idleStreak = 0;
          try {
            const rearm = await armLease();
            if (rearm.ok) {
              lastLeaseAt = Date.now();
              leaseFailureStreak = 0;
            } else {
              leaseFailureStreak += 1;
            }
          } catch {
            if (opts.signal?.aborted) {
              await releaseLease();
              return "cancelled";
            }
            leaseFailureStreak += 1;
          }
          if (leaseFailureStreak >= MAX_LEASE_FAILURES) {
            return "unreachable";
          }
          await sleepMs(pollIntervalMs, opts.signal);
          continue;
        }
        // Require two consecutive idle snapshots: work that raced past a
        // pre-lease gate check lands its run row within a tick, so a second
        // read one poll later rules out a stop landing on that window.
        idleStreak += 1;
        if (idleStreak >= 2) {
          return "drained";
        }
        await sleepMs(pollIntervalMs, opts.signal);
        continue;
      }
      idleStreak = 0;

      const now = Date.now();
      const signature = busySignature(status);
      if (
        signature !== lastSignature ||
        now - lastNarratedAt >= NARRATE_HEARTBEAT_MS
      ) {
        const items = describeBusyWork(status, now);
        const shown = items.slice(0, 4);
        const more = items.length - shown.length;
        log(
          `Waiting for the assistant to finish: ${shown.join(", ")}${
            more > 0 ? ` and ${more} more` : ""
          }…`,
        );
        lastSignature = signature;
        lastNarratedAt = now;
      }
    } catch {
      if (opts.signal?.aborted) {
        await releaseLease();
        return "cancelled";
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return "unreachable";
      }
    }

    if (Date.now() - lastLeaseAt >= QUIESCE_REFRESH_INTERVAL_MS) {
      try {
        const refresh = await armLease();
        if (refresh.ok) {
          lastLeaseAt = Date.now();
          leaseFailureStreak = 0;
        } else {
          leaseFailureStreak += 1;
        }
      } catch {
        leaseFailureStreak += 1;
      }
      if (leaseFailureStreak >= MAX_LEASE_FAILURES) {
        return "unreachable";
      }
    }

    await sleepMs(pollIntervalMs, opts.signal);
  }
}
