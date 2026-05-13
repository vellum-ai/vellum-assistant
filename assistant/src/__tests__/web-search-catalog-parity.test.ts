import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  SEARCH_PROVIDER_CATALOG,
  type SearchProviderCatalogEntry,
} from "../providers/search-provider-catalog.js";

/**
 * Parity guard: daemon TS catalog vs the two generated JSON copies.
 *
 * The daemon maintains its canonical search-provider catalog in
 * `assistant/src/providers/search-provider-catalog.ts`.
 * `assistant/scripts/sync-web-search-catalog.ts` writes two byte-identical
 * artifacts:
 *   - `meta/web-search-provider-catalog.json` — primary cross-package artifact.
 *   - `clients/shared/Resources/web-search-provider-catalog.json` — SwiftPM
 *     resource bundled into `VellumAssistantShared` (Swift cannot reach
 *     files outside a target's source directory).
 *
 * These tests enforce structural equality between the TS catalog and the
 * meta/ copy, plus byte equality between the meta/ copy and the SwiftPM
 * mirror. CI fails when any of the three drift.
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
const SWIFTPM_MIRROR_PATH = join(
  process.cwd(),
  "..",
  "clients/shared/Resources/web-search-provider-catalog.json",
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
  if (entry.fallbackOrder !== undefined) out.fallbackOrder = entry.fallbackOrder;
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

  test("SwiftPM mirror is byte-identical to meta/ copy", () => {
    // The generator writes both files from the same serializer; this guard
    // catches any case where one copy is regenerated without the other.
    // Byte equality is required because SwiftPM bundles the resource verbatim
    // and the meta/ JSON is consumed as a cross-package artifact.
    const metaBytes = readFileSync(META_JSON_PATH);
    const swiftPmBytes = readFileSync(SWIFTPM_MIRROR_PATH);
    expect(swiftPmBytes.equals(metaBytes)).toBe(true);
  });
});
