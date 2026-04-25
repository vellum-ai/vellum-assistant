import {
  readNowScratchpad,
  readPkbContext,
} from "../../../daemon/conversation-runtime-assembly.js";
import { getLogger } from "../../../util/logger.js";
import { embedWithRetry } from "../../embed.js";
import { generateSparseEmbedding } from "../../embedding-backend.js";
import { searchPkbFiles } from "../../pkb/pkb-search.js";
import { PKB_WORKSPACE_SCOPE } from "../../pkb/types.js";
import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSearchResult,
} from "../types.js";

const log = getLogger("context-search-pkb-source");

export async function searchPkbSource(
  query: string,
  context: RecallSearchContext,
  limit: number,
): Promise<RecallSearchResult> {
  try {
    const result = await embedWithRetry(context.config, [query], {
      signal: context.signal,
    });
    const queryVector = result.vectors[0];
    if (!queryVector) return { evidence: [] };

    const sparseVector = generateSparseEmbedding(query);
    const hits = await searchPkbFiles(queryVector, sparseVector, limit, [
      PKB_WORKSPACE_SCOPE,
    ]);

    return {
      evidence: hits.map((hit, index): RecallEvidence => {
        const score = hit.hybridScore ?? hit.denseScore;
        return {
          id: `pkb:${hit.path}:${index}`,
          source: "pkb",
          title: hit.path,
          locator: hit.path,
          excerpt: hit.snippet ?? hit.path,
          score,
          metadata: {
            path: hit.path,
            denseScore: hit.denseScore,
            ...(hit.hybridScore !== undefined
              ? { hybridScore: hit.hybridScore }
              : {}),
          },
        };
      }),
    };
  } catch (err) {
    log.warn({ err }, "PKB recall source failed; returning empty results");
    return { evidence: [] };
  }
}

export function readPkbContextEvidence(
  _context: RecallSearchContext,
): RecallEvidence[] {
  const evidence: RecallEvidence[] = [];

  const pkbContext = readPkbContext();
  if (pkbContext) {
    evidence.push({
      id: "pkb:auto-inject",
      source: "pkb",
      title: "PKB auto-injected context",
      locator: "pkb:auto-inject",
      excerpt: pkbContext,
      metadata: { kind: "auto-inject" },
    });
  }

  const nowScratchpad = readNowScratchpad();
  if (nowScratchpad) {
    evidence.push({
      id: "pkb:NOW.md",
      source: "pkb",
      title: "NOW.md",
      locator: "NOW.md",
      excerpt: nowScratchpad,
      metadata: { kind: "now" },
    });
  }

  return evidence;
}
