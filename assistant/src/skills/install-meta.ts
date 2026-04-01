import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ─── SkillInstallMeta type ──────────────────────────────────────────────────

export interface SkillInstallMeta {
  origin: "vellum" | "clawhub" | "skillssh" | "custom";
  installedAt: string; // ISO 8601
  installedBy?: string; // actorPrincipalId from auth context (identifies who initiated the install)
  backfilledBy?: string; // set by migration that backfilled this file (e.g. "migration-026")
  version?: string; // semver if known
  slug?: string; // registry slug
  sourceRepo?: string; // GitHub repo (e.g. "vercel-labs/agent-skills")
  contentHash?: string; // SHA-256 content hash (v2:hex format)
}

// ─── Atomic write helper ────────────────────────────────────────────────────

function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

// ─── Write install-meta.json ────────────────────────────────────────────────

const INSTALL_META_FILENAME = "install-meta.json";
const LEGACY_VERSION_FILENAME = "version.json";

/**
 * Atomically write `install-meta.json` inside the skill directory.
 */
export function writeInstallMeta(
  skillDir: string,
  meta: SkillInstallMeta,
): void {
  const filePath = join(skillDir, INSTALL_META_FILENAME);
  atomicWriteFile(filePath, JSON.stringify(meta, null, 2) + "\n");
}

// ─── Read install-meta.json (with legacy fallback) ──────────────────────────

/**
 * Reads `install-meta.json` from the skill directory. If not found, falls
 * back to reading legacy `version.json` and inferring the origin:
 *
 * - Has `origin: "skills.sh"` -> `origin: "skillssh"`, copies `source` as
 *   `sourceRepo` and `skillSlug` as `slug`.
 * - Has `version` but no `origin` field -> `origin: "vellum"`.
 * - Otherwise -> `origin: "custom"`.
 *
 * Legacy files never have `installedBy`, so it will be `undefined` for
 * backfilled skills.
 *
 * If neither file exists, returns `null`.
 */
export function readInstallMeta(skillDir: string): SkillInstallMeta | null {
  // Try install-meta.json first
  const metaPath = join(skillDir, INSTALL_META_FILENAME);
  if (existsSync(metaPath)) {
    try {
      return JSON.parse(readFileSync(metaPath, "utf-8")) as SkillInstallMeta;
    } catch {
      // Malformed install-meta.json (partial write, manual edit, etc.) —
      // fall through to the legacy version.json path so we don't lose
      // provenance info when a valid legacy file exists.
    }
  }

  // Fall back to legacy version.json
  const legacyPath = join(skillDir, LEGACY_VERSION_FILENAME);
  if (!existsSync(legacyPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(legacyPath, "utf-8")) as Record<
      string,
      unknown
    >;
    return inferFromLegacyVersionJson(raw);
  } catch {
    return null;
  }
}

/**
 * Infer a SkillInstallMeta from a legacy version.json object.
 */
function inferFromLegacyVersionJson(
  raw: Record<string, unknown>,
): SkillInstallMeta {
  // skills.sh origin: has `origin: "skills.sh"`
  if (raw.origin === "skills.sh") {
    return {
      origin: "skillssh",
      installedAt:
        typeof raw.installedAt === "string"
          ? raw.installedAt
          : new Date().toISOString(),
      sourceRepo: typeof raw.source === "string" ? raw.source : undefined,
      slug: typeof raw.skillSlug === "string" ? raw.skillSlug : undefined,
    };
  }

  // Vellum (first-party catalog) origin: has `version` but no `origin` field
  if (typeof raw.version === "string" && !("origin" in raw)) {
    return {
      origin: "vellum",
      installedAt:
        typeof raw.installedAt === "string"
          ? raw.installedAt
          : new Date().toISOString(),
      version: raw.version,
    };
  }

  // Unknown format -> custom
  return {
    origin: "custom",
    installedAt:
      typeof raw.installedAt === "string"
        ? raw.installedAt
        : new Date().toISOString(),
  };
}

// ─── Content hash computation ───────────────────────────────────────────────

/**
 * Metadata files excluded from content hashing. These are written by the
 * installer and must not contribute to the content hash — otherwise the hash
 * stored inside `install-meta.json` would change after writing the file.
 */
const METADATA_FILENAMES = new Set([
  INSTALL_META_FILENAME, // install-meta.json
  LEGACY_VERSION_FILENAME, // version.json
]);

/**
 * Collect all file contents in a directory tree, sorted by relative path
 * for determinism. Metadata files (`install-meta.json`, `version.json`) at
 * the root level are excluded so the content hash covers only actual skill
 * content.
 */
export function collectFileContents(
  dir: string,
  prefix = "",
): Array<{ relPath: string; content: Buffer }> {
  const results: Array<{ relPath: string; content: Buffer }> = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Exclude metadata files at the root level (prefix === "").
    // Only exclude actual files — a directory with a metadata name should
    // still be traversed so nested content contributes to the hash.
    if (!prefix && entry.isFile() && METADATA_FILENAMES.has(entry.name))
      continue;

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
 * Compute a SHA-256 hash over all files in a skill directory.
 * Returns format: "v2:sha256hex" (version prefix added to support hash format
 * evolution).
 *
 * This is the content hash used by the integrity manifest (trust-on-first-use).
 * It differs from `computeSkillVersionHash` in `version-hash.ts`, which uses a
 * different hashing strategy (v1: prefix) for version identity.
 */
export function computeSkillHash(skillDir: string): string | null {
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) return null;

  const files = collectFileContents(skillDir);
  if (files.length === 0) return null;

  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    // Length-prefix each segment to prevent boundary ambiguity collisions
    const pathBuf = Buffer.from(file.relPath, "utf-8");
    hasher.update(`${pathBuf.length}:`);
    hasher.update(pathBuf);
    hasher.update(`${file.content.length}:`);
    hasher.update(file.content);
  }
  return `v2:${hasher.digest("hex")}`;
}
