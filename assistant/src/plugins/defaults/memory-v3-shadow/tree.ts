import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { getWorkspaceDir } from "../../../util/platform.js";
import type {
  LeafFrontmatter,
  LeafNode,
  LeafPath,
  LeafTree,
  Slug,
} from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Bundled stub data shipped alongside the loader. */
const BUNDLED_DATA_DIR = join(HERE, "data");

/**
 * Resolve the directory the loaders should read leaf-tree artifacts from.
 *
 * Prefers a maintainer's per-instance workspace override
 * (`<workspace>/memory/v3/data/`) when present, otherwise falls back to the
 * generic bundled stub shipped in this package.
 *
 * The public {@link loadLeafTree} API still takes an explicit `dataDir` for
 * testability; orchestrators that want the runtime default call this helper.
 */
export function resolveDataDir(): string {
  const workspaceData = join(getWorkspaceDir(), "memory", "v3", "data");
  if (existsSync(workspaceData)) return workspaceData;
  return BUNDLED_DATA_DIR;
}

/** Recursively collect every `*.md` file under `dir`. */
async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Split a leaf `.md` file into its YAML frontmatter and body.
 *
 * Frontmatter is the `---`-delimited block at the top of the file; everything
 * after the closing delimiter is the description body.
 */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const normalized = raw.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new Error("leaf markdown is missing YAML frontmatter");
  }
  return { frontmatter: match[1], body: match[2] };
}

function parseLeafFrontmatter(yaml: string, file: string): LeafFrontmatter {
  const parsed = parseYaml(yaml) as unknown;
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`leaf ${file} frontmatter is not a mapping`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.path !== "string") {
    throw new Error(`leaf ${file} frontmatter is missing a string \`path\``);
  }
  if (typeof record.in_core !== "boolean") {
    throw new Error(
      `leaf ${file} frontmatter is missing a boolean \`in_core\``,
    );
  }
  return {
    path: record.path,
    in_core: record.in_core,
    ...(typeof record.id === "string" ? { id: record.id } : {}),
  };
}

/** Derive the canonical leaf path from a file's location under `leaves/`. */
function pathFromLocation(leavesDir: string, file: string): LeafPath {
  return relative(leavesDir, file).replace(/\.md$/, "").split(sep).join("/");
}

/**
 * Load the leaf tree from `dataDir`. READ-ONLY: walks `leaves/**\/*.md` and
 * reads `assignments.json` without mutating anything on disk.
 *
 * Builds:
 * - `leaves`: leaf path → {@link LeafNode} (frontmatter, description, domain,
 *   and the slugs assigned to it).
 * - `byPage`: slug → the leaf paths it is assigned to (inverted assignments).
 *
 * Page→leaf membership precedence is per-page: when `pageLeaves` supplies a
 * non-empty array for a slug, those frontmatter-derived leaves win for that
 * page; slugs absent from `pageLeaves` (or mapped to an empty array) fall back
 * to `assignments.json`. Omitting `pageLeaves` reproduces the legacy
 * assignments.json-only behavior exactly (used by the bundled stub and tests);
 * orchestrators supply `pageLeaves` from the page index.
 */
export async function loadLeafTree(
  dataDir: string,
  pageLeaves?: Map<Slug, LeafPath[]>,
): Promise<LeafTree> {
  const leavesDir = join(dataDir, "leaves");
  const files = await collectMarkdownFiles(leavesDir);

  const nodes = await Promise.all(
    files.map(async (file): Promise<LeafNode> => {
      const raw = await readFile(file, "utf8");
      const { frontmatter, body } = splitFrontmatter(raw);
      const path = pathFromLocation(leavesDir, file);
      return {
        path,
        frontmatter: parseLeafFrontmatter(frontmatter, file),
        description: body.trim(),
        members: [],
        domain: path.split("/")[0],
      };
    }),
  );

  const leaves = new Map<LeafPath, LeafNode>(
    nodes.map((node) => [node.path, node]),
  );

  const assignmentsRaw = await readFile(
    join(dataDir, "assignments.json"),
    "utf8",
  );
  const assignments = JSON.parse(assignmentsRaw) as Record<Slug, LeafPath[]>;

  const slugs = new Set<Slug>(Object.keys(assignments));
  if (pageLeaves) for (const slug of pageLeaves.keys()) slugs.add(slug);

  const byPage = new Map<Slug, LeafPath[]>();
  for (const slug of slugs) {
    const fromFrontmatter = pageLeaves?.get(slug);
    const leafPaths =
      fromFrontmatter && fromFrontmatter.length > 0
        ? fromFrontmatter
        : (assignments[slug] ?? []);
    byPage.set(slug, [...leafPaths]);
    for (const leafPath of leafPaths) {
      leaves.get(leafPath)?.members.push(slug);
    }
  }

  return { leaves, byPage };
}

/** The slugs assigned to a leaf. */
export function membersOf(tree: LeafTree, leaf: LeafPath): Slug[] {
  return tree.leaves.get(leaf)?.members ?? [];
}

/** The leaf paths a slug is assigned to. */
export function leavesOf(tree: LeafTree, slug: Slug): LeafPath[] {
  return tree.byPage.get(slug) ?? [];
}

/** The unique slugs owned by every leaf in `core` (expand leaf-paths → slugs). */
export function coreSlugs(tree: LeafTree, core: Set<LeafPath>): Set<Slug> {
  return new Set([...core].flatMap((leaf) => membersOf(tree, leaf)));
}
