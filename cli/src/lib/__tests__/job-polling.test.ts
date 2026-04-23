import { describe, expect, test } from "bun:test";

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
});
