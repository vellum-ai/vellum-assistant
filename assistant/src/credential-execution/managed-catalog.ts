/**
 * Managed CES credential catalog.
 *
 * Discovers platform-managed OAuth connections by calling the platform's CES
 * catalog endpoint. Returns displayable descriptors with exact
 * `platform_oauth:<connection_id>` handles suitable for CES tools.
 *
 * This module never reveals token values — it only surfaces handle references
 * and non-secret metadata (provider, account info, scopes, status).
 */

import { platformOAuthHandle } from "@vellumai/ces-contracts";

import { getPlatformAssistantId } from "../config/env.js";
import { resolveManagedProxyContext } from "../providers/managed-proxy/context.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("managed-catalog");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ManagedCredentialDescriptor {
  /** CES handle string (e.g. `platform_oauth:conn_abc123`). */
  handle: string;
  /** Source of the credential — always `"platform"` for managed entries. */
  source: "platform";
  /** Provider key on the platform (e.g. `google`, `slack`). */
  provider: string;
  /** Platform-assigned connection identifier. */
  connectionId: string;
  /** Human-readable account info (e.g. email), if available. */
  accountInfo: string | null;
  /** Granted OAuth scopes, if reported by the platform. */
  grantedScopes: string[];
  /** Connection status as reported by the platform (e.g. `active`, `expired`). */
  status: string;
}

// ---------------------------------------------------------------------------
// Platform response shape (non-secret subset)
// ---------------------------------------------------------------------------

/**
 * Shape of a single connection entry in the platform catalog response.
 * Only non-secret fields are parsed; token values are never included.
 *
 * Field names match the platform's ManagedConnectionCatalogEntrySerializer:
 *   handle, connection_id, provider, account_label, scopes_granted, status
 */
interface PlatformCatalogEntry {
  handle: string;
  connection_id: string;
  provider: string;
  account_label?: string | null;
  scopes_granted?: string[];
  status?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FetchManagedCatalogResult {
  ok: boolean;
  descriptors: ManagedCredentialDescriptor[];
  error?: string;
}

/**
 * Fetch the managed credential catalog from the platform.
 *
 * Requires managed proxy prerequisites (platform base URL + assistant API key).
 * Returns an empty list with `ok: true` when prerequisites are missing —
 * callers should not treat a missing platform as an error.
 *
 * Errors from the platform are captured and returned as `ok: false` with an
 * error message that never contains secret material.
 */
export async function fetchManagedCatalog(): Promise<FetchManagedCatalogResult> {
  const ctx = await resolveManagedProxyContext();

  if (!ctx.enabled) {
    return { ok: true, descriptors: [] };
  }

  const assistantId = getPlatformAssistantId();
  if (!assistantId) {
    log.warn("PLATFORM_ASSISTANT_ID not set; cannot fetch managed catalog");
    return { ok: true, descriptors: [] };
  }

  const url = `${ctx.platformBaseUrl}/v1/assistants/${encodeURIComponent(assistantId)}/oauth/managed/catalog/`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Api-Key ${ctx.assistantApiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const statusText = response.statusText || `HTTP ${response.status}`;
      log.warn(
        `Platform CES catalog returned ${response.status}: ${statusText}`,
      );
      return {
        ok: false,
        descriptors: [],
        error: `Platform CES catalog request failed (${response.status})`,
      };
    }

    // The platform returns a flat JSON array of catalog entries
    // (serialized with many=True), not a wrapper object.
    const body = (await response.json()) as PlatformCatalogEntry[];

    if (!Array.isArray(body)) {
      return {
        ok: false,
        descriptors: [],
        error: "Platform CES catalog returned unexpected response format",
      };
    }

    const descriptors: ManagedCredentialDescriptor[] = body.map((entry) => ({
      handle: platformOAuthHandle(entry.connection_id),
      source: "platform" as const,
      provider: entry.provider,
      connectionId: entry.connection_id,
      accountInfo: entry.account_label ?? null,
      grantedScopes: entry.scopes_granted ?? [],
      status: entry.status ?? "unknown",
    }));

    return { ok: true, descriptors };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Ensure the error message does not leak secrets — strip any URL params
    // that might contain tokens (defensive, since we use Api-Key header).
    const safeMessage = message.replace(
      /Api-Key\s+\S+/gi,
      "Api-Key [REDACTED]",
    );
    log.warn(`Failed to fetch managed CES catalog: ${safeMessage}`);
    return {
      ok: false,
      descriptors: [],
      error: `Failed to fetch managed CES catalog: ${safeMessage}`,
    };
  }
}
