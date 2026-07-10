/**
 * Credential-store-backed persistence for MCP server static auth headers.
 *
 * Follows the same pattern as mcp-oauth-provider.ts: headers are stored in
 * the secure credential store (CES or encrypted file fallback) rather than
 * in plaintext config.json, keeping secrets out of workspace config files.
 *
 * Key format: mcp:{serverId}:headers — stores a JSON-serialized versioned
 * envelope (McpHeaderEnvelope). Literal header values are stored inline;
 * credential references point at a stored vault credential (service/field)
 * and are resolved to a header value at connect time so key rotation is
 * picked up on reconnect. Legacy flat `Record<string, string>` blobs are
 * read transparently and treated as literals.
 */

import { loadRawConfig, saveRawConfig } from "../config/loader.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  getSecureKeyResultAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { resolveCredentialRef } from "../tools/credentials/resolve.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("mcp-header-store");

/**
 * A header whose value is derived from a stored vault credential. The
 * resolved header value is `${prefix ?? ""}${credentialValue}`.
 */
export interface McpHeaderCredentialRef {
  headerName: string;
  service: string;
  field: string;
  prefix?: string;
}

/**
 * Versioned envelope stored in the credential store for an MCP server's
 * static auth headers. `literals` hold verbatim header values; `refs`
 * resolve to header values through the vault at read time.
 */
export interface McpHeaderEnvelope {
  version: 2;
  literals: Record<string, string>;
  refs: McpHeaderCredentialRef[];
}

/**
 * Raised when a stored credential reference cannot be resolved to a value
 * (the credential was deleted or the store is unreachable). Callers treat
 * this as a needs-auth state rather than silently dropping the header.
 */
export class McpHeaderResolutionError extends Error {
  readonly serverId: string;
  readonly missing: McpHeaderCredentialRef[];

  constructor(serverId: string, missing: McpHeaderCredentialRef[]) {
    const refs = missing.map((m) => `${m.service}/${m.field}`).join(", ");
    super(
      `MCP server "${serverId}" references credential(s) that could not be resolved: ${refs}`,
    );
    this.name = "McpHeaderResolutionError";
    this.serverId = serverId;
    this.missing = missing;
  }
}

function headersKey(serverId: string): string {
  return `mcp:${serverId}:headers`;
}

/**
 * The exact CLI command that creates a missing vault credential. The prompt
 * flow collects the secret through the client UI, never the conversation.
 */
export function buildMissingCredentialCommand(
  service: string,
  field: string,
): string {
  const label = `${service} ${field.replace(/_/g, " ")}`;
  return `assistant credentials prompt --service ${service} --field ${field} --label "${label}"`;
}

function normalizeEnvelope(parsed: unknown): McpHeaderEnvelope | undefined {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.version === 2) {
    const literals: Record<string, string> = {};
    if (obj.literals && typeof obj.literals === "object") {
      for (const [k, v] of Object.entries(obj.literals as object)) {
        if (typeof v === "string") {
          literals[k] = v;
        }
      }
    }
    const refs: McpHeaderCredentialRef[] = [];
    if (Array.isArray(obj.refs)) {
      for (const entry of obj.refs) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const r = entry as Record<string, unknown>;
        if (
          typeof r.headerName === "string" &&
          typeof r.service === "string" &&
          typeof r.field === "string"
        ) {
          refs.push({
            headerName: r.headerName,
            service: r.service,
            field: r.field,
            ...(typeof r.prefix === "string" ? { prefix: r.prefix } : {}),
          });
        }
      }
    }
    return { version: 2, literals, refs };
  }

  // Legacy flat Record<string, string> — treat every string entry as a literal.
  const literals: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      literals[k] = v;
    }
  }
  return { version: 2, literals, refs: [] };
}

/**
 * Retrieve the stored header envelope for an MCP server. Legacy flat blobs
 * are normalized into a v2 envelope with all entries as literals. Returns
 * undefined if none are stored or the credential store is unreachable.
 */
export async function getMcpHeaderEnvelope(
  serverId: string,
): Promise<McpHeaderEnvelope | undefined> {
  const raw = await getSecureKeyAsync(headersKey(serverId));
  if (!raw) {
    return undefined;
  }
  try {
    return normalizeEnvelope(JSON.parse(raw));
  } catch {
    log.warn({ serverId }, "Failed to parse stored MCP headers");
    return undefined;
  }
}

/**
 * Persist a header envelope for an MCP server in the credential store.
 */
export async function setMcpHeaderEnvelope(
  serverId: string,
  envelope: McpHeaderEnvelope,
): Promise<boolean> {
  const ok = await setSecureKeyAsync(
    headersKey(serverId),
    JSON.stringify(envelope),
  );
  if (!ok) {
    log.warn({ serverId }, "Failed to persist MCP headers to secure storage");
    return false;
  }
  log.info({ serverId }, "MCP static auth headers saved to credential store");
  return true;
}

/**
 * Store literal-only static auth headers for an MCP server. Convenience
 * wrapper over setMcpHeaderEnvelope for callers with no credential refs.
 */
export async function setMcpHeaders(
  serverId: string,
  headers: Record<string, string>,
): Promise<boolean> {
  return setMcpHeaderEnvelope(serverId, {
    version: 2,
    literals: { ...headers },
    refs: [],
  });
}

/**
 * Resolve the effective static auth headers for an MCP server, merging
 * literal headers with credential-reference headers resolved through the
 * vault at call time. Refs win over literals on header-name collision.
 *
 * Throws McpHeaderResolutionError if any ref cannot be resolved so the
 * caller can surface a needs-auth state instead of connecting with a
 * silently missing header.
 */
export async function resolveMcpHeaders(
  serverId: string,
): Promise<Record<string, string>> {
  const envelope = await getMcpHeaderEnvelope(serverId);
  if (!envelope) {
    return {};
  }

  const headers: Record<string, string> = { ...envelope.literals };
  const missing: McpHeaderCredentialRef[] = [];

  for (const ref of envelope.refs) {
    const resolved = resolveCredentialRef(`${ref.service}/${ref.field}`);
    if (!resolved) {
      missing.push(ref);
      continue;
    }
    const { value } = await getSecureKeyResultAsync(resolved.storageKey);
    if (value == null || value.length === 0) {
      missing.push(ref);
      continue;
    }
    headers[ref.headerName] = `${ref.prefix ?? ""}${value}`;
  }

  if (missing.length > 0) {
    log.error(
      { serverId, missing: missing.map((m) => `${m.service}/${m.field}`) },
      "MCP header credential references could not be resolved",
    );
    throw new McpHeaderResolutionError(serverId, missing);
  }

  return headers;
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
    const existing = await getMcpHeaderEnvelope(id);
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
