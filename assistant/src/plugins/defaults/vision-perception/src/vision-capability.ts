/**
 * Resolve whether the `visionPerception` call site lands on a usable, vision-capable
 * inference provider.
 *
 * The vision-perception feature routes every `vlm_*` call through the dedicated
 * `visionPerception` call site (see {@link call-vision-model.ts}). That call site
 * is *intended* to resolve to the managed `vision` profile (a `supportsVision`
 * model), but it does not always: in BYOK installs the managed `vision` profile
 * is seeded `status: "disabled"`, so the call-site resolver strips it back to the
 * workspace's active/default profile — which may be a NON-vision model. Sending
 * image frames to a non-vision model is wrong, so both the tool-offering gate and
 * the execution path must first confirm the call site resolves to an enabled,
 * vision-capable model.
 *
 * This module is the single source of truth for that check. It resolves the
 * `visionPerception` call site exactly as dispatch does (via
 * {@link resolveCallSiteConfig}) and looks the resolved `(provider, model)` pair
 * up in the model catalog, requiring `supportsVision === true`. "Enabled" is
 * captured structurally: a disabled profile is dropped by the resolver, so the
 * call site falls back to a different (non-vision) model and the catalog check
 * fails — there is no separate status flag to read here.
 */

import { resolveCallSiteConfig } from "../../../../config/llm-resolver.js";
import { getConfig } from "../../../../config/loader.js";
import { PROVIDER_CATALOG } from "../../../../providers/model-catalog.js";

/** The dedicated call site every `vlm_*` tool dispatches through. */
export const VISION_CALL_SITE = "visionPerception" as const;

/**
 * Resolve the catalog model entry the `visionPerception` call site would
 * actually dispatch to, or `undefined` when the resolved `(provider, model)` is
 * not in the catalog. Resolution failures (unreadable config, etc.) also yield
 * `undefined` so callers fail closed.
 */
export function resolveVisionPerceptionCatalogModel() {
  try {
    const { llm } = getConfig();
    const resolved = resolveCallSiteConfig(VISION_CALL_SITE, llm);
    const catalogProvider = PROVIDER_CATALOG.find(
      (p) => p.id === resolved.provider,
    );
    return catalogProvider?.models.find((m) => m.id === resolved.model);
  } catch {
    return undefined;
  }
}

/**
 * Whether the `visionPerception` call site resolves to an enabled, vision-capable
 * provider/model. True only when the resolved `(provider, model)` is a known
 * catalog model with `supportsVision === true`.
 *
 * Fails CLOSED: an unresolvable call site, an unknown model, or a non-vision
 * model all return `false`, so the `vlm_*` tools are not offered and execution is
 * refused rather than risk sending image frames to a model that cannot read them
 * (the BYOK-disabled-vision-profile case — see the module doc).
 */
export function isVisionPerceptionProviderAvailable(): boolean {
  return resolveVisionPerceptionCatalogModel()?.supportsVision === true;
}
