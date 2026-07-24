/**
 * Resolve the concrete model a call site runs when invoked with no per-turn
 * profile override.
 *
 * A plugin that must price or capability-check a call site's default target
 * reads the model this way instead of assuming the shipped call-site pin: a
 * workspace `llm.callSites` override or a BYOK `defaultProvider` can resolve the
 * same call site to a different model. This is the model
 * `getConfiguredProvider(callSite)` (with no `overrideProfile`) would dispatch
 * to — the image-fallback plugin uses it to rank the `vision` call-site default
 * against its vision profiles and to exclude a call-site default that resolves
 * to a text-only model.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";

/**
 * The model id a call site resolves to with no per-turn override, or `null`
 * when resolution fails.
 */
export function resolveCallSiteModel(callSite: LLMCallSite): string | null {
  try {
    return resolveCallSiteConfig(callSite, getConfig().llm).model ?? null;
  } catch {
    return null;
  }
}
