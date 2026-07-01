// ---------------------------------------------------------------------------
// Memory v3 — dense retrieval lane (section-grain)
// ---------------------------------------------------------------------------
//
// Read counterpart to `section-dense-store.ts`. Embeds the turn query and runs
// a single cosine search against the `memory_v3_sections` collection, then
// dedupes the matched section points down to the top-`k` distinct articles —
// each carrying its best-scoring section ordinal. This is the dense lane of the
// section-grain retrieval design: where the v2 dense lane matches whole pages,
// this one matches the single most relevant section of a long article and hands
// the orchestrator both the article and which section matched (so the selector
// can show the matched section as the descriptor).
//
// Degrades safely: any embedding or Qdrant failure logs a warning and returns
// `[]`. The orchestrator unions the other lanes (needle, edge) plus carry-
// forward regardless, so a dense outage narrows recall but never breaks a turn.

import type { AssistantConfig } from "../../../../config/types.js";
import { isEmbeddingDimensionAvailable } from "../../../../persistence/embeddings/embedding-backend.js";
import { getLogger } from "../../../../util/logger.js";
import { embedWithBackend } from "../embeddings.js";
import {
  getSectionDenseClient,
  SECTION_COLLECTION,
} from "./section-dense-store.js";
import type { Slug } from "./types.js";

const log = getLogger("memory-v3-dense-lane");

/**
 * Multiplier applied to `k` when fetching section points from Qdrant. Several
 * sections can belong to the same article, so we oversample the section hits to
 * leave room for the article-level dedupe to still yield `k` distinct articles.
 */
export const OVERSAMPLE = 6;

/** A single dense-lane hit: an article plus the section ordinal that matched. */
export interface DenseHit {
  article: Slug;
  section: number;
}

/**
 * Run the dense lane: embed `query`, search the section collection for the top
 * `k * OVERSAMPLE` section points, then dedupe to the top-`k` distinct articles
 * — each with its best-scoring section ordinal. Section points are returned by
 * Qdrant in descending score order, so the first time an article is seen is its
 * best section; subsequent sections of the same article are ignored.
 *
 * Returns `[]` on any embedding or Qdrant failure (logged at warn level), and
 * short-circuits to `[]` when the reachable backend cannot produce vectors of
 * the committed collection dimension (degraded backend or dimension mismatch) —
 * so a 3072-dim collection committed while only a 384-dim backend is reachable
 * narrows recall cleanly rather than failing the dimension assertion every turn.
 */
export async function denseLane(
  config: AssistantConfig,
  query: string,
  k: number,
): Promise<DenseHit[]> {
  if (k <= 0) return [];

  if (!(await isEmbeddingDimensionAvailable(config))) {
    return [];
  }

  let points: Array<{ payload?: unknown; score?: number }>;
  try {
    const { vectors } = await embedWithBackend([query]);
    const vector = vectors[0];
    if (!vector || vector.length === 0) return [];

    const result = await getSectionDenseClient().query(SECTION_COLLECTION, {
      query: vector,
      limit: k * OVERSAMPLE,
      with_payload: true,
    });
    points = result.points;
  } catch (err) {
    log.warn({ err }, "memory v3 dense lane failed; degrading to no hits");
    return [];
  }

  // Walk hits in score order, keeping the first (best) section per article and
  // stopping once we have `k` distinct articles.
  const seen = new Set<Slug>();
  const hits: DenseHit[] = [];
  for (const point of points) {
    const payload = point.payload as
      | { article?: unknown; ordinal?: unknown }
      | null
      | undefined;
    const article = payload?.article;
    const ordinal = payload?.ordinal;
    if (typeof article !== "string" || typeof ordinal !== "number") continue;
    if (seen.has(article)) continue;
    seen.add(article);
    hits.push({ article, section: ordinal });
    if (hits.length >= k) break;
  }

  return hits;
}
