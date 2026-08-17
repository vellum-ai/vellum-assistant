import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

/**
 * Guards over every sidecar worker-process entrypoint — the `worker.ts`
 * files under `src/` that run as their own OS processes (`src/cli/**` is
 * excluded: files there are CLI subcommands wrapping worker lifecycle
 * over IPC, not process entrypoints). Each entrypoint must, at bootstrap:
 *
 * - disable SSE seq stamping — the daemon is the sole seq authority; a
 *   worker that stamps issues seqs from its own counter (overlapping the
 *   daemon's range, so clients seq-dedupe real events into drops) and
 *   races the daemon's writes to the shared reservation file
 *   (`data/stream-seq.json`);
 * - start the PID-file identity guard — the PID file is a worker's sole
 *   tracking handle, so a worker the file stops naming can never be
 *   stopped externally and must evict itself.
 *
 * The subset that hosts real agent conversations
 * ({@link CONVERSATION_RUNNING_ENTRYPOINTS}) must additionally register the
 * default plugins' hooks and injectors, since hook dispatch is process-global
 * and a worker that skips it runs conversations with no plugin behavior at all
 * (no image captioning or vision-rejection recovery, no tool-result
 * truncation, no runtime injections).
 */

const DISABLE_CALL = "disableStreamSeqStamping()";
const PID_GUARD_CALL = "startWorkerPidFileGuard(";
const PLUGIN_SURFACE_CALL = "registerWorkerPluginSurface(";

/** Shape of a shutdown that schedules `process.exit` instead of calling it. */
const DEFERRED_EXIT = ".finally(() => process.exit";

/** A synchronously-set shutdown flag re-checked before work starts. */
const BAILOUT = /if\s*\(\s*shuttingDown\s*\)\s*\{\s*return;/;

/**
 * The first call each entrypoint makes that can run orphaned schedule/job
 * work. The PID guard must be armed before this — its on-arm identity check
 * evicts a worker superseded at startup before the call runs. Every discovered
 * entrypoint must have an entry here, so a new worker forces its author to
 * declare (and order) its work-start.
 */
const WORK_START_MARKERS: Record<string, string> = {
  "schedule/worker.ts": "void tick()",
  "monitoring/worker.ts": "startResourceSampler(",
  "plugins/defaults/memory/worker.ts": "startMemoryJobsWorkerLoop(",
  // The route host begins serving when it attaches the connection handler.
  "routes/worker.ts": 'server.on("connection"',
};

/**
 * The entrypoints whose work wakes real agent conversations. `monitoring` (a
 * resource sampler) and `routes` (an HTTP route host) run no conversations, so
 * they carry no plugin surface.
 */
const CONVERSATION_RUNNING_ENTRYPOINTS: ReadonlySet<string> = new Set([
  "schedule/worker.ts",
  "plugins/defaults/memory/worker.ts",
]);

function findWorkerEntrypoints(): string[] {
  const srcRoot = join(process.cwd(), "src");
  const glob = new Glob("**/worker.ts");
  const files: string[] = [];
  for (const match of glob.scanSync({ cwd: srcRoot })) {
    if (match.includes("__tests__") || match.startsWith("cli/")) {
      continue;
    }
    files.push(match);
  }
  return files.sort();
}

function entrypointsMissing(call: string): string[] {
  return findWorkerEntrypoints().filter((file) => {
    const source = readFileSync(join(process.cwd(), "src", file), "utf8");
    return !source.includes(call);
  });
}

describe("worker entrypoint guards", () => {
  test("finds the known worker entrypoints", () => {
    // If this shrinks, the glob broke — not the workers.
    expect(findWorkerEntrypoints().length).toBeGreaterThanOrEqual(3);
  });

  test("every worker entrypoint disables seq stamping at bootstrap", () => {
    expect(
      entrypointsMissing(DISABLE_CALL),
      `Worker entrypoints must call ${DISABLE_CALL} before any event can ` +
        "be published — the daemon is the sole SSE seq authority.",
    ).toEqual([]);
  });

  test("every worker entrypoint starts the PID-file identity guard", () => {
    expect(
      entrypointsMissing(PID_GUARD_CALL),
      `Worker entrypoints must call ${PID_GUARD_CALL}...) so an orphaned ` +
        "worker (one its PID file stops naming) evicts itself.",
    ).toEqual([]);
  });

  /**
   * Arming the guard before work-start is only sufficient while the eviction
   * path exits synchronously. An entrypoint that defers its exit (to reap child
   * processes first) hands control back to startup, which then runs its
   * work-start call anyway: for the memory worker that means
   * `resetRunningJobsToPending()` flipping the LIVE successor's in-progress
   * jobs back to pending. Such an entrypoint must re-check and bail.
   */
  test("an entrypoint that defers its exit bails out before starting work", () => {
    const offenders = findWorkerEntrypoints().filter((file) => {
      const source = readFileSync(join(process.cwd(), "src", file), "utf8");
      if (!source.includes(DEFERRED_EXIT)) {
        return false;
      }
      const marker = WORK_START_MARKERS[file];
      if (marker == null) {
        return true;
      }
      const guardAt = source.indexOf(PID_GUARD_CALL);
      const workAt = source.indexOf(marker);
      if (guardAt < 0 || workAt < 0) {
        return true;
      }
      return !BAILOUT.test(source.slice(guardAt, workAt));
    });
    expect(
      offenders,
      "A worker whose shutdown defers process.exit must re-check a " +
        "synchronously-set shutdown flag and return before its work-start " +
        "call, so an evicted worker cannot run work against live data.",
    ).toEqual([]);
  });

  test("every worker entrypoint arms the PID guard before starting work", () => {
    const offenders = findWorkerEntrypoints().filter((file) => {
      const marker = WORK_START_MARKERS[file];
      if (marker == null) {
        return true; // unregistered entrypoint — force a marker to be added
      }
      const source = readFileSync(join(process.cwd(), "src", file), "utf8");
      const guardAt = source.indexOf(PID_GUARD_CALL);
      const workAt = source.indexOf(marker);
      return guardAt < 0 || workAt < 0 || guardAt > workAt;
    });
    expect(
      offenders,
      "Each worker must arm the PID guard before its work-start call " +
        `(see WORK_START_MARKERS) so the guard's on-arm check evicts a ` +
        "worker superseded at startup before it runs orphaned work.",
    ).toEqual([]);
  });

  test("the conversation-running entrypoints are all discovered workers", () => {
    const discovered = new Set(findWorkerEntrypoints());
    const unknown = [...CONVERSATION_RUNNING_ENTRYPOINTS].filter(
      (file) => !discovered.has(file),
    );
    expect(
      unknown,
      "CONVERSATION_RUNNING_ENTRYPOINTS names an entrypoint the glob does " +
        "not find — the worker moved or was renamed.",
    ).toEqual([]);
  });

  test("every conversation-running entrypoint registers the default plugin surface before starting work", () => {
    const offenders = [...CONVERSATION_RUNNING_ENTRYPOINTS]
      .sort()
      .filter((file) => {
        const source = readFileSync(join(process.cwd(), "src", file), "utf8");
        const marker = WORK_START_MARKERS[file];
        if (marker == null) {
          return true;
        }
        const registerAt = source.indexOf(PLUGIN_SURFACE_CALL);
        const workAt = source.indexOf(marker);
        return registerAt < 0 || workAt < 0 || registerAt > workAt;
      });
    expect(
      offenders,
      `A worker that wakes agent conversations must call ` +
        `${PLUGIN_SURFACE_CALL}) before its work-start call (see ` +
        "WORK_START_MARKERS). Hook dispatch is process-global, so without it " +
        "the conversations this process runs get no default plugin behavior: " +
        "no vision-rejection recovery, no tool-result truncation, no runtime " +
        "injections.",
    ).toEqual([]);
  });
});
