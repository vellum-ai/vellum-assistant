/**
 * Content fingerprint of an installed plugin tree, used to detect local
 * modifications after install.
 *
 * A plugin install is a flattened snapshot of a commit — the `.git` metadata is
 * stripped during materialization (see {@link ./install-from-github}), so there
 * is no working tree to ask `git status`. To tell whether a user has edited an
 * installed copy, install records a per-file digest of the materialized tree in
 * the provenance sidecar; later a recompute over the on-disk copy is compared
 * against that baseline.
 *
 * The fingerprint is a one-way digest map — it answers "did this change?" and
 * "which files?", but cannot reconstruct the original bytes. Producing an
 * actual diff or a 3-way merge instead re-derives the baseline from the
 * recorded immutable commit SHA (a separate concern from this module).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { walkPluginTree } from "../../plugins/plugin-tree-walk.js";

/** Digest algorithm recorded alongside the file map, for forward compatibility. */
export type FingerprintAlgorithm = "sha256";

/**
 * Per-file content digest of a plugin tree. Keys are POSIX-style
 * (forward-slash) paths relative to the plugin root so the baseline is stable
 * across platforms; values are lowercase hex digests of each file's bytes.
 */
export interface Fingerprint {
  readonly algorithm: FingerprintAlgorithm;
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Difference between a recorded fingerprint and the current on-disk tree.
 * Paths are POSIX-relative, matching {@link Fingerprint.files}. A rename
 * surfaces as one `removed` plus one `added` entry.
 */
export interface FingerprintComparison {
  /** Present in both, but the content digest differs. */
  readonly modified: readonly string[];
  /** Present on disk, absent from the recorded baseline. */
  readonly added: readonly string[];
  /** Recorded in the baseline, absent on disk. */
  readonly removed: readonly string[];
  /** True when the on-disk tree exactly matches the recorded baseline. */
  readonly clean: boolean;
}

function hashFile(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/**
 * Walk `root` and return a content digest for every regular file, keyed by its
 * POSIX-relative path. Symlinks are skipped (see {@link walkPluginTree});
 * top-level entries named in `exclude` are skipped so the provenance sidecar
 * never fingerprints itself.
 */
export function computeFingerprint(
  root: string,
  exclude: readonly string[] = [],
): Fingerprint {
  const files: Record<string, string> = {};
  walkPluginTree(root, { excludeRootEntries: exclude }, (rel, abs) => {
    files[rel] = hashFile(abs);
  });
  return { algorithm: "sha256", files };
}

/**
 * Compare the current contents of `root` against a recorded fingerprint,
 * applying the same `exclude` used to compute the baseline so the sidecar is
 * not counted as an addition.
 */
export function compareFingerprint(
  root: string,
  baseline: Fingerprint,
  exclude: readonly string[] = [],
): FingerprintComparison {
  const current = computeFingerprint(root, exclude).files;
  const modified: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [path, digest] of Object.entries(current)) {
    const recorded = baseline.files[path];
    if (recorded === undefined) {
      added.push(path);
    } else if (recorded !== digest) {
      modified.push(path);
    }
  }
  for (const path of Object.keys(baseline.files)) {
    if (current[path] === undefined) {
      removed.push(path);
    }
  }

  modified.sort();
  added.sort();
  removed.sort();
  return {
    modified,
    added,
    removed,
    clean: modified.length === 0 && added.length === 0 && removed.length === 0,
  };
}

/**
 * Whether two fingerprints cover the same files with identical digests. Used to
 * confirm a re-materialized tree faithfully reproduces a recorded baseline
 * before it is trusted as a merge base.
 */
export function fingerprintsEqual(a: Fingerprint, b: Fingerprint): boolean {
  const aKeys = Object.keys(a.files);
  if (aKeys.length !== Object.keys(b.files).length) {
    return false;
  }
  for (const key of aKeys) {
    if (a.files[key] !== b.files[key]) {
      return false;
    }
  }
  return true;
}

/**
 * Parse a fingerprint from already-decoded JSON. Lenient by design — any shape
 * problem yields `null` so an older or hand-edited sidecar simply reports "no
 * recorded baseline" rather than throwing.
 */
export function parseFingerprint(value: unknown): Fingerprint | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (obj.algorithm !== "sha256") {
    return null;
  }
  const rawFiles = obj.files;
  if (
    typeof rawFiles !== "object" ||
    rawFiles === null ||
    Array.isArray(rawFiles)
  ) {
    return null;
  }
  const files: Record<string, string> = {};
  for (const [path, digest] of Object.entries(rawFiles)) {
    if (typeof digest !== "string") {
      return null;
    }
    files[path] = digest;
  }
  return { algorithm: "sha256", files };
}

// The preserved-entries constant lives with the shared walk so install
// fingerprinting and the live-reload source fingerprint can't disagree on
// what counts as the plugin's source tree; re-exported here for the
// install/upgrade/diff callers that treat this module as the fingerprint API.
export { PRESERVED_ENTRIES } from "../../plugins/plugin-tree-walk.js";

/**
 * Aggregate SHA-256 digest over a tree's contents, returned as `v2:<hex>`.
 *
 * This is the same scheme skills record in their `install-meta.json`
 * `contentHash` (see `src/skills/install-meta.ts`): files are visited in
 * POSIX-relative path order and each contributes a length-prefixed path
 * segment followed by its length-prefixed bytes, so neither path/content
 * boundaries nor reordering can collide. The `v2:` prefix marks the hashing
 * scheme so it can evolve without ambiguity. Unlike {@link Fingerprint}, this
 * is a single whole-tree digest — useful as a compact integrity signal
 * alongside the per-file map. Symlinks are skipped and top-level entries named
 * in `exclude` (e.g. the sidecar itself) are omitted, matching
 * {@link computeFingerprint}.
 */
export function computeContentHash(
  root: string,
  exclude: readonly string[] = [],
): string {
  const entries: Array<{ rel: string; abs: string }> = [];
  walkPluginTree(root, { excludeRootEntries: exclude }, (rel, abs) => {
    entries.push({ rel, abs });
  });
  entries.sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = createHash("sha256");
  for (const { rel, abs } of entries) {
    const pathBuf = Buffer.from(rel, "utf-8");
    const content = readFileSync(abs);
    hash.update(`${pathBuf.length}:`);
    hash.update(pathBuf);
    hash.update(`${content.length}:`);
    hash.update(content);
  }
  return `v2:${hash.digest("hex")}`;
}
