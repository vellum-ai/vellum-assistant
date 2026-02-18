import { eq } from 'drizzle-orm';
import type { AssistantConfig } from '../../config/types.js';
import { getConfig } from '../../config/loader.js';
import { getLogger } from '../../util/logger.js';
import { getDb } from '../db.js';
import {
  extractEntitiesWithLLM,
  linkMemoryItemToEntity,
  resolveEntityName,
  upsertEntity,
  upsertEntityRelation,
} from '../entity-extractor.js';
import { extractAndUpsertMemoryItemsForMessage } from '../items-extractor.js';
import { enqueueMemoryJob, type MemoryJob } from '../jobs-store.js';
import { asString } from '../job-utils.js';
import { extractTextFromStoredMessageContent } from '../message-content.js';
import { memoryItemSources, messages } from '../schema.js';

const log = getLogger('memory-jobs-worker');

export async function extractItemsJob(job: MemoryJob): Promise<void> {
  const messageId = asString(job.payload.messageId);
  if (!messageId) return;
  // Backward compat: old payloads may lack scopeId — default to 'default'
  const scopeId = typeof job.payload.scopeId === 'string' && job.payload.scopeId
    ? job.payload.scopeId
    : 'default';
  await extractAndUpsertMemoryItemsForMessage(messageId);
  // Queue entity extraction for this message after items are extracted
  const config = getConfig();
  if (config.memory.entity.enabled) {
    enqueueMemoryJob('extract_entities', { messageId, scopeId });
  }
}

export async function extractEntitiesJob(job: MemoryJob, config: AssistantConfig): Promise<void> {
  const messageId = asString(job.payload.messageId);
  if (!messageId) return;

  const db = getDb();
  const message = db
    .select({
      id: messages.id,
      content: messages.content,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  if (!message) return;

  const text = extractTextFromStoredMessageContent(message.content);
  if (text.trim().length < 15) return;

  const extracted = await extractEntitiesWithLLM(text, config.memory.entity);
  const entities = extracted.entities;
  const relations = extracted.relations;
  if (entities.length === 0 && relations.length === 0) return;

  // Find all memory items linked to this message via memory_item_sources
  const linkedItems = db
    .select({ memoryItemId: memoryItemSources.memoryItemId })
    .from(memoryItemSources)
    .where(eq(memoryItemSources.messageId, messageId))
    .all();
  const itemIds = linkedItems.map((row) => row.memoryItemId);
  const entityNameToId = new Map<string, string>();

  for (const entity of entities) {
    const entityId = upsertEntity(entity);
    entityNameToId.set(entity.name.toLowerCase(), entityId);
    for (const alias of entity.aliases) {
      entityNameToId.set(alias.toLowerCase(), entityId);
    }
    // Link all memory items from this message to the entity
    for (const itemId of itemIds) {
      linkMemoryItemToEntity(itemId, entityId);
    }
  }

  const relationTelemetry = {
    attempted: 0,
    parsed: relations.length,
    persisted: 0,
    dropped: 0,
  };

  if (config.memory.entity.extractRelations.enabled && relations.length > 0) {
    const seenRelationKeys = new Set<string>();
    for (const relation of relations) {
      relationTelemetry.attempted += 1;
      const sourceLookup = relation.sourceEntityName.toLowerCase();
      const targetLookup = relation.targetEntityName.toLowerCase();
      const sourceEntityId = entityNameToId.get(sourceLookup) ?? resolveEntityName(relation.sourceEntityName);
      const targetEntityId = entityNameToId.get(targetLookup) ?? resolveEntityName(relation.targetEntityName);
      if (!sourceEntityId || !targetEntityId || sourceEntityId === targetEntityId) {
        relationTelemetry.dropped += 1;
        continue;
      }

      const dedupeKey = `${sourceEntityId}|${targetEntityId}|${relation.relation}`;
      if (seenRelationKeys.has(dedupeKey)) continue;
      seenRelationKeys.add(dedupeKey);

      upsertEntityRelation({
        sourceEntityId,
        targetEntityId,
        relation: relation.relation,
        evidence: relation.evidence,
      });
      relationTelemetry.persisted += 1;
    }
  }

  log.debug({
    messageId,
    entityCount: entities.length,
    linkedItems: itemIds.length,
    relationAttempts: relationTelemetry.attempted,
    relationParsed: relationTelemetry.parsed,
    relationPersisted: relationTelemetry.persisted,
    relationDropped: relationTelemetry.dropped,
  }, 'Extracted entity graph from message');
}
