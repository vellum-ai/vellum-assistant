import type { ProfileEntry } from "../config/schemas/llm.js";
import { PROVIDER_CATALOG } from "./model-catalog.js";
import {
  getManagedUpstream,
  parseVellumModel,
} from "./vellum-model-routing.js";

export type ModelCost =
  | { kind: "tier"; tier: 1 | 2 | 3 }
  | { kind: "varies" | "unknown" };

/** Relative catalog pricing, excluding usage, subscription terms, and custom rates. */
export function profileModelCost(
  name: string,
  profile: ProfileEntry,
): ModelCost {
  if (name === "auto" || profile.mix) {
    return { kind: "varies" };
  }
  if (
    !profile.model ||
    !profile.provider ||
    (profile.provider_connection && profile.provider_connection !== "vellum")
  ) {
    return { kind: "unknown" };
  }
  const route =
    profile.provider === "vellum" ? parseVellumModel(profile.model) : null;
  const provider =
    profile.provider === "vellum"
      ? (route?.provider ?? getManagedUpstream(profile.model))
      : profile.provider;
  const model = route?.model ?? profile.model;
  const tier = PROVIDER_CATALOG.find(
    (entry) => entry.id === provider,
  )?.models.find((entry) => entry.id === model)?.costTier;
  return tier ? { kind: "tier", tier } : { kind: "unknown" };
}

/** A tier is stable only when every automatic route shares it. */
export function profileCostWithFallback(
  name: string,
  profile: ProfileEntry,
  profiles: Record<string, ProfileEntry>,
  hasCustomPrices = false,
): ModelCost {
  if (name === "auto" || profile.mix) {
    return { kind: "varies" };
  }
  if (hasCustomPrices) {
    return { kind: "unknown" };
  }
  const primary = profileModelCost(name, profile);
  if (!profile.fallbackProfile) {
    return primary;
  }
  const fallback = profiles[profile.fallbackProfile];
  if (!fallback) {
    return { kind: "varies" };
  }
  const backup = profileModelCost(profile.fallbackProfile, fallback);
  return primary.kind === "tier" &&
    backup.kind === "tier" &&
    primary.tier === backup.tier
    ? primary
    : { kind: "varies" };
}
