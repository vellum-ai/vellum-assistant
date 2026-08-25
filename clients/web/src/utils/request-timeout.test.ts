import { describe, expect, test } from "bun:test";

import {
  RequestAbortedError,
  RequestTimeoutError,
  runWithRequestTimeout,
} from "@/utils/request-timeout";

describe("runWithRequestTimeout", () => {
  test("returns a request result that settles inside the bound", async () => {
    const result = await runWithRequestTimeout({
      timeoutMs: 1_000,
      run: async () => "connections",
    });

    expect(result).toBe("connections");
  });

  test("rejects and aborts a request that outlives the bound", async () => {
    let requestSignal: AbortSignal | undefined;
    const settled = runWithRequestTimeout({
      timeoutMs: 10,
      run: (signal) => {
        requestSignal = signal;
        return new Promise<string>(() => {});
      },
    });

    await expect(settled).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBeInstanceOf(RequestTimeoutError);
  });

  test("preserves the outer cancellation classification", async () => {
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

    outer.abort();

    await expect(settled).rejects.toBeInstanceOf(RequestAbortedError);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBeInstanceOf(RequestAbortedError);
  });

  test("settles when cancelled even if the request ignores its signal", async () => {
    const outer = new AbortController();
    const settled = runWithRequestTimeout({
      timeoutMs: 10_000,
      signal: outer.signal,
      run: () => new Promise<string>(() => {}),
    });

    outer.abort();

    await expect(settled).rejects.toBeInstanceOf(RequestAbortedError);
  });

  test("does not start work for an already-cancelled lifecycle", async () => {
    const outer = new AbortController();
    outer.abort();
    let runCalls = 0;

    const settled = runWithRequestTimeout({
      timeoutMs: 10_000,
      signal: outer.signal,
      run: async () => {
        runCalls += 1;
        return "connections";
      },
    });

    await expect(settled).rejects.toBeInstanceOf(RequestAbortedError);
    expect(runCalls).toBe(0);
  });
});
