/**
 * Tripwire coupling the generated worker scripts to the cache-invalidation
 * version that ships them.
 *
 * `isReady()` short-circuits `ensureInstalled()` whenever the on-disk manifest
 * matches RUNTIME_VERSION, and the worker scripts are only written from
 * `install()`. So editing a generator without bumping the trailing
 * `_workers-vN` suffix leaves every existing install running the old scripts,
 * and the change silently does nothing for anyone who already downloaded the
 * runtime. That is a shipped no-op with green CI, which is why it needs a
 * mechanical check rather than reviewer memory.
 */

import { describe, expect, test } from "bun:test";

import {
  generateRerankWorkerScript,
  generateWorkerScript,
  RUNTIME_VERSION,
} from "../embedding-runtime-manager.js";

/**
 * Fingerprint of the two generated scripts. Update this together with the
 * `_workers-vN` bump below, never on its own.
 */
const EXPECTED_WORKER_SCRIPTS_HASH = "4f85253eaebd315";

/** Suffix the fingerprint above was taken at. */
const EXPECTED_WORKERS_VERSION = "workers-v4";

function workerScriptsHash(): string {
  // The two scripts are joined by a NUL, written as an escape so this file
  // stays ASCII text rather than tripping git's binary heuristic. NUL cannot
  // occur inside either generated script, so text moving from one worker to
  // the other can never hash the same as the unchanged pair.
  return Bun.hash(
    generateWorkerScript() + "\u0000" + generateRerankWorkerScript(),
  ).toString(16);
}

describe("worker script cache invalidation", () => {
  test("a change to either generator comes with a _workers-vN bump", () => {
    const actual = workerScriptsHash();
    expect(
      actual,
      [
        "The generated worker scripts changed.",
        "",
        "Existing installs only regenerate these scripts when RUNTIME_VERSION",
        "changes, so bump the trailing `_workers-vN` suffix in",
        "embedding-runtime-manager.ts, then update both constants in this test:",
        "",
        `  EXPECTED_WORKER_SCRIPTS_HASH = "${actual}"`,
        `  EXPECTED_WORKERS_VERSION     = "workers-v<N+1>"`,
        "",
        "Skipping the bump ships a silent no-op for every existing install.",
      ].join("\n"),
    ).toBe(EXPECTED_WORKER_SCRIPTS_HASH);
  });

  test("RUNTIME_VERSION carries the workers suffix the hash was taken at", () => {
    expect(RUNTIME_VERSION.endsWith(`_${EXPECTED_WORKERS_VERSION}`)).toBe(true);
  });

  test("both workers read the intra-op thread cap the host sets", () => {
    // Guards the JARVIS-1398 wiring specifically: the host computing a cap is
    // useless if the scripts on disk never consult it.
    for (const script of [
      generateWorkerScript(),
      generateRerankWorkerScript(),
    ]) {
      expect(script).toContain("VELLUM_ONNX_INTRA_OP_THREADS");
      expect(script).toContain("session_options: sessionOptions");
    }
  });
});
