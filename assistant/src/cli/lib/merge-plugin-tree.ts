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
 * hunk edited differently on both sides is a true conflict, resolved per the
 * caller's strategy:
 * - `ours` keeps the local hunk (`git merge-file --ours`),
 * - `theirs` keeps the pinned hunk (`git merge-file --theirs`),
 * - `assistant` writes standard git conflict markers into the file (no resolve
 *   flag) and reports the path, leaving the conflict for the assistant to
 *   resolve — exactly the mid-merge working-tree UX.
 *
 * File-level add/delete divergence (a file added, removed, or modified on only
 * one side) is resolved here before any line merge, since `git merge-file`
 * operates on three existing blobs.
 *
 * Binary files cannot be line-merged, so a binary file that diverged on both
 * sides is resolved whole-file by the strategy (`ours`/`theirs`); under
 * `assistant` the local copy is kept and the path is reported as a binary
 * conflict, since markers cannot be written into binary content.
 *
 * The `overwrite` strategy never reaches here — it discards local edits and is
 * a plain re-install at the pin.
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

import {
  computeFingerprint,
  PRESERVED_ENTRIES,
} from "./plugin-fingerprint.js";

const execFileAsync = promisify(execFile);

/** Cap on a single `git merge-file`; a per-file line merge is near-instant. */
const MERGE_TIMEOUT_MS = 30_000;

/**
 * How hunks edited differently on both sides are reconciled. `ours`/`theirs`
 * auto-resolve toward that side; `assistant` writes conflict markers and
 * reports the conflict for later resolution. `overwrite` is not a merge
 * strategy — the caller re-installs the pin wholesale instead of merging.
 */
export type PluginMergeStrategy = "ours" | "theirs" | "assistant";

/** Human-readable labels for the conflict markers `assistant` writes. */
export interface ConflictLabels {
  readonly ours: string;
  readonly base: string;
  readonly theirs: string;
}

const DEFAULT_CONFLICT_LABELS: ConflictLabels = {
  ours: "local edits",
  base: "install baseline",
  theirs: "upgrade pin",
};

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
  readonly strategy: PluginMergeStrategy;
  /** Marker labels for the `assistant` strategy. Defaults are used when omitted. */
  readonly conflictLabels?: ConflictLabels;
}

/** Outcome of a three-way plugin-tree merge. */
export interface PluginMergeResult {
  /** Number of files written into the destination tree. */
  readonly fileCount: number;
  /**
   * Paths (relative to the tree root) left for the assistant to resolve.
   * Text files carry git conflict markers; modify/delete divergences keep the
   * surviving content. Empty for `ours`/`theirs`, which auto-resolve.
   */
  readonly conflicts: readonly string[];
  /**
   * Paths of binary files that diverged on both sides. The local copy is kept
   * (markers cannot be written into binary content), so the assistant must
   * choose a version rather than edit markers. Empty for `ours`/`theirs`.
   */
  readonly binaryConflicts: readonly string[];
}

/** Result of merging a single file. */
interface MergedFile {
  readonly content: Buffer;
  /** Conflict markers were written into `content` (text, `assistant` only). */
  readonly conflicted: boolean;
  /** A binary file conflicted; `content` is the kept local copy (`assistant`). */
  readonly binaryConflicted: boolean;
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
 * Line-merge three blobs with `git merge-file`. Non-conflicting hunks from both
 * sides are always kept. `ours`/`theirs` auto-resolve conflicting hunks toward
 * that side (no markers); `assistant` writes git conflict markers and flags the
 * file as conflicted.
 *
 * Binary input cannot be line-merged: a side that matches the base did not
 * change, so the other side's edit is taken. A binary blob changed on *both*
 * sides is a true conflict — resolved whole-file by `ours`/`theirs`, or kept as
 * the local copy and flagged under `assistant` (no markers possible).
 */
async function threeWayMergeFile(
  ours: Buffer,
  base: Buffer,
  theirs: Buffer,
  strategy: PluginMergeStrategy,
  labels: ConflictLabels,
): Promise<MergedFile> {
  if (isBinary(ours) || isBinary(base) || isBinary(theirs)) {
    if (ours.equals(base))
      return { content: theirs, conflicted: false, binaryConflicted: false };
    if (theirs.equals(base))
      return { content: ours, conflicted: false, binaryConflicted: false };
    if (strategy === "assistant") {
      return { content: ours, conflicted: false, binaryConflicted: true };
    }
    return {
      content: strategy === "ours" ? ours : theirs,
      conflicted: false,
      binaryConflicted: false,
    };
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
    // place. `--ours`/`--theirs` auto-resolve conflicting hunks toward that
    // side; with neither (the `assistant` strategy) git writes conflict
    // markers, labelled via `-L` so the assistant can tell the sides apart.
    const args = ["merge-file", "-p"];
    if (strategy === "ours" || strategy === "theirs") {
      args.push(`--${strategy}`);
    } else {
      args.push("-L", labels.ours, "-L", labels.base, "-L", labels.theirs);
    }
    args.push(oursPath, basePath, theirsPath);
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: scratch,
        encoding: "buffer",
        timeout: MERGE_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { content: stdout, conflicted: false, binaryConflicted: false };
    } catch (err) {
      // `git merge-file` exits with the (positive) conflict count when markers
      // were left, still printing the full merged bytes to stdout — that is the
      // only rejection we may install. A killed process (timeout) or a
      // `maxBuffer` overflow also rejects here, but with truncated/partial
      // stdout we must NOT install it, or a large conflicted file would be
      // silently corrupted; surface those as errors. A resolving flag never
      // leaves conflicts, so any non-zero exit there is likewise a real
      // failure.
      const e = err as {
        stdout?: Buffer;
        code?: unknown;
        killed?: boolean;
        signal?: string | null;
      };
      const isConflictExit =
        strategy === "assistant" &&
        e.killed !== true &&
        e.signal == null &&
        typeof e.code === "number" &&
        e.code > 0;
      if (isConflictExit && Buffer.isBuffer(e.stdout)) {
        return { content: e.stdout, conflicted: true, binaryConflicted: false };
      }
      throw err;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Three-way merge `oursDir`/`theirsDir` against `baseDir` into `destDir` per
 * `strategy`. The provenance sidecar is excluded on every side — it is
 * rewritten by the caller after the swap and must not be carried through the
 * merge.
 *
 * Returns the file count plus, for the `assistant` strategy, the paths left for
 * the assistant to resolve (text files with conflict markers and modify/delete
 * divergences) and the binary files that conflicted.
 */
export async function mergePluginTree({
  baseDir,
  oursDir,
  theirsDir,
  destDir,
  strategy,
  conflictLabels,
}: MergePluginTreeOptions): Promise<PluginMergeResult> {
  const labels = conflictLabels ?? DEFAULT_CONFLICT_LABELS;
  const exclude = PRESERVED_ENTRIES;
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
  const conflicts: string[] = [];
  const binaryConflicts: string[] = [];
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
          labels,
        );
        keep(rel, merged.content);
        if (merged.conflicted) conflicts.push(rel);
        if (merged.binaryConflicted) binaryConflicts.push(rel);
      }
      continue;
    }

    if (o !== undefined) {
      // Present only locally. A local-only addition (no base) always survives.
      // A file deleted upstream is a delete: drop it when unchanged locally.
      // On a modify/delete conflict `ours` keeps the edit and `theirs` honors
      // the deletion; `assistant` keeps the edit and flags it (a whole-file
      // conflict markers can't express).
      if (b === undefined || (b !== o && strategy !== "theirs")) {
        keep(rel, readOurs(rel));
        if (b !== undefined && b !== o && strategy === "assistant") {
          conflicts.push(rel);
        }
      }
      continue;
    }

    if (t !== undefined) {
      // Present only at the pin. A remote-only addition (no base) always lands.
      // A file deleted locally is a delete: keep upstream's removal when the
      // pin left it unchanged. On a delete/modify conflict `theirs` keeps the
      // pin's edit and `ours` honors the local deletion; `assistant` keeps the
      // pin's edit and flags it.
      if (b === undefined || (b !== t && strategy !== "ours")) {
        keep(rel, readTheirs(rel));
        if (b !== undefined && b !== t && strategy === "assistant") {
          conflicts.push(rel);
        }
      }
      continue;
    }

    // Present only in the base: removed on both sides, so it stays removed.
  }

  return { fileCount, conflicts, binaryConflicts };
}
