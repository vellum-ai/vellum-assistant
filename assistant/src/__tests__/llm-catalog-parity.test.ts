import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { PROVIDER_CATALOG } from "../providers/model-catalog.js";

/**
 * Parity guard: daemon LLM provider catalog vs client LLM catalog JSON.
 *
 * The daemon maintains its canonical provider catalog in
 * `assistant/src/providers/model-catalog.ts`.
 * The client-facing metadata lives in `meta/llm-provider-catalog.json` and is
 * bundled into native clients at build time (wired up in follow-up PRs).
 *
 * These tests enforce exact structural equality between the two catalogs on
 * every field they share: provider-level metadata, per-model capabilities,
 * and pricing. CI fails when they drift, forcing the developer to update
 * whichever side fell behind.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve repo root (tests run from assistant/) */
function getRepoRoot(): string {
  return join(process.cwd(), "..");
}

interface ClientCatalogCredentialsGuide {
  description: string;
  url: string;
  linkLabel: string;
}

interface ClientCatalogModel {
  id: string;
  displayName: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
  supportsCaching?: boolean;
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  pricing?: {
    inputPer1mTokens: number;
    outputPer1mTokens: number;
    cacheWritePer1mTokens?: number;
    cacheReadPer1mTokens?: number;
  };
}

interface ClientCatalogEntry {
  id: string;
  displayName: string;
  subtitle?: string;
  setupMode?: string;
  setupHint?: string;
  envVar?: string;
  apiKeyPlaceholder?: string;
  credentialsGuide?: ClientCatalogCredentialsGuide;
  defaultModel: string;
  models: ClientCatalogModel[];
}

interface ClientCatalog {
  version: number;
  providers: ClientCatalogEntry[];
}

function loadClientCatalog(): ClientCatalog {
  const catalogPath = join(getRepoRoot(), "meta", "llm-provider-catalog.json");
  const raw = readFileSync(catalogPath, "utf-8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LLM catalog parity: daemon vs client", () => {
  // -----------------------------------------------------------------------
  // Structural sanity
  // -----------------------------------------------------------------------

  test("client catalog JSON has version 1", () => {
    const json = loadClientCatalog();
    expect(json.version).toBe(1);
  });

  test("client catalog provider count matches daemon", () => {
    const json = loadClientCatalog();
    expect(json.providers.length).toBe(PROVIDER_CATALOG.length);
  });

  // -----------------------------------------------------------------------
  // Provider-level field parity
  // -----------------------------------------------------------------------

  test("each provider's top-level fields match the daemon catalog", () => {
    const json = loadClientCatalog();

    for (let i = 0; i < PROVIDER_CATALOG.length; i++) {
      const daemonEntry = PROVIDER_CATALOG[i]!;
      const clientEntry = json.providers[i]!;

      expect(clientEntry.id).toBe(daemonEntry.id);
      expect(clientEntry.displayName).toBe(daemonEntry.displayName);
      expect(clientEntry.subtitle).toBe(daemonEntry.subtitle);
      expect(clientEntry.setupMode).toBe(daemonEntry.setupMode);
      expect(clientEntry.setupHint).toBe(daemonEntry.setupHint);
      expect(clientEntry.envVar).toBe(daemonEntry.envVar);
      expect(clientEntry.apiKeyPlaceholder).toBe(daemonEntry.apiKeyPlaceholder);
      expect(clientEntry.credentialsGuide).toEqual(
        daemonEntry.credentialsGuide,
      );
      expect(clientEntry.defaultModel).toBe(daemonEntry.defaultModel);
    }
  });

  test("each provider's model count matches the daemon catalog", () => {
    const json = loadClientCatalog();

    for (let i = 0; i < PROVIDER_CATALOG.length; i++) {
      const daemonEntry = PROVIDER_CATALOG[i]!;
      const clientEntry = json.providers[i]!;
      expect(clientEntry.models.length).toBe(daemonEntry.models.length);
    }
  });

  // -----------------------------------------------------------------------
  // Per-model field parity
  // -----------------------------------------------------------------------

  test("each model's fields match the daemon catalog", () => {
    const json = loadClientCatalog();

    for (let i = 0; i < PROVIDER_CATALOG.length; i++) {
      const daemonEntry = PROVIDER_CATALOG[i]!;
      const clientEntry = json.providers[i]!;

      for (let j = 0; j < daemonEntry.models.length; j++) {
        const daemonModel = daemonEntry.models[j]!;
        const clientModel = clientEntry.models[j]!;

        expect(clientModel.id).toBe(daemonModel.id);
        expect(clientModel.displayName).toBe(daemonModel.displayName);
        expect(clientModel.contextWindowTokens).toBe(
          daemonModel.contextWindowTokens,
        );
        expect(clientModel.maxOutputTokens).toBe(daemonModel.maxOutputTokens);
        expect(clientModel.supportsThinking).toBe(daemonModel.supportsThinking);
        expect(clientModel.supportsCaching).toBe(daemonModel.supportsCaching);
        expect(clientModel.supportsVision).toBe(daemonModel.supportsVision);
        expect(clientModel.supportsToolUse).toBe(daemonModel.supportsToolUse);
        expect(clientModel.pricing).toEqual(daemonModel.pricing);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Internal consistency
  // -----------------------------------------------------------------------

  test("every provider's defaultModel exists in its models list", () => {
    for (const entry of PROVIDER_CATALOG) {
      const found = entry.models.some((m) => m.id === entry.defaultModel);
      expect(
        found,
        `defaultModel "${entry.defaultModel}" not in models for provider "${entry.id}"`,
      ).toBe(true);
    }
  });
});
