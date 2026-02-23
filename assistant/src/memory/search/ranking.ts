import { inArray, sql } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import type { AssistantConfig, MemoryRerankingConfig } from '../../config/types.js';
import { getConfig } from '../../config/loader.js';
import { estimateTextTokens } from '../../context/token-estimator.js';
import { getLogger } from '../../util/logger.js';
import { getDb } from '../db.js';
import { memoryItems } from '../schema.js';
import type { Candidate, CandidateSource, ItemMetadata } from './types.js';
import { buildInjectedText } from './formatting.js';

const log = getLogger('memory-retriever');

/**
 * Trust weight by verification state. Higher = more trusted.
 * Bounded: lowest weight is 0.7, never zero -- low-trust items are
 * down-ranked but not suppressed.
 */
const TRUST_WEIGHTS: Record<string, number> = {
  user_confirmed: 1.0,
  user_reported: 0.9,
  assistant_inferred: 0.7,
};
const DEFAULT_TRUST_WEIGHT = 0.85;

export const SOURCE_WEIGHTS: Record<CandidateSource, number> = {
  lexical: 1.0,
  semantic: 1.0,
  recency: 1.0,
  entity_direct: 1.0,
  item_direct: 0.95,
  entity_relation: 1.0,
};

const MS_PER_DAY = 86_400_000;

/**
 * Reciprocal Rank Fusion (RRF) -- merge candidates from independent ranking
 * lists without assuming comparable score scales.
 *
 * Each candidate's RRF contribution from a list is `1 / (k + rank)` where
 * rank is 1-based position in that list sorted by its native score.
 * The final score is further modulated by importance so that high-importance
 * memories surface more readily.
 *
 * For item-type candidates we also apply retrieval reinforcement: access_count
 * from the DB boosts effective importance via `min(1, importance + 0.03 * accessCount)`.
 */
export function mergeCandidates(
  lexical: Candidate[],
  semantic: Candidate[],
  recency: Candidate[],
  entity: Candidate[] = [],
  freshnessConfig?: { enabled: boolean; maxAgeDays: Record<string, number>; staleDecay: number; reinforcementShieldDays: number },
  relationScoreMultiplier?: number,
  candidateDepthMap?: Map<string, number>,
): Candidate[] {
  // Build effective weight map that reflects the actual scoring weight for
  // each source.  For entity_relation the static SOURCE_WEIGHTS entry is 1.0
  // (a neutral placeholder) but the real multiplier comes from the config
  // (relationScoreMultiplier).  Using the effective weight in the dedup
  // upgrade comparison ensures item_direct (0.95) correctly outranks
  // entity_relation (e.g. 0.7) when both sources return the same candidate.
  const effectiveWeights: Record<string, number> = { ...SOURCE_WEIGHTS };
  if (relationScoreMultiplier != null) {
    effectiveWeights['entity_relation'] = relationScoreMultiplier;
  }

  // Build merged candidate map (dedup by key, keep best metadata)
  const merged = new Map<string, Candidate>();
  for (const candidate of [...lexical, ...semantic, ...recency, ...entity]) {
    const existing = merged.get(candidate.key);
    if (!existing) {
      merged.set(candidate.key, { ...candidate });
      continue;
    }
    existing.lexical = Math.max(existing.lexical, candidate.lexical);
    existing.semantic = Math.max(existing.semantic, candidate.semantic);
    existing.recency = Math.max(existing.recency, candidate.recency);
    existing.confidence = Math.max(existing.confidence, candidate.confidence);
    existing.importance = Math.max(existing.importance, candidate.importance);
    if (candidate.text.length > existing.text.length) {
      existing.text = candidate.text;
    }
    // Upgrade source to whichever has the higher effective weight so scoring
    // and caps reflect the strongest retrieval signal for this candidate.
    const existingWeight = effectiveWeights[existing.source] ?? 1.0;
    const candidateWeight = effectiveWeights[candidate.source] ?? 1.0;
    if (candidateWeight > existingWeight) {
      existing.source = candidate.source;
    }
  }

  // Build 1-based rank maps from each list (sorted by native score desc)
  const lexicalRanks = buildRankMap(lexical, (c) => c.lexical);
  const semanticRanks = buildRankMap(semantic, (c) => c.semantic);
  const recencyRanks = buildRankMap(recency, (c) => c.recency);
  const entityRanks = buildRankMap(entity, (c) => c.confidence);

  // Look up access_count and verification_state for item-type candidates
  const itemIds = [...merged.values()]
    .filter((c) => c.type === 'item')
    .map((c) => c.id);
  const itemMetadata = lookupItemMetadata(itemIds);

  const rows = [...merged.values()];
  for (const row of rows) {
    const ranks: number[] = [];
    if (lexicalRanks.has(row.key)) ranks.push(lexicalRanks.get(row.key)!);
    if (semanticRanks.has(row.key)) ranks.push(semanticRanks.get(row.key)!);
    if (recencyRanks.has(row.key)) ranks.push(recencyRanks.get(row.key)!);
    if (entityRanks.has(row.key)) ranks.push(entityRanks.get(row.key)!);

    const rrfScore = rrf(ranks);

    // Retrieval reinforcement: boost importance by accessCount
    const meta = itemMetadata.get(row.id);
    const accessCount = meta?.accessCount ?? 0;
    const effectiveImportance = Math.min(1, row.importance + 0.03 * accessCount);

    // Trust-aware ranking: only apply to item candidates (segments/summaries have no metadata)
    const trustWeight = (row.type === 'item' && meta)
      ? (TRUST_WEIGHTS[meta.verificationState] ?? DEFAULT_TRUST_WEIGHT)
      : 1.0;

    // Freshness decay: down-rank stale items unless recently reinforced
    const lastUsedAt = meta?.lastUsedAt ?? null;
    const freshnessWeight = computeFreshnessWeight(row, accessCount, lastUsedAt, freshnessConfig);

    let sourceWeight = effectiveWeights[row.source] ?? 1.0;
    if (row.source === 'entity_relation' && candidateDepthMap && relationScoreMultiplier != null) {
      const depth = candidateDepthMap.get(row.key) ?? 1;
      sourceWeight = Math.pow(relationScoreMultiplier, depth);
    }
    row.finalScore = rrfScore * (0.5 + 0.5 * effectiveImportance) * trustWeight * freshnessWeight * sourceWeight;
  }

  rows.sort((a, b) => {
    const scoreDelta = b.finalScore - a.finalScore;
    if (scoreDelta !== 0) return scoreDelta;
    const createdAtDelta = b.createdAt - a.createdAt;
    if (createdAtDelta !== 0) return createdAtDelta;
    return a.key.localeCompare(b.key);
  });
  return rows;
}

export function applySourceCaps(candidates: Candidate[], config: AssistantConfig): Candidate[] {
  if (candidates.length === 0) return candidates;
  const sourceCaps = buildSourceCaps(config);
  const counts: Partial<Record<CandidateSource, number>> = {};
  const capped: Candidate[] = [];

  for (const candidate of candidates) {
    const cap = sourceCaps[candidate.source];
    const current = counts[candidate.source] ?? 0;
    if (current >= cap) continue;
    counts[candidate.source] = current + 1;
    capped.push(candidate);
  }

  return capped;
}

function buildSourceCaps(config: AssistantConfig): Record<CandidateSource, number> {
  const lexicalTopK = Math.max(1, config.memory.retrieval.lexicalTopK);
  const semanticTopK = Math.max(1, config.memory.retrieval.semanticTopK);
  const relationLimit = Math.max(
    3,
    Math.floor(
      Math.min(
        config.memory.entity.relationRetrieval.maxNeighborEntities,
        config.memory.entity.relationRetrieval.maxEdges,
        semanticTopK,
      ) * 0.4,
    ),
  );

  return {
    lexical: Math.max(12, lexicalTopK),
    semantic: Math.max(8, semanticTopK),
    recency: Math.max(6, Math.floor(semanticTopK / 2)),
    entity_direct: Math.max(6, Math.floor(semanticTopK / 2)),
    item_direct: Math.max(8, Math.floor(lexicalTopK / 2)),
    entity_relation: relationLimit,
  };
}

/** Reciprocal Rank Fusion score: sum of 1/(k+rank) across all lists. */
function rrf(ranks: number[], k = 60): number {
  return ranks.reduce((sum, rank) => sum + 1 / (k + rank), 0);
}

/**
 * Build a map from candidate key to 1-based rank within a list,
 * sorted descending by the given score accessor.
 */
function buildRankMap(candidates: Candidate[], scoreAccessor: (c: Candidate) => number): Map<string, number> {
  const sorted = [...candidates].sort((a, b) => scoreAccessor(b) - scoreAccessor(a));
  const rankMap = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    rankMap.set(sorted[i].key, i + 1);
  }
  return rankMap;
}

/**
 * Look up access_count and verification_state from memory_items for a batch of item IDs.
 */
function lookupItemMetadata(itemIds: string[]): Map<string, ItemMetadata> {
  const metadata = new Map<string, ItemMetadata>();
  if (itemIds.length === 0) return metadata;
  try {
    const db = getDb();
    const rows = db
      .select({
        id: memoryItems.id,
        accessCount: memoryItems.accessCount,
        lastUsedAt: memoryItems.lastUsedAt,
        verificationState: memoryItems.verificationState,
      })
      .from(memoryItems)
      .where(inArray(memoryItems.id, itemIds))
      .all();
    for (const row of rows) {
      metadata.set(row.id, {
        accessCount: row.accessCount,
        lastUsedAt: row.lastUsedAt,
        verificationState: row.verificationState,
      });
    }
  } catch (err) {
    log.warn({ err }, 'Failed to look up item metadata for retrieval ranking');
  }
  return metadata;
}

/**
 * Compute a freshness weight for a candidate based on its kind and age.
 * Returns 1.0 for fresh items and `staleDecay` for items past their window.
 * Items with recent reinforcement (accessed via lastUsedAt within the shield
 * window) are shielded from decay.
 */
export function computeFreshnessWeight(
  candidate: { type: string; kind: string; createdAt: number },
  accessCount: number,
  lastUsedAt: number | null,
  config?: { enabled: boolean; maxAgeDays: Record<string, number>; staleDecay: number; reinforcementShieldDays: number },
): number {
  if (!config?.enabled) return 1.0;

  // Only apply freshness to item-type candidates
  if (candidate.type !== 'item') return 1.0;

  const maxAgeDays = config.maxAgeDays[candidate.kind] ?? 0;
  // maxAgeDays of 0 means no expiry for this kind
  if (maxAgeDays <= 0) return 1.0;

  const now = Date.now();
  const ageMs = now - candidate.createdAt;
  const ageDays = ageMs / MS_PER_DAY;

  if (ageDays <= maxAgeDays) return 1.0;

  // Check reinforcement shield: items retrieved within the shield window are protected
  if (accessCount > 0 && lastUsedAt != null && config.reinforcementShieldDays > 0) {
    const shieldCutoff = now - config.reinforcementShieldDays * MS_PER_DAY;
    if (lastUsedAt >= shieldCutoff) return 1.0;
  }

  return config.staleDecay;
}

/**
 * Logarithmic recency decay (ACT-R inspired).
 *
 * Old formula `1/(1+ageDays)` decays far too aggressively:
 *   - 30 days -> 0.032, 1 year -> 0.003
 *
 * New formula `1/(1+log2(1+ageDays))` preserves long-term recall:
 *   - 1 day -> 0.50, 7 days -> 0.25, 30 days -> 0.17
 *   - 90 days -> 0.15, 1 year -> 0.12, 2 years -> 0.10
 */
export function computeRecencyScore(createdAt: number): number {
  const ageMs = Math.max(0, Date.now() - createdAt);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return 1 / (1 + Math.log2(1 + ageDays));
}

/**
 * LLM re-ranking: send candidate memories to Haiku for relevance scoring.
 * Returns candidates re-sorted by LLM-assigned relevance score.
 */
export async function rerankWithLLM(
  query: string,
  candidates: Candidate[],
  rerankingConfig: MemoryRerankingConfig,
): Promise<Candidate[]> {
  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.debug('No Anthropic API key available for LLM re-ranking, skipping');
    return candidates;
  }

  const candidateList = candidates.map((c, i) => ({
    index: i,
    id: c.key,
    text: truncate(c.text, 200),
  }));

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: rerankingConfig.model,
    max_tokens: 1024,
    system: 'You are a relevance scoring assistant. Given a query and a list of memory candidates, rate each candidate\'s relevance to the query on a scale of 0-10. Return ONLY a JSON array of objects with "index" (the candidate index) and "score" (0-10 integer). No explanation.',
    messages: [{
      role: 'user',
      content: `Query: ${truncate(query, 200)}\n\nCandidates:\n${candidateList.map((c) => `[${c.index}] ${c.text}`).join('\n')}`,
    }],
  });

  // Extract text from the response
  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    log.warn('LLM re-ranking returned no text block, skipping');
    return candidates;
  }

  // Parse the JSON array from the response
  const jsonMatch = textBlock.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    log.warn('LLM re-ranking response did not contain JSON array, skipping');
    return candidates;
  }

  let scores: Array<{ index: number; score: number }>;
  try {
    scores = JSON.parse(jsonMatch[0]) as Array<{ index: number; score: number }>;
  } catch {
    log.warn('Failed to parse LLM re-ranking JSON response, skipping');
    return candidates;
  }

  // Build a score map from LLM results
  const scoreMap = new Map<number, number>();
  for (const entry of scores) {
    if (typeof entry.index === 'number' && typeof entry.score === 'number') {
      scoreMap.set(entry.index, Math.max(0, Math.min(10, entry.score)));
    }
  }

  // Re-sort candidates by LLM score (desc); unscored candidates keep original order after scored ones
  const reranked = candidates.map((c, i) => ({
    candidate: c,
    llmScore: scoreMap.has(i) ? scoreMap.get(i)! : null,
    originalIndex: i,
  }));

  reranked.sort((a, b) => {
    // Scored items come before unscored items
    if (a.llmScore !== null && b.llmScore === null) return -1;
    if (a.llmScore === null && b.llmScore !== null) return 1;
    // Both scored: sort by score descending
    if (a.llmScore !== null && b.llmScore !== null) {
      const scoreDelta = b.llmScore - a.llmScore;
      if (scoreDelta !== 0) return scoreDelta;
    }
    // Both unscored or tie: preserve original RRF order
    return a.originalIndex - b.originalIndex;
  });

  return reranked.map((r) => r.candidate);
}

export function trimToTokenBudget(candidates: Candidate[], maxTokens: number, format: string = 'markdown'): Candidate[] {
  if (maxTokens <= 0) return [];
  const selected: Candidate[] = [];
  for (const candidate of candidates) {
    const tentativeText = buildInjectedText([...selected, candidate], format);
    const cost = estimateTextTokens(tentativeText);
    if (cost > maxTokens) continue;
    selected.push(candidate);
    if (cost >= maxTokens) break;
  }
  return selected;
}

export function markItemUsage(candidates: Candidate[]): void {
  const itemIds = candidates.filter((candidate) => candidate.type === 'item').map((candidate) => candidate.id);
  if (itemIds.length === 0) return;
  const db = getDb();
  const now = Date.now();
  db.update(memoryItems)
    .set({
      lastUsedAt: now,
      accessCount: sql`${memoryItems.accessCount} + 1`,
    })
    .where(inArray(memoryItems.id, itemIds))
    .run();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
