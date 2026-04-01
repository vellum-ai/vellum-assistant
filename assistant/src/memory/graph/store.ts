// ---------------------------------------------------------------------------
// Memory Graph — Data access layer
// ---------------------------------------------------------------------------

import { and, eq, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "../db.js";
import {
  memoryGraphEdges,
  memoryGraphNodes,
  memoryGraphTriggers,
} from "../schema.js";
import type {
  ApplyDiffResult,
  EmotionalCharge,
  Fidelity,
  ImageRef,
  MemoryDiff,
  MemoryEdge,
  MemoryNode,
  MemoryTrigger,
  MemoryType,
  NewEdge,
  NewNode,
  NewTrigger,
  SourceType,
} from "./types.js";

// ---------------------------------------------------------------------------
// Row ↔ Domain conversion helpers
// ---------------------------------------------------------------------------

function rowToNode(row: typeof memoryGraphNodes.$inferSelect): MemoryNode {
  return {
    id: row.id,
    content: row.content,
    type: row.type as MemoryType,
    created: row.created,
    lastAccessed: row.lastAccessed,
    lastConsolidated: row.lastConsolidated,
    eventDate: row.eventDate ?? null,
    emotionalCharge: JSON.parse(row.emotionalCharge) as EmotionalCharge,
    fidelity: row.fidelity as Fidelity,
    confidence: row.confidence,
    significance: row.significance,
    stability: row.stability,
    reinforcementCount: row.reinforcementCount,
    lastReinforced: row.lastReinforced,
    sourceConversations: JSON.parse(row.sourceConversations) as string[],
    sourceType: row.sourceType as SourceType,
    narrativeRole: row.narrativeRole,
    partOfStory: row.partOfStory,
    imageRefs: row.imageRefs ? (JSON.parse(row.imageRefs) as ImageRef[]) : null,
    scopeId: row.scopeId,
  };
}

function nodeToInsertValues(node: NewNode, id: string) {
  return {
    id,
    content: node.content,
    type: node.type,
    created: node.created,
    lastAccessed: node.lastAccessed,
    lastConsolidated: node.lastConsolidated,
    eventDate: node.eventDate ?? null,
    emotionalCharge: JSON.stringify(node.emotionalCharge),
    fidelity: node.fidelity,
    confidence: node.confidence,
    significance: node.significance,
    stability: node.stability,
    reinforcementCount: node.reinforcementCount,
    lastReinforced: node.lastReinforced,
    sourceConversations: JSON.stringify(node.sourceConversations),
    sourceType: node.sourceType,
    narrativeRole: node.narrativeRole,
    partOfStory: node.partOfStory,
    imageRefs: node.imageRefs ? JSON.stringify(node.imageRefs) : null,
    scopeId: node.scopeId,
  };
}

function rowToEdge(row: typeof memoryGraphEdges.$inferSelect): MemoryEdge {
  return {
    id: row.id,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    relationship: row.relationship as MemoryEdge["relationship"],
    weight: row.weight,
    created: row.created,
  };
}

function rowToTrigger(
  row: typeof memoryGraphTriggers.$inferSelect,
): MemoryTrigger {
  return {
    id: row.id,
    nodeId: row.nodeId,
    type: row.type as MemoryTrigger["type"],
    schedule: row.schedule,
    condition: row.condition,
    conditionEmbedding: row.conditionEmbedding
      ? new Float32Array(row.conditionEmbedding as ArrayBuffer)
      : null,
    threshold: row.threshold,
    eventDate: row.eventDate,
    rampDays: row.rampDays,
    followUpDays: row.followUpDays,
    recurring: row.recurring,
    consumed: row.consumed,
    cooldownMs: row.cooldownMs,
    lastFired: row.lastFired,
  };
}

// ---------------------------------------------------------------------------
// Node CRUD
// ---------------------------------------------------------------------------

export function createNode(node: NewNode): MemoryNode {
  const db = getDb();
  const id = uuid();
  db.insert(memoryGraphNodes).values(nodeToInsertValues(node, id)).run();
  return { ...node, id };
}

export function getNode(id: string): MemoryNode | null {
  const db = getDb();
  const row = db
    .select()
    .from(memoryGraphNodes)
    .where(eq(memoryGraphNodes.id, id))
    .get();
  return row ? rowToNode(row) : null;
}

export function getNodesByIds(ids: string[]): MemoryNode[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = db
    .select()
    .from(memoryGraphNodes)
    .where(inArray(memoryGraphNodes.id, ids))
    .all();
  return rows.map(rowToNode);
}

export function updateNode(
  id: string,
  changes: Partial<Omit<MemoryNode, "id">>,
): void {
  const db = getDb();
  const updates: Record<string, unknown> = {};

  if (changes.content !== undefined) updates.content = changes.content;
  if (changes.type !== undefined) updates.type = changes.type;
  if (changes.created !== undefined) updates.created = changes.created;
  if (changes.lastAccessed !== undefined)
    updates.lastAccessed = changes.lastAccessed;
  if (changes.lastConsolidated !== undefined)
    updates.lastConsolidated = changes.lastConsolidated;
  if (changes.emotionalCharge !== undefined)
    updates.emotionalCharge = JSON.stringify(changes.emotionalCharge);
  if (changes.fidelity !== undefined) updates.fidelity = changes.fidelity;
  if (changes.confidence !== undefined) updates.confidence = changes.confidence;
  if (changes.significance !== undefined)
    updates.significance = changes.significance;
  if (changes.stability !== undefined) updates.stability = changes.stability;
  if (changes.reinforcementCount !== undefined)
    updates.reinforcementCount = changes.reinforcementCount;
  if (changes.lastReinforced !== undefined)
    updates.lastReinforced = changes.lastReinforced;
  if (changes.sourceConversations !== undefined)
    updates.sourceConversations = JSON.stringify(changes.sourceConversations);
  if (changes.sourceType !== undefined) updates.sourceType = changes.sourceType;
  if (changes.narrativeRole !== undefined)
    updates.narrativeRole = changes.narrativeRole;
  if (changes.partOfStory !== undefined)
    updates.partOfStory = changes.partOfStory;
  if (changes.imageRefs !== undefined)
    updates.imageRefs = changes.imageRefs ? JSON.stringify(changes.imageRefs) : null;
  if (changes.scopeId !== undefined) updates.scopeId = changes.scopeId;
  if (changes.eventDate !== undefined) updates.eventDate = changes.eventDate;

  if (Object.keys(updates).length === 0) return;

  db.update(memoryGraphNodes)
    .set(updates)
    .where(eq(memoryGraphNodes.id, id))
    .run();

  // Sync event triggers when eventDate changes
  if (changes.eventDate !== undefined) {
    const triggers = getTriggersForNode(id);
    const eventTriggers = triggers.filter((t) => t.type === "event");
    for (const trigger of eventTriggers) {
      if (changes.eventDate === null) {
        // Clearing eventDate — delete orphaned event trigger
        deleteTrigger(trigger.id);
      } else {
        // Updating eventDate — sync trigger's eventDate
        updateTrigger(trigger.id, { eventDate: changes.eventDate });
      }
    }
  }
}

export function deleteNode(id: string): void {
  const db = getDb();
  db.delete(memoryGraphNodes).where(eq(memoryGraphNodes.id, id)).run();
}

// ---------------------------------------------------------------------------
// Node queries
// ---------------------------------------------------------------------------

export interface NodeQueryFilters {
  scopeId?: string;
  types?: MemoryType[];
  fidelityNot?: Fidelity[];
  minSignificance?: number;
  createdAfter?: number;
  createdBefore?: number;
  hasEventDate?: boolean;
  eventDateAfter?: number;
  eventDateBefore?: number;
  limit?: number;
}

export function queryNodes(filters: NodeQueryFilters): MemoryNode[] {
  const db = getDb();
  const conditions = [];

  if (filters.scopeId) {
    conditions.push(eq(memoryGraphNodes.scopeId, filters.scopeId));
  }
  if (filters.types && filters.types.length > 0) {
    conditions.push(inArray(memoryGraphNodes.type, filters.types));
  }
  if (filters.fidelityNot && filters.fidelityNot.length > 0) {
    conditions.push(
      sql`${memoryGraphNodes.fidelity} NOT IN (${sql.join(
        filters.fidelityNot.map((f) => sql`${f}`),
        sql`, `,
      )})`,
    );
  }
  if (filters.minSignificance !== undefined) {
    conditions.push(
      sql`${memoryGraphNodes.significance} >= ${filters.minSignificance}`,
    );
  }
  if (filters.createdAfter !== undefined) {
    conditions.push(
      sql`${memoryGraphNodes.created} >= ${filters.createdAfter}`,
    );
  }
  if (filters.createdBefore !== undefined) {
    conditions.push(
      sql`${memoryGraphNodes.created} <= ${filters.createdBefore}`,
    );
  }
  if (filters.hasEventDate) {
    conditions.push(sql`${memoryGraphNodes.eventDate} IS NOT NULL`);
  }
  if (filters.eventDateAfter !== undefined) {
    conditions.push(
      sql`${memoryGraphNodes.eventDate} >= ${filters.eventDateAfter}`,
    );
  }
  if (filters.eventDateBefore !== undefined) {
    conditions.push(
      sql`${memoryGraphNodes.eventDate} <= ${filters.eventDateBefore}`,
    );
  }

  let query = db
    .select()
    .from(memoryGraphNodes)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${memoryGraphNodes.significance} DESC`);

  if (filters.limit) {
    query = query.limit(filters.limit) as typeof query;
  }

  return query.all().map(rowToNode);
}

/** Count all non-gone nodes in a scope. */
export function countNodes(scopeId: string): number {
  const db = getDb();
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(memoryGraphNodes)
    .where(
      and(
        eq(memoryGraphNodes.scopeId, scopeId),
        sql`${memoryGraphNodes.fidelity} != 'gone'`,
      ),
    )
    .get();
  return result?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Edge CRUD
// ---------------------------------------------------------------------------

export function createEdge(edge: NewEdge): MemoryEdge {
  const db = getDb();
  const id = uuid();
  db.insert(memoryGraphEdges)
    .values({
      id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      relationship: edge.relationship,
      weight: edge.weight,
      created: edge.created,
    })
    .run();
  return { ...edge, id };
}

export function deleteEdge(id: string): void {
  const db = getDb();
  db.delete(memoryGraphEdges).where(eq(memoryGraphEdges.id, id)).run();
}

export function getEdgesForNode(
  nodeId: string,
  direction?: "incoming" | "outgoing",
): MemoryEdge[] {
  const db = getDb();
  const condition =
    direction === "outgoing"
      ? eq(memoryGraphEdges.sourceNodeId, nodeId)
      : direction === "incoming"
        ? eq(memoryGraphEdges.targetNodeId, nodeId)
        : sql`${memoryGraphEdges.sourceNodeId} = ${nodeId} OR ${memoryGraphEdges.targetNodeId} = ${nodeId}`;

  return db
    .select()
    .from(memoryGraphEdges)
    .where(condition)
    .all()
    .map(rowToEdge);
}

// ---------------------------------------------------------------------------
// Trigger CRUD
// ---------------------------------------------------------------------------

export function createTrigger(trigger: NewTrigger): MemoryTrigger {
  const db = getDb();
  const id = uuid();
  db.insert(memoryGraphTriggers)
    .values({
      id,
      nodeId: trigger.nodeId,
      type: trigger.type,
      schedule: trigger.schedule,
      condition: trigger.condition,
      conditionEmbedding: trigger.conditionEmbedding
        ? Buffer.from(trigger.conditionEmbedding.buffer)
        : null,
      threshold: trigger.threshold,
      eventDate: trigger.eventDate,
      rampDays: trigger.rampDays,
      followUpDays: trigger.followUpDays,
      recurring: trigger.recurring,
      consumed: trigger.consumed,
      cooldownMs: trigger.cooldownMs,
      lastFired: trigger.lastFired,
    })
    .run();
  return { ...trigger, id };
}

export function deleteTrigger(id: string): void {
  const db = getDb();
  db.delete(memoryGraphTriggers)
    .where(eq(memoryGraphTriggers.id, id))
    .run();
}

export function updateTrigger(
  id: string,
  updates: Partial<MemoryTrigger>,
): void {
  const db = getDb();
  const values: Record<string, unknown> = {};
  if (updates.consumed !== undefined) values.consumed = updates.consumed;
  if (updates.lastFired !== undefined) values.lastFired = updates.lastFired;
  if (updates.conditionEmbedding !== undefined)
    values.conditionEmbedding = updates.conditionEmbedding
      ? Buffer.from(updates.conditionEmbedding.buffer)
      : null;
  if (updates.eventDate !== undefined) values.eventDate = updates.eventDate;
  if (updates.rampDays !== undefined) values.rampDays = updates.rampDays;
  if (updates.followUpDays !== undefined)
    values.followUpDays = updates.followUpDays;

  if (Object.keys(values).length === 0) return;
  db.update(memoryGraphTriggers)
    .set(values)
    .where(eq(memoryGraphTriggers.id, id))
    .run();
}

export function getTriggersForNode(nodeId: string): MemoryTrigger[] {
  const db = getDb();
  return db
    .select()
    .from(memoryGraphTriggers)
    .where(eq(memoryGraphTriggers.nodeId, nodeId))
    .all()
    .map(rowToTrigger);
}

export function getActiveTriggersByType(
  type: MemoryTrigger["type"],
  scopeId?: string,
): MemoryTrigger[] {
  const db = getDb();
  const conditions = [
    eq(memoryGraphTriggers.type, type),
    eq(memoryGraphTriggers.consumed, false),
  ];

  // Join to nodes table to filter by scope if needed
  if (scopeId) {
    const rows = db
      .select({
        trigger: memoryGraphTriggers,
      })
      .from(memoryGraphTriggers)
      .innerJoin(
        memoryGraphNodes,
        eq(memoryGraphTriggers.nodeId, memoryGraphNodes.id),
      )
      .where(
        and(
          ...conditions,
          eq(memoryGraphNodes.scopeId, scopeId),
          sql`${memoryGraphNodes.fidelity} != 'gone'`,
        ),
      )
      .all();
    return rows.map((r) => rowToTrigger(r.trigger));
  }

  return db
    .select()
    .from(memoryGraphTriggers)
    .where(and(...conditions))
    .all()
    .map(rowToTrigger);
}

// ---------------------------------------------------------------------------
// Reinforcement
// ---------------------------------------------------------------------------

const REINFORCEMENT_STABILITY_MULTIPLIER = 1.5;

/**
 * Reinforce a memory node — confirms it's still accurate/relevant.
 * Increments reinforcementCount, multiplies stability by 1.5,
 * and optionally boosts significance back toward peak.
 */
export function reinforceNode(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.update(memoryGraphNodes)
    .set({
      reinforcementCount: sql`${memoryGraphNodes.reinforcementCount} + 1`,
      stability: sql`${memoryGraphNodes.stability} * ${REINFORCEMENT_STABILITY_MULTIPLIER}`,
      lastReinforced: now,
      significance: sql`MIN(1.0, ${memoryGraphNodes.significance} * 1.1)`,
    })
    .where(eq(memoryGraphNodes.id, id))
    .run();
}

/**
 * Supersede an old node with a new one. The new node inherits the old node's
 * earned durability (stability, reinforcementCount, significance).
 * A "supersedes" edge is created, and the old node is returned for content update.
 */
export function supersedeNode(
  oldNodeId: string,
  newNode: NewNode,
): { newNode: MemoryNode; oldNode: MemoryNode | null } {
  const oldNode = getNode(oldNodeId);
  if (!oldNode) {
    return { newNode: createNode(newNode), oldNode: null };
  }

  // Inherit the old node's earned durability
  const inherited: NewNode = {
    ...newNode,
    stability: Math.max(newNode.stability, oldNode.stability),
    reinforcementCount: Math.max(
      newNode.reinforcementCount,
      oldNode.reinforcementCount,
    ),
    significance: Math.max(newNode.significance, oldNode.significance),
    eventDate: newNode.eventDate ?? oldNode.eventDate,
    imageRefs: newNode.imageRefs ?? oldNode.imageRefs,
  };

  const created = createNode(inherited);

  // Create supersedes edge
  createEdge({
    sourceNodeId: created.id,
    targetNodeId: oldNodeId,
    relationship: "supersedes",
    weight: 1.0,
    created: Date.now(),
  });

  return { newNode: created, oldNode };
}

// ---------------------------------------------------------------------------
// Diff application (transactional)
// ---------------------------------------------------------------------------

/**
 * Apply a MemoryDiff atomically. All operations run in a single transaction.
 */
export function applyDiff(diff: MemoryDiff): ApplyDiffResult {
  const db = getDb();
  const result: ApplyDiffResult = {
    nodesCreated: 0,
    nodesUpdated: 0,
    nodesDeleted: 0,
    edgesCreated: 0,
    edgesDeleted: 0,
    triggersCreated: 0,
    triggersDeleted: 0,
    nodesReinforced: 0,
    createdNodeIds: [],
  };

  db.transaction((tx) => {
    // Delete nodes first (cascades edges + triggers)
    for (const id of diff.deleteNodeIds) {
      tx.delete(memoryGraphNodes).where(eq(memoryGraphNodes.id, id)).run();
      result.nodesDeleted++;
    }

    // Create nodes
    for (const node of diff.createNodes) {
      const id = uuid();
      tx.insert(memoryGraphNodes).values(nodeToInsertValues(node, id)).run();
      result.nodesCreated++;
      result.createdNodeIds.push(id);
    }

    // Update nodes
    for (const update of diff.updateNodes) {
      const updates: Record<string, unknown> = {};
      const c = update.changes;
      if (c.content !== undefined) updates.content = c.content;
      if (c.type !== undefined) updates.type = c.type;
      if (c.emotionalCharge !== undefined)
        updates.emotionalCharge = JSON.stringify(c.emotionalCharge);
      if (c.fidelity !== undefined) updates.fidelity = c.fidelity;
      if (c.confidence !== undefined) updates.confidence = c.confidence;
      if (c.significance !== undefined) updates.significance = c.significance;
      if (c.stability !== undefined) updates.stability = c.stability;
      if (c.narrativeRole !== undefined)
        updates.narrativeRole = c.narrativeRole;
      if (c.partOfStory !== undefined) updates.partOfStory = c.partOfStory;
      if (c.imageRefs !== undefined)
        updates.imageRefs = c.imageRefs ? JSON.stringify(c.imageRefs) : null;
      if (c.sourceConversations !== undefined)
        updates.sourceConversations = JSON.stringify(c.sourceConversations);
      if (c.eventDate !== undefined) updates.eventDate = c.eventDate;

      if (Object.keys(updates).length > 0) {
        tx.update(memoryGraphNodes)
          .set(updates)
          .where(eq(memoryGraphNodes.id, update.id))
          .run();
        result.nodesUpdated++;
      }

      // Sync event triggers when eventDate changes
      if (c.eventDate !== undefined) {
        const triggers = tx
          .select()
          .from(memoryGraphTriggers)
          .where(
            and(
              eq(memoryGraphTriggers.nodeId, update.id),
              eq(memoryGraphTriggers.type, "event"),
            ),
          )
          .all();

        for (const trigger of triggers) {
          if (c.eventDate == null) {
            // eventDate cleared — delete orphaned event trigger
            tx.delete(memoryGraphTriggers)
              .where(eq(memoryGraphTriggers.id, trigger.id))
              .run();
          } else {
            // eventDate changed — sync trigger
            tx.update(memoryGraphTriggers)
              .set({ eventDate: c.eventDate })
              .where(eq(memoryGraphTriggers.id, trigger.id))
              .run();
          }
        }
      }
    }

    // Reinforce nodes
    const now = Date.now();
    for (const id of diff.reinforceNodeIds) {
      tx.update(memoryGraphNodes)
        .set({
          reinforcementCount: sql`${memoryGraphNodes.reinforcementCount} + 1`,
          stability: sql`${memoryGraphNodes.stability} * ${REINFORCEMENT_STABILITY_MULTIPLIER}`,
          lastReinforced: now,
          significance: sql`MIN(1.0, ${memoryGraphNodes.significance} * 1.1)`,
        })
        .where(eq(memoryGraphNodes.id, id))
        .run();
      result.nodesReinforced++;
    }

    // Delete edges
    for (const id of diff.deleteEdgeIds) {
      tx.delete(memoryGraphEdges).where(eq(memoryGraphEdges.id, id)).run();
      result.edgesDeleted++;
    }

    // Create edges
    for (const edge of diff.createEdges) {
      const id = uuid();
      tx.insert(memoryGraphEdges)
        .values({
          id,
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          relationship: edge.relationship,
          weight: edge.weight,
          created: edge.created,
        })
        .run();
      result.edgesCreated++;
    }

    // Delete triggers
    for (const id of diff.deleteTriggerIds) {
      tx.delete(memoryGraphTriggers)
        .where(eq(memoryGraphTriggers.id, id))
        .run();
      result.triggersDeleted++;
    }

    // Create triggers
    for (const trigger of diff.createTriggers) {
      const id = uuid();
      tx.insert(memoryGraphTriggers)
        .values({
          id,
          nodeId: trigger.nodeId,
          type: trigger.type,
          schedule: trigger.schedule,
          condition: trigger.condition,
          conditionEmbedding: trigger.conditionEmbedding
            ? Buffer.from(trigger.conditionEmbedding.buffer)
            : null,
          threshold: trigger.threshold,
          eventDate: trigger.eventDate,
          rampDays: trigger.rampDays,
          followUpDays: trigger.followUpDays,
          recurring: trigger.recurring,
          consumed: trigger.consumed,
          cooldownMs: trigger.cooldownMs,
          lastFired: trigger.lastFired,
        })
        .run();
      result.triggersCreated++;
    }
  });

  return result;
}
