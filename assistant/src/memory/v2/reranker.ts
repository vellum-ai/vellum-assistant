/** Memory v2 cross-encoder rerank — `(query, page-preview)` pairs scored by a local model. */

import { createHash } from "node:crypto";

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { getOrCreateRerankBackend } from "../rerank-local.js";
import { readPage } from "./page-store.js";

const log = getLogger("memory-v2-reranker");

// ~512-token model context for bge-reranker-base; cap input to bound payload.
const PASSAGE_CHAR_CAP = 240;

interface CacheEntry {
  scores: Map<string, number>;
  ts: number;
}

const CACHE_TTL_MS = 2 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
const cache = new Map<string, CacheEntry>();

function cacheKey(query: string, slugs: readonly string[]): string {
  const sorted = [...slugs].sort().join("\0");
  return createHash("sha256").update(`${query}\0${sorted}`).digest("hex");
}

function evictExpired(now: number): void {
  for (const [k, v] of cache) {
    if (now - v.ts > CACHE_TTL_MS) cache.delete(k);
  }
  if (cache.size > CACHE_MAX_ENTRIES) {
    const toDrop = cache.size - CACHE_MAX_ENTRIES;
    let i = 0;
    for (const k of cache.keys()) {
      if (i++ >= toDrop) break;
      cache.delete(k);
    }
  }
}

function buildPassage(slug: string, body: string): string {
  const trimmed = body.replace(/^\s+/, "");
  const blank = trimmed.search(/\n\s*\n/);
  const para = blank === -1 ? trimmed : trimmed.slice(0, blank);
  const stripped = para.replace(/^#+\s.*\n/, "").trim();
  const compact = stripped.replace(/\s+/g, " ").slice(0, PASSAGE_CHAR_CAP);
  return `${slug}\n${compact}`;
}

/**
 * Run the cross-encoder over each candidate's first-paragraph preview for
 * one or more queries against the same candidate set. Returns one
 * `Map<slug, score>` per query, in the same order as the `queries` array.
 *
 * Multi-query batching: the user-channel and assistant-channel queries share
 * a candidate set per turn, so scoring them in a single tokenizer +
 * forward-pass call avoids the ONNX-invocation overhead of two serialised
 * worker round-trips. Cache hits short-circuit per-query independently —
 * a whitespace-only query yields an empty Map without hitting the backend.
 *
 * Failures (worker down, page read errors) yield empty Maps so callers can
 * fall back to pure fused scores. Per-batch normalisation and boost math
 * live in `computeOwnActivation`.
 */
export async function rerankCandidates(
  queries: readonly string[],
  candidates: readonly string[],
  config: AssistantConfig,
): Promise<Array<Map<string, number>>> {
  if (queries.length === 0) return [];
  if (candidates.length === 0) return queries.map(() => new Map());

  const now = Date.now();
  evictExpired(now);

  const results: Array<Map<string, number> | null> = queries.map(() => null);
  const uncachedIndices: number[] = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    if (q.trim().length === 0) {
      results[i] = new Map();
      continue;
    }
    const key = cacheKey(q, candidates);
    const cached = cache.get(key);
    if (cached) {
      // Refresh insertion order so frequently-hit entries survive eviction.
      cache.delete(key);
      cache.set(key, { ...cached, ts: now });
      results[i] = new Map(cached.scores);
    } else {
      uncachedIndices.push(i);
    }
  }

  const finalize = (): Array<Map<string, number>> =>
    results.map((r) => r ?? new Map());

  if (uncachedIndices.length === 0) return finalize();

  const workspaceDir = getWorkspaceDir();
  const pages = await Promise.all(
    candidates.map((slug) =>
      readPage(workspaceDir, slug).catch((err) => {
        log.debug({ err, slug }, "Reranker skipping page that failed to load");
        return null;
      }),
    ),
  );
  const passages: string[] = [];
  const slugsForPassages: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const page = pages[i];
    if (!page) continue;
    passages.push(buildPassage(candidates[i], page.body));
    slugsForPassages.push(candidates[i]);
  }

  if (passages.length === 0) {
    for (const i of uncachedIndices) results[i] = new Map();
    return finalize();
  }

  // One tokenizer + ONNX forward pass over every uncached query × passage
  // pair. Pairs are laid out query-major: queries[uncached[0]] × passages,
  // then queries[uncached[1]] × passages, etc.
  const batchQueries: string[] = [];
  const batchPassages: string[] = [];
  for (const qi of uncachedIndices) {
    const q = queries[qi];
    for (const p of passages) {
      batchQueries.push(q);
      batchPassages.push(p);
    }
  }

  const { model, dtype } = config.memory.v2.rerank;
  let scores: number[];
  try {
    const backend = getOrCreateRerankBackend(model, dtype);
    scores = await backend.score(batchQueries, batchPassages);
  } catch (err) {
    log.warn(
      { err, model, n: batchPassages.length },
      "Rerank backend failed; falling back to pure fused scores",
    );
    for (const i of uncachedIndices) results[i] = new Map();
    return finalize();
  }

  for (let j = 0; j < uncachedIndices.length; j++) {
    const qi = uncachedIndices[j];
    const offset = j * passages.length;
    const result = new Map<string, number>();
    for (let i = 0; i < slugsForPassages.length; i++) {
      const s = scores[offset + i];
      if (typeof s !== "number" || Number.isNaN(s)) continue;
      // sigmoid output should already be in [0, 1]; clamp defensively.
      result.set(slugsForPassages[i], Math.max(0, Math.min(1, s)));
    }
    results[qi] = result;
    cache.set(cacheKey(queries[qi], candidates), {
      scores: new Map(result),
      ts: now,
    });
  }

  return finalize();
}

/** @internal Test-only: clear the LRU cache. */
export function _resetRerankCacheForTests(): void {
  cache.clear();
}
