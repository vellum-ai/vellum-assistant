/**
 * Workspace migration 026: Backfill install-meta.json for existing skills
 *
 * Scans ~/.vellum/workspace/skills/ for installed skill directories and writes
 * an install-meta.json for each skill that lacks one, inferring the origin
 * from legacy version.json and .integrity.json files.
 *
 * Idempotent: safe to re-run after interruption at any point.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INSTALL_META_FILENAME = "install-meta.json";
const VERSION_JSON_FILENAME = "version.json";
const INTEGRITY_JSON_FILENAME = ".integrity.json";
const SKILL_MD_FILENAME = "SKILL.md";

// ---------------------------------------------------------------------------
// Inlined helpers (self-contained per migrations/AGENTS.md)
// ---------------------------------------------------------------------------

interface SkillInstallMeta {
  origin: "vellum" | "clawhub" | "skillssh" | "custom";
  installedAt: string;
  installedBy?: string;
  backfilledBy?: string;
  version?: string;
  slug?: string;
  sourceRepo?: string;
  contentHash?: string;
}

/**
 * Atomically write a file: write to a temp file, then rename.
 */
function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

/**
 * Write install-meta.json into a skill directory.
 */
function writeInstallMeta(skillDir: string, meta: SkillInstallMeta): void {
  const filePath = join(skillDir, INSTALL_META_FILENAME);
  atomicWriteFile(filePath, JSON.stringify(meta, null, 2) + "\n");
}

/**
 * Metadata files excluded from content hashing.
 */
const METADATA_FILENAMES = new Set([
  INSTALL_META_FILENAME,
  VERSION_JSON_FILENAME,
]);

/**
 * Collect all file contents in a directory tree, sorted by relative path.
 * Metadata files at root level are excluded.
 */
function collectFileContents(
  dir: string,
  prefix = "",
): Array<{ relPath: string; content: Buffer }> {
  const results: Array<{ relPath: string; content: Buffer }> = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!prefix && METADATA_FILENAMES.has(entry.name)) continue;

    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFileContents(fullPath, relPath));
    } else if (entry.isFile()) {
      results.push({ relPath, content: readFileSync(fullPath) });
    }
  }
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * Compute SHA-256 content hash over all non-metadata files in a skill dir.
 * Returns format: "v2:sha256hex".
 */
function computeSkillHash(skillDir: string): string | null {
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) return null;

  const files = collectFileContents(skillDir);
  if (files.length === 0) return null;

  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    const pathBuf = Buffer.from(file.relPath, "utf-8");
    hasher.update(`${pathBuf.length}:`);
    hasher.update(pathBuf);
    hasher.update(`${file.content.length}:`);
    hasher.update(file.content);
  }
  return `v2:${hasher.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Integrity manifest helpers
// ---------------------------------------------------------------------------

interface IntegrityRecord {
  sha256: string;
  installedAt: string;
}

type IntegrityManifest = Record<string, IntegrityRecord>;

function loadIntegrityManifest(skillsDir: string): IntegrityManifest {
  const path = join(skillsDir, INTEGRITY_JSON_FILENAME);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as IntegrityManifest;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Origin inference
// ---------------------------------------------------------------------------

/**
 * Infer SkillInstallMeta for a skill directory that has no install-meta.json.
 *
 * Decision tree:
 * 1. version.json with `origin: "skills.sh"` -> skillssh
 * 2. version.json with `version` but no `origin` field:
 *    - Has entry in .integrity.json -> clawhub
 *    - Otherwise -> vellum
 * 3. version.json exists but doesn't match above -> custom
 * 4. No version.json:
 *    - Has entry in .integrity.json -> clawhub
 *    - Otherwise -> custom
 */
function inferInstallMeta(
  skillDir: string,
  skillId: string,
  integrityManifest: IntegrityManifest,
): SkillInstallMeta {
  const versionJsonPath = join(skillDir, VERSION_JSON_FILENAME);
  const hasIntegrityEntry = skillId in integrityManifest;

  if (existsSync(versionJsonPath)) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(versionJsonPath, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      // Malformed version.json — treat as if it doesn't exist
      return buildFallbackMeta(skillDir, skillId, hasIntegrityEntry);
    }

    // Case 1: skills.sh origin
    if (raw.origin === "skills.sh") {
      return {
        origin: "skillssh",
        installedAt:
          typeof raw.installedAt === "string"
            ? raw.installedAt
            : getDirectoryMtime(skillDir),
        sourceRepo: typeof raw.source === "string" ? raw.source : undefined,
        slug: typeof raw.skillSlug === "string" ? raw.skillSlug : undefined,
        contentHash: computeSkillHash(skillDir) ?? undefined,
      };
    }

    // Case 2: has version but no origin field
    if (typeof raw.version === "string" && !("origin" in raw)) {
      return {
        origin: hasIntegrityEntry ? "clawhub" : "vellum",
        installedAt:
          typeof raw.installedAt === "string"
            ? raw.installedAt
            : getDirectoryMtime(skillDir),
        version: raw.version,
        contentHash: computeSkillHash(skillDir) ?? undefined,
      };
    }

    // Case 3: version.json exists but doesn't match known patterns
    return {
      origin: "custom",
      installedAt:
        typeof raw.installedAt === "string"
          ? raw.installedAt
          : getDirectoryMtime(skillDir),
      contentHash: computeSkillHash(skillDir) ?? undefined,
    };
  }

  // Case 4: no version.json
  return buildFallbackMeta(skillDir, skillId, hasIntegrityEntry);
}

function buildFallbackMeta(
  skillDir: string,
  _skillId: string,
  hasIntegrityEntry: boolean,
): SkillInstallMeta {
  return {
    origin: hasIntegrityEntry ? "clawhub" : "custom",
    installedAt: getDirectoryMtime(skillDir),
    contentHash: computeSkillHash(skillDir) ?? undefined,
  };
}

/**
 * Get directory mtime as ISO 8601 string. Falls back to current time.
 */
function getDirectoryMtime(dir: string): string {
  try {
    return statSync(dir).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export const backfillInstallMetaMigration: WorkspaceMigration = {
  id: "026-backfill-install-meta",
  description:
    "Backfill install-meta.json with origin field for existing skill directories",

  run(workspaceDir: string): void {
    const skillsDir = join(workspaceDir, "skills");
    if (!existsSync(skillsDir)) return;

    // Load the integrity manifest once — shared across all skills
    const integrityManifest = loadIntegrityManifest(skillsDir);

    // Enumerate skill directories (each subdirectory containing a SKILL.md)
    let dirNames: string[];
    try {
      dirNames = readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return;
    }

    for (const name of dirNames) {
      const skillDir = join(skillsDir, name);
      const skillMdPath = join(skillDir, SKILL_MD_FILENAME);
      const installMetaPath = join(skillDir, INSTALL_META_FILENAME);

      // Only process directories that contain SKILL.md
      if (!existsSync(skillMdPath)) continue;

      // Skip if install-meta.json already exists (idempotency)
      if (existsSync(installMetaPath)) continue;

      const meta = inferInstallMeta(skillDir, name, integrityManifest);

      // Mark as backfilled so down() can safely identify and remove only
      // migration-created files without touching CLI-installed ones.
      writeInstallMeta(skillDir, { ...meta, backfilledBy: "migration-026" });
    }
  },

  down(workspaceDir: string): void {
    const skillsDir = join(workspaceDir, "skills");
    if (!existsSync(skillsDir)) return;

    let dirNames: string[];
    try {
      dirNames = readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return;
    }

    for (const name of dirNames) {
      const installMetaPath = join(skillsDir, name, INSTALL_META_FILENAME);
      if (existsSync(installMetaPath)) {
        try {
          const meta = JSON.parse(
            readFileSync(installMetaPath, "utf-8"),
          ) as SkillInstallMeta;

          // Only remove install-meta.json that were backfilled by this migration.
          // Files written by the normal install flow (CLI, daemon, etc.) won't
          // have backfilledBy set and are safely preserved on rollback.
          if (meta.backfilledBy === "migration-026") {
            unlinkSync(installMetaPath);
          }
        } catch {
          // Malformed file — skip
        }
      }
    }
  },
};
