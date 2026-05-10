// ---------------------------------------------------------------------------
// Memory v2 — Concept page frontmatter sweep
// ---------------------------------------------------------------------------
//
// At daemon startup, walk every concept page on disk and validate its
// frontmatter against `ConceptPageFrontmatterSchema` (which is `.strict()`).
// Schema-drifted pages — e.g. a user-authored file that adds a frontmatter
// key the schema doesn't allow — would otherwise stay invisible until the
// page lands in a conversation's top-K and `renderInjectionBlock`'s
// `Promise.all` rejects, silently no-op'ing V2 dynamic injection for the
// whole turn. Surfacing them as `warn` log lines at boot turns that into a
// debuggable signal.
//
// This sweep is intentionally separate from `rebuildConceptPageCorpusStats`:
// the BM25 walker reads only page bodies (skipping frontmatter parsing for
// speed) and integrating the schema check there would mean reshaping its
// hot loop. A second, simple walker is cheaper to read and trivial to
// delete once schema drift has stopped happening in practice.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { FRONTMATTER_REGEX } from "../../skills/frontmatter.js";
import { getLogger } from "../../util/logger.js";
import { listPages } from "./page-store.js";
import { ConceptPageFrontmatterSchema } from "./types.js";

const log = getLogger("memory-v2-frontmatter-sweep");

/**
 * Validate every concept page's frontmatter against the strict schema and
 * emit a `warn` per offender. Never throws — daemon startup must not block
 * on this safety net.
 */
export async function sweepConceptPageFrontmatter(
  workspaceDir: string,
): Promise<void> {
  let slugs: string[];
  try {
    slugs = await listPages(workspaceDir);
  } catch (err) {
    log.warn(
      { err },
      "Concept page frontmatter sweep failed to enumerate pages — skipping",
    );
    return;
  }

  for (const slug of slugs) {
    const path = join(workspaceDir, "memory", "concepts", `${slug}.md`);
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch (err) {
      log.warn({ slug, err }, "Concept page frontmatter sweep: read failed");
      continue;
    }

    const match = raw.match(FRONTMATTER_REGEX);
    const yamlBlock = match ? match[1] : "";

    let parsed: unknown;
    try {
      parsed = parseYaml(yamlBlock) ?? {};
    } catch (err) {
      log.warn(
        { slug, err },
        "Concept page has malformed YAML frontmatter — V2 injection will throw if this slug enters top-K",
      );
      continue;
    }

    const result = ConceptPageFrontmatterSchema.safeParse(parsed);
    if (result.success) continue;

    for (const issue of result.error.issues) {
      log.warn(
        {
          slug,
          errCode: issue.code,
          errKeys: "keys" in issue ? issue.keys : [],
          errPath: issue.path,
          errMessage: issue.message,
        },
        "Concept page has invalid frontmatter — V2 injection will throw if this slug enters top-K",
      );
    }
  }
}
