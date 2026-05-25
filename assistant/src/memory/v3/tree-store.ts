/**
 * Memory v3 — Tree node store.
 *
 * Owns the on-disk read/write contract for `memory/v3/tree/<id>.md`. Nodes may
 * live directly under `memory/v3/tree/` or nested in subdirectories (e.g.
 * `memory/v3/tree/people/colleagues.md`); the id encodes the relative path from
 * `tree/` minus the `.md` extension, using forward slashes as separators (so
 * `people/colleagues` is a valid id).
 *
 * The v3 tree is a DAG *overlay* over the existing flat `memory/concepts/`
 * pages — this module never touches `memory/concepts/`. Pages stay canonical
 * and shared; nodes reference pages and sub-nodes by `children` refs
 * (`page:<slug>` / `node:<id>`), which are the portable replacement for
 * filesystem symlinks.
 *
 * Each node is a YAML-frontmatter Markdown file: a `---`-delimited block
 * (`children`, optional `routing_hints` / `summary`) followed by the prose body
 * that is the node's full self-description. This module is the only v3
 * component that knows how to parse or render that format — every other v3
 * module routes through `readNode` / `writeNode` so the on-disk shape can
 * evolve without touching downstream callers.
 *
 * Writes are atomic (temp + rename) so a crash mid-write leaves either the old
 * file or the new file in place — never a half-written node. The id machinery
 * mirrors v2's page-store `slugify` / `validateSlug` so node ids and page slugs
 * share the same filesystem-safe shape.
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { FRONTMATTER_REGEX } from "../../skills/frontmatter.js";
import { type TreeNode, TreeNodeFrontmatterSchema } from "./types.js";

/** Filename suffix for tree nodes. */
const NODE_EXTENSION = ".md";

/** Cap individual id-segment length so we stay well under filesystem limits. */
const MAX_ID_SEGMENT_LENGTH = 80;

/** Cap the full id (including any folder separators) to a sane bound. */
const MAX_ID_TOTAL_LENGTH = 200;

/** Each path segment must match this — same shape `slugify` produces. */
const ID_SEGMENT_REGEX = /^[a-z0-9](?:[a-z0-9-]*)$/;

/**
 * Reserved id for the root of the v3 tree. The root node is the entry point a
 * future migration authors first; reserving the id keeps the well-known handle
 * stable across the codebase.
 */
export const ROOT_NODE_ID = "_root";

/**
 * Convert an arbitrary input string into a filesystem-safe id **segment**.
 *
 * Returns a single path segment (no `/`). Path-shaped ids are constructed by
 * the authoring migration writing files at full paths; this helper is for
 * turning free-form text (e.g. a node label) into one clean segment.
 *
 * Rules:
 *   - Lowercase ASCII letters, digits, and hyphens only.
 *   - Non-ASCII / non-alphanumeric characters (including `/`) collapse to hyphens.
 *   - Consecutive hyphens collapse to one; leading/trailing hyphens trimmed.
 *   - Truncated to {@link MAX_ID_SEGMENT_LENGTH} characters (with trailing
 *     hyphen re-trimmed after truncation).
 *   - Empty inputs (e.g. emoji-only) fall back to `node-<random>` so the caller
 *     always gets a non-empty, write-safe segment.
 */
export function slugify(input: string): string {
  let slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length > MAX_ID_SEGMENT_LENGTH) {
    slug = slug.slice(0, MAX_ID_SEGMENT_LENGTH).replace(/-+$/, "");
  }

  if (!slug) {
    slug = `node-${randomUUID().slice(0, 8)}`;
  }

  return slug;
}

/**
 * Validate a node id — possibly path-shaped — that is about to cross the
 * storage boundary. Throws on any malformed or unsafe value.
 *
 * The on-disk tree treats ids as relative paths under `memory/v3/tree/`. A
 * malformed id (e.g. `..`, leading `/`, embedded null byte) could escape that
 * root via `path.join` if it slipped through, so we enforce shape here at every
 * read/write/delete entry point rather than relying on callers.
 *
 * The reserved {@link ROOT_NODE_ID} (`_root`) is accepted as a special case;
 * its leading underscore would otherwise fail {@link ID_SEGMENT_REGEX}.
 *
 * Rules:
 *   - Non-empty, ≤ {@link MAX_ID_TOTAL_LENGTH} chars.
 *   - Each `/`-separated segment matches {@link ID_SEGMENT_REGEX}
 *     (lowercase alphanum + hyphen, no leading hyphen, ≤80 chars).
 *   - No `..` segments, no empty segments (`a//b`), no leading or trailing `/`.
 *   - No `\` (Windows separator), no null bytes, no whitespace, no non-ASCII.
 */
export function validateNodeId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Invalid tree-node id: empty`);
  }
  if (id === ROOT_NODE_ID) {
    return;
  }
  if (id.length > MAX_ID_TOTAL_LENGTH) {
    throw new Error(
      `Invalid tree-node id: length ${id.length} exceeds max ${MAX_ID_TOTAL_LENGTH}: ${id}`,
    );
  }
  if (id.includes("\\")) {
    throw new Error(`Invalid tree-node id: backslash not allowed: ${id}`);
  }
  if (id.includes("\0")) {
    throw new Error(`Invalid tree-node id: null byte not allowed`);
  }
  if (/\s/.test(id)) {
    throw new Error(`Invalid tree-node id: whitespace not allowed: ${id}`);
  }
  if (id.startsWith("/") || id.endsWith("/")) {
    throw new Error(
      `Invalid tree-node id: leading or trailing '/' not allowed: ${id}`,
    );
  }
  const segments = id.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error(`Invalid tree-node id: empty path segment: ${id}`);
    }
    if (segment === "..") {
      throw new Error(`Invalid tree-node id: '..' segment not allowed: ${id}`);
    }
    if (segment.length > MAX_ID_SEGMENT_LENGTH) {
      throw new Error(
        `Invalid tree-node id: segment '${segment}' exceeds max ${MAX_ID_SEGMENT_LENGTH} chars: ${id}`,
      );
    }
    if (!ID_SEGMENT_REGEX.test(segment)) {
      throw new Error(
        `Invalid tree-node id: segment '${segment}' must match [a-z0-9][a-z0-9-]*: ${id}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getTreeDir(workspaceDir: string): string {
  return join(workspaceDir, "memory", "v3", "tree");
}

/**
 * Resolve the absolute path for a node id. Ids may contain `/` to indicate
 * folder hierarchy under `memory/v3/tree/`; `path.join` handles those correctly
 * on POSIX, and `validateNodeId` (called at every public entry point) rejects
 * shapes that could escape the tree root.
 */
function getNodePath(workspaceDir: string, id: string): string {
  return join(getTreeDir(workspaceDir), `${id}${NODE_EXTENSION}`);
}

/**
 * Compute the id for a tree-node file, given the tree root and the absolute
 * file path. Returns the path-relative location with `.md` stripped and
 * platform separators normalized to `/`. Tolerant of paths that don't end in
 * `.md` so callers walking arbitrary content can use it defensively.
 */
function idFromNodePath(treeRoot: string, filePath: string): string {
  const rel = relative(treeRoot, filePath);
  const withoutExt = rel.endsWith(NODE_EXTENSION)
    ? rel.slice(0, -NODE_EXTENSION.length)
    : rel;
  return sep === "/" ? withoutExt : withoutExt.split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Frontmatter parse / render
// ---------------------------------------------------------------------------

/**
 * Split raw file contents into (frontmatter, body). If no frontmatter block is
 * present the entire input is treated as body and an empty frontmatter block is
 * returned (validated by `TreeNodeFrontmatterSchema` so any unexpected shape —
 * bad types, extra junk — surfaces as a parse error to the caller, not silent
 * dropped data).
 *
 * The schema's default guarantees `children` is always an array even on a
 * freshly created node with empty frontmatter.
 */
function parseNodeContent(raw: string): {
  frontmatter: TreeNode["frontmatter"];
  body: string;
} {
  const match = raw.match(FRONTMATTER_REGEX);
  if (!match) {
    return {
      frontmatter: TreeNodeFrontmatterSchema.parse({}),
      body: raw,
    };
  }
  const yamlBlock = match[1];
  const body = raw.slice(match[0].length);
  const parsed = parseYaml(yamlBlock) ?? {};
  return {
    frontmatter: TreeNodeFrontmatterSchema.parse(parsed),
    body,
  };
}

/**
 * Render a tree node back into the on-disk Markdown form. The output is always
 * frontmatter + body; even nodes with empty `children` keep the explicit YAML
 * key so callers see the canonical shape on round-trip.
 */
export function renderNodeContent(node: TreeNode): string {
  const frontmatter = TreeNodeFrontmatterSchema.parse(node.frontmatter);
  const yamlBlock = stringifyYaml(frontmatter, { indent: 2 }).trimEnd();
  return `---\n${yamlBlock}\n---\n${node.body}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a single tree node. Returns `null` if the file does not exist.
 *
 * Any other read or parse failure (permission denied, malformed YAML,
 * frontmatter that fails schema validation) throws — unlike "missing", these
 * are programmer / data-corruption errors the caller needs to see.
 */
export async function readNode(
  workspaceDir: string,
  id: string,
): Promise<TreeNode | null> {
  validateNodeId(id);
  const path = getNodePath(workspaceDir, id);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const { frontmatter, body } = parseNodeContent(raw);
  return { id, frontmatter, body };
}

/**
 * Write a tree node atomically (temp file + rename). A crash between the temp
 * write and the rename leaves the prior file intact; a crash after the rename
 * leaves the new file. Readers therefore never observe a partial node.
 *
 * Parent directories are created on demand (`mkdir -p`) so nested-folder ids
 * like `people/colleagues` work without callers pre-creating the folder.
 */
export async function writeNode(
  workspaceDir: string,
  node: TreeNode,
): Promise<void> {
  validateNodeId(node.id);
  const path = getNodePath(workspaceDir, node.id);
  const tmpPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const content = renderNodeContent(node);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup: if the rename failed (or the write succeeded but the
    // rename did not), remove the orphan tmp file so we don't leak it into the
    // tree/ directory where listNodes would then surface it.
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * List every tree-node id present on disk, walking subdirectories.
 *
 * Ids are returned in path-relative form with forward slashes as separators
 * (e.g. `people/colleagues`) so callers can pass them straight back to
 * `readNode`.
 *
 * Hidden directories (segment starts with `.`), non-`.md` files, and atomic-
 * write temp files (`.tmp.<pid>.<uuid>`) are skipped. If the tree/ directory
 * does not yet exist (fresh workspace pre-migration), returns `[]`.
 */
export async function listNodes(workspaceDir: string): Promise<string[]> {
  const root = getTreeDir(workspaceDir);
  const ids: string[] = [];
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
      if (!entry.name.endsWith(NODE_EXTENSION)) continue;
      // Skip orphaned temp files left behind by a crashed atomic write.
      if (entry.name.includes(".tmp.")) continue;
      ids.push(idFromNodePath(root, fullPath));
    }
  }

  ids.sort();
  return ids;
}

/**
 * Delete a tree node. Idempotent — missing files are not an error.
 *
 * Any other failure (permission denied, etc.) throws so the caller can react.
 */
export async function deleteNode(
  workspaceDir: string,
  id: string,
): Promise<void> {
  validateNodeId(id);
  const path = getNodePath(workspaceDir, id);
  try {
    await rm(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}
