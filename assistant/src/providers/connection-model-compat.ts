/**
 * Model-compatibility gate for auto-resolved provider connections.
 *
 * When a profile uses "Any active <provider> connection" (no
 * `provider_connection` pinned), the daemon auto-picks an active connection
 * for the provider. `oauth_subscription` connections (ChatGPT Codex) hard-
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
 * This gate applies to auto-resolution only — an explicitly pinned
 * `provider_connection` bypasses connection selection entirely and is used
 * regardless of model.
 */
export function isConnectionCompatibleWithModel(
  connection: Pick<ProviderConnection, "auth">,
  model: string | undefined,
): boolean {
  if (connection.auth.type !== "oauth_subscription") return true;
  if (!model) return true;
  return isCodexSubscriptionModel(model);
}
