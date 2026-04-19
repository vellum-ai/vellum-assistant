/**
 * IPC routes for the daemon-memory cache.
 *
 * Exposes set/get/delete operations so CLI commands and external processes
 * can interact with the shared in-memory cache store.
 *
 * Each operation is registered under both a slash-style method name
 * (e.g. `cache/set`) and an underscore alias (`cache_set`) for ergonomics.
 */

import { z } from "zod";

import {
  deleteCacheEntry,
  getCacheEntry,
  setCacheEntry,
} from "../../skills/skill-cache-store.js";
import type { IpcRoute } from "../cli-server.js";

// ── Param schemas ─────────────────────────────────────────────────────

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

// ── Handlers ──────────────────────────────────────────────────────────

function handleCacheSet(params?: Record<string, unknown>): { key: string } {
  const { data, key, ttl_ms } = CacheSetParams.parse(params);
  return setCacheEntry(data, { key, ttlMs: ttl_ms });
}

function handleCacheGet(
  params?: Record<string, unknown>,
): { data: unknown } | null {
  const { key } = CacheKeyParams.parse(params);
  return getCacheEntry(key);
}

function handleCacheDelete(params?: Record<string, unknown>): {
  deleted: boolean;
} {
  const { key } = CacheKeyParams.parse(params);
  const deleted = deleteCacheEntry(key);
  return { deleted };
}

// ── Route definitions ─────────────────────────────────────────────────

export const cacheSetRoute: IpcRoute = {
  method: "cache/set",
  handler: handleCacheSet,
};

export const cacheSetAliasRoute: IpcRoute = {
  method: "cache_set",
  handler: handleCacheSet,
};

export const cacheGetRoute: IpcRoute = {
  method: "cache/get",
  handler: handleCacheGet,
};

export const cacheGetAliasRoute: IpcRoute = {
  method: "cache_get",
  handler: handleCacheGet,
};

export const cacheDeleteRoute: IpcRoute = {
  method: "cache/delete",
  handler: handleCacheDelete,
};

export const cacheDeleteAliasRoute: IpcRoute = {
  method: "cache_delete",
  handler: handleCacheDelete,
};

/** All cache IPC routes (canonical + aliases). */
export const cacheRoutes: IpcRoute[] = [
  cacheSetRoute,
  cacheSetAliasRoute,
  cacheGetRoute,
  cacheGetAliasRoute,
  cacheDeleteRoute,
  cacheDeleteAliasRoute,
];
