/**
 * Regression tests for the export deadline in the backup worker.
 *
 * `fetch` resolves as soon as the response headers arrive; the bundle streams
 * in afterwards. The worker used to clear its abort timer in a `finally` on
 * that call, which left the download — the part that actually takes an hour on
 * a large workspace — with no deadline at all. A body that stalled after
 * headers hung `performBackup` forever, and with it the `snapshotInProgress`
 * mutex, so every later tick logged "snapshot already in progress" until the
 * gateway was restarted.
 *
 * These drive a response whose headers arrive normally and whose body never
 * produces a chunk, and assert the run gives up and lets go of the mutex.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let localDir: string;

/**
 * The failure this file guards against is a hang, which a bare `await` would
 * inherit — a regression would stall the runner instead of reporting. Race
 * every run against a deadline so it fails fast and says why.
 */
function withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} did not settle within 10s`)),
        10_000,
      ),
    ),
  ]);
}

/**
 * Records the init the worker passed to fetch, so a test can assert on the
 * deadline options rather than waiting one out.
 */
let lastInit: (RequestInit & { timeout?: boolean | number }) | undefined;

/** A response that sends headers immediately and then never sends a chunk. */
function stalledBodyResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // One chunk so the transfer visibly begins, then silence forever.
      controller.enqueue(new Uint8Array([0x1f, 0x8b]));
    },
  });
  return new Response(body, { status: 200 });
}

beforeEach(async () => {
  localDir = await mkdtemp(join(tmpdir(), "backup-worker-timeout-"));

  mock.module("../config-file-utils.js", () => ({
    readConfigFileOrEmpty: () => ({
      backup: {
        enabled: true,
        intervalHours: 6,
        retention: 3,
        // Offsite off keeps the run local: no encryption key is needed, so
        // nothing touches the gateway security dir.
        offsite: { enabled: false },
        localDirectory: localDir,
      },
    }),
  }));

  mock.module("../auth/token-exchange.js", () => ({
    mintServiceToken: () => "test-service-token",
  }));

  mock.module("../fetch.js", () => ({
    fetchImpl: async (
      _input: string | URL | Request,
      init?: RequestInit & { timeout?: boolean | number },
    ) => {
      lastInit = init;
      init?.signal?.throwIfAborted();
      return stalledBodyResponse();
    },
  }));
});

afterEach(async () => {
  mock.restore();
  await rm(localDir, { recursive: true, force: true });
});

describe("backup export deadline", () => {
  test("a body that stalls after headers aborts instead of hanging", async () => {
    const { createSnapshotNow } = await import("../backup/backup-worker.js");

    const startedAt = Date.now();
    const run = withDeadline(
      createSnapshotNow({
        assistantRuntimeBaseUrl: "http://127.0.0.1:7821",
        exportTimeoutMs: 300,
      }),
      "stalled export",
    );

    await expect(run).rejects.toThrow(/aborted|abort/i);
    // The deadline fired rather than the call returning on its own; the guard
    // is that this resolved at all, well inside the real 60-minute budget.
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 30_000);

  test("the concurrency mutex is released after a stalled transfer", async () => {
    const { createSnapshotNow } = await import("../backup/backup-worker.js");

    const deps = {
      assistantRuntimeBaseUrl: "http://127.0.0.1:7821",
      exportTimeoutMs: 300,
    };

    await expect(
      withDeadline(createSnapshotNow(deps), "first stalled export"),
    ).rejects.toThrow();

    // A wedged mutex surfaces here: the second run is refused outright rather
    // than getting as far as its own stalled transfer.
    const secondFailure = await withDeadline(
      createSnapshotNow(deps),
      "second stalled export",
    ).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(secondFailure).not.toBeNull();
    expect(secondFailure).not.toContain("already in progress");
  }, 30_000);
});

describe("backup export request options", () => {
  test("opts out of the runtime's default request timeout", async () => {
    // The daemon builds the entire archive before it can write a response
    // header, so on a large workspace no header arrives for many minutes. The
    // runtime's 300-second default would kill that request — and it is NOT
    // extended by the abort signal below, so the explicit budget alone does
    // not save it. This is the option that makes the budget real.
    const { createSnapshotNow } = await import("../backup/backup-worker.js");

    await expect(
      withDeadline(
        createSnapshotNow({
          assistantRuntimeBaseUrl: "http://127.0.0.1:7821",
          exportTimeoutMs: 300,
        }),
        "stalled export",
      ),
    ).rejects.toThrow();

    expect(lastInit?.timeout).toBe(false);
    // The caller's own deadline is still what governs.
    expect(lastInit?.signal).toBeInstanceOf(AbortSignal);
  }, 30_000);
});
