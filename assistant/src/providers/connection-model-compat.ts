/**
 * Model compatibility for `oauth_subscription` (ChatGPT Codex) connections,
 * before dispatch and after it.
 *
 * Such a connection hard-routes every request to the Codex endpoint, which
 * rejects models outside its allowlist with HTTP 400. Two surfaces need that
 * fact. Auto-resolution — when a profile says "Any active <provider>
 * connection" and the daemon picks a row — uses the gate to skip a connection
 * that cannot serve the requested model, and preflight uses it to judge a
 * pinned one. Callers holding a failure instead of a candidate use
 * {@link isSubscriptionRouteRejection} to tell this permanent fault from a
 * transient provider error.
 */

import { ProviderError } from "../util/errors.js";
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
  if (connection.auth.type !== "oauth_subscription") {
    return true;
  }
  if (!model) {
    return true;
  }
  return isCodexSubscriptionModel(model);
}

/**
 * Sole owner of the user-facing sentence for "this ChatGPT subscription
 * cannot serve that model". Given the connections that would serve a
 * request — the candidate set during auto-resolution, or the single pinned
 * row during preflight — return the explanation when none of them can serve
 * `model` and the reason is specifically that they are all
 * `oauth_subscription` (ChatGPT) connections.
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

/**
 * Whether `error` is the Codex endpoint refusing the request as configured —
 * most often a model outside its allowlist, which is what a subscription
 * connection answers with HTTP 400.
 *
 * The distinction callers need is retryability, not the precise upstream
 * complaint: a 400 on this route is a configuration fault, so no retry,
 * backoff, or credential refresh will change the outcome. Call sites that
 * otherwise treat every provider failure as a transient blip use this to
 * report a fault the user has to fix instead of one that fixes itself.
 */
export function isSubscriptionRouteRejection(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    error.statusCode === 400 &&
    error.routeAttribution?.credentialSource === "oauth-subscription"
  );
}
