/**
 * Route handler for the unified global search endpoint.
 *
 * GET /v1/search/global?q=<query>&limit=20&categories=conversations,memories,schedules,contacts[&deep=true]
 *
 * Federates search across conversations, memories, schedules, and contacts.
 * When `deep=true`, additionally runs Qdrant semantic search on memories
 * and merges results with lexical matches.
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { searchContacts } from "../../contacts/contact-store.js";
import { searchConversations } from "../../memory/conversation-queries.js";
import {
  embedWithBackend,
  getMemoryBackendStatus,
} from "../../memory/embedding-backend.js";
import { rawAll } from "../../memory/raw-query.js";
import { semanticSearch } from "../../memory/search/semantic.js";
import { listSchedules } from "../../schedule/schedule-store.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("global-search");

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
    type: string;
    content: string;
    confidence: number;
    last_accessed: number;
  }

  const rows = rawAll<MemoryRow>(
    `SELECT id, type, content, confidence, last_accessed
     FROM memory_graph_nodes
     WHERE content LIKE ? AND fidelity != 'gone'
     ORDER BY last_accessed DESC
     LIMIT ?`,
    likePattern,
    limit,
  );

  return rows.map((r) => {
    const nl = r.content.indexOf("\n");
    const subject = nl >= 0 ? r.content.slice(0, nl) : r.content;
    const statement = nl >= 0 ? r.content.slice(nl + 1) : r.content;
    return {
      id: r.id,
      kind: r.type,
      text: statement,
      subject: subject || null,
      confidence: r.confidence,
      updatedAt: r.last_accessed,
      source: "lexical" as const,
    };
  });
}

async function searchMemoriesSemantic(
  query: string,
  limit: number,
  existingIds: Set<string>,
): Promise<GlobalSearchMemory[]> {
  const config = getConfig();
  const backendStatus = await getMemoryBackendStatus(config);
  if (!backendStatus.provider) return [];

  try {
    const embedded = await embedWithBackend(config, [query]);
    const queryVector = embedded.vectors[0];
    if (!queryVector) return [];

    const candidates = await semanticSearch(
      queryVector,
      embedded.provider,
      embedded.model,
      limit,
    );

    // Only include item-type candidates (not segments/summaries) for cleaner results
    const results: GlobalSearchMemory[] = [];
    for (const c of candidates) {
      if (c.type !== "item") continue;
      if (existingIds.has(c.id)) continue;
      results.push({
        id: c.id,
        kind: c.kind,
        text: c.text,
        subject: null,
        confidence: c.confidence,
        updatedAt: c.createdAt,
        source: "semantic",
      });
    }
    return results;
  } catch (err) {
    log.warn({ err }, "Deep semantic search failed, returning lexical only");
    return [];
  }
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
  const deep = url.searchParams.get("deep") === "true";

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

    if (deep) {
      const existingIds = new Set(results.memories.map((m) => m.id));
      const semanticResults = await searchMemoriesSemantic(
        query,
        limit,
        existingIds,
      );
      results.memories = [...results.memories, ...semanticResults];
    }
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
      summary: "Global search",
      description:
        "Federated search across conversations, memories, schedules, and contacts.",
      tags: ["search"],
      queryParams: [
        {
          name: "q",
          schema: { type: "string" },
          description: "Search query (required)",
        },
        {
          name: "limit",
          schema: { type: "integer" },
          description: "Max results per category (1–100, default 20)",
        },
        {
          name: "categories",
          schema: { type: "string" },
          description: "Comma-separated categories to search",
        },
        {
          name: "deep",
          schema: { type: "string" },
          description: "Enable semantic search for memories (true/false)",
        },
      ],
      responseBody: z.object({
        query: z.string(),
        results: z
          .object({})
          .passthrough()
          .describe("Results grouped by category"),
      }),
      handler: async ({ url }) => handleGlobalSearch(url),
    },
  ];
}
