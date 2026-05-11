/**
 * Shared types and helpers for OAuth CLI commands.
 *
 * This module is intentionally thin — it contains only types and pure-logic
 * helpers. All daemon-internal concerns (config, oauth-store, platform client)
 * are handled by the daemon routes accessed via IPC.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface PlatformConnectionEntry {
  id: string;
  account_label?: string;
  scopes_granted?: string[];
  status?: string;
}
