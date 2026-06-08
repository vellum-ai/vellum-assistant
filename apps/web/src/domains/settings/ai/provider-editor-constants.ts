import type { ConnectionProvider } from "@/domains/settings/ai/provider-connections-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthType = "api_key" | "platform" | "none" | "oauth_subscription";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
