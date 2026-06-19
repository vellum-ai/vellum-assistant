/**
 * Regression test for descriptor hygiene in the vbundle export path.
 *
 * `streamExportVBundle` opens every file in the workspace twice — once to hash
 * it (Pass 1) and once to stream it into the tar (Pass 2). This test pins the
 * invariant that those reads release their descriptors: the number of open
 * descriptors held by the process must not grow proportionally to the number
 * of files exported. Without that guarantee a workspace-sized export exhausts
 * the daemon's descriptor limit (EMFILE) and every subsequent subprocess spawn
 * fails.
 *
 * Descriptor counting uses `/proc/self/fd`, which only exists on Linux. The
 * assertion is skipped on platforms without it (e.g. macOS dev machines); CI
 * runs on Linux, so the regression stays covered there.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { assertNotLiveDb } from "../../../__tests__/assert-not-live-db.js";
import { streamExportVBundle } from "../vbundle-builder.js";
import { defaultV1Options } from "./v1-test-helpers.js";

const PROC_SELF_FD = "/proc/self/fd";
const hasProcFd = existsSync(PROC_SELF_FD);

/** Count the descriptors currently open by this process. */
function openFdCount(): number {
  return readdirSync(PROC_SELF_FD).length;
}

/**
 * Build a workspace with enough distinct files (across nested directories) that
 * a per-file descriptor leak would be obvious against the assertion bound.
 */
function createPopulatedWorkspace(fileCount: number): {
  dir: string;
  cleanup: () => void;
} {
  const dir = join(
    tmpdir(),
    `vbundle-fd-leak-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ test: true }));
  const dbDir = join(dir, "data", "db");
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(join(dbDir, "assistant.db"), "fake-db-content");

  // A spread of files under a few nested directories, each with non-trivial
  // (multi-chunk) content so the read loop iterates more than once.
  const filler = "x".repeat(200 * 1024);
  for (let i = 0; i < fileCount; i++) {
    const sub = join(dir, "data", "files", `dir-${i % 5}`);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `file-${i}.txt`), `${filler}\n${i}`);
  }

  return {
    dir,
    cleanup: () => {
      assertNotLiveDb(dir);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("streamExportVBundle — descriptor lifecycle", () => {
  test.skipIf(!hasProcFd)(
    "does not leak a file descriptor per exported file",
    async () => {
      const fileCount = 60;
      const workspace = createPopulatedWorkspace(fileCount);

      // Warm-up export: first run can open and cache descriptors that legitimately
      // persist (loggers, the daemon DB, etc.). Measuring the delta around a
      // second export isolates per-file leakage from one-time setup.
      let warmup: Awaited<ReturnType<typeof streamExportVBundle>> | undefined;
      try {
        warmup = await streamExportVBundle({
          workspaceDir: workspace.dir,
          ...defaultV1Options(),
        });
      } finally {
        await warmup?.cleanup();
      }

      const before = openFdCount();

      let result: Awaited<ReturnType<typeof streamExportVBundle>> | undefined;
      try {
        result = await streamExportVBundle({
          workspaceDir: workspace.dir,
          ...defaultV1Options(),
        });
        // Manifest covers every file we wrote — proves the walk actually read
        // them (otherwise a no-op export would trivially leak nothing).
        expect(result.manifest.contents.length).toBeGreaterThanOrEqual(
          fileCount,
        );
      } finally {
        await result?.cleanup();
        workspace.cleanup();
      }

      const after = openFdCount();
      const delta = after - before;

      // Each export reads 2×fileCount files (hash pass + tar pass). A per-file
      // leak would push the delta past `fileCount`. Allow a small constant for
      // incidental descriptors (temp output file already cleaned up, jitter).
      expect(delta).toBeLessThan(8);
    },
  );
});
