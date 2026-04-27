/**
 * Transport-agnostic routes for the daemon-memory cache.
 *
 * Exposes set/get/delete operations so CLI commands and external processes
 * can interact with the shared in-memory cache store.
 */

import { z } from "zod";

import {
  deleteCacheEntry,
  getCacheEntry,
  setCacheEntry,
} from "../../skills/skill-cache-store.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Handlers ──────────────────────────────────────────────────────────

const CacheSetParams = z.object({
  data: z.unknown().refine((v) => v !== undefined, {
    message: "data is required",
  }),
  key: z.string().min(1).optional(),
  ttl_ms: z.number().int().positive().optional(),
});

const CacheKeyParams = z.object({
  key: z.string().min(1),
});

function handleCacheSet({ body = {} }: RouteHandlerArgs): { key: string } {
  const { data, key, ttl_ms } = CacheSetParams.parse(body);
  return setCacheEntry(data, { key, ttlMs: ttl_ms });
}

function handleCacheGet(
  { body = {} }: RouteHandlerArgs,
): { data: unknown } | null {
  const { key } = CacheKeyParams.parse(body);
  return getCacheEntry(key);
}

function handleCacheDelete({ body = {} }: RouteHandlerArgs): {
  deleted: boolean;
} {
  const { key } = CacheKeyParams.parse(body);
  const deleted = deleteCacheEntry(key);
  return { deleted };
}

// ── Routes ────────────────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "cache_set",
    endpoint: "cache/set",
    method: "POST",
    handler: handleCacheSet,
    summary: "Set a cache entry",
    description:
      "Store a value in the daemon's in-memory cache, optionally with a TTL.",
    tags: ["cache"],
    requestBody: CacheSetParams,
    responseBody: z.object({
      key: z.string(),
    }),
  },
  {
    operationId: "cache_get",
    endpoint: "cache/get",
    method: "POST",
    handler: handleCacheGet,
    summary: "Get a cache entry",
    description: "Retrieve a cached value by key. Returns null if not found.",
    tags: ["cache"],
    requestBody: CacheKeyParams,
    responseBody: z
      .object({
        data: z.unknown(),
      })
      .nullable(),
  },
  {
    operationId: "cache_delete",
    endpoint: "cache/delete",
    method: "POST",
    handler: handleCacheDelete,
    summary: "Delete a cache entry",
    description: "Remove a cached value by key.",
    tags: ["cache"],
    requestBody: CacheKeyParams,
    responseBody: z.object({
      deleted: z.boolean(),
    }),
  },
];
