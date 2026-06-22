/**
 * Vision-support resolution for plugin consumption.
 *
 * A plugin that gates image processing on vision capability (e.g. an
 * image-to-text fallback for text-only models) calls {@link doesSupportVision}
 * instead of hardcoding model names. The function resolves the effective
 * (provider, model) for a profile — merging with `llm.default` to fill gaps,
 * inferring the provider for model-only profiles via the catalog — and then
 * looks up `supportsVision` in the model catalog.
 */

import { AUTO_PROFILE_KEY } from "../api/constants/inference-profiles.js";
import { getConfig } from "../config/loader.js";
import {
  getCatalogProviderForModel,
  PROVIDER_CATALOG,
} from "../providers/model-catalog.js";
import type { ModelProfileInfo } from "./types.js";

/**
 * Whether a profile's resolved model can process image input.
 *
 * Resolution mirrors the host's call-site resolver:
 * - The profile's `(provider, model)` fields are merged over `llm.default` so
 *   a profile that only sets `model` (or only `provider`) inherits the other
 *   from the workspace default.
 * - When `provider` is still missing but `model` is a known catalog model,
 *   the provider is inferred via `getCatalogProviderForModel` (same logic as
 *   the resolver's `withImpliedProviderForKnownModel`).
 * - For a mix profile, returns `true` if any constituent arm supports vision
 *   (the mix can route to it) and `false` only if every arm is text-only.
 * - The "auto" meta-profile returns `false` — it has no concrete model and
 *   may route to a text-only profile at runtime.
 * - Unknown `(provider, model)` pairs default to `true` (fail-open), matching
 *   the config GET route's `enrichProfilesWithVisionFlag`.
 */
export function doesSupportVision(profile: ModelProfileInfo): boolean {
  // The "auto" meta-profile has no concrete provider/model — it delegates to
  // the model's own profile selection at runtime, which may route to a
  // text-only model. Conservatively report `false` so image-fallback does not
  // pick it as a vision candidate. Checked before getConfig() to short-circuit.
  if (profile.key === AUTO_PROFILE_KEY) return false;

  const { llm } = getConfig();
  const entry = llm.profiles[profile.key];
  if (entry == null) return true;

  // Mix: fail-open if any arm supports vision.
  if (entry.mix != null) {
    return entry.mix.some((arm) => {
      const armEntry = llm.profiles[arm.profile];
      if (armEntry == null) return true;
      return resolveEntrySupportsVision(armEntry, llm);
    });
  }

  return resolveEntrySupportsVision(entry, llm);
}

/**
 * Resolve whether a concrete (non-mix) profile entry supports vision by
 * merging its fields over `llm.default` and inferring the provider when
 * only the model is set.
 */
function resolveEntrySupportsVision(
  entry: { provider?: string; model?: string },
  llm: { default?: { provider?: string; model?: string } },
): boolean {
  const provider = entry.provider ?? llm.default?.provider;
  const model = entry.model ?? llm.default?.model;

  // Infer provider from model when missing (mirrors the resolver's
  // withImpliedProviderForKnownModel).
  const effectiveProvider =
    provider ?? (typeof model === "string" ? getCatalogProviderForModel(model) : undefined);

  if (typeof effectiveProvider !== "string" || typeof model !== "string") {
    return true; // fail-open
  }

  const catalogProvider = PROVIDER_CATALOG.find((p) => p.id === effectiveProvider);
  const catalogModel = catalogProvider?.models.find((m) => m.id === model);
  return catalogModel?.supportsVision ?? true;
}
