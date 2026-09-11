/**
 * Content fingerprint of an app's source tree, recorded at compile time so
 * later inspects can tell whether source has drifted from the last successful
 * build.
 *
 * The fingerprint is a one-way per-file digest map written into
 * `dist/.source-fingerprint.json` after a successful compile. It answers "did
 * this change?" and "which files?", not a reconstructable diff.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Digest algorithm recorded alongside the file map, for forward compatibility. */
export type FingerprintAlgorithm = "sha256";

/** Filename written into `dist/` next to compiled output. */
export const SOURCE_FINGERPRINT_FILENAME = ".source-fingerprint.json";

/** Directory names skipped at the app root only (compile output and records). */
const ROOT_SKIP_DIRS: ReadonlySet<string> = new Set(["dist", "records"]);

/** Directory names skipped at any depth. */
const SKIP_DIRS_ANY_DEPTH: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
]);

/**
 * Per-file content digest of an app source tree. Keys are POSIX-style
 * (forward-slash) paths relative to the app directory; values are lowercase
 * hex SHA-256 digests of each file's bytes.
 */
export interface AppSourceFingerprint {
  readonly algorithm: FingerprintAlgorithm;
  readonly files: Readonly<Record<string, string>>;
  /** ISO-8601 timestamp of the compile that produced this baseline, when known. */
  readonly compiledAt?: string;
}

/**
 * Difference between a recorded fingerprint and the current on-disk source.
 * Paths are POSIX-relative. A rename surfaces as one `removed` plus one `added`.
 */
export interface FingerprintComparison {
  readonly modified: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly clean: boolean;
}

export type AppSourceInspectStatus =
  | "clean"
  | "stale"
  | "never_compiled"
  | "unknown_baseline";

export interface AppSourceInspectResult {
  readonly status: AppSourceInspectStatus;
  readonly compiledAt: string | null;
  readonly modified: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

function hashFile(absPath: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Walk `appDir` and digest every regular source file. Skips `dist/` and
 * `records/` at the app root, and `node_modules` / `.git` at any depth.
 * Symlinks are neither visited nor followed.
 */
export function computeAppSourceFingerprint(
  appDir: string,
): AppSourceFingerprint {
  const files: Record<string, string> = {};

  const walk = (relDir: string): void => {
    const absDir = relDir ? join(appDir, relDir) : appDir;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (relDir === "" && ROOT_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory() && SKIP_DIRS_ANY_DEPTH.has(entry.name)) {
        continue;
      }
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.isFile()) {
        const digest = hashFile(join(absDir, entry.name));
        if (digest !== null) {
          files[rel] = digest;
        }
      }
    }
  };

  walk("");
  return { algorithm: "sha256", files };
}

export function compareAppSourceFingerprint(
  appDir: string,
  baseline: AppSourceFingerprint,
): FingerprintComparison {
  const current = computeAppSourceFingerprint(appDir).files;
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
 * Parse a fingerprint from already-decoded JSON. Lenient: any shape problem
 * yields `null` so a missing or hand-edited sidecar reports "no baseline"
 * rather than throwing.
 */
export function parseAppSourceFingerprint(
  value: unknown,
): AppSourceFingerprint | null {
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
  const compiledAt =
    typeof obj.compiledAt === "string" ? obj.compiledAt : undefined;
  return compiledAt === undefined
    ? { algorithm: "sha256", files }
    : { algorithm: "sha256", files, compiledAt };
}

export function readAppSourceFingerprint(
  appDir: string,
): AppSourceFingerprint | null {
  const path = join(appDir, "dist", SOURCE_FINGERPRINT_FILENAME);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return parseAppSourceFingerprint(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

/**
 * Write a source fingerprint into `distDir`. Pass the snapshot taken
 * before compile so inspect compares against the tree that produced this
 * dist, even if source changes during the build.
 */
export function writeAppSourceFingerprint(
  appDir: string,
  distDir: string,
  fingerprint: AppSourceFingerprint = computeAppSourceFingerprint(appDir),
): void {
  const payload: AppSourceFingerprint = {
    algorithm: fingerprint.algorithm,
    compiledAt: fingerprint.compiledAt ?? new Date().toISOString(),
    files: fingerprint.files,
  };
  writeFileSync(
    join(distDir, SOURCE_FINGERPRINT_FILENAME),
    `${JSON.stringify(payload)}\n`,
    "utf-8",
  );
}

/**
 * Compare current app source against the fingerprint recorded at last
 * successful compile.
 */
export function inspectAppSource(appDir: string): AppSourceInspectResult {
  const compiled = existsSync(join(appDir, "dist", "index.html"));
  if (!compiled) {
    return {
      status: "never_compiled",
      compiledAt: null,
      modified: [],
      added: [],
      removed: [],
    };
  }

  const baseline = readAppSourceFingerprint(appDir);
  if (baseline === null) {
    return {
      status: "unknown_baseline",
      compiledAt: null,
      modified: [],
      added: [],
      removed: [],
    };
  }

  const comparison = compareAppSourceFingerprint(appDir, baseline);
  return {
    status: comparison.clean ? "clean" : "stale",
    compiledAt: baseline.compiledAt ?? null,
    modified: comparison.modified,
    added: comparison.added,
    removed: comparison.removed,
  };
}
