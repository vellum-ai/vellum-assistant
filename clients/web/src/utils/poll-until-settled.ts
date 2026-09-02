/**
 * The poll loop shared by the browser sign-in flows that hand the daemon a
 * `state` and then wait for it to report the token landing (Connect Claude's
 * loopback capture, the ChatGPT subscription device code).
 *
 * Every one of those flows wants the same four things: a fixed cadence, a
 * bounded budget, transient poll failures ridden out rather than surfaced, and
 * a way for an abandoned flow to stop writing state. Only the request and the
 * phases the outcome maps onto differ, so those are the caller's.
 */

export interface PollStatusResponse {
  status: "pending" | "connected" | "error";
  /** Daemon-supplied detail for `error`, already user-facing. */
  error?: string;
}

export type PollOutcome =
  | { kind: "connected" }
  | { kind: "error"; message?: string }
  /** The budget ran out with the flow still pending. */
  | { kind: "timed_out" }
  /** `isStale` went true: the caller moved on and must not be written to. */
  | { kind: "abandoned" };

export interface PollUntilSettledOptions {
  /** One status request. Rejections are treated as transient. */
  poll: () => Promise<PollStatusResponse>;
  intervalMs: number;
  maxAttempts: number;
  /** True once the flow this loop belongs to has been reset or unmounted. */
  isStale: () => boolean;
}

/**
 * Polls `poll` on `intervalMs` until it settles, the budget runs out, or the
 * flow goes stale. Waits before the first request, since the flow has only
 * just started and cannot be finished yet.
 *
 * Never throws: a rejected `poll` is retried within the remaining budget, so a
 * blip in connectivity does not end a flow the user is still completing.
 */
export async function pollUntilSettled({
  poll,
  intervalMs,
  maxAttempts,
  isStale,
}: PollUntilSettledOptions): Promise<PollOutcome> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (isStale()) {
      return { kind: "abandoned" };
    }
    let result: PollStatusResponse;
    try {
      result = await poll();
    } catch {
      continue;
    }
    if (isStale()) {
      return { kind: "abandoned" };
    }
    if (result.status === "connected") {
      return { kind: "connected" };
    }
    if (result.status === "error") {
      return { kind: "error", message: result.error };
    }
  }
  return { kind: "timed_out" };
}
