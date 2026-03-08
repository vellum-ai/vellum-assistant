import { inArray } from "drizzle-orm";

import { getDb, initializeDb } from "../../../../memory/db.js";
import type {
  EntityRelationType,
  EntityType,
} from "../../../../memory/entity-extractor.js";
import { memoryEntities } from "../../../../memory/schema.js";
import {
  collectTypedNeighbors,
  findMatchedEntities,
  findNeighborEntities,
  getEntityLinkedItemCandidates,
} from "../../../../memory/search/entity.js";
import type { TraversalStep } from "../../../../memory/search/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

interface GraphQueryInput {
  query_type: "neighbors" | "typed_traversal" | "intersection";
  seeds: string[];
  steps?: Array<{
    relation_types?: string[];
    entity_types?: string[];
  }>;
  max_results?: number;
  include_items?: boolean;
}

interface EntityResult {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  items?: Array<{ subject: string; statement: string }>;
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const params = input as unknown as GraphQueryInput;

  initializeDb();

  const maxResults = params.max_results ?? 20;
  const includeItems = params.include_items ?? true;

  // Resolve seed entity names to IDs
  const seedEntityIds: string[] = [];
  const resolvedSeeds: Array<{ name: string; id: string }> = [];
  for (const seedName of params.seeds) {
    const matched = findMatchedEntities(seedName, 5);
    if (matched.length > 0) {
      seedEntityIds.push(matched[0].id);
      resolvedSeeds.push({ name: seedName, id: matched[0].id });
    }
  }

  if (seedEntityIds.length === 0) {
    return {
      content: JSON.stringify({
        error: "No matching entities found for the provided seed names",
        seeds: params.seeds,
      }),
      isError: true,
    };
  }

  // For intersection queries, all seeds must resolve — dropping any seed silently
  // changes semantics from "reachable from ALL seeds" to "reachable from resolved seeds"
  if (
    params.query_type === "intersection" &&
    seedEntityIds.length < params.seeds.length
  ) {
    const unresolvedSeeds = params.seeds.filter(
      (name) => !resolvedSeeds.some((s) => s.name === name),
    );
    return {
      content: JSON.stringify({
        error:
          "Some seed entities could not be resolved. Intersection requires all seeds to match.",
        unresolved_seeds: unresolvedSeeds,
        resolved_seeds: resolvedSeeds,
      }),
      isError: true,
    };
  }

  let resultEntityIds: string[];

  switch (params.query_type) {
    case "neighbors": {
      const steps = params.steps?.[0];
      const result = findNeighborEntities(seedEntityIds, {
        maxEdges: 40,
        maxNeighborEntities: maxResults,
        maxDepth: 1,
        relationTypes: steps?.relation_types as
          | EntityRelationType[]
          | undefined,
        entityTypes: steps?.entity_types as EntityType[] | undefined,
      });
      resultEntityIds = result.neighborEntityIds;
      break;
    }

    case "typed_traversal": {
      const traversalSteps: TraversalStep[] = (params.steps ?? []).map((s) => ({
        relationTypes: s.relation_types as EntityRelationType[] | undefined,
        entityTypes: s.entity_types as EntityType[] | undefined,
      }));
      resultEntityIds = collectTypedNeighbors(seedEntityIds, traversalSteps, {
        maxResultsPerStep: maxResults,
        maxEdgesPerStep: 40,
      });
      break;
    }

    case "intersection": {
      // Run typed traversal from each seed independently, then intersect
      const traversalSteps: TraversalStep[] = (params.steps ?? []).map((s) => ({
        relationTypes: s.relation_types as EntityRelationType[] | undefined,
        entityTypes: s.entity_types as EntityType[] | undefined,
      }));

      const resultSets: Set<string>[] = [];
      for (const seedId of seedEntityIds) {
        const result = collectTypedNeighbors([seedId], traversalSteps, {
          maxResultsPerStep: maxResults,
          maxEdgesPerStep: 40,
        });
        resultSets.push(new Set(result));
      }

      if (resultSets.length === 0) {
        resultEntityIds = [];
      } else {
        // Intersect all sets
        const intersection = [...resultSets[0]].filter((id) =>
          resultSets.every((set) => set.has(id)),
        );
        resultEntityIds = intersection;
      }
      break;
    }

    default:
      return {
        content: JSON.stringify({
          error: `Unknown query_type: ${params.query_type}`,
        }),
        isError: true,
      };
  }

  // Look up entity details
  const db = getDb();
  const entities: EntityResult[] = [];

  if (resultEntityIds.length > 0) {
    const entityRows = db
      .select()
      .from(memoryEntities)
      .where(inArray(memoryEntities.id, resultEntityIds.slice(0, maxResults)))
      .all();

    for (const row of entityRows) {
      const entity: EntityResult = {
        id: row.id,
        name: row.name,
        type: row.type,
        aliases: row.aliases ? (JSON.parse(row.aliases) as string[]) : [],
      };

      if (includeItems) {
        const candidates = getEntityLinkedItemCandidates([row.id], {
          source: "entity_direct",
          scopeIds: _context.memoryScopeId
            ? [_context.memoryScopeId]
            : undefined,
        });
        entity.items = candidates.slice(0, 5).map((c) => {
          const parts = c.text.split(": ");
          return {
            subject: parts[0] ?? "",
            statement: parts.slice(1).join(": ") || c.text,
          };
        });
      }

      entities.push(entity);
    }
  }

  return {
    content: JSON.stringify(
      {
        query_type: params.query_type,
        resolved_seeds: resolvedSeeds,
        result_count: entities.length,
        entities,
      },
      null,
      2,
    ),
    isError: false,
  };
}
