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
import { embedWithBackend } from "../embeddings.js";
import { getLogger } from "../logging.js";
import {
  getSectionDenseClient,
  SECTION_COLLECTION,
} from "./section-dense-store.js";
import type { Slug } from "./types.js";

const log = getLogger("memory-v3-dense-lane");

/** Why the dense lane produced nothing, for the degraded-turn record. */
export type DenseLaneFailureCause = "embed_worker_died" | "dense_query_failed";

/**
 * Distinguish a dead embed worker from any other dense-lane failure.
 *
 * Both degrade the turn to zero semantic recall, but they need different
 * responses: a dead worker is a fault to investigate, while a query failure is
 * usually a transient backend condition. Matching on the message is what the
 * backend gives us. A worker death arrives as the string `embed()` resolves
 * pending requests with when the child exits (`embedding-local.ts`), not as a
 * typed error, so this is deliberately coupled to that text and tested here.
 */
export function classifyDenseLaneFailure(err: unknown): DenseLaneFailureCause {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("worker process exited unexpectedly")
    ? "embed_worker_died"
    : "dense_query_failed";
}

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

/** A dense-lane hit plus the raw cosine similarity Qdrant returned. */
export interface DenseHitScored {
  article: Slug;
  section: number;
  score: number;
}

/**
 * Run the dense lane and keep each hit's raw cosine score: embed `query`, search
 * the section collection for the top `k * OVERSAMPLE` section points, then dedupe
 * to the top-`k` distinct articles — each with its best-scoring section ordinal
 * and that section's cosine score. Section points are returned by Qdrant in
 * descending score order, so the first time an article is seen is its best
 * section; subsequent sections of the same article are ignored. A point that
 * arrives without a `score` is recorded as `0`.
 *
 * Returns `[]` on any embedding or Qdrant failure (logged at warn level), and
 * short-circuits to `[]` when the reachable backend cannot produce vectors of
 * the committed collection dimension (degraded backend or dimension mismatch) —
 * so a 3072-dim collection committed while only a 384-dim backend is reachable
 * narrows recall cleanly rather than failing the dimension assertion every turn.
 */
export async function denseLaneScored(
  config: AssistantConfig,
  query: string,
  k: number,
): Promise<DenseHitScored[]> {
  if (k <= 0) {
    return [];
  }

  let points: Array<{ payload?: unknown; score?: number }>;
  try {
    // Inside the try so a rejecting probe (e.g. a transient credential-store
    // error surfacing through getProviderKeyAsync) degrades to `[]` instead of
    // throwing — the orchestrator calls this lane in an unguarded Promise.all
    // that relies on the `[]` contract, so one throw would discard the sibling
    // lanes too. The check itself skips the embed on a dimension mismatch.
    if (!(await isEmbeddingDimensionAvailable(config))) {
      return [];
    }

    const { vectors } = await embedWithBackend(config, [query]);
    const vector = vectors[0];
    if (!vector || vector.length === 0) {
      return [];
    }

    const result = await getSectionDenseClient().query(SECTION_COLLECTION, {
      query: vector,
      limit: k * OVERSAMPLE,
      with_payload: true,
    });
    points = result.points;
  } catch (err) {
    // Degrading open is right for availability, but it silently changes what
    // the model sees, so the record has to carry enough to recognise the cause
    // later. A dead embed worker is a fault, not an expected miss: it logs at
    // `error` and is flagged so it can be alerted on separately from the
    // ordinary "backend unavailable" case (JARVIS-1410).
    const cause = classifyDenseLaneFailure(err);
    const workerDied = cause === "embed_worker_died";
    const fields = { err, cause, degradedTo: "no_hits" };
    if (workerDied) {
      log.error(
        fields,
        "memory v3 dense lane lost its embed worker; this turn runs with no semantic recall",
      );
    } else {
      log.warn(fields, "memory v3 dense lane failed; degrading to no hits");
    }
    return [];
  }

  // Walk hits in score order, keeping the first (best) section per article and
  // stopping once we have `k` distinct articles.
  const seen = new Set<Slug>();
  const hits: DenseHitScored[] = [];
  for (const point of points) {
    const payload = point.payload as
      | { article?: unknown; ordinal?: unknown }
      | null
      | undefined;
    const article = payload?.article;
    const ordinal = payload?.ordinal;
    if (typeof article !== "string" || typeof ordinal !== "number") {
      continue;
    }
    if (seen.has(article)) {
      continue;
    }
    seen.add(article);
    hits.push({ article, section: ordinal, score: point.score ?? 0 });
    if (hits.length >= k) {
      break;
    }
  }

  return hits;
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
 *
 * Thin wrapper over {@link denseLaneScored} that drops the raw cosine score for
 * callers that only need the matched article and section.
 */
export async function denseLane(
  config: AssistantConfig,
  query: string,
  k: number,
): Promise<DenseHit[]> {
  return (await denseLaneScored(config, query, k)).map(
    ({ article, section }) => ({ article, section }),
  );
}
