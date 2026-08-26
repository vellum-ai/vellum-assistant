import { toast } from "@vellumai/design-library/components/toast";

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import type { TFunction } from "@/i18n";
import type {
  Auth,
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthType = Auth["type"];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Providers that can be selected when creating a provider connection. Must
 * list exactly the meta/llm-provider-catalog.json provider ids (including
 * daemon-only ones like ollama and the openai-compatible escape hatch);
 * parity is enforced by llm-model-catalog.test.ts. Array order is the
 * picker's display order.
 */
export const CONNECTION_PROVIDERS: ConnectionProvider[] = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "together",
  "openrouter",
  "vercel-ai-gateway",
  "minimax",
  "atlascloud",
  "litellm",
  "opencode",
  "baseten",
  "poolside",
  "openai-compatible",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Auth a connection to `provider` uses. Ollama serves a local endpoint with no
 * credential; every other catalog provider authenticates by API key. The
 * ChatGPT subscription pseudo-provider (`oauth_subscription`) is a picker-level
 * identity, not a `ConnectionProvider`, and is handled by its own OAuth flow.
 */
export function connectionAuthTypeForProvider(
  provider: ConnectionProvider,
): AuthType {
  return provider === "ollama" ? "none" : "api_key";
}

/**
 * Providers that persist a client-supplied Base URL. openai-compatible
 * requires one; ollama and opencode treat it as an optional override of
 * their well-known defaults.
 */
export function providerAllowsCustomBaseUrl(
  provider: ConnectionProvider,
): boolean {
  return (
    provider === "openai-compatible" ||
    provider === "ollama" ||
    provider === "opencode"
  );
}

/**
 * Providers that persist a per-connection model list used by the profile
 * picker when the static catalog is empty.
 */
export function providerPersistsConnectionModels(
  provider: ConnectionProvider,
): boolean {
  return provider === "openai-compatible" || provider === "opencode";
}

export function parseCredentialRef(
  credRef: string,
): { service: string; field: string } | null {
  const parts = credRef.split("/");
  if (parts.length < 3 || parts[0] !== "credential") {
    return null;
  }
  return { service: parts[1], field: parts.slice(2).join("/") };
}

export function connectionSaveErrorMessage(status: number | undefined): string {
  switch (status) {
    case 409:
      return "A provider with these settings already exists.";
    case 404:
      return "Provider not found. It may have been removed.";
    case 400:
      return "Invalid configuration. Check the provider settings.";
    default:
      return "Failed to save provider. Please try again.";
  }
}

/**
 * Extract the daemon's error-envelope message for 400 validation responses,
 * which are field-specific and actionable ("Invalid base_url: …"). Reads the
 * generated SDK's already-parsed `error` field — the client consumes the
 * response body, so re-reading `response.json()` would throw. Other statuses
 * intentionally fall back to the generic status-mapped copy so internal
 * identifiers never leak into the provider-first UI.
 */
export function validationErrorMessage(
  status: number | undefined,
  sdkError: unknown,
): string | undefined {
  if (status !== 400) {
    return undefined;
  }
  const inner = (sdkError as { error?: { message?: unknown } } | null)?.error;
  const message = inner?.message;
  return typeof message === "string" && message.length > 0
    ? message
    : undefined;
}

/**
 * Surface a failed save-time endpoint probe as a warning toast, mapping the
 * probe's structured status onto catalog copy (the daemon's English `hint` is
 * for non-localized surfaces like the CLI). The save itself succeeded, so
 * this never blocks the flow.
 */
export function warnOnFailedEndpointCheck(
  connection: {
    endpoint_check?: { ok: boolean; status?: number };
  },
  t: TFunction<"settings">,
): void {
  const check = connection.endpoint_check;
  if (!check || check.ok) {
    return;
  }
  const key =
    check.status === 404
      ? ("providerEndpointCheck.notFound" as const)
      : check.status === 401 || check.status === 403
        ? ("providerEndpointCheck.unauthorized" as const)
        : check.status !== undefined
          ? ("providerEndpointCheck.httpError" as const)
          : ("providerEndpointCheck.unreachable" as const);
  toast.warning(t(key, { status: check.status }));
}

export function providerConnectionDisplayName(
  connection: ProviderConnection,
): string {
  if (connection.label) {
    return connection.label;
  }
  if (connection.auth.type === "oauth_subscription") {
    return PROVIDER_DISPLAY_NAMES.chatgpt;
  }
  return PROVIDER_DISPLAY_NAMES[connection.provider] ?? connection.provider;
}
