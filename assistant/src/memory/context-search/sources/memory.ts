import { getLogger } from "../../../util/logger.js";
import { embedWithRetry } from "../../embed.js";
import { generateSparseEmbedding } from "../../embedding-backend.js";
import { searchGraphNodes } from "../../graph/graph-search.js";
import { getNodesByIds } from "../../graph/store.js";
import type { MemoryNode, MemoryType } from "../../graph/types.js";
import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSearchResult,
} from "../types.js";
import { isMemoryV2ReadActive, searchMemoryV2Source } from "./memory-v2.js";

const log = getLogger("context-search-memory-source");

export async function searchMemorySource(
  query: string,
  context: RecallSearchContext,
  limit: number,
): Promise<RecallSearchResult> {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit === 0) {
    return { evidence: [] };
  }

  if (isMemoryV2ReadActive(context.config)) {
    return searchMemoryV2Source(query, context, normalizedLimit);
  }

  let queryVector: number[] | null = null;
  try {
    const result = await embedWithRetry(context.config, [query], {
      signal: context.signal,
    });
    queryVector = result.vectors[0] ?? null;
  } catch (err) {
    log.warn({ err }, "Failed to embed memory recall query");
    return { evidence: [] };
  }

  if (!queryVector || queryVector.length === 0) {
    return { evidence: [] };
  }

  try {
    const sparseVector = generateSparseEmbedding(query);
    const searchResults = await searchGraphNodes(
      queryVector,
      normalizedLimit,
      [context.memoryScopeId],
      sparseVector,
    );

    if (searchResults.length === 0) {
      return { evidence: [] };
    }

    const nodes = getNodesByIds(searchResults.map((result) => result.nodeId));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const evidence: RecallEvidence[] = searchResults.flatMap((result) => {
      const node = nodeById.get(result.nodeId);
      if (!node || node.fidelity === "gone") {
        return [];
      }

      return [memoryNodeToEvidence(node, result.score)];
    });

    return { evidence };
  } catch (err) {
    log.warn({ err }, "Failed to search memory graph for recall");
    return { evidence: [] };
  }
}

function memoryNodeToEvidence(node: MemoryNode, score: number): RecallEvidence {
  return {
    id: `memory:${node.id}`,
    source: "memory",
    title: formatMemoryTypeTitle(node.type),
    locator: node.id,
    excerpt: node.content,
    timestampMs: node.created,
    score,
    metadata: {
      confidence: node.confidence,
      significance: node.significance,
      type: node.type,
    },
  };
}

function formatMemoryTypeTitle(type: MemoryType): string {
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} memory`;
}
