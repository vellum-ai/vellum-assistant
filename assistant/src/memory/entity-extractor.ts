import Anthropic from '@anthropic-ai/sdk';
import { eq, sql } from 'drizzle-orm';
import { getConfig } from '../config/loader.js';
import type { MemoryEntityConfig } from '../config/types.js';
import { getLogger } from '../util/logger.js';
import { getDb } from './db.js';
import { memoryEntities, memoryItemEntities } from './schema.js';

const log = getLogger('memory-entity-extractor');

export type EntityType =
  | 'person'
  | 'project'
  | 'tool'
  | 'company'
  | 'concept'
  | 'location'
  | 'organization';

const VALID_ENTITY_TYPES = new Set<string>([
  'person', 'project', 'tool', 'company', 'concept', 'location', 'organization',
]);

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  aliases: string[];
}

interface LLMExtractedEntity {
  name: string;
  type: string;
  aliases: string[];
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

For each entity, provide:
- name: The canonical name (proper casing, full name preferred)
- type: One of the categories above
- aliases: Array of alternate names, abbreviations, or nicknames (empty array if none)

Rules:
- Only extract concrete, named entities. Skip generic terms like "the project" or "that tool".
- Prefer the most specific and complete name as the canonical name.
- Include common abbreviations and nicknames as aliases.
- Do NOT extract the assistant itself or generic conversation participants.
- If there are no extractable entities, return an empty array.`;

export async function extractEntitiesWithLLM(
  text: string,
  entityConfig: MemoryEntityConfig,
): Promise<ExtractedEntity[]> {
  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.debug('No Anthropic API key available for entity extraction');
    return [];
  }

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
          input_schema: {
            type: 'object' as const,
            properties: {
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
            },
            required: ['entities'],
          },
        }],
        tool_choice: { type: 'tool' as const, name: 'store_entities' },
        messages: [{ role: 'user' as const, content: text }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Entity extraction LLM timeout')), 15000),
      ),
    ]);

    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      log.warn('No tool_use block in entity extraction response');
      return [];
    }

    const input = toolBlock.input as { entities?: LLMExtractedEntity[] };
    if (!Array.isArray(input.entities)) {
      log.warn('Invalid entities in entity extraction response');
      return [];
    }

    const entities: ExtractedEntity[] = [];
    for (const raw of input.entities) {
      if (!VALID_ENTITY_TYPES.has(raw.type)) continue;
      if (!raw.name || raw.name.trim().length === 0) continue;
      const name = String(raw.name).trim().slice(0, 200);
      const aliases = Array.isArray(raw.aliases)
        ? raw.aliases.map((a) => String(a).trim().slice(0, 200)).filter((a) => a.length > 0)
        : [];
      entities.push({
        name,
        type: raw.type as EntityType,
        aliases,
      });
    }

    return entities;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'Entity extraction LLM call failed');
    return [];
  }
}

/**
 * Resolve an extracted entity against existing entities in the database.
 * Returns the existing entity ID if a match is found, or null if no match.
 */
export function resolveEntity(entity: ExtractedEntity): string | null {
  const db = getDb();
  const nameLower = entity.name.toLowerCase();

  // Search by exact name match or exact alias match using json_each()
  const raw = (db as unknown as { $client: { query: (q: string) => { all: (...params: unknown[]) => unknown[] } } }).$client;
  const candidates = raw.query(`
    SELECT DISTINCT me.* FROM memory_entities me
    WHERE LOWER(me.name) = ?
    UNION
    SELECT DISTINCT me.* FROM memory_entities me, json_each(me.aliases) je
    WHERE me.aliases IS NOT NULL AND LOWER(je.value) = ?
  `).all(nameLower, nameLower) as Array<typeof memoryEntities.$inferSelect>;

  if (candidates.length === 0) {
    // Also check if any of the extracted aliases match an existing entity name
    for (const alias of entity.aliases) {
      const aliasLower = alias.toLowerCase();
      const aliasCandidates = raw.query(`
        SELECT DISTINCT me.* FROM memory_entities me
        WHERE LOWER(me.name) = ?
        UNION
        SELECT DISTINCT me.* FROM memory_entities me, json_each(me.aliases) je
        WHERE me.aliases IS NOT NULL AND LOWER(je.value) = ?
      `).all(aliasLower, aliasLower) as Array<typeof memoryEntities.$inferSelect>;
      if (aliasCandidates.length > 0) {
        // Return the first match — same type preferred
        const sameType = aliasCandidates.find((c) => c.type === entity.type);
        return sameType?.id ?? aliasCandidates[0].id;
      }
    }
    return null;
  }

  // Prefer same-type matches
  const sameType = candidates.find((c) => c.type === entity.type);
  return sameType?.id ?? candidates[0].id;
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
    // Update existing entity: bump mention count, update lastSeenAt, merge aliases
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
          aliases: JSON.stringify(mergedAliases),
        })
        .where(eq(memoryEntities.id, existingId))
        .run();
    }

    return existingId;
  }

  // Insert new entity
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
 * Link a memory item to an entity via the join table.
 */
export function linkMemoryItemToEntity(memoryItemId: string, entityId: string): void {
  const db = getDb();
  db.insert(memoryItemEntities).values({
    memoryItemId,
    entityId,
  }).onConflictDoNothing().run();
}

/**
 * Merge alias lists, deduplicating and excluding the canonical name.
 */
function mergeAliases(existing: string[], incoming: string[], canonicalName: string): string[] {
  const seen = new Set<string>();
  const canonicalLower = canonicalName.toLowerCase();
  const merged: string[] = [];
  for (const alias of [...existing, ...incoming]) {
    const lower = alias.toLowerCase();
    if (lower === canonicalLower) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    merged.push(alias);
  }
  return merged;
}
