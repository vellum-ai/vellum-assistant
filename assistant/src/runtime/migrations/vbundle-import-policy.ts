/**
 * Shared invariants and predicate functions consumed by both the buffer-
 * based `commitImport` and the streaming `streamCommitImport`. These
 * decisions must stay in lockstep across both importers — moving them
 * here removes the parallel-implementation skew risk that would otherwise
 * grow as either importer evolves.
 *
 * Pure: no `node:fs`, no I/O, no async. Functions over strings + manifest
 * data shapes only.
 */

export const LEGACY_USER_MD_ARCHIVE_PATH = "prompts/USER.md";

export const CONFIG_ARCHIVE_PATHS: ReadonlySet<string> = new Set([
  "workspace/config.json",
  "config/settings.json",
]);

export const CREDENTIAL_METADATA_ARCHIVE_PATH =
  "workspace/data/credentials/metadata.json";

export const WORKSPACE_PRESERVE_PATHS: readonly string[] = [
  "embedding-models",
  "deprecated",
  "data/db",
  "data/qdrant",
];

export function isWorkspaceNamespacedArchivePath(archivePath: string): boolean {
  return archivePath.startsWith("workspace/");
}

export function isLegacyPersonaArchivePath(archivePath: string): boolean {
  return archivePath === LEGACY_USER_MD_ARCHIVE_PATH;
}

export function isConfigArchivePath(archivePath: string): boolean {
  return CONFIG_ARCHIVE_PATHS.has(archivePath);
}

export function isCredentialMetadataArchivePath(archivePath: string): boolean {
  return archivePath === CREDENTIAL_METADATA_ARCHIVE_PATH;
}

/**
 * Partition `WORKSPACE_PRESERVE_PATHS` into the two skip sets the buffer
 * importer's selective-clear loop consumes:
 *
 * - `topLevelSkipDirs`: single-segment preserve-paths (e.g. "embedding-models").
 * - `dataSubdirSkipDirs`: second segment of `data/<x>` preserve-paths
 *   (e.g. "db" for "data/db").
 *
 * Stays in sync with WORKSPACE_PRESERVE_PATHS automatically — adding a
 * new entry of either shape doesn't require touching the buffer importer.
 * Multi-segment paths outside the `data/` subtree are intentionally
 * unsupported here; the buffer importer's walk doesn't recurse into
 * arbitrary subdirs. If a future preserve-path needs deeper coverage,
 * widen this helper and the buffer importer's walk together.
 */
export function partitionWorkspacePreserveSkipDirs(): {
  topLevelSkipDirs: ReadonlySet<string>;
  dataSubdirSkipDirs: ReadonlySet<string>;
} {
  const topLevelSkipDirs = new Set<string>();
  const dataSubdirSkipDirs = new Set<string>();
  for (const rel of WORKSPACE_PRESERVE_PATHS) {
    const parts = rel.split("/");
    if (parts.length === 1) {
      topLevelSkipDirs.add(parts[0]!);
    } else if (parts.length === 2 && parts[0] === "data") {
      dataSubdirSkipDirs.add(parts[1]!);
    }
  }
  return { topLevelSkipDirs, dataSubdirSkipDirs };
}

export const LEGACY_RUNTIME_VERSION_SENTINEL = "0.0.0-legacy";

type SemverTriple = readonly [number, number, number];

function parseSemverTriple(version: string): SemverTriple | null {
  // Strip optional prerelease/build suffix ("-foo", "+sha"). We treat
  // "0.7.1-staging.1" as equal-to-release "0.7.1" for gating purposes.
  // The platform-side check uses packaging.version.Version, which sorts
  // prereleases BEFORE the corresponding release; matching that exactly
  // would require a fuller parser — for runtime-side defense-in-depth
  // this conservative read is sufficient (matches release of the same
  // base triple).
  const base = version.split(/[-+]/)[0] ?? version;
  const parts = base.split(".");
  if (parts.length !== 3) return null;
  // Reject components with anything other than ASCII digits to avoid
  // Number.parseInt's lenient prefix-parse — e.g. "0.8.0foo" would
  // otherwise coerce to [0, 8, 0] and silently pass the gate, defeating
  // the parse-failure-fail-open contract in evaluateRuntimeCompatibility.
  // Leading zeros (e.g. "01.02.03") are intentionally accepted since
  // they round-trip to the same numeric triple as the un-padded form.
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const [maj, min, pat] = parts.map((p) => Number(p));
  if (![maj, min, pat].every((n) => Number.isFinite(n) && n >= 0)) {
    return null;
  }
  return [maj!, min!, pat!] as const;
}

// -1 if a < b, 0 if equal, +1 if a > b. Returns null on parse failure.
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const ta = parseSemverTriple(a);
  const tb = parseSemverTriple(b);
  if (!ta || !tb) return null;
  for (let i = 0; i < 3; i++) {
    if (ta[i]! < tb[i]!) return -1;
    if (ta[i]! > tb[i]!) return +1;
  }
  return 0;
}

export interface RuntimeCompatibility {
  min_runtime_version: string;
  max_runtime_version: string | null;
}

export type RuntimeCompatibilityResult =
  | { ok: true }
  | {
      ok: false;
      reason: "version_incompatible";
      bundle_compat: RuntimeCompatibility;
      runtime_version: string;
    };

export function formatRuntimeCompatibilityMessage(
  compat: RuntimeCompatibility,
  runtimeVersion: string,
): string {
  const range = compat.max_runtime_version
    ? `${compat.min_runtime_version}–${compat.max_runtime_version}`
    : `${compat.min_runtime_version}+`;
  return `Cannot import: bundle requires runtime ${range}, but this runtime is ${runtimeVersion}. Update your runtime before importing.`;
}

export function evaluateRuntimeCompatibility(
  compat: RuntimeCompatibility,
  runtimeVersion: string,
): RuntimeCompatibilityResult {
  if (compat.min_runtime_version === LEGACY_RUNTIME_VERSION_SENTINEL) {
    return { ok: true };
  }
  const minCmp = compareSemver(runtimeVersion, compat.min_runtime_version);
  if (minCmp === null) return { ok: true };
  if (minCmp < 0) {
    return {
      ok: false,
      reason: "version_incompatible",
      bundle_compat: compat,
      runtime_version: runtimeVersion,
    };
  }
  if (compat.max_runtime_version !== null) {
    const maxCmp = compareSemver(runtimeVersion, compat.max_runtime_version);
    if (maxCmp === null) return { ok: true };
    if (maxCmp > 0) {
      return {
        ok: false,
        reason: "version_incompatible",
        bundle_compat: compat,
        runtime_version: runtimeVersion,
      };
    }
  }
  return { ok: true };
}
