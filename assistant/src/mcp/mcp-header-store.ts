/**
 * Credential-store-backed persistence for MCP server static auth headers.
 *
 * Follows the same pattern as mcp-oauth-provider.ts: headers are stored in
 * the secure credential store (CES or encrypted file fallback) rather than
 * in plaintext config.json, keeping secrets out of workspace config files.
 *
 * Key format: mcp:{serverId}:headers — stores JSON-serialized Record<string, string>.
 */

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
export async function deleteMcpHeaders(serverId: string): Promise<void> {
  const result = await deleteSecureKeyAsync(headersKey(serverId));
  if (result === "error") {
    log.warn({ serverId }, "Failed to delete MCP headers from secure storage");
  }
}
