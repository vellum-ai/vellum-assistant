/**
 * Model-compatibility gate for auto-resolved provider connections.
 *
 * When a profile carries a bare vendor provider, the daemon auto-picks an
 * active connection for it. `oauth_subscription` connections (ChatGPT Codex) hard-
 * route every request to the Codex endpoint, which rejects non-Codex models
 * with HTTP 400. This helper lets the auto-resolution sites skip such a
 * connection when the requested model is not Codex-compatible.
 */

import type { ProviderConnection } from "./inference/auth.js";
import { isCodexSubscriptionModel } from "./openai/codex-models.js";

/**
 * Whether `connection` can serve a request for `model` during
 * auto-resolution.
 *
 * `oauth_subscription` connections route through the ChatGPT Codex endpoint,
 * so they are only compatible with Codex models. Every other auth type
 * imposes no model restriction and is always compatible.
 *
 * `model` may be undefined when the call site has no resolved model; in that
 * case no model gating is applied (returns true) so resolution behaviour is
 * unchanged.
 *
 * This gate applies to auto-resolution only: an entry-name provider names
 * its row directly and bypasses connection selection entirely, regardless
 * of model.
 */
export function isConnectionCompatibleWithModel(
  connection: Pick<ProviderConnection, "auth">,
  model: string | undefined,
): boolean {
  if (connection.auth.type !== "oauth_subscription") {
    return true;
  }
  if (!model) {
    return true;
  }
  return isCodexSubscriptionModel(model);
}

/**
 * Deterministic pick among a vendor's rows during auto-resolution (a
 * bare-vendor provider with no entry name of its own). Preference order:
 *
 *   1. a row named exactly the vendor id;
 *   2. the conventional default row (`<provider>-personal`, the shape
 *      `resolveDefaultConnectionName` reports for the default-provider
 *      status route and the deletion guard);
 *   3. the first model-compatible candidate.
 *
 * The first two rungs keep dispatch aligned with the surfaces that reason
 * about the conventional row, so a bare vendor resolves to the same row
 * the status route and delete guard report ("bare catalog id = the default
 * entry of that kind") instead of whichever row happens to list first.
 */
export function pickAutoResolvedConnection<
  T extends Pick<ProviderConnection, "name" | "auth">,
>(
  candidates: readonly T[],
  provider: string,
  model: string | undefined,
): T | undefined {
  const compatible = candidates.filter((c) =>
    isConnectionCompatibleWithModel(c, model),
  );
  return (
    compatible.find((c) => c.name === provider) ??
    compatible.find((c) => c.name === `${provider}-personal`) ??
    compatible[0]
  );
}

/**
 * When auto-resolution found candidates but none were model-compatible,
 * return a user-facing explanation if the incompatibility is specifically
 * due to all candidates being `oauth_subscription` (ChatGPT) connections.
 *
 * Returns `null` when the incompatibility has a different cause (callers
 * should fall through to their existing generic error).
 */
export function describeSubscriptionModelIncompatibility(
  candidates: Pick<ProviderConnection, "auth">[],
  model: string | undefined,
): string | null {
  if (!model || candidates.length === 0) {
    return null;
  }
  if (candidates.some((c) => isConnectionCompatibleWithModel(c, model))) {
    return null;
  }
  const allSubscription = candidates.every(
    (c) => c.auth.type === "oauth_subscription",
  );
  if (!allSubscription) {
    return null;
  }
  return `Model "${model}" isn't available through your ChatGPT subscription. Select a supported model or add an OpenAI API key connection.`;
}
