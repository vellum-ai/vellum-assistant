/**
 * Memory v2 — Concept page store.
 *
 * Owns the on-disk read/write contract for `memory/concepts/<slug>.md`.
 * Pages may live directly under `memory/concepts/` or nested in subdirectories
 * (e.g. `memory/concepts/people/alice.md`); the slug encodes the relative
 * path from `concepts/` minus the `.md` extension, using forward slashes as
 * separators (so `people/alice` is a valid slug).
 *
 * Each page is a YAML-frontmatter Markdown file: a `---`-delimited block
 * (`edges`, `ref_files`) followed by prose body. This module is the only
 * v2 component that knows how to parse or render that format — every other
 * v2 module routes through `readPage` / `writePage` so the on-disk shape
 * can evolve without touching downstream callers.
 *
 * Writes are atomic (temp + rename) so a crash mid-write leaves either the
 * old file or the new file in place — never a half-written page.
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { FRONTMATTER_REGEX } from "../../skills/frontmatter.js";
import { type ConceptPage, ConceptPageFrontmatterSchema } from "./types.js";

/** Filename suffix for concept pages. */
const PAGE_EXTENSION = ".md";

/** Cap individual slug-segment length so we stay well under filesystem limits. */
const MAX_SLUG_SEGMENT_LENGTH = 80;

/** Cap the full slug (including any folder separators) to a sane bound. */
const MAX_SLUG_TOTAL_LENGTH = 200;

/** Each path segment must match this — same shape `slugify` produces. */
const SLUG_SEGMENT_REGEX = /^[a-z0-9](?:[a-z0-9-]*)$/;

/**
 * Convert an arbitrary input string into a filesystem-safe slug **segment**.
 *
 * Returns a single path segment (no `/`). Path-shaped slugs are constructed
 * by the consolidation LLM writing files at full paths; this helper is for
 * turning free-form text (e.g. a hint phrase) into one clean segment.
 *
 * Rules:
 *   - Lowercase ASCII letters, digits, and hyphens only.
 *   - Non-ASCII / non-alphanumeric characters (including `/`) collapse to hyphens.
 *   - Consecutive hyphens collapse to one; leading/trailing hyphens trimmed.
 *   - Truncated to {@link MAX_SLUG_SEGMENT_LENGTH} characters (with trailing
 *     hyphen re-trimmed after truncation).
 *   - Empty inputs (e.g. emoji-only) fall back to `concept-<random>` so the
 *     caller always gets a non-empty, write-safe segment.
 */
export function slugify(input: string): string {
  let slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length > MAX_SLUG_SEGMENT_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_SEGMENT_LENGTH).replace(/-+$/, "");
  }

  if (!slug) {
    slug = `concept-${randomUUID().slice(0, 8)}`;
  }

  return slug;
}

/**
 * Validate a slug — possibly path-shaped — that is about to cross the storage
 * boundary. Throws on any malformed or unsafe value.
 *
 * The on-disk concept-page tree treats slugs as relative paths under
 * `memory/concepts/`. A malformed slug (e.g. `..`, leading `/`, embedded
 * null byte) could escape that root via `path.join` if it slipped through,
 * so we enforce shape here at every read/write/delete entry point rather
 * than relying on callers.
 *
 * Rules:
 *   - Non-empty, ≤ {@link MAX_SLUG_TOTAL_LENGTH} chars.
 *   - Each `/`-separated segment matches {@link SLUG_SEGMENT_REGEX}
 *     (lowercase alphanum + hyphen, no leading hyphen, ≤80 chars).
 *   - No `..` segments, no empty segments (`a//b`), no leading or trailing `/`.
 *   - No `\` (Windows separator), no null bytes, no whitespace, no non-ASCII.
 */
export function validateSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error(`Invalid concept-page slug: empty`);
  }
  if (slug.length > MAX_SLUG_TOTAL_LENGTH) {
    throw new Error(
      `Invalid concept-page slug: length ${slug.length} exceeds max ${MAX_SLUG_TOTAL_LENGTH}: ${slug}`,
    );
  }
  if (slug.includes("\\")) {
    throw new Error(
      `Invalid concept-page slug: backslash not allowed: ${slug}`,
    );
  }
  if (slug.includes("\0")) {
    throw new Error(`Invalid concept-page slug: null byte not allowed`);
  }
  if (/\s/.test(slug)) {
    throw new Error(
      `Invalid concept-page slug: whitespace not allowed: ${slug}`,
    );
  }
  if (slug.startsWith("/") || slug.endsWith("/")) {
    throw new Error(
      `Invalid concept-page slug: leading or trailing '/' not allowed: ${slug}`,
    );
  }
  const segments = slug.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error(`Invalid concept-page slug: empty path segment: ${slug}`);
    }
    if (segment === "..") {
      throw new Error(
        `Invalid concept-page slug: '..' segment not allowed: ${slug}`,
      );
    }
    if (segment.length > MAX_SLUG_SEGMENT_LENGTH) {
      throw new Error(
        `Invalid concept-page slug: segment '${segment}' exceeds max ${MAX_SLUG_SEGMENT_LENGTH} chars: ${slug}`,
      );
    }
    if (!SLUG_SEGMENT_REGEX.test(segment)) {
      throw new Error(
        `Invalid concept-page slug: segment '${segment}' must match [a-z0-9][a-z0-9-]*: ${slug}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getConceptsDir(workspaceDir: string): string {
  return join(workspaceDir, "memory", "concepts");
}

/**
 * Resolve the absolute path for a slug. Slugs may contain `/` to indicate
 * folder hierarchy under `memory/concepts/`; `path.join` handles those
 * correctly on POSIX, and `validateSlug` (called at every public entry point)
 * rejects shapes that could escape the concepts root.
 */
function getPagePath(workspaceDir: string, slug: string): string {
  return join(getConceptsDir(workspaceDir), `${slug}${PAGE_EXTENSION}`);
}

/**
 * Compute the slug for a concept-page file, given the concepts root and the
 * absolute file path. Returns the path-relative location with `.md` stripped
 * and platform separators normalized to `/`. Tolerant of paths that don't
 * end in `.md` so callers walking arbitrary content can use it defensively.
 */
export function slugFromConceptPath(
  conceptsRoot: string,
  filePath: string,
): string {
  const rel = relative(conceptsRoot, filePath);
  const withoutExt = rel.endsWith(PAGE_EXTENSION)
    ? rel.slice(0, -PAGE_EXTENSION.length)
    : rel;
  return sep === "/" ? withoutExt : withoutExt.split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Frontmatter parse / render
// ---------------------------------------------------------------------------

/**
 * Split raw file contents into (frontmatter, body). If no frontmatter block
 * is present the entire input is treated as body and an empty frontmatter
 * block is returned (validated by `ConceptPageFrontmatterSchema` so any
 * unexpected shape — bad types, extra junk — surfaces as a parse error to
 * the caller, not silent dropped data).
 *
 * The schema's defaults guarantee `edges` and `ref_files` are always arrays
 * even on freshly created pages with empty frontmatter.
 */
function parsePageContent(raw: string): {
  frontmatter: ConceptPage["frontmatter"];
  body: string;
} {
  const match = raw.match(FRONTMATTER_REGEX);
  if (!match) {
    return {
      frontmatter: ConceptPageFrontmatterSchema.parse({}),
      body: raw,
    };
  }
  const yamlBlock = match[1];
  const body = raw.slice(match[0].length);
  const parsed = parseYaml(yamlBlock) ?? {};
  return {
    frontmatter: ConceptPageFrontmatterSchema.parse(parsed),
    body,
  };
}

/**
 * Render a concept page back into the on-disk Markdown form. The output is
 * always frontmatter + body; even pages with empty `edges` and `ref_files`
 * keep the explicit YAML keys so callers see the canonical shape on round-trip.
 */
function renderPageContent(page: ConceptPage): string {
  const frontmatter = ConceptPageFrontmatterSchema.parse(page.frontmatter);
  const yamlBlock = stringifyYaml(frontmatter, { indent: 2 }).trimEnd();
  return `---\n${yamlBlock}\n---\n${page.body}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a single concept page. Returns `null` if the file does not exist.
 *
 * Any other read or parse failure (permission denied, malformed YAML,
 * frontmatter that fails schema validation) throws — unlike "missing", these
 * are programmer / data-corruption errors the caller needs to see.
 */
export async function readPage(
  workspaceDir: string,
  slug: string,
): Promise<ConceptPage | null> {
  validateSlug(slug);
  const path = getPagePath(workspaceDir, slug);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const { frontmatter, body } = parsePageContent(raw);
  return { slug, frontmatter, body };
}

/**
 * Write a concept page atomically (temp file + rename). A crash between the
 * temp write and the rename leaves the prior file intact; a crash after the
 * rename leaves the new file. Readers therefore never observe a partial page.
 *
 * Parent directories are created on demand (`mkdir -p`) so nested-folder
 * slugs like `people/alice` work without callers pre-creating the folder.
 */
export async function writePage(
  workspaceDir: string,
  page: ConceptPage,
): Promise<void> {
  validateSlug(page.slug);
  const path = getPagePath(workspaceDir, page.slug);
  const tmpPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const content = renderPageContent(page);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup: if the rename failed (or the write succeeded but
    // the rename did not), remove the orphan tmp file so we don't leak it
    // into the concepts/ directory where listPages would then surface it.
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * List every concept-page slug present on disk, walking subdirectories.
 *
 * Slugs are returned in path-relative form with forward slashes as separators
 * (e.g. `people/alice`) so callers can pass them straight back to `readPage`.
 *
 * Hidden directories (segment starts with `.`), non-`.md` files, and atomic-
 * write temp files (`.tmp.<pid>.<uuid>`) are skipped. If the concepts/
 * directory does not yet exist (fresh workspace pre-migration), returns `[]`.
 */
export async function listPages(workspaceDir: string): Promise<string[]> {
  const root = getConceptsDir(workspaceDir);
  const slugs: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Root missing → return []. Nested missing dir is impossible mid-walk
        // (we only enqueue what readdir surfaced) but treat the same defensively.
        if (dir === root) return [];
        continue;
      }
      throw err;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(PAGE_EXTENSION)) continue;
      // Skip orphaned temp files left behind by a crashed atomic write.
      if (entry.name.includes(".tmp.")) continue;
      slugs.push(slugFromConceptPath(root, fullPath));
    }
  }

  slugs.sort();
  return slugs;
}

/**
 * Delete a concept page. Idempotent — missing files are not an error.
 *
 * Any other failure (permission denied, etc.) throws so the caller can react.
 */
export async function deletePage(
  workspaceDir: string,
  slug: string,
): Promise<void> {
  validateSlug(slug);
  const path = getPagePath(workspaceDir, slug);
  try {
    await rm(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}

/**
 * Check whether a concept page exists on disk. Useful for callers that want
 * to gate work on presence without paying for a full read.
 */
export async function pageExists(
  workspaceDir: string,
  slug: string,
): Promise<boolean> {
  validateSlug(slug);
  const path = getPagePath(workspaceDir, slug);
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
