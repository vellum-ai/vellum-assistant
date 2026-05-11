#!/usr/bin/env bun
/**
 * Generate `meta/llm-provider-catalog.json` from the canonical
 * `PROVIDER_CATALOG` in `assistant/src/providers/model-catalog.ts`.
 *
 * The JSON file is the client-facing catalog bundled into native clients
 * (macOS, web). Keeping it generated — rather than hand-mirrored — eliminates
 * the recurring "I edited model-catalog.ts and forgot the JSON" failure mode
 * that the parity test only catches after push.
 *
 * The projection drops daemon-only fields (today: `apiKeyUrl`, which clients
 * read from `credentialsGuide.url` instead) and pins field order so the
 * diff stays minimal when models or providers change.
 *
 * Usage:
 *   cd assistant && bun run scripts/sync-llm-catalog.ts
 *   cd assistant && bun run sync:llm-catalog              # via npm script
 *   cd assistant && bun run sync:llm-catalog -- --check   # CI: fail if stale
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  type CatalogModel,
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
} from "../src/providers/model-catalog.js";

const ROOT = resolve(import.meta.dir, "../..");
const OUTPUT_PATH = join(ROOT, "meta/llm-provider-catalog.json");

/**
 * Bumped when the *shape* of the client catalog JSON changes in a way native
 * clients must opt into. Adding fields that older clients can ignore does
 * NOT require a bump.
 */
const CLIENT_CATALOG_VERSION = 1;

// ---------------------------------------------------------------------------
// Projection
//
// Each helper pins explicit field order so JSON.stringify produces a stable
// diff. Optional fields are omitted (not serialized as null) when undefined.
// ---------------------------------------------------------------------------

function projectModel(model: CatalogModel): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    id: model.id,
    displayName: model.displayName,
  };
  if (model.contextWindowTokens !== undefined)
    projected.contextWindowTokens = model.contextWindowTokens;
  if (model.maxOutputTokens !== undefined)
    projected.maxOutputTokens = model.maxOutputTokens;
  if (model.defaultContextWindowTokens !== undefined)
    projected.defaultContextWindowTokens = model.defaultContextWindowTokens;
  if (model.longContextPricingThresholdTokens !== undefined)
    projected.longContextPricingThresholdTokens =
      model.longContextPricingThresholdTokens;
  if (model.longContextMode !== undefined)
    projected.longContextMode = model.longContextMode;
  if (model.supportsThinking !== undefined)
    projected.supportsThinking = model.supportsThinking;
  if (model.supportsCaching !== undefined)
    projected.supportsCaching = model.supportsCaching;
  if (model.supportsVision !== undefined)
    projected.supportsVision = model.supportsVision;
  if (model.supportsToolUse !== undefined)
    projected.supportsToolUse = model.supportsToolUse;
  if (model.pricing !== undefined) projected.pricing = model.pricing;
  return projected;
}

function projectProvider(entry: ProviderCatalogEntry): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    id: entry.id,
    displayName: entry.displayName,
  };
  if (entry.subtitle !== undefined) projected.subtitle = entry.subtitle;
  if (entry.setupMode !== undefined) projected.setupMode = entry.setupMode;
  if (entry.setupHint !== undefined) projected.setupHint = entry.setupHint;
  if (entry.envVar !== undefined) projected.envVar = entry.envVar;
  if (entry.apiKeyPlaceholder !== undefined)
    projected.apiKeyPlaceholder = entry.apiKeyPlaceholder;
  if (entry.credentialsGuide !== undefined)
    projected.credentialsGuide = entry.credentialsGuide;
  projected.defaultModel = entry.defaultModel;
  projected.models = entry.models.map(projectModel);
  // NOTE: `apiKeyUrl` intentionally omitted — clients use
  // `credentialsGuide.url` instead. Daemon callers still read it from
  // PROVIDER_CATALOG directly.
  return projected;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const isCheck = process.argv.includes("--check");

  const generated = {
    version: CLIENT_CATALOG_VERSION,
    providers: PROVIDER_CATALOG.map(projectProvider),
  };

  // 2-space indent + trailing newline matches the existing format.
  const output = JSON.stringify(generated, null, 2) + "\n";

  if (isCheck) {
    let existing: string;
    try {
      existing = await readFile(OUTPUT_PATH, "utf-8");
    } catch {
      console.error(
        "meta/llm-provider-catalog.json does not exist. Run: bun run sync:llm-catalog",
      );
      process.exit(1);
    }
    if (existing !== output) {
      console.error(
        "meta/llm-provider-catalog.json is stale. Run: bun run sync:llm-catalog",
      );
      process.exit(1);
    }
    console.log("meta/llm-provider-catalog.json is up to date.");
    return;
  }

  await writeFile(OUTPUT_PATH, output);

  const modelCount = generated.providers.reduce(
    (n, p) => n + (p.models as unknown[]).length,
    0,
  );
  console.log(`Generated ${OUTPUT_PATH}`);
  console.log(
    `  ${generated.providers.length} providers, ${modelCount} models`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
