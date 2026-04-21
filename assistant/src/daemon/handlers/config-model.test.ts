import { describe, expect, test } from "bun:test";

import { PROVIDER_CATALOG } from "../../providers/model-catalog.js";
import { projectProviderForWire } from "./config-model.js";

/**
 * Regression guard for the wire contract declared in
 * `daemon/message-types/conversations.ts#ModelInfo.allProviders`. The
 * daemon's `PROVIDER_CATALOG` carries richer metadata (capability flags,
 * pricing, subtitle, setupMode, setupHint, envVar, credentialsGuide), but
 * clients source that metadata from the bundled `LLMProviderRegistry`
 * JSON, so only the legacy fields belong on the wire. The Swift generated
 * DTO declares the same legacy-only shape and silently discards any
 * extras — this test keeps the daemon honest about what it sends.
 */
describe("projectProviderForWire", () => {
  const LEGACY_WIRE_KEYS = new Set([
    "id",
    "displayName",
    "models",
    "defaultModel",
    "apiKeyUrl",
    "apiKeyPlaceholder",
  ]);

  test("drops rich catalog fields (subtitle, setupMode, envVar, credentialsGuide, setupHint)", () => {
    for (const entry of PROVIDER_CATALOG) {
      const wire = projectProviderForWire(entry);
      const keys = Object.keys(wire);
      for (const key of keys) {
        expect(LEGACY_WIRE_KEYS.has(key)).toBe(true);
      }
      expect(keys).not.toContain("subtitle");
      expect(keys).not.toContain("setupMode");
      expect(keys).not.toContain("setupHint");
      expect(keys).not.toContain("envVar");
      expect(keys).not.toContain("credentialsGuide");
    }
  });

  test("drops rich CatalogModel fields (capability flags, pricing, context windows)", () => {
    for (const entry of PROVIDER_CATALOG) {
      const wire = projectProviderForWire(entry);
      for (const model of wire.models) {
        expect(Object.keys(model).sort()).toEqual(["displayName", "id"]);
      }
    }
  });

  test("preserves legacy wire fields exactly", () => {
    const anthropic = PROVIDER_CATALOG.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    const wire = projectProviderForWire(anthropic!);
    expect(wire.id).toBe(anthropic!.id);
    expect(wire.displayName).toBe(anthropic!.displayName);
    expect(wire.defaultModel).toBe(anthropic!.defaultModel);
    expect(wire.apiKeyUrl).toBe(anthropic!.apiKeyUrl);
    expect(wire.apiKeyPlaceholder).toBe(anthropic!.apiKeyPlaceholder);
    expect(wire.models.length).toBe(anthropic!.models.length);
  });

  test("omits apiKeyUrl/apiKeyPlaceholder when source entry has none (keyless providers)", () => {
    const ollama = PROVIDER_CATALOG.find((p) => p.id === "ollama");
    expect(ollama).toBeDefined();
    // Sanity-check the fixture: ollama is the keyless provider.
    expect(ollama!.apiKeyUrl).toBeUndefined();
    expect(ollama!.apiKeyPlaceholder).toBeUndefined();

    const wire = projectProviderForWire(ollama!);
    expect("apiKeyUrl" in wire).toBe(false);
    expect("apiKeyPlaceholder" in wire).toBe(false);
  });

  test("JSON round-trip exposes only the legacy wire keys", () => {
    for (const entry of PROVIDER_CATALOG) {
      const wire = projectProviderForWire(entry);
      const serialized = JSON.parse(JSON.stringify(wire)) as Record<
        string,
        unknown
      >;
      for (const key of Object.keys(serialized)) {
        expect(LEGACY_WIRE_KEYS.has(key)).toBe(true);
      }
    }
  });
});
