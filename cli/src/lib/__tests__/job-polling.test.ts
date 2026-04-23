import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { pollJobUntilDone } from "../job-polling.js";
import type { UnifiedJobStatus } from "../platform-client.js";

describe("pollJobUntilDone", () => {
  test("returns terminal 'complete' after N processing polls", async () => {
    const statuses: UnifiedJobStatus[] = [
      { jobId: "j1", type: "export", status: "processing" },
      { jobId: "j1", type: "export", status: "processing" },
      {
        jobId: "j1",
        type: "export",
        status: "complete",
        bundleKey: "bundles/j1.tar.gz",
      },
    ];
    let i = 0;
    const result = await pollJobUntilDone({
      poll: async () => statuses[i++]!,
      intervalMs: 1,
      timeoutMs: 1_000,
      label: "test export",
    });

    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.bundleKey).toBe("bundles/j1.tar.gz");
    }
    expect(i).toBe(3);
  });

  test("propagates terminal 'failed' status to caller without throwing", async () => {
    const result = await pollJobUntilDone({
      poll: async () => ({
        jobId: "j2",
        type: "import",
        status: "failed",
        error: "bad bundle",
      }),
      intervalMs: 1,
      timeoutMs: 1_000,
      label: "test import",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBe("bad bundle");
    }
  });

  test("throws with label when polling exceeds timeoutMs", async () => {
    let calls = 0;
    await expect(
      pollJobUntilDone({
        poll: async () => {
          calls += 1;
          return { jobId: "j3", type: "export", status: "processing" };
        },
        intervalMs: 20,
        timeoutMs: 10,
        label: "slow export",
      }),
    ).rejects.toThrow(/slow export/);

    // The loop does one poll before checking the deadline, so calls ≥ 1.
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test("uses defaults when intervalMs/timeoutMs are omitted (fast path)", async () => {
    // Fast path: first poll is already terminal so neither default matters.
    const result = await pollJobUntilDone({
      poll: async () => ({ jobId: "j4", type: "export", status: "complete" }),
      label: "defaults test",
    });
    expect(result.status).toBe("complete");
  });

  describe("transient-error retry", () => {
    let warnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    test("retries N-1 transient errors then returns terminal status", async () => {
      const maxTransientErrors = 3;
      let calls = 0;
      const result = await pollJobUntilDone({
        label: "flaky export",
        intervalMs: 1,
        timeoutMs: 1_000,
        maxTransientErrors,
        poll: async () => {
          calls += 1;
          if (calls < maxTransientErrors) {
            throw new Error(
              `Local job status check failed: 503 Service Unavailable`,
            );
          }
          return {
            jobId: "j5",
            type: "export",
            status: "complete",
          } as UnifiedJobStatus;
        },
      });
      expect(result.status).toBe("complete");
      expect(calls).toBe(maxTransientErrors);
      // One warning per retried transient error (first two attempts).
      expect(warnSpy).toHaveBeenCalledTimes(maxTransientErrors - 1);
    });

    test("propagates the last error once maxTransientErrors is exceeded", async () => {
      const maxTransientErrors = 2;
      let calls = 0;
      await expect(
        pollJobUntilDone({
          label: "always broken",
          intervalMs: 1,
          timeoutMs: 1_000,
          maxTransientErrors,
          poll: async () => {
            calls += 1;
            throw new Error(`Local job status check failed: 502 Bad Gateway`);
          },
        }),
      ).rejects.toThrow(/502 Bad Gateway/);
      // Helper makes `maxTransientErrors + 1` attempts before giving up: the
      // first attempt plus N retries, counted against the budget.
      expect(calls).toBe(maxTransientErrors + 1);
    });

    test("permanent 4xx errors (except 429) propagate immediately", async () => {
      let calls = 0;
      await expect(
        pollJobUntilDone({
          label: "auth broken",
          intervalMs: 1,
          timeoutMs: 1_000,
          maxTransientErrors: 5,
          poll: async () => {
            calls += 1;
            throw new Error(`Local job status check failed: 403 Forbidden`);
          },
        }),
      ).rejects.toThrow(/403 Forbidden/);
      expect(calls).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test("429 rate-limit is retried as transient", async () => {
      let calls = 0;
      const result = await pollJobUntilDone({
        label: "rate limited",
        intervalMs: 1,
        timeoutMs: 1_000,
        maxTransientErrors: 3,
        poll: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error(`Local job status check failed: 429 Too Many`);
          }
          return {
            jobId: "j6",
            type: "export",
            status: "complete",
          } as UnifiedJobStatus;
        },
      });
      expect(result.status).toBe("complete");
      expect(calls).toBe(2);
    });

    test("unclassified network-style errors are treated as transient", async () => {
      let calls = 0;
      const result = await pollJobUntilDone({
        label: "network blip",
        intervalMs: 1,
        timeoutMs: 1_000,
        maxTransientErrors: 3,
        poll: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("fetch failed");
          }
          return {
            jobId: "j7",
            type: "export",
            status: "complete",
          } as UnifiedJobStatus;
        },
      });
      expect(result.status).toBe("complete");
      expect(calls).toBe(2);
    });
  });
});
