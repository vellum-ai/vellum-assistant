import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Slug } from "./types.js";

/**
 * Workspace-relative path of the maintainer-curated core-set file. Edited
 * during memory consolidation — the loader never creates or modifies it.
 */
const CORE_PAGES_RELATIVE_PATH = join("memory", "core-pages.md");

/**
 * A list line is `- <item>`; the item may be a bare slug or a `[[slug]]`
 * wikilink. Anything else on the line (headings, prose, annotations) is the
 * maintainer's notes and is ignored.
 */
const LIST_LINE = /^-\s+(?:\[\[([^\]]+)\]\]|(\S+))\s*$/;

/** Slug-safe charset; existence against the page store is checked at lane init. */
const SLUG_SHAPE = /^[a-z0-9-/]+$/;

/**
 * Load the maintainer-curated core set from `<workspaceDir>/memory/core-pages.md`.
 *
 * The core lane answers the associative-texture gap (pages with no
 * lexical/semantic match to the message), so its membership is curated, not
 * computed. Parsing is tolerant: list lines in `- [[some-slug]]` or
 * `- some-slug` form are accepted; headings, blank lines, and prose are
 * skipped so the maintainer can annotate the file; malformed or
 * non-slug-shaped entries are dropped, never fatal.
 *
 * Returns slugs deduped in first-seen file order — that order is the stable
 * sort the selector uses for the core prefix. A missing file yields `[]`.
 */
export function loadCoreSet(workspaceDir: string): Slug[] {
  let raw: string;
  try {
    raw = readFileSync(join(workspaceDir, CORE_PAGES_RELATIVE_PATH), "utf8");
  } catch {
    return [];
  }

  const seen = new Set<Slug>();
  const slugs: Slug[] = [];
  for (const line of raw.split("\n")) {
    const match = LIST_LINE.exec(line.trim());
    if (!match) continue;
    const slug = (match[1] ?? match[2] ?? "").trim();
    if (!SLUG_SHAPE.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}
