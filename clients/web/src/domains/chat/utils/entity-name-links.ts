/**
 * Unique conversation titles and schedule names that assistant-authored
 * markdown may turn into in-app links. A name is eligible only when it is
 * long enough and appears once across both catalogs: collisions stay plain
 * text rather than guessing which destination the author meant.
 */

import type { Conversation } from "@/types/conversation-types";
import type { AssistantSchedule } from "@/utils/schedules";

/** Custom tag emitted by `rehypeEntityName` for a resolved name span. */
export const ENTITY_NAME_TAG = "entity-name";

/** Short tokens like "Chat" or "Q3" are too common to claim as a title. */
export const MIN_ENTITY_NAME_LENGTH = 4;

export type EntityNameKind = "conversation" | "schedule";

export interface EntityNameEntry {
  kind: EntityNameKind;
  id: string;
  name: string;
}

export interface EntityNameCatalog {
  /** Unique names, longest first, so overlapping titles prefer the longer. */
  names: readonly string[];
  byName: ReadonlyMap<string, EntityNameEntry>;
}

export const EMPTY_ENTITY_NAME_CATALOG: EntityNameCatalog = {
  names: [],
  byName: new Map(),
};

export interface EntityNameHit {
  start: number;
  end: number;
  name: string;
}

function considerName(
  raw: string | undefined,
  entry: EntityNameEntry,
  counts: Map<string, number>,
  first: Map<string, EntityNameEntry>,
): void {
  const name = raw?.trim() ?? "";
  if (name.length < MIN_ENTITY_NAME_LENGTH) {
    return;
  }
  counts.set(name, (counts.get(name) ?? 0) + 1);
  if (!first.has(name)) {
    first.set(name, { ...entry, name });
  }
}

export function buildEntityNameCatalog(input: {
  conversations: readonly Pick<Conversation, "conversationId" | "title">[];
  schedules: readonly Pick<AssistantSchedule, "id" | "name">[];
}): EntityNameCatalog {
  const counts = new Map<string, number>();
  const first = new Map<string, EntityNameEntry>();

  for (const conversation of input.conversations) {
    considerName(
      conversation.title,
      {
        kind: "conversation",
        id: conversation.conversationId,
        name: conversation.title ?? "",
      },
      counts,
      first,
    );
  }
  for (const schedule of input.schedules) {
    considerName(
      schedule.name,
      { kind: "schedule", id: schedule.id, name: schedule.name },
      counts,
      first,
    );
  }

  const byName = new Map<string, EntityNameEntry>();
  for (const [name, count] of counts) {
    if (count !== 1) {
      continue;
    }
    const entry = first.get(name);
    if (entry) {
      byName.set(name, entry);
    }
  }

  const names = [...byName.keys()].sort((left, right) => {
    if (right.length !== left.length) {
      return right.length - left.length;
    }
    return left.localeCompare(right);
  });

  return { names, byName };
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

function isBounded(text: string, start: number, end: number): boolean {
  const left = start === 0 || !isWordChar(text.charAt(start - 1));
  const right = end === text.length || !isWordChar(text.charAt(end));
  return left && right;
}

/**
 * Exact unique-name hits in `text`, longest-first at each index, respecting
 * unicode letter/number boundaries so "Brief" does not fire inside "Briefing".
 */
export function findEntityNameMatches(
  text: string,
  catalog: EntityNameCatalog,
): EntityNameHit[] {
  if (catalog.names.length === 0 || text.length === 0) {
    return [];
  }
  const hits: EntityNameHit[] = [];
  let index = 0;
  while (index < text.length) {
    let found: EntityNameHit | null = null;
    for (const name of catalog.names) {
      if (index + name.length > text.length) {
        continue;
      }
      if (
        text.startsWith(name, index) &&
        isBounded(text, index, index + name.length)
      ) {
        found = { start: index, end: index + name.length, name };
        break;
      }
    }
    if (found) {
      hits.push(found);
      index = found.end;
    } else {
      index += 1;
    }
  }
  return hits;
}

export function lookupEntityName(
  text: string,
  catalog: EntityNameCatalog,
): EntityNameEntry | undefined {
  return catalog.byName.get(text) ?? catalog.byName.get(text.trim());
}
