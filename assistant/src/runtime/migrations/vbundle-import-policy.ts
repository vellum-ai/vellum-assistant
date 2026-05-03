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
