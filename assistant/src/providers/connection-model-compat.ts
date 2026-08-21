/**
 * Model-compatibility gate for auto-resolved provider connections.
 *
 * When a profile carries a bare vendor provider, the daemon auto-picks an
 * active connection for it. `oauth_subscription` connections (ChatGPT Codex) hard-
 * route every request to the Codex endpoint, which rejects non-Codex models
 * with HTTP 400. This helper lets the auto-resolution sites skip such a
 * connection when the requested model is not Codex-compatible.
 */

import { resolveDefaultConnectionName } from "../config/default-provider-resolution.js";
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
 *   1. the conventional default row (`resolveDefaultConnectionName`'s
 *      shape: `<provider>-personal` for catalog vendors, the canonical
 *      names for identities), the same row the default-provider status
 *      route and the deletion guard reason about;
 *   2. a row named exactly the vendor id;
 *   3. the first model-compatible candidate.
 *
 * The convention rung comes first so every surface gives one answer: a
 * bare vendor dispatches on the row the status route reports and the
 * delete guard protects ("bare catalog id = the default entry of that
 * kind"), never on whichever row happens to list first.
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
  const conventional = resolveDefaultConnectionName({ provider });
  return (
    compatible.find((c) => c.name === conventional) ??
    compatible.find((c) => c.name === provider) ??
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
