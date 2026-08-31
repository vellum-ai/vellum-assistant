/**
 * Invariants behind `LlmCatalogModel.vendor`, which is what names a section of
 * the model picker. Getting it wrong files a model under a gateway rather than
 * under the organisation that made it, which is the state this field exists to
 * end: someone looking for Grok looks under xAI, not under whichever router
 * the catalog happens to list first.
 */

import { describe, expect, test } from "bun:test";

import {
  MODELS_BY_PROVIDER,
  vendorDisplayName,
} from "@/assistant/llm-model-catalog";

const entries = Object.entries(MODELS_BY_PROVIDER) as [
  string,
  readonly {
    id: string;
    displayName: string;
    family?: string;
    vendor?: string;
  }[],
][];

/**
 * Providers that list other people's work. Every model one of them lists
 * first has to name its maker, or the picker files it under the gateway.
 * MiniMax, Poolside and the first-party labs are absent: they list only what
 * they made themselves.
 */
const AGGREGATOR_PROVIDERS = new Set([
  "ollama",
  "fireworks",
  "together",
  "openrouter",
  "vercel-ai-gateway",
  "atlascloud",
  "litellm",
  "opencode",
  "baseten",
  "vellum",
  "openai-compatible",
]);

/** Vendors the catalog genuinely knows a single model from. */
const SINGLE_MODEL_VENDORS = new Set(["amazon", "thinking-machines"]);

/** The provider that lists each model first, which is what owns it. */
const owners = new Map<string, string>();
for (const [providerId, models] of entries) {
  for (const model of models) {
    if (!owners.has(model.displayName)) {
      owners.set(model.displayName, providerId);
    }
  }
}

function modelNamed(displayName: string) {
  return entries
    .flatMap(([, models]) => models)
    .find((entry) => entry.displayName === displayName);
}

describe("model vendors", () => {
  test("a display name carries the same vendor under every provider", () => {
    const seen = new Map<string, string | undefined>();
    for (const [, models] of entries) {
      for (const model of models) {
        if (!seen.has(model.displayName)) {
          seen.set(model.displayName, model.vendor);
          continue;
        }
        expect(
          seen.get(model.displayName),
          `"${model.displayName}" carries two different vendors`,
        ).toBe(model.vendor);
      }
    }
  });

  test("a model a gateway lists first names who made it", () => {
    for (const [displayName, owner] of owners) {
      if (!AGGREGATOR_PROVIDERS.has(owner)) {
        continue;
      }
      expect(
        modelNamed(displayName)?.vendor,
        `"${displayName}" is listed first by ${owner}, which did not make it`,
      ).toBeTruthy();
    }
  });

  test("a model its own maker lists first names no vendor twice", () => {
    for (const [displayName, owner] of owners) {
      if (AGGREGATOR_PROVIDERS.has(owner)) {
        continue;
      }
      expect(
        modelNamed(displayName)?.vendor,
        `"${displayName}" is listed first by its own maker, ${owner}`,
      ).toBeUndefined();
    }
  });

  test("every vendor slug has a display name", () => {
    const slugs = new Set<string>();
    for (const [, models] of entries) {
      for (const model of models) {
        if (model.vendor) {
          slugs.add(model.vendor);
        }
      }
    }
    expect(slugs.size).toBeGreaterThan(0);
    for (const slug of slugs) {
      expect(vendorDisplayName(slug), `"${slug}" has no label`).not.toBe(slug);
    }
  });

  test("a vendor is not left naming one model by accident", () => {
    const byVendor = new Map<string, Set<string>>();
    for (const [, models] of entries) {
      for (const model of models) {
        if (!model.vendor) {
          continue;
        }
        const named = byVendor.get(model.vendor) ?? new Set<string>();
        named.add(model.displayName);
        byVendor.set(model.vendor, named);
      }
    }
    for (const [vendor, displayNames] of byVendor) {
      if (displayNames.size > 1) {
        continue;
      }
      expect(
        SINGLE_MODEL_VENDORS.has(vendor),
        `"${vendor}" names one model; a sibling is probably missing it`,
      ).toBe(true);
    }
  });

  test("every member of a model line names the same vendor", () => {
    const byFamily = new Map<string, Set<string | undefined>>();
    for (const [, models] of entries) {
      for (const model of models) {
        if (!model.family) {
          continue;
        }
        const vendors = byFamily.get(model.family) ?? new Set<string | undefined>();
        vendors.add(model.vendor);
        byFamily.set(model.family, vendors);
      }
    }
    for (const [family, vendors] of byFamily) {
      expect(
        vendors.size,
        `family "${family}" spans vendors ${[...vendors].join(", ")}`,
      ).toBe(1);
    }
  });
});
