import type { Auth, ConnectionProvider } from "@/generated/daemon/types.gen";

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
  "openrouter",
  "minimax",
  "openai-compatible",
];

export const AUTH_TYPE_DISPLAY_NAMES: Record<AuthType, string> = {
  api_key: "API Key",
  platform: "Platform (managed proxy)",
  none: "None (local / no auth)",
  oauth_subscription: "ChatGPT Subscription",
  service_account: "Service Account",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseCredentialRef(credRef: string): { service: string; field: string } | null {
  const parts = credRef.split("/");
  if (parts.length < 3 || parts[0] !== "credential") return null;
  return { service: parts[1], field: parts.slice(2).join("/") };
}

export function connectionSaveErrorMessage(
  status: number | undefined,
  connectionName: string,
): string {
  switch (status) {
    case 409:
      return `A connection named "${connectionName}" already exists.`;
    case 404:
      return "Connection not found. It may have been deleted.";
    case 400:
      return "Invalid configuration. Check the provider and auth settings.";
    default:
      return "Failed to save connection. Please try again.";
  }
}
