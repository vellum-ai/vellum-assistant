/**
 * Recording analyzer that processes NetworkRecordedEntry[] into a deduplicated
 * API map. Collapses ID-like path segments into {id} placeholders so repeated
 * calls to the same endpoint are grouped together.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDataDir } from '../../util/platform.js';
import type { NetworkRecordedEntry } from './network-recording-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiEndpoint {
  method: string;
  urlPattern: string;
  exampleUrl: string;
  queryParams: string[];
  requestBodyKeys: string[];
  responseStatus: number[];
  responseBodyKeys: string[];
  count: number;
}

export interface ApiMapResult {
  domain: string;
  analyzedAt: number;
  totalRequests: number;
  endpoints: ApiEndpoint[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const HEX_HASH_RE = /^[0-9a-f]{8,}$/i;

/** Returns true when a path segment looks like a dynamic ID. */
function isIdSegment(segment: string): boolean {
  if (NUMERIC_RE.test(segment)) return true;
  if (UUID_RE.test(segment)) return true;
  if (HEX_HASH_RE.test(segment)) return true;
  return false;
}

/** Replace ID-like path segments with `{id}`. */
function normalizePathSegments(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => (isIdSegment(seg) ? '{id}' : seg))
    .join('/');
}

/** Safely parse JSON, returning undefined on failure. */
function tryParseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

export function analyzeApiMap(
  entries: NetworkRecordedEntry[],
  domain: string,
): ApiMapResult {
  const groups = new Map<
    string,
    {
      method: string;
      urlPattern: string;
      exampleUrl: string;
      queryParams: Set<string>;
      requestBodyKeys: Set<string>;
      responseStatus: Set<number>;
      responseBodyKeys: Set<string>;
      count: number;
    }
  >();

  for (const entry of entries) {
    const { request, response } = entry;
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      continue; // skip malformed URLs
    }

    const method = request.method.toUpperCase();
    const urlPattern = normalizePathSegments(parsed.pathname);
    const key = `${method} ${urlPattern}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        method,
        urlPattern,
        exampleUrl: request.url,
        queryParams: new Set(),
        requestBodyKeys: new Set(),
        responseStatus: new Set(),
        responseBodyKeys: new Set(),
        count: 0,
      };
      groups.set(key, group);
    }

    group.count++;

    // Collect query param keys
    for (const paramKey of parsed.searchParams.keys()) {
      group.queryParams.add(paramKey);
    }

    // Request body keys (POST/PUT/PATCH)
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      const body = tryParseJson(request.postData);
      if (body) {
        for (const k of Object.keys(body)) {
          group.requestBodyKeys.add(k);
        }
      }
    }

    // Response status
    if (response) {
      group.responseStatus.add(response.status);

      // Response body keys
      const resBody = tryParseJson(response.body);
      if (resBody) {
        for (const k of Object.keys(resBody)) {
          group.responseBodyKeys.add(k);
        }
      }
    }
  }

  const endpoints: ApiEndpoint[] = Array.from(groups.values()).map((g) => ({
    method: g.method,
    urlPattern: g.urlPattern,
    exampleUrl: g.exampleUrl,
    queryParams: Array.from(g.queryParams).sort(),
    requestBodyKeys: Array.from(g.requestBodyKeys).sort(),
    responseStatus: Array.from(g.responseStatus).sort((a, b) => a - b),
    responseBodyKeys: Array.from(g.responseBodyKeys).sort(),
    count: g.count,
  }));

  // Sort by count descending, then by urlPattern for stability
  endpoints.sort((a, b) => b.count - a.count || a.urlPattern.localeCompare(b.urlPattern));

  return {
    domain,
    analyzedAt: Date.now(),
    totalRequests: entries.length,
    endpoints,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function saveApiMap(domain: string, result: ApiMapResult): string {
  const dir = join(getDataDir(), 'api-maps');
  mkdirSync(dir, { recursive: true });

  const timestamp = Date.now();
  const filePath = join(dir, `${domain}-${timestamp}.json`);
  writeFileSync(filePath, JSON.stringify(result, null, 2));
  return filePath;
}

// ---------------------------------------------------------------------------
// Pretty-print
// ---------------------------------------------------------------------------

export function printApiMapTable(result: ApiMapResult): void {
  console.log(`\nAPI Map for ${result.domain} — ${result.totalRequests} total requests, ${result.endpoints.length} unique endpoints\n`);

  const header = ['Method', 'URL Pattern', 'Count', 'Status', 'Query Params'];
  const rows = result.endpoints.map((ep) => [
    ep.method,
    ep.urlPattern,
    String(ep.count),
    ep.responseStatus.join(',') || '-',
    ep.queryParams.join(',') || '-',
  ]);

  // Calculate column widths
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  const sep = widths.map((w) => '-'.repeat(w)).join(' | ');
  const fmt = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join(' | ');

  console.log(fmt(header));
  console.log(sep);
  for (const row of rows) {
    console.log(fmt(row));
  }
  console.log();
}
