/**
 * Tests for `runWithRequestTimeout` - the client-side bound on a single
 * request.
 *
 * A request that settles in time passes through untouched; one that outlives
 * the bound rejects with `RequestTimeoutError` and aborts the work it wrapped;
 * an abort from the surrounding lifecycle is forwarded to the request and
 * settles the call even when the request ignores its signal.
 */

import { describe, expect, test } from "bun:test";

import {
  RequestAbortedError,
  RequestTimeoutError,
  runWithRequestTimeout,
} from "@/utils/request-timeout";

describe("runWithRequestTimeout", () => {
  test("returns the result of a request that settles inside the bound", async () => {
    /**
     * Tests that the bound is invisible to a request that completes in time.
     */

    // GIVEN a request that resolves immediately
    const run = async () => "connections";

    // WHEN it runs under a bound
    const result = await runWithRequestTimeout({ timeoutMs: 1_000, run });

    // THEN its value passes through
    expect(result).toBe("connections");
  });

  test("rejects and aborts a request that outlives the bound", async () => {
    /**
     * Tests that a request which never settles still produces a terminal
     * outcome, and that the transport is told to stop.
     */

    // GIVEN a request that never settles
    let requestSignal: AbortSignal | undefined;
    const run = (signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise<string>(() => {});
    };

    // WHEN it runs under a 10ms bound
    const settled = runWithRequestTimeout({ timeoutMs: 10, run });

    // THEN it rejects with the timeout error and the request is aborted
    await expect(settled).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBeInstanceOf(RequestTimeoutError);
  });

  test("forwards an abort from the surrounding lifecycle", async () => {
    /**
     * Tests that a query cancelled by TanStack Query cancels the request it
     * started rather than waiting out the bound.
     */

    // GIVEN a request under an outer signal
    const outer = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const settled = runWithRequestTimeout({
      timeoutMs: 10_000,
      signal: outer.signal,
      run: (signal) => {
        requestSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });

    // WHEN the outer signal aborts
    outer.abort();

    // THEN the request sees the abort and the call settles
    await expect(settled).rejects.toThrow("aborted");
    expect(requestSignal?.aborted).toBe(true);
  });

  test("settles on a cancelled lifecycle even when the request ignores its signal", async () => {
    /**
     * Tests that cancelling the surrounding lifecycle does not leave the call
     * hanging until the bound expires, which would report a stalled request
     * that nothing is waiting for as a client timeout.
     */

    // GIVEN a request that never settles and never observes its signal
    const outer = new AbortController();
    const settled = runWithRequestTimeout({
      timeoutMs: 10_000,
      signal: outer.signal,
      run: () => new Promise<string>(() => {}),
    });

    // WHEN the surrounding lifecycle aborts
    outer.abort();

    // THEN the call settles as an abort, not as a timeout
    await expect(settled).rejects.toBeInstanceOf(RequestAbortedError);
  });
});
