import Anthropic from '@anthropic-ai/sdk';
import { eq, sql } from 'drizzle-orm';
import { getConfig } from '../config/loader.js';
import type { MemoryEntityConfig } from '../config/types.js';
import { getLogger } from '../util/logger.js';
import { getDb } from './db.js';
import { memoryEntities, memoryEntityRelations, memoryItemEntities } from './schema.js';

const log = getLogger('memory-entity-extractor');

export type EntityType =
  | 'person'
  | 'project'
  | 'tool'
  | 'company'
  | 'concept'
  | 'location'
  | 'organization';

export type EntityRelationType =
  | 'works_on'
  | 'uses'
  | 'owns'
  | 'member_of'
  | 'located_in'
  | 'depends_on'
  | 'collaborates_with'
  | 'reports_to'
  | 'related_to';

const VALID_ENTITY_TYPES = new Set<string>([
  'person', 'project', 'tool', 'company', 'concept', 'location', 'organization',
]);

const VALID_RELATION_TYPES = new Set<string>([
  'works_on',
  'uses',
  'owns',
  'member_of',
  'located_in',
  'depends_on',
  'collaborates_with',
  'reports_to',
  'related_to',
]);

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  aliases: string[];
}

export interface ExtractedEntityRelation {
  sourceEntityName: string;
  targetEntityName: string;
  relation: EntityRelationType;
  evidence: string | null;
}

export interface ExtractedEntityGraph {
  entities: ExtractedEntity[];
  relations: ExtractedEntityRelation[];
}

export interface UpsertEntityRelationInput {
  sourceEntityId: string;
  targetEntityId: string;
  relation: EntityRelationType;
  evidence?: string | null;
  seenAt?: number;
}

interface LLMExtractedEntity {
  name: string;
  type: string;
  aliases: string[];
}

interface LLMExtractedRelation {
  sourceEntityName: string;
  targetEntityName: string;
  relation: string;
  evidence?: string;
}

const ENTITY_EXTRACTION_SYSTEM_PROMPT = `You are an entity extraction system. Given text from a conversation, extract named entities that are worth tracking across conversations.

Extract entities in these categories:
- person: People mentioned by name (users, colleagues, contacts)
- project: Named projects, repositories, products, apps
- tool: Software tools, libraries, frameworks, languages
- company: Companies, organizations with commercial identity
- concept: Technical concepts, methodologies, design patterns
- location: Cities, offices, regions relevant to the user
- organization: Non-commercial orgs, teams, groups, communities

If relation extraction is enabled, also extract directional entity relations using:
- works_on, uses, owns, member_of, located_in, depends_on, collaborates_with, reports_to, related_to

For each entity, provide:
- name: The canonical name (proper casing, full name preferred)
- type: One of the categories above
- aliases: Array of alternate names, abbreviations, or nicknames (empty array if none)

If relation extraction is enabled, for each relation provide:
- sourceEntityName: canonical source entity name
- targetEntityName: canonical target entity name
- relation: one of the allowed relation types
- evidence: short evidence phrase from the text (optional)

Rules:
- Only extract concrete, named entities. Skip generic terms like "the project" or "that tool".
- Prefer the most specific and complete name as the canonical name.
- Include common abbreviations and nicknames as aliases.
- Do NOT extract the assistant itself or generic conversation participants.
- If there are no extractable entities, return an empty entities array.
- Only emit relations that are explicitly or strongly implied by the text.`;

export async function extractEntitiesWithLLM(
  text: string,
  entityConfig: MemoryEntityConfig,
): Promise<ExtractedEntityGraph> {
  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.debug('No Anthropic API key available for entity extraction');
    return { entities: [], relations: [] };
  }

  const extractRelations = entityConfig.extractRelations?.enabled ?? false;

  try {
    const client = new Anthropic({ apiKey });
    const response = await Promise.race([
      client.messages.create({
        model: entityConfig.model,
        max_tokens: 1024,
        system: ENTITY_EXTRACTION_SYSTEM_PROMPT,
        tools: [{
          name: 'store_entities',
          description: 'Store extracted entities from the text',
          input_schema: buildToolInputSchema(extractRelations),
        }],
        tool_choice: { type: 'tool' as const, name: 'store_entities' },
        messages: [{ role: 'user' as const, content: text }],
      }) as Promise<Anthropic.Message>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Entity extraction LLM timeout')), 15000),
      ),
    ]) as Anthropic.Message;

    const toolBlock = response.content.find((block) => block.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      log.warn('No tool_use block in entity extraction response');
      return { entities: [], relations: [] };
    }

    const input = toolBlock.input as { entities?: LLMExtractedEntity[]; relations?: LLMExtractedRelation[] };
    if (!Array.isArray(input.entities)) {
      log.warn('Invalid entities in entity extraction response');
      return { entities: [], relations: [] };
    }

    const entities = parseExtractedEntities(input.entities);
    const relations = extractRelations ? parseExtractedRelations(input.relations) : [];

    return { entities, relations };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'Entity extraction LLM call failed');
    return { entities: [], relations: [] };
  }
}

/**
 * Resolve an extracted entity against existing entities in the database.
 * Returns the existing entity ID if a match is found, or null if no match.
 */
export function resolveEntity(entity: ExtractedEntity): string | null {
  const candidates = findEntityCandidates(entity.name);
  if (candidates.length > 0) {
    const sameType = candidates.find((candidate) => candidate.type === entity.type);
    return sameType?.id ?? candidates[0].id;
  }

  for (const alias of entity.aliases) {
    const aliasCandidates = findEntityCandidates(alias);
    if (aliasCandidates.length > 0) {
      const sameType = aliasCandidates.find((candidate) => candidate.type === entity.type);
      return sameType?.id ?? aliasCandidates[0].id;
    }
  }
  return null;
}

/**
 * Resolve an entity by canonical name or alias.
 * Prefers exact canonical name matches over alias-only matches so that
 * relations are attached to the correct node.
 */
export function resolveEntityName(entityName: string): string | null {
  const candidates = findEntityCandidates(entityName);
  if (candidates.length === 0) return null;
  const nameLower = entityName.trim().toLowerCase();
  const exactNameMatch = candidates.find((c) => c.name.toLowerCase() === nameLower);
  return exactNameMatch?.id ?? candidates[0].id;
}

/**
 * Upsert an entity into the database: resolve against existing entities,
 * update if found, or insert a new one.
 * Returns the entity ID.
 */
export function upsertEntity(entity: ExtractedEntity): string {
  const db = getDb();
  const now = Date.now();
  const existingId = resolveEntity(entity);

  if (existingId) {
    const existing = db
      .select()
      .from(memoryEntities)
      .where(eq(memoryEntities.id, existingId))
      .get();

    if (existing) {
      const existingAliases: string[] = existing.aliases
        ? (JSON.parse(existing.aliases) as string[])
        : [];
      const mergedAliases = mergeAliases(existingAliases, entity.aliases, existing.name);

      db.update(memoryEntities)
        .set({
          lastSeenAt: now,
          mentionCount: sql`${memoryEntities.mentionCount} + 1`,
          aliases: mergedAliases.length > 0 ? JSON.stringify(mergedAliases) : null,
        })
        .where(eq(memoryEntities.id, existingId))
        .run();
    }

    return existingId;
  }

  const id = crypto.randomUUID();
  db.insert(memoryEntities).values({
    id,
    name: entity.name,
    type: entity.type,
    aliases: entity.aliases.length > 0 ? JSON.stringify(entity.aliases) : null,
    description: null,
    firstSeenAt: now,
    lastSeenAt: now,
    mentionCount: 1,
  }).run();

  return id;
}

/**
 * Upsert an entity relation edge using (source, target, relation) as a stable uniqueness key.
 */
export function upsertEntityRelation(input: UpsertEntityRelationInput): void {
  if (input.sourceEntityId === input.targetEntityId) return;

  const db = getDb();
  const seenAt = input.seenAt ?? Date.now();
  const normalizedEvidence = normalizeEvidence(input.evidence);

  db.insert(memoryEntityRelations).values({
    id: crypto.randomUUID(),
    sourceEntityId: input.sourceEntityId,
    targetEntityId: input.targetEntityId,
    relation: input.relation,
    evidence: normalizedEvidence,
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  }).onConflictDoUpdate({
    target: [
      memoryEntityRelations.sourceEntityId,
      memoryEntityRelations.targetEntityId,
      memoryEntityRelations.relation,
    ],
    set: normalizedEvidence === null
      ? {
        firstSeenAt: sql`MIN(${memoryEntityRelations.firstSeenAt}, ${seenAt})`,
        lastSeenAt: sql`MAX(${memoryEntityRelations.lastSeenAt}, ${seenAt})`,
      }
      : {
        firstSeenAt: sql`MIN(${memoryEntityRelations.firstSeenAt}, ${seenAt})`,
        lastSeenAt: sql`MAX(${memoryEntityRelations.lastSeenAt}, ${seenAt})`,
        evidence: normalizedEvidence,
      },
  }).run();
}

/**
 * Link a memory item to an entity via the join table.
 */
export function linkMemoryItemToEntity(memoryItemId: string, entityId: string): void {
  const db = getDb();
  db.insert(memoryItemEntities).values({
    memoryItemId,
    entityId,
  }).onConflictDoNothing().run();
}

type ToolInputSchema = Record<string, unknown> & {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
};

function buildToolInputSchema(includeRelations: boolean): ToolInputSchema {
  const properties: Record<string, unknown> = {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Canonical name of the entity',
          },
          type: {
            type: 'string',
            enum: [...VALID_ENTITY_TYPES],
            description: 'Category of the entity',
          },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: 'Alternate names or abbreviations',
          },
        },
        required: ['name', 'type', 'aliases'],
      },
    },
  };

  const required: string[] = ['entities'];

  if (includeRelations) {
    properties.relations = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sourceEntityName: { type: 'string' },
          targetEntityName: { type: 'string' },
          relation: {
            type: 'string',
            enum: [...VALID_RELATION_TYPES],
          },
          evidence: { type: 'string' },
        },
        required: ['sourceEntityName', 'targetEntityName', 'relation'],
      },
    };
    required.push('relations');
  }

  return {
    type: 'object',
    properties,
    required,
  };
}

function parseExtractedEntities(rawEntities: LLMExtractedEntity[]): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();
  for (const raw of rawEntities) {
    if (!VALID_ENTITY_TYPES.has(raw.type)) continue;
    const name = normalizeEntityName(raw.name);
    if (!name) continue;

    const aliases = Array.isArray(raw.aliases)
      ? dedupeAliasList(raw.aliases, name)
      : [];
    const dedupeKey = `${name.toLowerCase()}|${raw.type}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    entities.push({
      name,
      type: raw.type as EntityType,
      aliases,
    });
  }
  return entities;
}

function parseExtractedRelations(
  rawRelations: LLMExtractedRelation[] | undefined,
): ExtractedEntityRelation[] {
  if (!Array.isArray(rawRelations)) return [];
  const relations: ExtractedEntityRelation[] = [];
  const seen = new Set<string>();
  for (const raw of rawRelations) {
    if (!VALID_RELATION_TYPES.has(raw.relation)) continue;
    const sourceEntityName = normalizeEntityName(raw.sourceEntityName);
    const targetEntityName = normalizeEntityName(raw.targetEntityName);
    if (!sourceEntityName || !targetEntityName) continue;
    if (sourceEntityName.toLowerCase() === targetEntityName.toLowerCase()) continue;
    const relation = raw.relation as EntityRelationType;
    const dedupeKey = `${sourceEntityName.toLowerCase()}|${targetEntityName.toLowerCase()}|${relation}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    relations.push({
      sourceEntityName,
      targetEntityName,
      relation,
      evidence: normalizeEvidence(raw.evidence),
    });
  }
  return relations;
}

function findEntityCandidates(nameOrAlias: string): Array<typeof memoryEntities.$inferSelect> {
  const normalized = normalizeEntityName(nameOrAlias);
  if (!normalized) return [];
  const db = getDb();
  const nameLower = normalized.toLowerCase();

  const raw = (db as unknown as {
    $client: { query: (q: string) => { all: (...params: unknown[]) => unknown[] } };
  }).$client;

  return raw.query(`
    SELECT DISTINCT me.* FROM memory_entities me
    WHERE LOWER(me.name) = ?
    UNION
    SELECT DISTINCT me.* FROM memory_entities me, json_each(me.aliases) je
    WHERE me.aliases IS NOT NULL AND LOWER(je.value) = ?
  `).all(nameLower, nameLower) as Array<typeof memoryEntities.$inferSelect>;
}

/**
 * Merge alias lists, deduplicating and excluding the canonical name.
 */
function mergeAliases(existing: string[], incoming: string[], canonicalName: string): string[] {
  const seen = new Set<string>();
  const canonicalLower = canonicalName.toLowerCase();
  const merged: string[] = [];
  for (const alias of [...existing, ...incoming]) {
    const normalizedAlias = normalizeEntityName(alias);
    if (!normalizedAlias) continue;
    const lower = normalizedAlias.toLowerCase();
    if (lower === canonicalLower) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    merged.push(normalizedAlias);
  }
  return merged;
}

function dedupeAliasList(rawAliases: string[], canonicalName: string): string[] {
  return mergeAliases([], rawAliases, canonicalName);
}

function normalizeEntityName(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = String(value).trim().slice(0, 200);
  return normalized.length > 0 ? normalized : null;
}

function normalizeEvidence(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = String(value).trim().slice(0, 500);
  return normalized.length > 0 ? normalized : null;
}
