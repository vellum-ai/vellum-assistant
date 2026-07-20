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
 */

const DISABLE_CALL = "disableStreamSeqStamping()";
const PID_GUARD_CALL = "startWorkerPidFileGuard(";

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
});
