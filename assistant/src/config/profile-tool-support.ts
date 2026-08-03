import type { z } from "zod";

import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { resolveDefaultProfileForProvider } from "./default-profile-catalog.js";
import { selectWinningProfile } from "./llm-resolver.js";
import type { AssistantConfig } from "./schema.js";
import type { LLMSchema } from "./schemas/llm.js";

/**
 * Whether a named inference profile is KNOWN to support tool calling.
 *
 * Tri-state on purpose. The model catalog is not exhaustive: BYOK installs
 * point profiles at models the catalog has never heard of, and a
 * `supportsToolUse` flag it does not carry is not evidence of anything. So
 * only `false` is a verdict:
 *   - `true`  the catalog states the model supports tool use
 *   - `false` the catalog states the model does NOT support tool use
 *   - `undefined` the model is unknown to the catalog, or the catalog entry
 *     is silent on tool use
 *
 * A `mix` profile is answered across ALL of its arms rather than by expanding
 * it, because the arm a mix lands on is a function of the running
 * conversation's `selectionSeed` and no such conversation exists at probe
 * time. A verdict is only returned when it holds for every arm: all-denied is
 * `false`, all-capable is `true`, and a mix of the two is `undefined` (which
 * arm runs is unknowable here, so there is no honest verdict).
 *
 * Callers gate on `=== false` so an unknown model is never punished (fail
 * open).
 */
export function profileSupportsTools(
  profileKey: string,
  config: AssistantConfig,
): boolean | undefined {
  const arms = mixArms(profileKey, config.llm);
  if (arms == null) {
    return concreteProfileSupportsTools(profileKey, config);
  }
  const verdicts = arms.map((arm) => concreteProfileSupportsTools(arm, config));
  if (verdicts.length === 0) {
    return undefined;
  }
  if (verdicts.every((verdict) => verdict === false)) {
    return false;
  }
  if (verdicts.every((verdict) => verdict === true)) {
    return true;
  }
  return undefined;
}

/** The arm profile names of a `mix` profile, or `undefined` if not a mix. */
function mixArms(
  profileKey: string,
  llm: z.infer<typeof LLMSchema>,
): string[] | undefined {
  const entry = resolveDefaultProfileForProvider(
    llm.profiles,
    profileKey,
    llm.defaultProvider ?? null,
  );
  return entry?.mix?.map((arm) => arm.profile);
}

/**
 * Verdict for a profile expected to name one concrete model. A key that is
 * itself a mix yields no verdict: `LLMSchema.superRefine` forbids nesting, so
 * this is only reachable from a hand-written config that never went through
 * the schema, and expanding it would reintroduce the unseeded random pick.
 */
function concreteProfileSupportsTools(
  profileKey: string,
  config: AssistantConfig,
): boolean | undefined {
  if (mixArms(profileKey, config.llm) != null) {
    return undefined;
  }
  // Run the profile through the real resolver so a catalog default and a
  // workspace shadow alike yield the model the child would actually run on.
  // Feeding the key in as the override rung means a profile the resolver
  // cannot use falls through to a different rung, and a non-`override` winner
  // tells us the key never resolved: unknown, so no verdict.
  const winner = selectWinningProfile("subagentSpawn", config.llm, {
    overrideProfile: profileKey,
  });
  if (winner.source !== "override") {
    return undefined;
  }
  const model = winner.entry?.model;
  return model == null ? undefined : modelSupportsTools(model);
}

/**
 * Look a model id up across every catalog provider. A model offered by more
 * than one provider (e.g. the same id direct and through OpenRouter) is
 * matched several times; any entry claiming tool support settles it, keeping
 * the answer on the fail-open side.
 */
function modelSupportsTools(modelId: string): boolean | undefined {
  const matches = PROVIDER_CATALOG.flatMap((provider) =>
    provider.models.filter((model) => model.id === modelId),
  );
  if (matches.some((model) => model.supportsToolUse === true)) {
    return true;
  }
  if (matches.some((model) => model.supportsToolUse === false)) {
    return false;
  }
  return undefined;
}
