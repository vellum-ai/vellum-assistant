#!/usr/bin/env bun
/**
 * Generate `llm-provider-catalog.json` from the canonical
 * `PROVIDER_CATALOG` in `assistant/src/providers/model-catalog.ts`.
 *
 * The JSON file is the client-facing catalog bundled into native clients
 * (macOS, web). Keeping it generated — rather than hand-mirrored — eliminates
 * the recurring "I edited model-catalog.ts and forgot the JSON" failure mode
 * that the parity test only catches after push.
 *
 * Two byte-identical copies are written:
 *   - `meta/llm-provider-catalog.json` — primary checked-in artifact, read
 *      by web codegen (§D) and any non-Swift consumer.
 *   - `clients/shared/Resources/llm-provider-catalog.json` — SwiftPM resource
 *      bundled into `VellumAssistantShared`. SwiftPM cannot reach files
 *      outside a target's source directory, so this mirror is necessary;
 *      both files are produced by the same generator and asserted equal by
 *      the parity test, making drift impossible.
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
import { join, relative, resolve } from "node:path";

import {
  type CatalogModel,
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
} from "../src/providers/model-catalog.js";

const ROOT = resolve(import.meta.dir, "../..");
const OUTPUT_PATHS = [
  join(ROOT, "meta/llm-provider-catalog.json"),
  join(ROOT, "clients/shared/Resources/llm-provider-catalog.json"),
] as const;

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
  if (model.adaptiveThinkingOnly !== undefined)
    projected.adaptiveThinkingOnly = model.adaptiveThinkingOnly;
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
  if (entry.supportsPlatformAuth !== undefined)
    projected.supportsPlatformAuth = entry.supportsPlatformAuth;
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
    let anyStale = false;
    for (const path of OUTPUT_PATHS) {
      const rel = relative(ROOT, path);
      let existing: string;
      try {
        existing = await readFile(path, "utf-8");
      } catch {
        console.error(`${rel} does not exist. Run: bun run sync:llm-catalog`);
        anyStale = true;
        continue;
      }
      if (existing !== output) {
        console.error(`${rel} is stale. Run: bun run sync:llm-catalog`);
        anyStale = true;
        continue;
      }
      console.log(`${rel} is up to date.`);
    }
    if (anyStale) process.exit(1);
    return;
  }

  for (const path of OUTPUT_PATHS) {
    await writeFile(path, output);
    console.log(`Generated ${relative(ROOT, path)}`);
  }

  const modelCount = generated.providers.reduce(
    (n, p) => n + (p.models as unknown[]).length,
    0,
  );
  console.log(
    `  ${generated.providers.length} providers, ${modelCount} models`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
