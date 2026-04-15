/**
 * catalog-files — preview file listings and single-file content for catalog
 * skills, including ones that are NOT installed locally.
 *
 * This module is pure library code: it does NOT wire itself into any handler
 * or route. Higher-level daemon handlers consume it via the exported
 * `readCatalogSkillFiles` / `readCatalogSkillFileContent` functions.
 *
 * Data sources:
 *   - In `VELLUM_DEV` mode, when `<repo>/skills/<id>/` exists on disk, we
 *     read the skill files directly from the repo checkout (matching the
 *     behavior of `getCatalog()` in dev).
 *   - Otherwise, we call the platform preview endpoints:
 *       GET /v1/skills/{skill_id}/files/
 *       GET /v1/skills/{skill_id}/files/content/?path=...
 *
 * Crucially, this code does NOT extract any tar/gzip archives. Previewing a
 * skill's files never installs it or touches the install flow.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, join, posix, sep } from "node:path";

import { getPlatformBaseUrl } from "../config/env.js";
import type { SlimSkillResponse } from "../daemon/message-types/skills.js";
import {
  isTextMimeType as isTextMime,
  MAX_INLINE_TEXT_SIZE,
} from "../runtime/routes/workspace-utils.js";
import { getLogger } from "../util/logger.js";
import { readPlatformToken } from "../util/platform.js";
import { getCachedCatalogSync, getCatalog } from "./catalog-cache.js";
import { type CatalogSkill, getRepoSkillsDir } from "./catalog-install.js";
import type { SkillFileProvider } from "./skill-file-provider.js";

const log = getLogger("catalog-files");

/**
 * Classify a file as text/binary from its name alone. Used by the preview
 * listings where we do not have the file's bytes on hand (platform mode) or
 * where we want to defer reading content until explicitly requested (dev
 * mode listings). Bun derives the mime type from the file extension, so
 * this works for non-existent paths too.
 */
function classifyByName(name: string): boolean {
  const mime = Bun.file(name).type;
  return !isTextMime(mime, name);
}

// ─── Shared types ────────────────────────────────────────────────────────────

/**
 * A single file entry in a skill directory or preview listing.
 *
 * This module owns the canonical shape; `daemon/handlers/skills.ts`
 * re-exports it so handler consumers can import it from either location.
 * Keeping the definition here avoids a circular import — catalog-files
 * depends on `catalog-cache.ts`, which would otherwise be reachable via
 * the handler module.
 */
export interface SkillFileEntry {
  path: string; // relative to skill directory root (e.g. "SKILL.md", "tools/foo.ts")
  name: string; // basename
  size: number;
  mimeType: string;
  isBinary: boolean;
  content: string | null; // inline text if ≤ 2 MB and text MIME, else null
}

// ─── Platform response contracts ─────────────────────────────────────────────
//
// The platform preview API uses snake_case on the wire. We map to the
// daemon's camelCase shape inside this module so nothing downstream needs to
// know about the platform contract.

interface PlatformFileListResponse {
  skill_id: string;
  files: Array<{ path: string; name: string; size: number; sha: string }>;
}

interface PlatformFileContentResponse {
  path: string;
  name: string;
  size: number;
  mime_type: string;
  is_binary: boolean;
  content: string | null;
}

// ─── Path sanitization ───────────────────────────────────────────────────────

/**
 * Normalize and validate a relative path coming from untrusted input. Returns
 * the normalized posix path on success, or `null` if the input is unsafe.
 *
 * Rules:
 *   - Reject empty strings and strings containing null bytes.
 *   - Reject absolute paths (unix or windows drive-prefixed).
 *   - Normalize backslashes to forward slashes, strip leading `./`, and
 *     run `posix.normalize` to collapse redundant segments.
 *   - Reject paths that escape the root (normalized result equals `..` or
 *     begins with `../`).
 *
 * The platform also validates these server-side; client-side sanitization is
 * defense in depth and short-circuits obvious bad requests before a network
 * round trip.
 */
export function sanitizeRelativePath(rawPath: string): string | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  if (rawPath.includes("\0")) return null;
  if (rawPath.startsWith("/")) return null;
  if (/^[a-zA-Z]:[/\\]/.test(rawPath)) return null;

  // Normalize separators and strip any leading "./" before posix.normalize
  // (which would otherwise preserve it in some cases).
  let candidate = rawPath.replace(/\\/g, "/");
  while (candidate.startsWith("./")) {
    candidate = candidate.slice(2);
  }
  if (candidate.length === 0) return null;

  const normalized = posix.normalize(candidate);
  if (normalized === "..") return null;
  if (normalized.startsWith("../")) return null;
  // posix.normalize can still return "." for purely no-op paths.
  if (normalized === ".") return null;
  // Reject if normalization produced an absolute or Windows-drive path.
  // Covers bypasses like `.//etc/passwd` where the leading `./` strip loop
  // leaves `/etc/passwd`, which `posix.normalize` then passes through as an
  // absolute path. The pre-normalization absolute-path check above only
  // catches inputs that were absolute to begin with.
  if (normalized.startsWith("/")) return null;
  if (/^[a-zA-Z]:[/\\]/.test(normalized)) return null;

  return normalized;
}

// ─── Source resolution ───────────────────────────────────────────────────────

type CatalogSource =
  | { kind: "dir"; dirPath: string }
  | { kind: "platform"; skillId: string };

/**
 * Resolve where to read files for a given catalog skill id. Performs NO
 * network calls — network requests happen only inside `readCatalogSkillFiles`
 * and `readCatalogSkillFileContent` on the platform path.
 *
 * Dev-mode safety: when a `<repoSkillsDir>/<skillId>` entry exists on disk,
 * we verify that the skill root is a real directory physically located
 * inside `repoSkillsDir` — rejecting symlinks and anything whose realpath
 * escapes the repo skills dir. This prevents a symlinked skill root from
 * pointing at an external directory and bypassing the later realpath
 * containment check in `readCatalogSkillFileContent` (the check there
 * derives `realRoot` from the already-resolved skill dir, so if the skill
 * root itself is a symlink, `realRoot` resolves through the symlink target
 * and the containment check becomes a no-op). On any violation we silently
 * fall through to platform mode, which is the safe default — the dev-mode
 * shortcut is an optimization, not a required code path.
 */
async function resolveCatalogSource(
  skillId: string,
): Promise<CatalogSource | null> {
  const catalog = await getCatalog();
  const inCatalog = catalog.some((skill) => skill.id === skillId);
  if (!inCatalog) return null;

  const repoSkillsDir = getRepoSkillsDir();
  if (repoSkillsDir) {
    const candidate = join(repoSkillsDir, skillId);
    if (existsSync(candidate) && isSafeDevSkillRoot(candidate, repoSkillsDir)) {
      return { kind: "dir", dirPath: candidate };
    }
  }
  return { kind: "platform", skillId };
}

/**
 * Verify that a dev-mode skill root candidate is a real directory physically
 * located inside `repoSkillsDir`. Returns `false` for any of:
 *
 *   - `candidate` is itself a symbolic link (even if the target is still
 *     "nearby" — following it would break the realpath containment check
 *     in `readCatalogSkillFileContent`).
 *   - `candidate` is not a directory.
 *   - `realpath(candidate)` escapes `realpath(repoSkillsDir)`.
 *   - Any fs call throws (EACCES, ENOENT race, etc.).
 *
 * Callers should fall through to platform mode on `false`.
 */
function isSafeDevSkillRoot(candidate: string, repoSkillsDir: string): boolean {
  let lstat;
  try {
    lstat = lstatSync(candidate);
  } catch {
    return false;
  }
  if (lstat.isSymbolicLink()) return false;
  if (!lstat.isDirectory()) return false;

  let realCandidate: string;
  let realRepoSkillsDir: string;
  try {
    realCandidate = realpathSync(candidate);
    realRepoSkillsDir = realpathSync(repoSkillsDir);
  } catch {
    return false;
  }
  if (
    !(
      realCandidate === realRepoSkillsDir ||
      realCandidate.startsWith(realRepoSkillsDir + sep)
    )
  ) {
    return false;
  }
  return true;
}

// ─── Platform fetch helper ───────────────────────────────────────────────────

/**
 * Fetch JSON from the platform preview API. Returns `null` on any failure
 * (non-2xx, network error, abort). The query string is stripped from log
 * messages to avoid leaking user-supplied file paths.
 */
async function fetchPlatformJson<T>(
  path: string,
  query?: Record<string, string>,
): Promise<T | null> {
  const base = getPlatformBaseUrl();
  const url = new URL(`${base}${path}`);
  if (query) {
    const params = new URLSearchParams(query);
    url.search = params.toString();
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  const token = readPlatformToken();
  if (token) {
    headers["X-Conversation-Token"] = token;
  }

  try {
    const response = await fetch(url.toString(), {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      log.warn(
        { status: response.status, path },
        "Platform preview API returned non-2xx",
      );
      return null;
    }
    return (await response.json()) as T;
  } catch (err) {
    log.warn({ err, path }, "Platform preview API request failed");
    return null;
  }
}

// ─── Dev-mode directory walker ───────────────────────────────────────────────

// Directory names that are always skipped when walking a catalog skill dir in
// dev mode. Also used by `daemon/handlers/skills.ts` — both for the
// installed-skill walker and for the single-file content endpoint's
// hidden/skipped path rejection. Exported so the daemon handler can
// import this single source of truth and stay in sync.
export const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git"]);

/**
 * Returns true if the given sanitized posix path contains any segment that
 * is hidden (starts with `.`) or present in `SKIP_DIRS`. Used to reject
 * file-content reads for paths the listing APIs intentionally hide, so
 * callers cannot fetch `.env`, `.git/config`, `node_modules/...`, etc. via
 * the content endpoint even though the listing never surfaces them.
 *
 * The input MUST already be a normalized posix path (i.e. the return value
 * of `sanitizeRelativePath`). This helper does not re-normalize — it splits
 * on `/` and inspects each segment directly.
 */
export function hasHiddenOrSkippedSegment(sanitized: string): boolean {
  const segments = sanitized.split("/");
  for (const segment of segments) {
    if (segment.length === 0) continue;
    if (segment.startsWith(".")) return true;
    if (SKIP_DIRS.has(segment)) return true;
  }
  return false;
}

function walkSkillDir(dir: string, rootDir: string): SkillFileEntry[] {
  const out: SkillFileEntry[] = [];
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of dirents) {
    // Skip dot-prefixed entries (hidden files like `.DS_Store` and dot-dirs
    // like `.git`, `.venv`). Matches the behavior of the installed-skill
    // walker in `daemon/handlers/skills.ts`.
    if (dirent.name.startsWith(".")) continue;
    const abs = join(dir, dirent.name);
    // Silently skip symlinks, sockets, devices, etc.
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      // Skip well-known heavyweight directories (node_modules, __pycache__,
      // ...) so a dev working on a catalog skill locally doesn't see
      // thousands of spurious entries in the preview listing.
      if (SKIP_DIRS.has(dirent.name)) continue;
      out.push(...walkSkillDir(abs, rootDir));
      continue;
    }
    if (!dirent.isFile()) continue;
    try {
      const stat = statSync(abs);
      // Convert absolute → relative with manual separator normalization so
      // the result is always posix-style regardless of the host platform.
      const relFromRoot = abs.slice(rootDir.length);
      const cleaned = relFromRoot.startsWith(sep)
        ? relFromRoot.slice(sep.length)
        : relFromRoot;
      const posixPath = cleaned.split(sep).join("/");
      out.push({
        path: posixPath,
        name: basename(posixPath),
        size: stat.size,
        mimeType: "",
        isBinary: classifyByName(dirent.name),
        content: null,
      });
    } catch {
      // Skip unreadable files silently.
    }
  }
  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * List files for a catalog skill (installed or not).
 *
 * Returns `null` if the skill id is not in the catalog at all. Otherwise
 * returns an array of `SkillFileEntry` with `content === null` for every
 * entry (single-file content is fetched on demand via
 * `readCatalogSkillFileContent`).
 */
export async function readCatalogSkillFiles(
  skillId: string,
): Promise<SkillFileEntry[] | null> {
  const source = await resolveCatalogSource(skillId);
  if (!source) return null;

  if (source.kind === "dir") {
    const entries = walkSkillDir(source.dirPath, source.dirPath);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  const response = await fetchPlatformJson<PlatformFileListResponse>(
    `/v1/skills/${encodeURIComponent(skillId)}/files/`,
  );
  if (!response) return null;

  const entries: SkillFileEntry[] = response.files.map((file) => ({
    path: file.path,
    name: file.name,
    size: file.size,
    mimeType: "",
    isBinary: classifyByName(file.name),
    content: null,
  }));
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/**
 * Read a single file's content from a catalog skill (installed or not).
 *
 * Returns `null` if the skill is missing from the catalog, the path fails
 * sanitization, the underlying source rejects the request, or the file does
 * not exist. In dev mode, text files up to `MAX_INLINE_TEXT_SIZE` are returned
 * with their UTF-8 content inline; anything larger or flagged as binary
 * returns with `content === null`. In platform mode, the server enforces
 * the same contract and we pass its response through unchanged.
 */
export async function readCatalogSkillFileContent(
  skillId: string,
  relativePath: string,
): Promise<SkillFileEntry | null> {
  const sanitized = sanitizeRelativePath(relativePath);
  if (!sanitized) return null;

  // Defense in depth: reject any path that references a hidden or
  // SKIP_DIRS segment. The daemon handler performs the same check before
  // calling us, but we repeat it here so direct callers of this module
  // short-circuit without a network round trip and without touching disk.
  if (hasHiddenOrSkippedSegment(sanitized)) return null;

  const source = await resolveCatalogSource(skillId);
  if (!source) return null;

  if (source.kind === "dir") {
    const abs = join(source.dirPath, sanitized);
    // Defense in depth: make absolutely sure the resolved absolute path is
    // still inside the skill root, even after `join` normalization. This is
    // a cheap lexical short-circuit that runs before any fs stat calls.
    if (!(abs === source.dirPath || abs.startsWith(source.dirPath + sep))) {
      return null;
    }
    if (!existsSync(abs)) return null;

    // Reject symlinks at the target path directly: we do NOT want to follow
    // a symlinked file inside a catalog skill dir out of the skill root.
    let lstat;
    try {
      lstat = lstatSync(abs);
    } catch {
      return null;
    }
    if (lstat.isSymbolicLink()) return null;
    if (!lstat.isFile()) return null;

    // Also resolve any intermediate symlinks in the parent path via
    // realpath and verify the result is still contained within the skill
    // root's own realpath. This catches symlinked parent directories that
    // the lexical check above can't see through.
    let realAbs: string;
    let realRoot: string;
    try {
      realAbs = realpathSync(abs);
      realRoot = realpathSync(source.dirPath);
    } catch {
      return null;
    }
    if (!(realAbs === realRoot || realAbs.startsWith(realRoot + sep))) {
      return null;
    }

    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;

    const name = basename(abs);
    const mimeType = Bun.file(abs).type;
    const isBinary = !isTextMime(mimeType, name);
    let content: string | null = null;
    if (!isBinary && stat.size <= MAX_INLINE_TEXT_SIZE) {
      try {
        content = readFileSync(abs, "utf-8");
      } catch {
        content = null;
      }
    }
    return {
      path: sanitized,
      name,
      size: stat.size,
      mimeType,
      isBinary,
      content,
    };
  }

  const response = await fetchPlatformJson<PlatformFileContentResponse>(
    `/v1/skills/${encodeURIComponent(skillId)}/files/content/`,
    { path: sanitized },
  );
  if (!response) return null;

  return {
    path: response.path,
    name: response.name,
    size: response.size,
    mimeType: response.mime_type,
    isBinary: response.is_binary,
    content: response.content,
  };
}

// ─── Catalog-to-slim conversion ──────────────────────────────────────────────

/**
 * Map a `CatalogSkill` (from the Vellum platform API) to a `SlimSkillResponse`
 * shaped for the "available catalog skill" case. Shared between
 * `listSkillsWithCatalog` (merging catalog entries into the installed list),
 * `getSkillFiles` (catalog fallback for preview listings), and the
 * `VellumCatalogProvider`. Keeping the mapping in one place avoids divergence
 * between the list and detail paths.
 *
 * Extracted here (rather than in `daemon/handlers/skills.ts`) to avoid a
 * circular import — catalog-files depends on `catalog-cache.ts`, which would
 * otherwise be reachable via the handler module.
 */
export function catalogSkillToSlim(cs: CatalogSkill): SlimSkillResponse {
  return {
    id: cs.id,
    name: cs.metadata?.vellum?.["display-name"] ?? cs.name,
    description: cs.description,
    emoji: cs.emoji,
    kind: "catalog",
    origin: "vellum",
    status: "available",
  };
}

// ─── Vellum Catalog Provider ─────────────────────────────────────────────────

/**
 * Create a `SkillFileProvider` that wraps the existing catalog-files functions
 * for the Vellum first-party catalog. This is the first provider implementation
 * in the unified file-preview chain.
 */
export function createVellumCatalogProvider(): SkillFileProvider {
  return {
    canHandle(skillId: string): boolean {
      const cached = getCachedCatalogSync();
      return cached.some((s) => s.id === skillId);
    },

    listFiles(skillId: string): Promise<SkillFileEntry[] | null> {
      return readCatalogSkillFiles(skillId);
    },

    readFileContent(
      skillId: string,
      sanitizedPath: string,
    ): Promise<SkillFileEntry | null> {
      return readCatalogSkillFileContent(skillId, sanitizedPath);
    },

    async toSlimSkill(skillId: string): Promise<SlimSkillResponse | null> {
      const catalog = await getCatalog();
      const cs = catalog.find((s) => s.id === skillId);
      if (!cs) return null;
      return catalogSkillToSlim(cs);
    },
  };
}
