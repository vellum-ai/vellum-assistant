/**
 * Route handler for the unified global search endpoint.
 *
 * GET /v1/search/global?q=<query>&limit=20&categories=conversations,memories,schedules,contacts[&deep=true]
 *
 * Federates search across conversations, memories, schedules, and contacts.
 * When `deep=true`, additionally runs Qdrant semantic search on memories
 * and merges results with lexical matches.
 */

import { searchContacts } from "../../contacts/contact-store.js";
import { searchConversations } from "../../memory/conversation-queries.js";
import { rawAll } from "../../memory/raw-query.js";
import { listSchedules } from "../../schedule/schedule-store.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GlobalSearchConversation {
  id: string;
  title: string | null;
  updatedAt: number;
  excerpt: string;
  matchCount: number;
}

interface GlobalSearchMemory {
  id: string;
  kind: string;
  text: string;
  subject: string | null;
  confidence: number;
  updatedAt: number;
  source: "lexical" | "semantic";
}

interface GlobalSearchSchedule {
  id: string;
  name: string;
  expression: string | null;
  message: string;
  enabled: boolean;
  nextRunAt: number | null;
}

interface GlobalSearchContact {
  id: string;
  displayName: string;
  notes: string | null;
  lastInteraction: number | null;
}

export interface GlobalSearchResponse {
  query: string;
  results: {
    conversations: GlobalSearchConversation[];
    memories: GlobalSearchMemory[];
    schedules: GlobalSearchSchedule[];
    contacts: GlobalSearchContact[];
  };
}

// ---------------------------------------------------------------------------
// Category search helpers
// ---------------------------------------------------------------------------

const ALL_CATEGORIES = [
  "conversations",
  "memories",
  "schedules",
  "contacts",
] as const;
type Category = (typeof ALL_CATEGORIES)[number];

function parseCategories(raw: string | null): Set<Category> {
  if (!raw) return new Set(ALL_CATEGORIES);
  const requested = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Category => ALL_CATEGORIES.includes(s as Category));
  return requested.length > 0 ? new Set(requested) : new Set(ALL_CATEGORIES);
}

function searchMemoryItems(query: string, limit: number): GlobalSearchMemory[] {
  const likePattern = `%${query.replace(/%/g, "").replace(/_/g, "")}%`;

  interface MemoryRow {
    id: string;
    kind: string;
    statement: string;
    subject: string;
    confidence: number;
    last_seen_at: number;
  }

  // Search on both statement and subject for broader recall
  const rows = rawAll<MemoryRow>(
    `SELECT id, kind, statement, subject, confidence, last_seen_at
     FROM memory_items
     WHERE (statement LIKE ? OR subject LIKE ?) AND status = 'active'
     ORDER BY last_seen_at DESC
     LIMIT ?`,
    likePattern,
    likePattern,
    limit,
  );

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    text: r.statement,
    subject: r.subject || null,
    confidence: r.confidence,
    updatedAt: r.last_seen_at,
    source: "lexical" as const,
  }));
}

function searchScheduleJobs(
  query: string,
  limit: number,
): GlobalSearchSchedule[] {
  const all = listSchedules();
  const q = query.toLowerCase();
  const matched = all.filter(
    (s) =>
      s.name.toLowerCase().includes(q) || s.message.toLowerCase().includes(q),
  );
  return matched.slice(0, limit).map((s) => ({
    id: s.id,
    name: s.name,
    expression: s.expression,
    message: s.message,
    enabled: s.enabled,
    nextRunAt: s.enabled ? s.nextRunAt : null,
  }));
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleGlobalSearch(url: URL): Promise<Response> {
  const query = url.searchParams.get("q") ?? "";
  if (!query.trim()) {
    return httpError("BAD_REQUEST", "q query parameter is required", 400);
  }

  const limit = Math.max(
    1,
    Math.min(Number(url.searchParams.get("limit") ?? 20), 100),
  );
  const categories = parseCategories(url.searchParams.get("categories"));

  const results: GlobalSearchResponse["results"] = {
    conversations: [],
    memories: [],
    schedules: [],
    contacts: [],
  };

  if (categories.has("conversations")) {
    const convResults = searchConversations(query, {
      limit,
      maxMessagesPerConversation: 1,
    });
    results.conversations = convResults.map((c) => ({
      id: c.conversationId,
      title: c.conversationTitle,
      updatedAt: c.conversationUpdatedAt,
      excerpt: c.matchingMessages[0]?.excerpt ?? "",
      matchCount: c.matchingMessages.length,
    }));
  }

  if (categories.has("memories")) {
    results.memories = searchMemoryItems(query, limit);

  }

  if (categories.has("schedules")) {
    results.schedules = searchScheduleJobs(query, limit);
  }

  if (categories.has("contacts")) {
    const contactResults = searchContacts({
      query,
      limit,
    });
    results.contacts = contactResults.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      notes: c.notes,
      lastInteraction: c.lastInteraction,
    }));
  }

  const response: GlobalSearchResponse = { query, results };
  return Response.json(response);
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function globalSearchRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "search/global",
      method: "GET",
      handler: async ({ url }) => handleGlobalSearch(url),
    },
  ];
}
