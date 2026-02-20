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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** URL path patterns that indicate non-API noise. */
const NOISE_PATH_PATTERNS = [
  /\/web-translations\//,
  /\/cdn-cgi\//,
  /\.properties$/,
  /\.js$/,
  /\.css$/,
  /\.woff2?$/,
  /\.png$/,
  /\.jpg$/,
  /\.svg$/,
  /\.ico$/,
  /\.map$/,
  /\/preference\//,
  /\/userpreference-service\//,
];

/** Returns true when a path segment looks like a dynamic ID. */
function isIdSegment(segment: string): boolean {
  if (NUMERIC_RE.test(segment)) return true;
  if (UUID_RE.test(segment)) return true;
  if (HEX_HASH_RE.test(segment)) return true;
  if (DATE_RE.test(segment)) return true;
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

/** Extract GraphQL operation name from request body. */
function extractGraphQLOperationName(postData: string | undefined): string | null {
  if (!postData) return null;
  const body = tryParseJson(postData);
  if (!body) return null;
  if (typeof body.operationName === 'string' && body.operationName) return body.operationName;
  // Try extracting from query string: "query FooBar { ..." or "mutation FooBar { ..."
  if (typeof body.query === 'string') {
    const named = body.query.match(/(?:query|mutation|subscription)\s+(\w+)/);
    if (named) return named[1];
    // Unnamed query — extract the first field name: "query{fooBar(" or "query { fooBar {"
    const firstField = body.query.match(/(?:query|mutation|subscription)\s*\{?\s*(\w+)/);
    if (firstField) return firstField[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

interface GroupData {
  method: string;
  urlPattern: string;
  exampleUrl: string;
  queryParams: Set<string>;
  requestBodyKeys: Set<string>;
  responseStatus: Set<number>;
  responseBodyKeys: Set<string>;
  count: number;
}

export function analyzeApiMap(
  entries: NetworkRecordedEntry[],
  domain: string,
): ApiMapResult {
  const groups = new Map<string, GroupData>();

  for (const entry of entries) {
    const { request, response } = entry;
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      continue;
    }

    // Skip non-API noise
    if (NOISE_PATH_PATTERNS.some(p => p.test(parsed.pathname))) continue;

    // Skip non-JSON responses
    const mimeType = response?.mimeType ?? '';
    if (response && !mimeType.includes('json') && !mimeType.includes('graphql')) continue;

    const method = request.method.toUpperCase();
    const normalizedPath = normalizePathSegments(parsed.pathname);
    const basePattern = `${parsed.hostname}${normalizedPath}`;

    // For GraphQL endpoints, split by operation name
    let urlPattern = basePattern;
    const isGraphQL = normalizedPath.includes('graphql');
    if (isGraphQL && method === 'POST') {
      const opName = extractGraphQLOperationName(request.postData);
      if (opName) {
        urlPattern = `${basePattern} → ${opName}`;
      }
    }

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

    for (const paramKey of parsed.searchParams.keys()) {
      group.queryParams.add(paramKey);
    }

    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      const body = tryParseJson(request.postData);
      if (body) {
        for (const k of Object.keys(body)) {
          if (k !== 'query' && k !== 'operationName' && k !== 'extensions') {
            group.requestBodyKeys.add(k);
          }
        }
      }
    }

    if (response) {
      group.responseStatus.add(response.status);
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

  // Sort: data endpoints first (low count = unique pages), then boilerplate
  // Within each tier, sort alphabetically by pattern for readability
  endpoints.sort((a, b) => {
    const aIsBoilerplate = a.count > 15;
    const bIsBoilerplate = b.count > 15;
    if (aIsBoilerplate !== bIsBoilerplate) return aIsBoilerplate ? 1 : -1;
    return a.urlPattern.localeCompare(b.urlPattern);
  });

  const totalApiRequests = endpoints.reduce((sum, ep) => sum + ep.count, 0);

  return {
    domain,
    analyzedAt: Date.now(),
    totalRequests: totalApiRequests,
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
  const dataEndpoints = result.endpoints.filter(ep => ep.count <= 15);
  const boilerplate = result.endpoints.filter(ep => ep.count > 15);

  console.log(`\nAPI Map for ${result.domain} — ${result.endpoints.length} endpoints discovered\n`);

  const stripDomain = (pattern: string) => {
    const idx = pattern.indexOf('/');
    return idx >= 0 ? pattern.slice(idx) : pattern;
  };

  const printSection = (title: string, eps: ApiEndpoint[]) => {
    if (eps.length === 0) return;
    console.log(`  ${title} (${eps.length})\n`);

    const header = ['Method', 'Endpoint', 'Hits', 'Response Keys'];
    const rows = eps.map((ep) => [
      ep.method,
      stripDomain(ep.urlPattern),
      String(ep.count),
      ep.responseBodyKeys.slice(0, 5).join(', ') || '-',
    ]);

    const widths = header.map((h, i) =>
      Math.min(i === 1 ? 72 : i === 3 ? 50 : 200, Math.max(h.length, ...rows.map((r) => r[i].length))),
    );

    const sep = widths.map((w) => '-'.repeat(w)).join(' | ');
    const fmt = (row: string[]) =>
      row.map((cell, i) => cell.slice(0, widths[i]).padEnd(widths[i])).join(' | ');

    console.log(`  ${fmt(header)}`);
    console.log(`  ${sep}`);
    for (const row of rows) {
      console.log(`  ${fmt(row)}`);
    }
    console.log();
  };

  printSection('DATA ENDPOINTS', dataEndpoints);
  printSection('PAGE-LOAD BOILERPLATE', boilerplate);
}
