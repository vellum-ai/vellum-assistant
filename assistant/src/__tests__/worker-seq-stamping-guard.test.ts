import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

/**
 * Guard: every sidecar worker-process entrypoint must disable SSE seq
 * stamping at bootstrap. The daemon is the sole seq authority — a worker
 * that stamps issues seqs from its own counter (overlapping the daemon's
 * range, so clients seq-dedupe real events into drops) and races the
 * daemon's writes to the shared reservation file
 * (`data/stream-seq.json`).
 *
 * Worker entrypoints are the `worker.ts` files under `src/` that run as
 * their own OS processes. `src/cli/**` is excluded: files there are CLI
 * subcommands (IPC wrappers around worker lifecycle), not process
 * entrypoints.
 */

const DISABLE_CALL = "disableStreamSeqStamping()";

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

describe("worker seq-stamping guard", () => {
  test("finds the known worker entrypoints", () => {
    // If this shrinks, the glob broke — not the workers.
    expect(findWorkerEntrypoints().length).toBeGreaterThanOrEqual(3);
  });

  test("every worker entrypoint disables seq stamping at bootstrap", () => {
    const missing = findWorkerEntrypoints().filter((file) => {
      const source = readFileSync(join(process.cwd(), "src", file), "utf8");
      return !source.includes(DISABLE_CALL);
    });
    expect(
      missing,
      `Worker entrypoints must call ${DISABLE_CALL} before any event can ` +
        "be published — the daemon is the sole SSE seq authority.",
    ).toEqual([]);
  });
});
