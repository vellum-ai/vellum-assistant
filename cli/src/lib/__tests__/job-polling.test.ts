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

    test("refreshOn401 is invoked on 401 and polling continues after refresh", async () => {
      let calls = 0;
      let refreshes = 0;
      const result = await pollJobUntilDone({
        label: "expiring auth",
        intervalMs: 1,
        timeoutMs: 1_000,
        maxTransientErrors: 0,
        refreshOn401: async () => {
          refreshes += 1;
        },
        poll: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("Local job status check failed: 401 Unauthorized");
          }
          return {
            jobId: "j401",
            type: "export",
            status: "complete",
          } as UnifiedJobStatus;
        },
      });
      expect(result.status).toBe("complete");
      expect(refreshes).toBe(1);
      expect(calls).toBe(2);
      // The 401 branch logs its own distinct warning (not the generic
      // "polling failed, retrying" one) so operators can distinguish an
      // auth refresh from a transient-error retry in the output.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("refreshing auth"),
      );
    });

    test("propagates 401 once maxAuthRefreshes is exceeded", async () => {
      const maxAuthRefreshes = 2;
      let calls = 0;
      let refreshes = 0;
      await expect(
        pollJobUntilDone({
          label: "persistently unauthorized",
          intervalMs: 1,
          timeoutMs: 1_000,
          maxAuthRefreshes,
          refreshOn401: async () => {
            refreshes += 1;
          },
          poll: async () => {
            calls += 1;
            throw new Error("Local job status check failed: 401 Unauthorized");
          },
        }),
      ).rejects.toThrow(/401 Unauthorized/);
      // Helper allows `maxAuthRefreshes` successful refresh-and-retry cycles
      // (each counted against the budget after the poll fails), plus one
      // final attempt on the refreshed token that exceeds the budget.
      expect(calls).toBe(maxAuthRefreshes + 1);
      expect(refreshes).toBe(maxAuthRefreshes);
    });

    test("without refreshOn401, 401 still propagates as a permanent 4xx", async () => {
      let calls = 0;
      await expect(
        pollJobUntilDone({
          label: "no refresh hook",
          intervalMs: 1,
          timeoutMs: 1_000,
          poll: async () => {
            calls += 1;
            throw new Error("Local job status check failed: 401 Unauthorized");
          },
        }),
      ).rejects.toThrow(/401 Unauthorized/);
      expect(calls).toBe(1);
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
