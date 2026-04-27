/**
 * Memory v2 — Concept page store.
 *
 * Owns the on-disk read/write contract for `memory/concepts/<slug>.md`.
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
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { FRONTMATTER_REGEX } from "../../skills/frontmatter.js";
import { type ConceptPage, ConceptPageFrontmatterSchema } from "./types.js";

/** Filename suffix for concept pages. */
const PAGE_EXTENSION = ".md";

/** Cap slug length so we stay well under filesystem name limits. */
const MAX_SLUG_LENGTH = 80;

/**
 * Convert an arbitrary input string into a filesystem-safe slug.
 *
 * Rules:
 *   - Lowercase ASCII letters, digits, and hyphens only.
 *   - Non-ASCII / non-alphanumeric characters collapse to hyphens.
 *   - Consecutive hyphens collapse to one; leading/trailing hyphens trimmed.
 *   - Truncated to {@link MAX_SLUG_LENGTH} characters (with trailing hyphen
 *     re-trimmed after truncation).
 *   - Empty inputs (e.g. emoji-only) fall back to `concept-<random>` so the
 *     caller always gets a non-empty, write-safe slug.
 */
export function slugify(input: string): string {
  let slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
  }

  if (!slug) {
    slug = `concept-${randomUUID().slice(0, 8)}`;
  }

  return slug;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getConceptsDir(workspaceDir: string): string {
  return join(workspaceDir, "memory", "concepts");
}

function getPagePath(workspaceDir: string, slug: string): string {
  return join(getConceptsDir(workspaceDir), `${slug}${PAGE_EXTENSION}`);
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
 */
export async function writePage(
  workspaceDir: string,
  page: ConceptPage,
): Promise<void> {
  const path = getPagePath(workspaceDir, page.slug);
  const tmpPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const content = renderPageContent(page);
  try {
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
 * List every concept-page slug present on disk. Slugs are returned without
 * the `.md` suffix so callers can pass them straight back to `readPage`.
 *
 * Non-`.md` files (e.g. editor swap files, attached media) are filtered out.
 * If the concepts/ directory does not yet exist (fresh workspace pre-migration),
 * returns `[]`.
 */
export async function listPages(workspaceDir: string): Promise<string[]> {
  const dir = getConceptsDir(workspaceDir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const slugs: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(PAGE_EXTENSION)) continue;
    slugs.push(entry.name.slice(0, -PAGE_EXTENSION.length));
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
