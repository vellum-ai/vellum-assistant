import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
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
  "openai-compatible",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * which are field-specific and actionable ("Invalid base_url: …"). Other
 * statuses intentionally fall back to the generic status-mapped copy so
 * internal identifiers never leak into the provider-first UI.
 */
export async function validationErrorMessage(
  response: { status?: number; json: () => Promise<unknown> } | undefined,
): Promise<string | undefined> {
  if (!response || response.status !== 400) {
    return undefined;
  }
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown };
    } | null;
    const message = body?.error?.message;
    return typeof message === "string" && message.length > 0
      ? message
      : undefined;
  } catch {
    return undefined;
  }
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
