/**
 * Routing-identity translation and the connection-resolution error type.
 *
 * This is a leaf module shared by `connection-resolution.ts` and
 * `usage/attribution.ts`. Keep its imports to leaves (codecs, constants,
 * error base classes): an import from anything that reaches the provider
 * registry creates an import cycle through retry/attribution, and the
 * compiled binary's cyclic-module lowering destabilizes bindings in
 * graphs containing a cycle.
 */

import { ConfigError } from "../util/errors.js";
import { CHATGPT_SUBSCRIPTION_CONNECTION_NAME } from "./inference/auth.js";
import { isCodexSubscriptionModel } from "./openai/codex-models.js";
import {
  getManagedUpstream,
  VELLUM_MANAGED_CONNECTION_NAME,
} from "./vellum-model-routing.js";

/**
 * Error raised when a `provider_connection` reference cannot be resolved
 * because the configuration is broken (DB lookup throws, no such row, or
 * the connection's provider does not match the resolving profile's
 * declared provider). These are deterministic configuration bugs that
 * should fail loudly rather than silently rerouting.
 */
export class ConnectionResolutionError extends ConfigError {
  public readonly model?: string;
  public readonly profileName?: string;

  constructor(
    public readonly connectionName: string,
    public readonly reason:
      | "lookup_failed"
      | "not_found"
      | "provider_mismatch"
      | "missing_connection"
      | "model_incompatible"
      | "missing_credential"
      | "platform_unauthenticated"
      | "unroutable_managed_model",
    message: string,
    options?: { cause?: unknown; model?: string; profileName?: string },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ConnectionResolutionError";
    this.model = options?.model;
    this.profileName = options?.profileName;
  }
}

/**
 * Translate a routing-identity provider into its dispatch target. "vellum"
 * derives the managed upstream from the model and routes through the
 * canonical vellum connection; "chatgpt" routes through the
 * chatgpt-subscription connection with an openai upstream. Returns null for
 * real providers. Throws `unroutable_managed_model` when a vellum model has
 * no managed upstream, and `model_incompatible` when a chatgpt model is
 * outside the Codex subscription set — loud and explainable, never a soft
 * fall-through to the (possibly platform-billed) default transport.
 */
export function resolveRoutingIdentity(
  provider: string | undefined,
  model: string | undefined,
): { connectionName: string; expectedProvider: string } | null {
  if (provider === "vellum") {
    const upstream = model ? getManagedUpstream(model) : null;
    if (!upstream) {
      throw new ConnectionResolutionError(
        VELLUM_MANAGED_CONNECTION_NAME,
        "unroutable_managed_model",
        `provider "vellum" cannot route model "${model ?? "<unset>"}" — no managed upstream serves it. Pick a model from the Vellum catalog or set a concrete provider.`,
        { model },
      );
    }
    return {
      connectionName: VELLUM_MANAGED_CONNECTION_NAME,
      expectedProvider: upstream,
    };
  }
  if (provider === "chatgpt") {
    // The subscription endpoint rejects non-Codex models with HTTP 400;
    // gate here so the misconfiguration surfaces as a config error instead
    // of an upstream request failure.
    if (model && !isCodexSubscriptionModel(model)) {
      throw new ConnectionResolutionError(
        CHATGPT_SUBSCRIPTION_CONNECTION_NAME,
        "model_incompatible",
        `provider "chatgpt" cannot route model "${model}" — the ChatGPT subscription serves Codex models only. Pick a Codex model or set a concrete provider.`,
        { model },
      );
    }
    return {
      connectionName: CHATGPT_SUBSCRIPTION_CONNECTION_NAME,
      expectedProvider: "openai",
    };
  }
  return null;
}
