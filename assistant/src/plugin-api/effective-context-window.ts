import { resolveEffectiveContextWindow } from "../config/llm-context-resolution.js";
import type { ResolveCallSiteOpts } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";

export interface EffectiveContextWindowInfo {
  provider: string;
  model: string;
  maxInputTokens: number;
}

export type EffectiveContextWindowOptions = Pick<
  ResolveCallSiteOpts,
  "overrideProfile" | "forceOverrideProfile" | "selectionSeed"
>;

/**
 * Resolve the provider, model, and effective input limit for one configured
 * call site. The result applies both the workspace override and the selected
 * model's catalog limit, using the same profile-selection options accepted by
 * {@link getConfiguredProvider}.
 */
export function getEffectiveContextWindow(
  callSite: LLMCallSite,
  options: EffectiveContextWindowOptions = {},
): EffectiveContextWindowInfo {
  const { provider, model, maxInputTokens } = resolveEffectiveContextWindow({
    llm: getConfig().llm,
    callSite,
    ...options,
  });
  return { provider, model, maxInputTokens };
}
