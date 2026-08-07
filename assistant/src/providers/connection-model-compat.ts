/**
 * Model compatibility for `oauth_subscription` (ChatGPT Codex) connections,
 * before dispatch and after it.
 *
 * Such a connection hard-routes every request to the Codex endpoint, which
 * rejects models outside its allowlist with HTTP 400. Two surfaces need that
 * fact. Auto-resolution (a profile saying "Any active <provider> connection",
 * where the daemon picks a row) uses the gate to skip a connection that cannot
 * serve the requested model, and preflight uses it to judge a pinned one.
 * Callers holding a failure instead of a candidate use
 * {@link isSubscriptionModelRejection}, which reads the same allowlist to tell
 * this permanent fault from an ordinary bad request on the same route.
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
 * cannot serve that model". Given the connections that would serve a request
 * (the candidate set during auto-resolution, or the single pinned row during
 * preflight), return the explanation when none of them can serve `model` and
 * the reason is specifically that they are all `oauth_subscription` (ChatGPT)
 * connections.
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
 * Whether `error` is the Codex endpoint refusing `model` because it is not one
 * the subscription serves.
 *
 * The status alone does not establish that. This endpoint is parameter
 * sensitive and answers HTTP 400 for ordinary client faults too, so a caller
 * that treated every 400 on the route as a model verdict would tell the user
 * to change a model that was never the problem. The allowlist is what
 * separates them: a model outside it can only fail, and no retry, backoff, or
 * credential refresh changes that, while an allowlisted model returning 400 is
 * some other bad request and stays the caller's ordinary failure.
 *
 * `model` is the model the call site resolved. An unknown model returns
 * `false`: without it there is no evidence for the stronger claim.
 */
export function isSubscriptionModelRejection(
  error: unknown,
  model: string | undefined,
): boolean {
  return (
    error instanceof ProviderError &&
    error.statusCode === 400 &&
    error.routeAttribution?.credentialSource === "oauth-subscription" &&
    model !== undefined &&
    !isCodexSubscriptionModel(model)
  );
}
