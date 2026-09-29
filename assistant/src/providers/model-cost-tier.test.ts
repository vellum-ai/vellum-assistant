import { expect, test } from "bun:test";

import { PROVIDER_CATALOG } from "./model-catalog.js";
import {
  profileCostWithFallback,
  profileModelCost,
} from "./model-cost-tier.js";

test("known direct and managed routes share the catalog tier", () => {
  const provider = PROVIDER_CATALOG.find((entry) => entry.id === "anthropic")!;
  const model = provider.models.find((entry) => entry.costTier)!;
  expect(
    profileModelCost("custom", { provider: "anthropic", model: model.id }),
  ).toEqual({ kind: "tier", tier: model.costTier! });
  expect(
    profileModelCost("balanced", {
      provider: "vellum",
      provider_connection: "vellum",
      model: `anthropic/${model.id}`,
    }),
  ).toEqual({ kind: "tier", tier: model.costTier! });
});
test("variable routing and missing pricing stay honest", () => {
  expect(profileModelCost("auto", {})).toEqual({ kind: "varies" });
  expect(
    profileModelCost("mix", { mix: [{ profile: "balanced", weight: 1 }] }),
  ).toEqual({ kind: "varies" });
  expect(
    profileModelCost("custom", { provider: "openai", model: "uncatalogued" }),
  ).toEqual({ kind: "unknown" });
  expect(
    profileModelCost("subscription", {
      provider: "openai",
      provider_connection: "chatgpt-subscription",
      model: "gpt-5",
    }),
  ).toEqual({ kind: "unknown" });
});

test("fallbacks use the full catalog and custom prices are unclassified", () => {
  const provider = PROVIDER_CATALOG.find((entry) => entry.id === "openai")!;
  const cheap = provider.models.find((entry) => entry.costTier === 1)!;
  const expensive = provider.models.find((entry) => entry.costTier === 3)!;
  const primary = {
    provider: "openai" as const,
    model: cheap.id,
    fallbackProfile: "backup",
  };
  expect(
    profileCostWithFallback("balanced", primary, {
      backup: { provider: "openai", model: expensive.id },
    }),
  ).toEqual({ kind: "varies" });
  expect(
    profileCostWithFallback("balanced", primary, {
      backup: { provider: "openai", model: cheap.id },
    }),
  ).toEqual({ kind: "tier", tier: 1 });
  expect(profileCostWithFallback("balanced", primary, {}, true)).toEqual({
    kind: "unknown",
  });
});
