/**
 * Credential-store-backed persistence for MCP server static auth headers.
 *
 * Follows the same pattern as mcp-oauth-provider.ts: headers are stored in
 * the secure credential store (CES or encrypted file fallback) rather than
 * in plaintext config.json, keeping secrets out of workspace config files.
 *
 * Key format: mcp:{serverId}:headers — stores JSON-serialized Record<string, string>.
 */

import { loadRawConfig, saveRawConfig } from "../config/loader.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("mcp-header-store");

function headersKey(serverId: string): string {
  return `mcp:${serverId}:headers`;
}

/**
 * Retrieve stored static auth headers for an MCP server.
 * Returns undefined if none are stored or if the credential store is unreachable.
 */
export async function getMcpHeaders(
  serverId: string,
): Promise<Record<string, string> | undefined> {
  const raw = await getSecureKeyAsync(headersKey(serverId));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    log.warn({ serverId }, "Failed to parse stored MCP headers");
    return undefined;
  }
}

/**
 * Store static auth headers for an MCP server in the credential store.
 */
export async function setMcpHeaders(
  serverId: string,
  headers: Record<string, string>,
): Promise<boolean> {
  const ok = await setSecureKeyAsync(
    headersKey(serverId),
    JSON.stringify(headers),
  );
  if (!ok) {
    log.warn({ serverId }, "Failed to persist MCP headers to secure storage");
    return false;
  }
  log.info({ serverId }, "MCP static auth headers saved to credential store");
  return true;
}

/**
 * Delete stored static auth headers for an MCP server.
 */
export async function deleteMcpHeaders(serverId: string): Promise<boolean> {
  const result = await deleteSecureKeyAsync(headersKey(serverId));
  if (result === "error") {
    log.warn({ serverId }, "Failed to delete MCP headers from secure storage");
    return false;
  }
  return true;
}

/**
 * One-time lazy migration: move any plaintext headers from config.json
 * transport entries into the credential store and strip them from config.
 * Safe to call on every MCP reload — no-ops when no legacy headers remain.
 */
export async function migrateLegacyMcpHeaders(): Promise<void> {
  const raw = loadRawConfig();
  const mcpConfig = raw.mcp as
    | { servers?: Record<string, Record<string, unknown>> }
    | undefined;
  const servers = mcpConfig?.servers;
  if (!servers) {
    return;
  }

  let configDirty = false;
  for (const [id, server] of Object.entries(servers)) {
    const transport = server?.transport as Record<string, unknown> | undefined;
    if (
      !transport ||
      (transport.type !== "sse" && transport.type !== "streamable-http")
    ) {
      continue;
    }
    const legacyHeaders = transport.headers as
      | Record<string, string>
      | undefined;
    if (!legacyHeaders || Object.keys(legacyHeaders).length === 0) {
      continue;
    }

    // Only migrate if credential store doesn't already have headers for
    // this server (idempotent — safe to re-run after partial failure).
    const existing = await getMcpHeaders(id);
    if (existing) {
      // Credential store already has headers; just strip the config copy.
      delete transport.headers;
      configDirty = true;
      continue;
    }

    const ok = await setMcpHeaders(id, legacyHeaders);
    if (ok) {
      delete transport.headers;
      configDirty = true;
      log.info(
        { serverId: id },
        "Migrated legacy MCP headers to credential store",
      );
    } else {
      log.warn(
        { serverId: id },
        "Skipping legacy header migration — credential store write failed; will retry on next reload",
      );
    }
  }

  if (configDirty) {
    saveRawConfig(raw);
    log.info("Config updated: legacy MCP headers removed after migration");
  }
}
