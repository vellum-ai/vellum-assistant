import { z } from "zod";

import {
  findPkbEntities,
  listPkbPreferences,
  listRecentPkbEpisodes,
} from "../../memory/personal-knowledge-store.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const EntitiesQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const EpisodesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const PreferencesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

function handlePkbEntities({ queryParams = {} }: RouteHandlerArgs) {
  const query = EntitiesQuerySchema.parse(queryParams);
  return {
    entries: findPkbEntities({
      query: query.query,
      ...(query.limit ? { limit: query.limit } : {}),
    }),
  };
}

function handlePkbEpisodes({ queryParams = {} }: RouteHandlerArgs) {
  const query = EpisodesQuerySchema.parse(queryParams);
  return {
    entries: listRecentPkbEpisodes({
      ...(query.limit ? { limit: query.limit } : {}),
    }),
  };
}

function handlePkbPreferences({ queryParams = {} }: RouteHandlerArgs) {
  const query = PreferencesQuerySchema.parse(queryParams);
  return {
    entries: listPkbPreferences({
      ...(query.limit ? { limit: query.limit } : {}),
    }),
  };
}

const PkbEntitySchema = z.object({
  id: z.string(),
  scopeId: z.string(),
  entityType: z.string(),
  canonicalName: z.string(),
  aliasesJson: z.string(),
  attributesJson: z.string(),
  confidence: z.number(),
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const PkbEpisodeSchema = z.object({
  id: z.string(),
  scopeId: z.string(),
  entityId: z.string().nullable(),
  summary: z.string(),
  detailsJson: z.string(),
  happenedAt: z.number(),
  salience: z.number(),
  sourceConversationId: z.string().nullable(),
  createdAt: z.number(),
});

const PkbPreferenceSchema = z.object({
  id: z.string(),
  scopeId: z.string(),
  key: z.string(),
  value: z.string(),
  confidence: z.number(),
  learnedFrom: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "personal_knowledge_entities",
    endpoint: "personal-knowledge/entities",
    method: "GET",
    summary: "Search personal knowledge entities",
    description:
      "Search entity records learned from perception and conversations.",
    tags: ["memory", "personal-knowledge"],
    queryParams: [
      {
        name: "query",
        type: "string",
        required: true,
        description: "Case-insensitive search string for names and aliases.",
      },
      {
        name: "limit",
        type: "integer",
        description: "Maximum number of entities to return (default 10).",
      },
    ],
    responseBody: z.object({ entries: z.array(PkbEntitySchema) }),
    handler: handlePkbEntities,
  },
  {
    operationId: "personal_knowledge_episodes",
    endpoint: "personal-knowledge/episodes",
    method: "GET",
    summary: "List recent personal knowledge episodes",
    description:
      "Return most recent episodic memory entries written by the PKB writer.",
    tags: ["memory", "personal-knowledge"],
    queryParams: [
      {
        name: "limit",
        type: "integer",
        description: "Maximum number of episodes to return (default 20).",
      },
    ],
    responseBody: z.object({ entries: z.array(PkbEpisodeSchema) }),
    handler: handlePkbEpisodes,
  },
  {
    operationId: "personal_knowledge_preferences",
    endpoint: "personal-knowledge/preferences",
    method: "GET",
    summary: "List learned preference signals",
    description:
      "Return implicit preference records inferred from recurring behavior.",
    tags: ["memory", "personal-knowledge"],
    queryParams: [
      {
        name: "limit",
        type: "integer",
        description: "Maximum number of preferences to return (default 50).",
      },
    ],
    responseBody: z.object({ entries: z.array(PkbPreferenceSchema) }),
    handler: handlePkbPreferences,
  },
];
