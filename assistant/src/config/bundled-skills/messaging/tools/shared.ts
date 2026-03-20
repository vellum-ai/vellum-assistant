/**
 * Shared utilities for messaging skill tools.
 */

import type { MessagingProvider } from "../../../../messaging/provider.js";
import {
  getConnectedProviders,
  getMessagingProvider,
} from "../../../../messaging/registry.js";
import type { OAuthConnection } from "../../../../oauth/connection.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type { ToolExecutionResult } from "../../../../tools/types.js";

export function ok(content: string): ToolExecutionResult {
  return { content, isError: false };
}

export function err(message: string): ToolExecutionResult {
  return { content: message, isError: true };
}

// ── RFC 5322 address helpers ──────────────────────────────────────────────────

export function extractHeader(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string {
  return (
    headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
    ""
  );
}

/**
 * RFC 5322-aware address list parser. Splits a header value like
 * `"Doe, Jane" <jane@example.com>, bob@example.com` into individual
 * addresses without breaking on commas inside quoted display names.
 */
export function parseAddressList(header: string): string[] {
  const addresses: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;

  for (let i = 0; i < header.length; i++) {
    const ch = header[i];

    if (ch === '"' && !inAngle) {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "<" && !inQuotes) {
      inAngle = true;
      current += ch;
    } else if (ch === ">" && !inQuotes) {
      inAngle = false;
      current += ch;
    } else if (ch === "," && !inQuotes && !inAngle) {
      const trimmed = current.trim();
      if (trimmed) addresses.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed) addresses.push(trimmed);

  return addresses;
}

/**
 * Extracts the bare email from an address that may be in any of these forms:
 *   - `user@example.com`
 *   - `<user@example.com>`
 *   - `"Display Name" <user@example.com>`
 *   - `Display Name <user@example.com>`
 *   - `"Team <Ops>" <user@example.com>`
 *   - `user@example.com (team <ops>)`
 *
 * Extracts all angle-bracketed segments and picks the last one containing `@`,
 * preferring the actual mailbox over display-name fragments like
 * `"Acme <support@acme.com>" <owner@example.com>`. If no segment contains `@`,
 * strips angle-bracketed portions and parenthetical comments, returning the
 * remaining text. This handles display names with angle brackets and trailing
 * RFC 5322 comments.
 */
export function extractEmail(address: string): string {
  // Strip parenthetical comments first to avoid matching addresses inside them
  const cleaned = address.replace(/\(.*?\)/g, "");
  const segments = [...cleaned.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  if (segments.length > 0) {
    const emailSegment = [...segments].reverse().find((s) => s.includes("@"));
    if (emailSegment) return emailSegment.trim().toLowerCase();
  }
  return address
    .replace(/<[^>]+>/g, "")
    .replace(/\(.*?\)/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Resolve the messaging provider from user input.
 * If platform is specified, look it up directly.
 * If only one provider is connected, auto-select it.
 * Otherwise, throw asking the user to specify.
 */
export async function resolveProvider(
  platformInput?: string,
): Promise<MessagingProvider> {
  if (platformInput) return getMessagingProvider(platformInput);

  const connected = await getConnectedProviders();
  if (connected.length === 1) return connected[0];
  if (connected.length === 0) {
    throw new Error(
      "No messaging platforms are connected. Use messaging_auth_test to check connection status, then set up a platform.",
    );
  }

  const names = connected.map((p) => `"${p.id}"`).join(", ");
  throw new Error(
    `Multiple platforms connected (${names}). Specify platform parameter.`,
  );
}

/**
 * Resolve an OAuthConnection (or empty string for non-OAuth providers)
 * for the given messaging provider.
 *
 * Non-OAuth providers (e.g. Telegram) use isConnected() and don't need
 * tokens - they receive an empty string which the string overload handles.
 */
export async function getProviderConnection(
  provider: MessagingProvider,
  account?: string,
): Promise<OAuthConnection | string> {
  if (provider.resolveConnection) return provider.resolveConnection(account);
  if (await provider.isConnected?.()) return "";
  return resolveOAuthConnection(provider.credentialService, { account });
}
