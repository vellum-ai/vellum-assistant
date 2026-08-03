import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { selectWinningProfile } from "./llm-resolver.js";
import type { AssistantConfig } from "./schema.js";

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
 * Callers gate on `=== false` so an unknown model is never punished (fail
 * open).
 */
export function profileSupportsTools(
  profileKey: string,
  config: AssistantConfig,
): boolean | undefined {
  // Run the profile through the real resolver so a catalog default, a
  // workspace shadow, and a mix (which expands to one concrete arm) all yield
  // the model the child would actually run on. Feeding the key in as the
  // override rung means a profile the resolver cannot use falls through to a
  // different rung, and a non-`override` winner tells us the key never
  // resolved: unknown, so no verdict.
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
