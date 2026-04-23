import type { UnifiedJobStatus } from "./platform-client.js";

/**
 * Terminal status returned by {@link pollJobUntilDone}. Callers decide
 * whether to treat `failed` as a fatal error or retry logic concern.
 */
export type TerminalJobStatus = Extract<
  UnifiedJobStatus,
  { status: "complete" | "failed" }
>;

export interface PollJobUntilDoneOptions {
  /** Async producer that returns the latest job status. */
  poll: () => Promise<UnifiedJobStatus>;
  /** Sleep between successive polls. Defaults to 2_000 ms. */
  intervalMs?: number;
  /** Maximum wall-clock time to wait. Defaults to 30 minutes. */
  timeoutMs?: number;
  /** Human-readable label used in the timeout error message (e.g. "export job"). */
  label: string;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `options.poll` until it returns a terminal status (`complete` or
 * `failed`), or until `timeoutMs` elapses.
 *
 * On terminal status, returns the status object — including the `failed`
 * case. The caller decides how to treat a failed terminal status (e.g.
 * print the `error` field and exit). Only timeouts throw.
 */
export async function pollJobUntilDone(
  options: PollJobUntilDoneOptions,
): Promise<TerminalJobStatus> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  // First poll happens immediately so fast-path completions don't wait
  // one interval before returning.
  while (true) {
    const status = await options.poll();
    if (status.status === "complete" || status.status === "failed") {
      return status;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${options.label} after ${Math.round(
          timeoutMs / 1000,
        )}s`,
      );
    }

    await sleep(intervalMs);
  }
}
