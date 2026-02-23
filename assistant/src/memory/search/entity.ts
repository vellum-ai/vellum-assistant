import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { MemoryEntityConfig } from '../../config/types.js';
import { getLogger } from '../../util/logger.js';
import { getDb } from '../db.js';
import {
  memoryEntityRelations,
  memoryItemEntities,
  memoryItems,
  memoryItemSources,
} from '../schema.js';
import type { Candidate, CandidateSource, CandidateType, EntitySearchResult, MatchedEntityRow, TraversalOptions, TraversalResult, TraversalStep } from './types.js';
import { computeRecencyScore } from './ranking.js';

const log = getLogger('memory-retriever');

/**
 * Entity-based retrieval: match seed entities from query text, fetch directly
 * linked items, and optionally expand one hop across entity relations.
 */
export function entitySearch(
  query: string,
  entityConfig: MemoryEntityConfig,
  scopeIds?: string[],
  excludedMessageIds: string[] = [],
): EntitySearchResult {
  const trimmed = query.trim();
  if (trimmed.length === 0) return emptyEntitySearchResult();

  const relationConfig = entityConfig.relationRetrieval;
  const matchedEntities = findMatchedEntities(
    trimmed,
    relationConfig.enabled ? relationConfig.maxSeedEntities : 20,
  );
  if (matchedEntities.length === 0) return emptyEntitySearchResult();

  const seedEntityIds = matchedEntities.map((row) => row.id);
  const directCandidates = getEntityLinkedItemCandidates(seedEntityIds, {
    scopeIds,
    excludedMessageIds,
    source: 'entity_direct',
  });

  if (!relationConfig.enabled) {
    return {
      candidates: directCandidates,
      relationSeedEntityCount: 0,
      relationTraversedEdgeCount: 0,
      relationNeighborEntityCount: 0,
      relationExpandedItemCount: 0,
    };
  }

  const relationSeedEntityCount = seedEntityIds.length;

  const {
    neighborEntityIds,
    traversedEdgeCount: relationTraversedEdgeCount,
    neighborDepths,
  } = findNeighborEntities(seedEntityIds, {
    maxEdges: relationConfig.maxEdges,
    maxNeighborEntities: relationConfig.maxNeighborEntities,
    maxDepth: relationConfig.maxDepth,
  });
  const relationNeighborEntityCount = neighborEntityIds.length;
  const directItemIds = new Set(directCandidates.map((candidate) => candidate.id));
  const relationCandidates = getEntityLinkedItemCandidates(neighborEntityIds, {
    scopeIds,
    excludedMessageIds,
    source: 'entity_relation',
    excludeItemIds: directItemIds,
  });
  const relationExpandedItemCount = relationCandidates.length;

  // Build candidate key → BFS depth map so ranking can apply distance-based decay
  const candidateDepths = new Map<string, number>();
  if (relationCandidates.length > 0 && neighborDepths.size > 0) {
    const db = getDb();
    const itemIds = relationCandidates.map((c) => c.id);
    const links = db
      .select({
        memoryItemId: memoryItemEntities.memoryItemId,
        entityId: memoryItemEntities.entityId,
      })
      .from(memoryItemEntities)
      .where(inArray(memoryItemEntities.memoryItemId, itemIds))
      .all();

    // For each item, find the minimum depth among its linked neighbor entities
    const itemDepthMap = new Map<string, number>();
    for (const link of links) {
      const depth = neighborDepths.get(link.entityId);
      if (depth !== undefined) {
        const existing = itemDepthMap.get(link.memoryItemId);
        if (existing === undefined || depth < existing) {
          itemDepthMap.set(link.memoryItemId, depth);
        }
      }
    }

    for (const candidate of relationCandidates) {
      const depth = itemDepthMap.get(candidate.id);
      if (depth !== undefined) {
        candidateDepths.set(candidate.key, depth);
      }
    }
  }

  return {
    candidates: [...directCandidates, ...relationCandidates],
    relationSeedEntityCount,
    relationTraversedEdgeCount,
    relationNeighborEntityCount,
    relationExpandedItemCount,
    candidateDepths,
  };
}

export function emptyEntitySearchResult(): EntitySearchResult {
  return {
    candidates: [],
    relationSeedEntityCount: 0,
    relationTraversedEdgeCount: 0,
    relationNeighborEntityCount: 0,
    relationExpandedItemCount: 0,
    candidateDepths: new Map(),
  };
}

export function findMatchedEntities(query: string, maxMatches: number): MatchedEntityRow[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const db = getDb();
  const raw = (db as unknown as { $client: { query: (q: string) => { all: (...params: unknown[]) => unknown[] } } }).$client;
  const safeLimit = Math.max(1, Math.floor(maxMatches));

  // Tokenize query into words for entity matching (min length 3 to reduce false positives)
  const tokens = trimmed
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/g)
    .filter((t) => t.length >= 3);
  const fullQuery = trimmed.toLowerCase();

  // Use exact matching on entity names and json_each() for individual alias values.
  // Also match the full trimmed query to support multi-word entity names (e.g. "Visual Studio Code").
  // When tokens is empty (all words < 3 chars), only match on fullQuery.
  let entityQuery: string;
  let queryParams: string[];
  if (tokens.length > 0) {
    const namePlaceholders = tokens.map(() => '?').join(',');
    entityQuery = `
      SELECT DISTINCT me.id, me.name, me.type, me.aliases, me.mention_count
      FROM memory_entities me
      WHERE LOWER(me.name) IN (${namePlaceholders}) OR LOWER(me.name) = ?
      UNION
      SELECT DISTINCT me.id, me.name, me.type, me.aliases, me.mention_count
      FROM memory_entities me, json_each(me.aliases) je
      WHERE me.aliases IS NOT NULL AND (LOWER(je.value) IN (${namePlaceholders}) OR LOWER(je.value) = ?)
      LIMIT ${safeLimit}
    `;
    queryParams = [...tokens, fullQuery, ...tokens, fullQuery];
  } else {
    entityQuery = `
      SELECT DISTINCT me.id, me.name, me.type, me.aliases, me.mention_count
      FROM memory_entities me
      WHERE LOWER(me.name) = ?
      UNION
      SELECT DISTINCT me.id, me.name, me.type, me.aliases, me.mention_count
      FROM memory_entities me, json_each(me.aliases) je
      WHERE me.aliases IS NOT NULL AND LOWER(je.value) = ?
      LIMIT ${safeLimit}
    `;
    queryParams = [fullQuery, fullQuery];
  }

  let matchedEntities: MatchedEntityRow[] = [];
  try {
    matchedEntities = raw.query(entityQuery).all(...queryParams) as MatchedEntityRow[];
  } catch (err) {
    log.warn({ err }, 'Entity search query failed');
    return [];
  }
  return matchedEntities;
}

/**
 * BFS traversal across entity relations with visited-set cycle detection
 * and configurable max depth to prevent unbounded graph walking.
 */
export function findNeighborEntities(
  seedEntityIds: string[],
  opts: TraversalOptions,
): TraversalResult {
  const { maxEdges, maxNeighborEntities, maxDepth = 3, relationTypes, entityTypes, directed } = opts;
  if (seedEntityIds.length === 0 || maxEdges <= 0 || maxNeighborEntities <= 0 || maxDepth <= 0) {
    return { neighborEntityIds: [], traversedEdgeCount: 0, neighborDepths: new Map() };
  }

  const db = getDb();
  const visited = new Set<string>(seedEntityIds);
  const neighbors: string[] = [];
  const neighborDepths = new Map<string, number>();
  let totalEdgesTraversed = 0;
  const filterByEntityType = entityTypes && entityTypes.length > 0;

  // BFS frontier starts with seed entities
  let frontier = [...seedEntityIds];

  for (let depth = 0; depth < maxDepth; depth++) {
    if (frontier.length === 0 || neighbors.length >= maxNeighborEntities) break;

    const edgeBudget = maxEdges - totalEdgesTraversed;
    if (edgeBudget <= 0) break;

    let rows: Array<{ sourceEntityId: string; targetEntityId: string }>;

    if (filterByEntityType) {
      // When filtering by entity type, JOIN with memoryEntities on the neighbor
      // side so non-matching edges are excluded at the SQL level and don't
      // consume the edge budget.
      const relationTypeCondition = relationTypes && relationTypes.length > 0
        ? `AND r.relation IN (${relationTypes.map(() => '?').join(',')})`
        : '';
      const entityTypeFilter = `AND me.type IN (${entityTypes.map(() => '?').join(',')})`;
      const frontierPlaceholders = frontier.map(() => '?').join(',');
      const limit = Math.max(1, edgeBudget);

      const raw = (db as unknown as { $client: { query: (q: string) => { all: (...params: unknown[]) => unknown[] } } }).$client;
      const relationParams = relationTypes && relationTypes.length > 0 ? relationTypes : [];

      if (directed) {
        // GROUP BY deduplicates entity pairs that have multiple relation rows
        const q1 = `
          SELECT r.source_entity_id AS sourceEntityId, r.target_entity_id AS targetEntityId
          FROM memory_entity_relations r
          INNER JOIN memory_entities me ON me.id = r.target_entity_id
          WHERE r.source_entity_id IN (${frontierPlaceholders})
          ${relationTypeCondition} ${entityTypeFilter}
          GROUP BY r.source_entity_id, r.target_entity_id
          ORDER BY MAX(r.last_seen_at) DESC
          LIMIT ?
        `;
        const params1 = [...frontier, ...relationParams, ...entityTypes, limit];
        rows = raw.query(q1).all(...params1) as Array<{ sourceEntityId: string; targetEntityId: string }>;
      } else {
        // Combine both directions in a single query with global recency
        // ordering so the edge budget isn't direction-biased.
        const q = `
          SELECT sourceEntityId, targetEntityId FROM (
            SELECT r.source_entity_id AS sourceEntityId, r.target_entity_id AS targetEntityId, r.last_seen_at
            FROM memory_entity_relations r
            INNER JOIN memory_entities me ON me.id = r.target_entity_id
            WHERE r.source_entity_id IN (${frontierPlaceholders})
            ${relationTypeCondition} ${entityTypeFilter}
            UNION ALL
            SELECT r.source_entity_id AS sourceEntityId, r.target_entity_id AS targetEntityId, r.last_seen_at
            FROM memory_entity_relations r
            INNER JOIN memory_entities me ON me.id = r.source_entity_id
            WHERE r.target_entity_id IN (${frontierPlaceholders})
            ${relationTypeCondition} ${entityTypeFilter}
          )
          GROUP BY sourceEntityId, targetEntityId
          ORDER BY MAX(last_seen_at) DESC
          LIMIT ?
        `;
        const params = [
          ...frontier,
          ...relationParams,
          ...entityTypes,
          ...frontier,
          ...relationParams,
          ...entityTypes,
          limit,
        ];

        rows = raw.query(q).all(...params) as Array<{ sourceEntityId: string; targetEntityId: string }>;
      }
    } else {
      const frontierCondition = directed
        ? inArray(memoryEntityRelations.sourceEntityId, frontier)
        : or(
            inArray(memoryEntityRelations.sourceEntityId, frontier),
            inArray(memoryEntityRelations.targetEntityId, frontier),
          );
      const whereCondition = relationTypes && relationTypes.length > 0
        ? and(frontierCondition, inArray(memoryEntityRelations.relation, relationTypes))
        : frontierCondition;

      rows = db
        .select({
          sourceEntityId: memoryEntityRelations.sourceEntityId,
          targetEntityId: memoryEntityRelations.targetEntityId,
        })
        .from(memoryEntityRelations)
        .where(whereCondition)
        .orderBy(desc(memoryEntityRelations.lastSeenAt))
        .limit(Math.max(1, edgeBudget))
        .all();
    }

    totalEdgesTraversed += rows.length;

    const nextFrontier: string[] = [];
    const frontierSet = new Set(frontier);
    for (const row of rows) {
      if (neighbors.length >= maxNeighborEntities) break;
      // In directed mode, only follow source→target (frontier is always on source side)
      if (frontierSet.has(row.sourceEntityId) && !visited.has(row.targetEntityId)) {
        visited.add(row.targetEntityId);
        neighbors.push(row.targetEntityId);
        nextFrontier.push(row.targetEntityId);
        neighborDepths.set(row.targetEntityId, depth + 1);
      }
      if (directed) continue;
      if (neighbors.length >= maxNeighborEntities) break;
      if (frontierSet.has(row.targetEntityId) && !visited.has(row.sourceEntityId)) {
        visited.add(row.sourceEntityId);
        neighbors.push(row.sourceEntityId);
        nextFrontier.push(row.sourceEntityId);
        neighborDepths.set(row.sourceEntityId, depth + 1);
      }
    }

    frontier = nextFrontier;
  }

  return {
    neighborEntityIds: neighbors.slice(0, maxNeighborEntities),
    traversedEdgeCount: totalEdgesTraversed,
    neighborDepths,
  };
}

export function getEntityLinkedItemCandidates(
  entityIds: string[],
  opts: {
    scopeIds?: string[];
    excludedMessageIds?: string[];
    source: CandidateSource;
    excludeItemIds?: Set<string>;
  },
): Candidate[] {
  if (entityIds.length === 0) return [];
  const excludedMessageIds = opts.excludedMessageIds ?? [];

  const db = getDb();
  const linkedRows = db
    .select({
      memoryItemId: memoryItemEntities.memoryItemId,
    })
    .from(memoryItemEntities)
    .where(inArray(memoryItemEntities.entityId, entityIds))
    .all();

  if (linkedRows.length === 0) return [];

  const itemIds = [...new Set(linkedRows.map((row) => row.memoryItemId))]
    .filter((itemId) => !opts.excludeItemIds?.has(itemId));
  if (itemIds.length === 0) return [];

  const itemConditions = [
    inArray(memoryItems.id, itemIds),
    eq(memoryItems.status, 'active'),
    isNull(memoryItems.invalidAt),
  ];
  if (opts.scopeIds && opts.scopeIds.length > 0) {
    itemConditions.push(inArray(memoryItems.scopeId, opts.scopeIds));
  }
  let items = db
    .select()
    .from(memoryItems)
    .where(and(...itemConditions))
    .all();
  if (items.length === 0) return [];

  if (excludedMessageIds.length > 0) {
    const excludedSet = new Set(excludedMessageIds);
    const sources = db
      .select({
        memoryItemId: memoryItemSources.memoryItemId,
        messageId: memoryItemSources.messageId,
      })
      .from(memoryItemSources)
      .where(inArray(memoryItemSources.memoryItemId, items.map((item) => item.id)))
      .all();
    const hasAnySource = new Set<string>();
    const hasNonExcludedSource = new Set<string>();
    for (const source of sources) {
      hasAnySource.add(source.memoryItemId);
      if (!excludedSet.has(source.messageId)) {
        hasNonExcludedSource.add(source.memoryItemId);
      }
    }
    items = items.filter((item) => !hasAnySource.has(item.id) || hasNonExcludedSource.has(item.id));
  }
  if (items.length === 0) return [];

  return items.map((item) => ({
    key: `item:${item.id}`,
    type: 'item' as CandidateType,
    id: item.id,
    source: opts.source,
    text: `${item.subject}: ${item.statement}`,
    kind: item.kind,
    confidence: item.confidence,
    importance: item.importance ?? 0.5,
    createdAt: item.lastSeenAt,
    lexical: 0,
    semantic: 0,
    recency: computeRecencyScore(item.lastSeenAt),
    finalScore: 0,
  }));
}

/**
 * Multi-step typed traversal: each step expands the frontier through
 * edges matching the step's relation/entity type filters.
 * Returns entity IDs reachable after all steps are applied in sequence.
 */
export function collectTypedNeighbors(
  seedEntityIds: string[],
  steps: TraversalStep[],
  opts?: { maxResultsPerStep?: number; maxEdgesPerStep?: number },
): string[] {
  if (seedEntityIds.length === 0 || steps.length === 0) return [];

  const maxResults = opts?.maxResultsPerStep ?? 20;
  const maxEdges = opts?.maxEdgesPerStep ?? 40;

  let currentSeeds = seedEntityIds;

  for (const step of steps) {
    if (currentSeeds.length === 0) break;

    const result = findNeighborEntities(currentSeeds, {
      maxEdges,
      maxNeighborEntities: maxResults,
      maxDepth: 1,
      relationTypes: step.relationTypes,
      entityTypes: step.entityTypes,
      directed: true,
    });

    currentSeeds = result.neighborEntityIds;
  }

  return currentSeeds;
}

/**
 * Find entities reachable from ALL given seeds via their respective
 * typed traversal steps, then return the intersection.
 */
export function intersectReachable(
  queries: Array<{
    seedEntityIds: string[];
    steps: TraversalStep[];
  }>,
  opts?: { maxResultsPerStep?: number; maxEdgesPerStep?: number },
): string[] {
  if (queries.length === 0) return [];

  const resultSets: Set<string>[] = [];
  for (const query of queries) {
    const result = collectTypedNeighbors(
      query.seedEntityIds,
      query.steps,
      opts,
    );
    resultSets.push(new Set(result));
  }

  if (resultSets.length === 0) return [];

  // Intersect all sets: keep only entities present in ALL sets
  const intersection = [...resultSets[0]].filter(id =>
    resultSets.every(set => set.has(id)),
  );

  return intersection;
}
