import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { getLogger, initLogger, LOG_FILE_PATTERN } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Test rationale
// ---------------------------------------------------------------------------
//
// `getLogger()` returns a Proxy that lazily creates a pino child against the
// current rootLogger. Before this PR's refactor, the child was cached on
// first access and never re-evaluated — which meant that across:
//
//   1. day rollover (ensureCurrentDate rebuilds rootLogger past UTC midnight),
//   2. or a late `initLogger()` call (which swaps the rootLogger),
//
// previously-cached children kept writing to the OLD root's destination
// forever — silently misrouting logs into the wrong daily file.
//
// These tests pin the new contract: when the rootLogger changes, the proxy's
// next access rebuilds the child against the new root.
//
// We assert via file-system side effects (logs appearing in the expected
// directory). pino's `sync: false` default makes the fd open asynchronous,
// so we wait a tick before reading.
//
// NB: the file-creating fallback path itself is gated behind a BUN_TEST=1
// stderr fast-path in `getRootLogger()` (so test output stays sensible), so
// these tests exercise the rebind via `initLogger()` calls instead. The
// "no vellum.log" property is covered by `platform.test.ts` (asserts
// `getLogsDir()` returns the directory) and by the mechanical guarantee that
// `buildRotatingLogger` derives filenames via `logFilePathForDate`.

const SLEEP_MS = 100;

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

    log.info("first — should land in dirA");

    await Bun.sleep(SLEEP_MS);

    const aFiles = readdirSync(dirA);
    expect(aFiles.some((f) => LOG_FILE_PATTERN.test(f))).toBe(true);
  });

  test("subsequent log calls follow rootLogger swaps from initLogger()", async () => {
    // rootLogger is currently bound to dirA from the previous test. Reuse
    // an existing proxy and verify it follows the swap.
    const log = getLogger("rebind-target");
    log.info("warm-up against dirA so the child is cached");

    await Bun.sleep(SLEEP_MS);

    // Swap the rootLogger to a different directory.
    initLogger({ dir: dirB, retentionDays: 0 });

    log.info("post-swap — should land in dirB if the proxy rebound");

    await Bun.sleep(SLEEP_MS);

    // If the proxy correctly re-evaluates getRootLogger() on each access,
    // the second log call hits the dirB root and dirB gets a daily log
    // file. If the proxy were still caching the original child against the
    // dirA root, dirB would stay empty.
    const bFiles = readdirSync(dirB);
    expect(bFiles.some((f) => LOG_FILE_PATTERN.test(f))).toBe(true);
  });
});
