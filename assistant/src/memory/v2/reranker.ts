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
 * Run the cross-encoder over each candidate's first-paragraph preview.
 * Returns raw sigmoid scores; failures (worker down, page read error) yield
 * an empty Map so callers can fall back to pure fused scores. Per-batch
 * normalisation and boost math live in `simBatch.applyRerankBoost`.
 */
export async function rerankCandidates(
  query: string,
  candidates: readonly string[],
  config: AssistantConfig,
): Promise<Map<string, number>> {
  if (candidates.length === 0 || query.trim().length === 0) {
    return new Map();
  }

  const now = Date.now();
  evictExpired(now);
  const key = cacheKey(query, candidates);
  const cached = cache.get(key);
  if (cached) {
    // Refresh insertion order so frequently-hit entries survive eviction.
    cache.delete(key);
    cache.set(key, { ...cached, ts: now });
    return new Map(cached.scores);
  }

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

  if (passages.length === 0) return new Map();

  let scores: number[];
  try {
    const backend = getOrCreateRerankBackend(config.memory.v2.rerank.model);
    scores = await backend.score(query, passages);
  } catch (err) {
    log.warn(
      { err, model: config.memory.v2.rerank.model, n: passages.length },
      "Rerank backend failed; falling back to pure fused scores",
    );
    return new Map();
  }

  const result = new Map<string, number>();
  for (let i = 0; i < slugsForPassages.length; i++) {
    const s = scores[i];
    if (typeof s !== "number" || Number.isNaN(s)) continue;
    // sigmoid output should already be in [0, 1]; clamp defensively.
    result.set(slugsForPassages[i], Math.max(0, Math.min(1, s)));
  }

  cache.set(key, { scores: new Map(result), ts: now });
  return result;
}

/** @internal Test-only: clear the LRU cache. */
export function _resetRerankCacheForTests(): void {
  cache.clear();
}
