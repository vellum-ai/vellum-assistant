/**
 * Resolve the concrete `(provider, model)` a call site runs when invoked with no
 * per-turn profile override.
 *
 * A plugin that must price or capability-check a call site's default target
 * reads this instead of assuming the shipped call-site pin: a workspace
 * `llm.callSites` override or a BYOK `defaultProvider` can move both the
 * provider and the model. The pair is what `getConfiguredProvider(callSite)`
 * (with no `overrideProfile`) would dispatch to — the image-fallback plugin
 * uses it to rank the `vision` call-site default against its vision profiles and
 * to exclude a call-site default that resolves to a text-only model. The
 * provider travels with the model because the catalog carries provider-specific
 * rates and capabilities for the same model id.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";

/**
 * The concrete `(provider, model)` a call site dispatches to with no per-turn
 * override. `provider` may be a routing identity (e.g. `vellum`) rather than a
 * catalog provider; capability and pricing lookups resolve such identities
 * through the model's catalog owner.
 */
export interface CallSiteModel {
  provider: string;
  model: string;
}

/**
 * The `(provider, model)` a call site resolves to with no per-turn override, or
 * `null` when resolution fails.
 */
export function resolveCallSiteModel(
  callSite: LLMCallSite,
): CallSiteModel | null {
  try {
    const config = resolveCallSiteConfig(callSite, getConfig().llm);
    if (config.provider == null || config.model == null) {
      return null;
    }
    return { provider: config.provider, model: config.model };
  } catch {
    return null;
  }
}
