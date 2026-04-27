/**
 * Memory v2 — read-only validation IPC route.
 *
 * Walks every concept page and the `memory/edges.json` index in the current
 * workspace, returning an aggregate report of structural violations:
 *   - `missingEdgeEndpoints`: edges whose endpoints reference a slug that no
 *     concept page exists for (orphan endpoints).
 *   - `oversizedPages`: pages whose body exceeds `memory.v2.max_page_chars`,
 *     a soft cap that consolidation will eventually try to split.
 *   - `parseFailures`: pages whose YAML frontmatter or schema validation
 *     failed during read — the page exists on disk but cannot be loaded.
 *
 * The route is purely diagnostic: it never mutates the workspace and it does
 * not require the `memory-v2-enabled` feature flag (the report is meaningful
 * even on a stale, opt-out v2 workspace).
 */
import { z } from "zod";

import { loadConfig } from "../../config/loader.js";
import { readEdges, validateEdges } from "../../memory/v2/edges.js";
import { listPages, readPage } from "../../memory/v2/page-store.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { IpcRoute } from "../assistant-server.js";

/**
 * No request parameters today. We still parse `{}` so an accidental payload
 * (e.g. a future caller passing options) raises a schema error rather than
 * being silently ignored.
 */
const MemoryV2ValidateParams = z.object({}).strict();

type MissingEdgeEndpoint = { from: string; to: string };
type OversizedPage = { slug: string; chars: number };
type ParseFailure = { slug: string; error: string };

export type MemoryV2ValidateResult = {
  pageCount: number;
  edgeCount: number;
  missingEdgeEndpoints: MissingEdgeEndpoint[];
  oversizedPages: OversizedPage[];
  parseFailures: ParseFailure[];
};

export const memoryV2ValidateRoute: IpcRoute = {
  method: "memory_v2/validate",
  handler: async (params): Promise<MemoryV2ValidateResult> => {
    MemoryV2ValidateParams.parse(params ?? {});

    const workspaceDir = getWorkspaceDir();
    const maxPageChars = loadConfig().memory.v2.max_page_chars;

    // Walk concept pages first so we have a known-slug set for edge validation
    // and can surface any per-page parse failure without aborting the whole
    // report.
    const slugs = await listPages(workspaceDir);
    const knownSlugs = new Set<string>();
    const oversizedPages: OversizedPage[] = [];
    const parseFailures: ParseFailure[] = [];

    for (const slug of slugs) {
      try {
        const page = await readPage(workspaceDir, slug);
        if (!page) continue;
        knownSlugs.add(slug);
        const chars = Buffer.byteLength(page.body, "utf8");
        if (chars > maxPageChars) {
          oversizedPages.push({ slug, chars });
        }
      } catch (err) {
        parseFailures.push({
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const edgesIdx = await readEdges(workspaceDir);
    const validation = validateEdges(edgesIdx, knownSlugs);

    // `validateEdges` collapses missing endpoints into a deduped slug list —
    // we re-pair them with their canonical tuples so the report points at
    // each broken edge, not just the slugs.
    const missing = new Set(validation.missing);
    const missingEdgeEndpoints: MissingEdgeEndpoint[] = [];
    for (const [from, to] of edgesIdx.edges) {
      if (missing.has(from) || missing.has(to)) {
        missingEdgeEndpoints.push({ from, to });
      }
    }

    return {
      pageCount: knownSlugs.size,
      edgeCount: edgesIdx.edges.length,
      missingEdgeEndpoints,
      oversizedPages,
      parseFailures,
    };
  },
};
