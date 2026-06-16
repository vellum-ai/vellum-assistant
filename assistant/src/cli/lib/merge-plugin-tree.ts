/**
 * Three-way merge of a plugin tree, used by `plugins upgrade --strategy` to
 * carry local edits forward across an upgrade instead of discarding them.
 *
 * An upgrade has three inputs, exactly like a git merge:
 * - **base** — the tree the plugin was installed at (the recorded commit,
 *   re-materialized through the install pipeline; see {@link ./diff-plugin}).
 * - **ours** — the current on-disk install, carrying any local edits.
 * - **theirs** — the marketplace's current pin, the tree being upgraded to.
 *
 * Per file the merge is delegated to `git merge-file`, the same line-level
 * three-way algorithm git itself uses: a hunk edited on only one side is taken
 * from that side, so non-conflicting edits from *both* sides survive. Only a
 * hunk edited differently on both sides is a true conflict, resolved by the
 * caller's strategy — `--ours` keeps the local hunk, `--theirs` the pinned one.
 * File-level add/delete divergence (a file added, removed, or modified on only
 * one side) is resolved here before any line merge, since `git merge-file`
 * operates on three existing blobs.
 *
 * Binary files cannot be line-merged, so a binary file that diverged on both
 * sides is resolved whole-file by the strategy rather than corrupted with
 * conflict markers.
 *
 * The `overwrite` strategy never reaches here — it discards local edits and is
 * a plain re-install at the pin. The `assistant` strategy is not yet supported.
 */

import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { INSTALL_META_FILENAME } from "./install-from-github.js";
import { computeFingerprint } from "./plugin-fingerprint.js";

const execFileAsync = promisify(execFile);

/** Cap on a single `git merge-file`; a per-file line merge is near-instant. */
const MERGE_TIMEOUT_MS = 30_000;

/**
 * Conflict-resolution strategy for the hunks `git merge-file` cannot
 * auto-resolve. `overwrite` and `assistant` are not merge strategies and are
 * handled by the caller before a merge is attempted.
 */
export type MergeConflictStrategy = "ours" | "theirs";

/** Inputs for a three-way plugin-tree merge. */
export interface MergePluginTreeOptions {
  /** Re-materialized install-commit tree (the merge base). */
  readonly baseDir: string;
  /** Current on-disk install, carrying local edits (`ours`). */
  readonly oursDir: string;
  /** Marketplace-pinned tree being upgraded to (`theirs`). */
  readonly theirsDir: string;
  /** Empty directory the merged tree is written into. */
  readonly destDir: string;
  /** How to resolve hunks edited differently on both sides. */
  readonly strategy: MergeConflictStrategy;
}

/** A NUL byte in the leading bytes is the heuristic git uses to flag a blob as binary. */
function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Write `content` to `destDir/rel`, creating parent directories as needed. */
function writeInto(destDir: string, rel: string, content: Buffer): void {
  const abs = join(destDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/**
 * Line-merge three blobs with `git merge-file`, resolving conflicting hunks
 * toward `strategy`. Non-conflicting hunks from both sides are always kept.
 * Binary input cannot be line-merged, so the whole `strategy` side is taken
 * instead of producing a marker-corrupted blob.
 */
async function threeWayMergeFile(
  ours: Buffer,
  base: Buffer,
  theirs: Buffer,
  strategy: MergeConflictStrategy,
): Promise<Buffer> {
  if (isBinary(ours) || isBinary(base) || isBinary(theirs)) {
    return strategy === "ours" ? ours : theirs;
  }

  const scratch = mkdtempSync(join(tmpdir(), "plugin-merge-file-"));
  try {
    const oursPath = join(scratch, "ours");
    const basePath = join(scratch, "base");
    const theirsPath = join(scratch, "theirs");
    writeFileSync(oursPath, ours);
    writeFileSync(basePath, base);
    writeFileSync(theirsPath, theirs);

    // `-p` prints the merged result to stdout instead of editing `ours` in
    // place; `--ours`/`--theirs` auto-resolve conflicting hunks toward that
    // side (so no markers are ever written). `git merge-file` exits non-zero
    // when conflicts remained — impossible with a resolving flag, but stdout
    // still carries the merged bytes, so capture it from the error too.
    const args = [
      "merge-file",
      "-p",
      `--${strategy}`,
      oursPath,
      basePath,
      theirsPath,
    ];
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: scratch,
        encoding: "buffer",
        timeout: MERGE_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const stdout = (err as { stdout?: Buffer }).stdout;
      if (Buffer.isBuffer(stdout)) return stdout;
      throw err;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Three-way merge `oursDir`/`theirsDir` against `baseDir` into `destDir`,
 * resolving conflicts toward `strategy`. The provenance sidecar is excluded on
 * every side — it is rewritten by the caller after the swap and must not be
 * carried through the merge.
 *
 * Returns the number of files written into `destDir`.
 */
export async function mergePluginTree({
  baseDir,
  oursDir,
  theirsDir,
  destDir,
  strategy,
}: MergePluginTreeOptions): Promise<number> {
  const exclude = [INSTALL_META_FILENAME];
  const base = computeFingerprint(baseDir, exclude).files;
  const ours = computeFingerprint(oursDir, exclude).files;
  const theirs = computeFingerprint(theirsDir, exclude).files;

  const paths = new Set([
    ...Object.keys(base),
    ...Object.keys(ours),
    ...Object.keys(theirs),
  ]);

  const readBase = (rel: string) => readFileSync(join(baseDir, rel));
  const readOurs = (rel: string) => readFileSync(join(oursDir, rel));
  const readTheirs = (rel: string) => readFileSync(join(theirsDir, rel));

  let fileCount = 0;
  const keep = (rel: string, content: Buffer): void => {
    writeInto(destDir, rel, content);
    fileCount++;
  };

  for (const rel of paths) {
    const b = base[rel];
    const o = ours[rel];
    const t = theirs[rel];

    if (o !== undefined && t !== undefined) {
      // Present on both sides: identical needs no merge; otherwise line-merge
      // (an empty base when the file was added on both sides).
      if (o === t) {
        keep(rel, readOurs(rel));
      } else {
        const merged = await threeWayMergeFile(
          readOurs(rel),
          b !== undefined ? readBase(rel) : Buffer.alloc(0),
          readTheirs(rel),
          strategy,
        );
        keep(rel, merged);
      }
      continue;
    }

    if (o !== undefined) {
      // Present only locally. A local-only addition (no base) always survives.
      // A file deleted upstream is a delete: drop it when unchanged locally,
      // and on a modify/delete conflict let the strategy decide.
      if (b === undefined || (b !== o && strategy === "ours")) {
        keep(rel, readOurs(rel));
      }
      continue;
    }

    if (t !== undefined) {
      // Present only at the pin. A remote-only addition (no base) always lands.
      // A file deleted locally is a delete: keep upstream's removal when the
      // pin left it unchanged, and on a delete/modify conflict let the strategy
      // decide.
      if (b === undefined || (b !== t && strategy === "theirs")) {
        keep(rel, readTheirs(rel));
      }
      continue;
    }

    // Present only in the base: removed on both sides, so it stays removed.
  }

  return fileCount;
}
