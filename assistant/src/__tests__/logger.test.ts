import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "bun:test";

import { getLogger, initLogger, LOG_FILE_PATTERN } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Test rationale
// ---------------------------------------------------------------------------
//
// `getLogger()` returns a Proxy that lazily creates a pino child against the
// current rootLogger. The child is rebuilt whenever the root changes, so:
//
//   1. day rollover (ensureCurrentDate rebuilds rootLogger past UTC midnight)
//   2. a late `initLogger()` call (which swaps the rootLogger)
//
// both keep writing to the active destination instead of a stale one.
//
// These tests pin that contract: when the rootLogger changes, the proxy's
// next access rebuilds the child against the new root.
//
// We assert via file-system side effects (logs appearing in the expected
// directory). `buildRotatingLogger` opens the pino destination with
// `sync: false`, so the fd (and therefore the daily log file) appears
// asynchronously. Poll until the file exists rather than sleeping a fixed
// interval; a loaded CI runner can take longer than a single tick.
//
// The file-creating fallback path itself is gated behind a BUN_TEST=1
// stderr fast-path in `getRootLogger()` (so test output stays sensible), so
// these tests exercise the rebind via `initLogger()` calls instead. The
// "no vellum.log" property is covered by `platform.test.ts` (asserts
// `getLogsDir()` returns the directory) and by the mechanical guarantee that
// `buildRotatingLogger` derives filenames via `logFilePathForDate`.

const LOG_FILE_WAIT_MS = 2_000;

function hasDailyLogFile(dir: string): boolean {
  return readdirSync(dir).some((f) => LOG_FILE_PATTERN.test(f));
}

async function waitForDailyLogFile(dir: string): Promise<void> {
  const deadline = Date.now() + LOG_FILE_WAIT_MS;
  while (Date.now() < deadline) {
    if (hasDailyLogFile(dir)) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for a daily log file in ${dir}`);
}

const dirA = mkdtempSync(join(tmpdir(), "logger-rebind-A-"));
const dirB = mkdtempSync(join(tmpdir(), "logger-rebind-B-"));

afterAll(() => {
  // Detach the module-level rootLogger from the temp dirs we're about to
  // delete. Without this, a later flush (or the test runner's shutdown)
  // could try to write into a removed directory.
  initLogger({ dir: undefined, retentionDays: 0 });
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe("getLogger() proxy rebind", () => {
  test("a proxy created BEFORE initLogger() still routes to the post-init root", async () => {
    // Create the proxy before initLogger has run. This mirrors the real
    // lifecycle.ts pattern: modules call `getLogger()` at import time, long
    // before `initLogger()` boots in daemon startup.
    const log = getLogger("early-binding");

    initLogger({ dir: dirA, retentionDays: 0 });

    log.info("first: should land in dirA");

    await waitForDailyLogFile(dirA);
  });

  test("subsequent log calls follow rootLogger swaps from initLogger()", async () => {
    initLogger({ dir: dirA, retentionDays: 0 });
    const log = getLogger("rebind-target");
    log.info("warm-up against dirA so the child is cached");
    await waitForDailyLogFile(dirA);

    initLogger({ dir: dirB, retentionDays: 0 });
    log.info("post-swap: should land in dirB if the proxy rebound");

    await waitForDailyLogFile(dirB);
  });
});
