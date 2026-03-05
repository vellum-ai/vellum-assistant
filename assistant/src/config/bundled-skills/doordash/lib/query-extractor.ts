/**
 * Extracts GraphQL queries from a session recording and persists them
 * to disk so the DoorDash client can use real, captured queries instead
 * of stale static fallbacks.
 *
 * Captured queries are saved to ~/.vellum/workspace/data/doordash/captured-queries.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDataDir } from "./shared/platform.js";
import type { SessionRecording } from "./shared/recording-types.js";

export interface CapturedQuery {
  operationName: string;
  query: string;
  exampleVariables: unknown;
  capturedAt: number;
}

function getCapturedQueriesPath(): string {
  return join(getDataDir(), "doordash", "captured-queries.json");
}

/**
 * Extract GraphQL queries from a session recording's network entries.
 * Filters for /graphql/ URLs, parses postData, deduplicates by operation name
 * (keeps last occurrence).
 */
export function extractQueries(recording: SessionRecording): CapturedQuery[] {
  const byName = new Map<string, CapturedQuery>();

  for (const entry of recording.networkEntries) {
    const url = entry.request.url;
    if (!url.includes("/graphql/") && !url.includes("/graphql?")) continue;
    if (!entry.request.postData) continue;

    try {
      const body = JSON.parse(entry.request.postData) as {
        operationName?: string;
        query?: string;
        variables?: unknown;
      };

      if (!body.operationName || !body.query) continue;

      byName.set(body.operationName, {
        operationName: body.operationName,
        query: body.query,
        exampleVariables: body.variables ?? null,
        capturedAt: entry.timestamp,
      });
    } catch {
      // Skip entries with unparseable postData
    }
  }

  return Array.from(byName.values());
}

/**
 * Merge new captured queries with existing ones on disk (newer wins),
 * then write to disk.
 */
export function saveQueries(queries: CapturedQuery[]): string {
  const existing = loadCapturedQueries();

  for (const q of queries) {
    const prev = existing[q.operationName];
    if (!prev || q.capturedAt >= prev.capturedAt) {
      existing[q.operationName] = q;
    }
  }

  const filePath = getCapturedQueriesPath();
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
  return filePath;
}

/**
 * Load captured queries from disk. Returns a map keyed by operation name.
 */
export function loadCapturedQueries(): Record<string, CapturedQuery> {
  const filePath = getCapturedQueriesPath();
  if (!existsSync(filePath)) return {};
  try {
    const data = readFileSync(filePath, "utf-8");
    return JSON.parse(data) as Record<string, CapturedQuery>;
  } catch {
    return {};
  }
}
