// ---------------------------------------------------------------------------
// Memory v2 — Concept page frontmatter sweep
// ---------------------------------------------------------------------------
//
// At daemon startup, walk every concept page on disk and validate its
// frontmatter against `ConceptPageFrontmatterSchema`. The schema is
// `.passthrough()`, so unknown keys are tolerated; what this sweep catches is
// genuinely malformed frontmatter — a wrong type on a declared field, or YAML
// that doesn't parse. Such pages would otherwise stay invisible until one lands
// in a conversation's top-K and `renderInjectionBlock`'s `Promise.all` rejects
// (readPage throws), silently no-op'ing V2 dynamic injection for the whole
// turn. Surfacing them as `warn` log lines at boot turns that into a
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

import type { AssistantConfig } from "../../../../config/schema.js";
import { FRONTMATTER_REGEX } from "../frontmatter.js";
import { getLogger } from "../logging.js";
import { listPages } from "./page-store.js";
import { ConceptPageFrontmatterSchema } from "./types.js";

const log = getLogger("memory-v2-frontmatter-sweep");

/**
 * Validate every concept page's frontmatter against the strict schema and
 * emit a `warn` per offender. Never throws — daemon startup must not block
 * on this safety net. Self-gates on `config.memory.v2.enabled`: when v2
 * is off, concept pages never enter a retrieval top-K so any warns here
 * would be pure noise.
 */
export async function sweepConceptPageFrontmatter(
  config: AssistantConfig,
  workspaceDir: string,
): Promise<void> {
  if (!config.memory.v2.enabled) return;

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
