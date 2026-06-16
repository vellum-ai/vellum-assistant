import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  SEARCH_PROVIDER_CATALOG,
  type SearchProviderCatalogEntry,
} from "../providers/search-provider-catalog.js";

/**
 * Parity guard: daemon TS catalog vs the generated JSON copy.
 *
 * The daemon maintains its canonical search-provider catalog in
 * `assistant/src/providers/search-provider-catalog.ts`.
 * `assistant/scripts/sync-web-search-catalog.ts` writes
 * `meta/web-search-provider-catalog.json` — the primary cross-package artifact.
 *
 * These tests enforce structural equality between the TS catalog and the
 * meta/ copy. CI fails when they drift.
 */

interface JsonCatalogEntry {
  id: string;
  displayName: string;
  displayNameLong?: string;
  kind: "managed" | "byok";
  apiKeyPrefix?: string;
  envVar?: string;
  secretKey?: string;
  fallbackOrder?: number;
  privacyPolicyUrl?: string;
}

interface JsonCatalog {
  version: number;
  providers: JsonCatalogEntry[];
}

const META_JSON_PATH = join(
  process.cwd(),
  "..",
  "meta/web-search-provider-catalog.json",
);

function loadJsonCatalog(): JsonCatalog {
  return JSON.parse(readFileSync(META_JSON_PATH, "utf-8"));
}

function entryToPlain(
  entry: SearchProviderCatalogEntry,
): Record<string, unknown> {
  // Project the TS entry into the same shape the JSON serializer emits:
  // field order matches `sync-web-search-catalog.ts`, optional fields are
  // omitted (not serialized as undefined).
  const out: Record<string, unknown> = {
    id: entry.id,
    displayName: entry.displayName,
  };
  if (entry.displayNameLong !== undefined) {
    out.displayNameLong = entry.displayNameLong;
  }
  out.kind = entry.kind;
  if (entry.apiKeyPrefix !== undefined) out.apiKeyPrefix = entry.apiKeyPrefix;
  if (entry.envVar !== undefined) out.envVar = entry.envVar;
  if (entry.secretKey !== undefined) out.secretKey = entry.secretKey;
  if (entry.fallbackOrder !== undefined)
    out.fallbackOrder = entry.fallbackOrder;
  if (entry.privacyPolicyUrl !== undefined) {
    out.privacyPolicyUrl = entry.privacyPolicyUrl;
  }
  return out;
}

describe("web-search catalog parity (TS canonical vs meta/ JSON)", () => {
  test("provider list and metadata match exactly", () => {
    const json = loadJsonCatalog();
    const expected = SEARCH_PROVIDER_CATALOG.map(
      entryToPlain,
    ) as unknown as JsonCatalogEntry[];
    expect(json.providers).toEqual(expected);
  });

  test("provider order matches declaration order", () => {
    const json = loadJsonCatalog();
    expect(json.providers.map((p) => p.id)).toEqual(
      SEARCH_PROVIDER_CATALOG.map((p) => p.id),
    );
  });
});
