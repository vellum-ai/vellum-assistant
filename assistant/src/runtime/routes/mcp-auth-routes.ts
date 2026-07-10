/**
 * Internal routes for daemon-owned MCP management.
 *
 * POST internal/mcp/auth/start   — kicks off the OAuth flow in the daemon
 *                                  and returns the authorization URL
 * GET  internal/mcp/auth/status/:serverId — polls current flow status
 * POST internal/mcp/reload       — trigger MCP server reload
 * GET  internal/mcp/list         — list servers with health status
 * GET  internal/mcp/tools-summary — per-server tool counts + token estimates
 * POST internal/mcp/add          — add a new MCP server config
 * POST internal/mcp/update       — update an existing MCP server config
 * POST internal/mcp/remove       — remove an MCP server config + credentials
 */

import { z } from "zod";

import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import type { McpConfig, McpServerConfig } from "../../config/schemas/mcp.js";
import { estimateToolDefinitionTokens } from "../../context/token-estimator.js";
import {
  type McpReloadServerResult,
  reloadMcpServers,
} from "../../daemon/mcp-reload-service.js";
import { McpClient } from "../../mcp/client.js";
import { getMcpServerManager } from "../../mcp/manager.js";
import { orchestrateMcpOAuthConnect } from "../../mcp/mcp-auth-orchestrator.js";
import { getMcpAuthState } from "../../mcp/mcp-auth-state.js";
import {
  buildMissingCredentialCommand,
  deleteMcpHeaders,
  getMcpHeaderEnvelope,
  type McpHeaderCredentialRef,
  type McpHeaderEnvelope,
  setMcpHeaderEnvelope,
} from "../../mcp/mcp-header-store.js";
import {
  deleteMcpOAuthCredentials,
  hasMcpOAuthTokens,
} from "../../mcp/mcp-oauth-provider.js";
import { resolveCredentialRef } from "../../tools/credentials/resolve.js";
import { getMcpToolsByServer } from "../../tools/registry.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("mcp-auth-routes");

async function handleMcpAuthStart({
  body,
}: {
  body?: Record<string, unknown>;
}): Promise<{
  auth_url: string;
  state: string;
  already_authenticated?: boolean;
}> {
  const { serverId } = body as { serverId: string };

  const raw = loadRawConfig();
  const servers = (raw.mcp as Partial<McpConfig> | undefined)?.servers ?? {};
  const serverConfig = servers[serverId];

  if (!serverConfig) {
    throw new BadRequestError(`MCP server "${serverId}" not configured`);
  }

  const transport = serverConfig.transport;
  if (transport.type !== "sse" && transport.type !== "streamable-http") {
    throw new BadRequestError(
      `OAuth only supported for sse/streamable-http transports (server "${serverId}" uses ${transport.type})`,
    );
  }

  let result: { auth_url: string; already_authenticated?: boolean };
  try {
    result = await orchestrateMcpOAuthConnect({
      serverId,
      transport: {
        url: transport.url,
        type: transport.type,
        headers: transport.headers,
      },
    });
  } catch (err) {
    throw new InternalError(err instanceof Error ? err.message : String(err));
  }

  return {
    auth_url: result.auth_url,
    state: serverId,
    already_authenticated: result.already_authenticated,
  };
}

function handleMcpAuthStatus({
  pathParams,
}: {
  pathParams?: Record<string, string>;
}):
  | { status: "pending"; auth_url: string }
  | { status: "complete" }
  | { status: "error"; error: string } {
  const { serverId } = pathParams as { serverId: string };
  const state = getMcpAuthState(serverId);

  if (state === null) {
    throw new NotFoundError(`No active OAuth flow for server "${serverId}"`);
  }

  if (state.status === "pending")
    return { status: "pending", auth_url: state.authUrl };
  if (state.status === "complete") return { status: "complete" };
  return { status: "error", error: state.error };
}

/**
 * Fire-and-forget MCP reload. reloadMcpServers() has its own
 * reloadInProgress mutex, so concurrent calls coalesce.
 */
function triggerReload(context: string): void {
  void reloadMcpServers().catch((err) => {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      `${context} background reload failed`,
    );
  });
}

interface McpReloadRouteServer {
  serverId: string;
  connected: boolean;
  needsAuth?: boolean;
  disabled?: boolean;
  error?: string;
}

function toReloadRouteServers(
  servers: McpReloadServerResult[],
): McpReloadRouteServer[] {
  return servers.map((s) => ({
    serverId: s.id,
    connected: s.connected,
    ...(s.needsAuth ? { needsAuth: true } : {}),
    ...(s.disabled ? { disabled: true } : {}),
    ...(s.error ? { error: s.error } : {}),
  }));
}

async function handleMcpReload({
  body,
}: {
  body?: Record<string, unknown>;
}): Promise<
  { ok: true } | { ok: true; servers: McpReloadRouteServer[]; error?: string }
> {
  const wait = (body as { wait?: boolean } | undefined)?.wait === true;
  if (!wait) {
    triggerReload("internal_mcp_reload");
    return { ok: true };
  }

  const result = await reloadMcpServers();
  return {
    ok: true,
    servers: toReloadRouteServers(result.servers ?? []),
    ...(result.success ? {} : { error: result.error }),
  };
}

// ---------------------------------------------------------------------------
// Health check helper
// ---------------------------------------------------------------------------

const HEALTH_CHECK_TIMEOUT_MS = 10_000;

type McpHealthStatus = "connected" | "needs-auth" | "error";

interface McpHealthResult {
  status: McpHealthStatus;
  error?: string;
}

async function checkMachineReadableHealth(
  serverId: string,
  config: McpServerConfig,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<McpHealthResult> {
  const client = new McpClient(serverId);
  try {
    await Promise.race([
      client.connect(config.transport),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        if (typeof t === "object" && "unref" in t) t.unref();
      }),
    ]);

    if (client.isConnected) {
      await client.disconnect();
      return { status: "connected" };
    }

    const err = client.lastError;
    if (err) {
      return { status: "error", error: err.message };
    }

    return { status: "needs-auth" };
  } catch (err) {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

interface McpServerEntry {
  id: string;
  status: string;
  transport: Omit<McpServerConfig["transport"], "headers"> & { type: string };
  enabled: boolean;
  defaultRiskLevel: string;
  hasOAuth: boolean;
  hasStaticAuth: boolean;
  authType: "none" | "bearer" | "api-key";
  authHeaderName?: string;
  allowedTools?: string[];
  blockedTools?: string[];
}

interface StaticAuthEntry {
  name: string;
  bearer: boolean;
}

/**
 * Derive the auth entries (header name + bearer-ness) for an MCP server from
 * its stored envelope, falling back to legacy config-level headers. Only the
 * header name and whether it carries a Bearer prefix are surfaced — resolved
 * secret values are never read here.
 */
function envelopeAuthEntries(
  envelope: McpHeaderEnvelope | undefined,
  legacyConfigHeaders: Record<string, string> | undefined,
): StaticAuthEntry[] {
  const entries: StaticAuthEntry[] = [];
  if (envelope) {
    for (const [name, value] of Object.entries(envelope.literals)) {
      entries.push({ name, bearer: value.startsWith("Bearer ") });
    }
    for (const ref of envelope.refs) {
      entries.push({
        name: ref.headerName,
        bearer: (ref.prefix ?? "").startsWith("Bearer"),
      });
    }
  } else if (legacyConfigHeaders) {
    for (const [name, value] of Object.entries(legacyConfigHeaders)) {
      entries.push({ name, bearer: value.startsWith("Bearer ") });
    }
  }
  return entries;
}

function summarizeStaticAuth(entries: StaticAuthEntry[]): {
  hasStaticAuth: boolean;
  authType: "none" | "bearer" | "api-key";
  authHeaderName?: string;
} {
  if (entries.length === 0) {
    return { hasStaticAuth: false, authType: "none" };
  }
  const authorization = entries.find(
    (e) => e.name.toLowerCase() === "authorization",
  );
  const authType: "bearer" | "api-key" = authorization?.bearer
    ? "bearer"
    : "api-key";
  const authHeaderName =
    authType === "api-key"
      ? entries.find((e) => e.name.toLowerCase() !== "authorization")?.name
      : undefined;
  return {
    hasStaticAuth: true,
    authType,
    ...(authHeaderName ? { authHeaderName } : {}),
  };
}

async function handleMcpList(_args: {
  body?: Record<string, unknown>;
}): Promise<{ servers: McpServerEntry[] }> {
  const raw = loadRawConfig();
  const mcpConfig = raw.mcp as Partial<McpConfig> | undefined;
  const servers = mcpConfig?.servers ?? {};
  const entries = Object.entries(servers) as [string, McpServerConfig][];
  const manager = getMcpServerManager();

  const results: McpServerEntry[] = await Promise.all(
    entries
      .filter(([, config]) => config && typeof config === "object")
      .map(async ([id, config]) => {
        const enabled = config.enabled !== false;
        let status: string;
        if (!enabled) {
          status = "disabled";
        } else if (manager.isServerConnected(id)) {
          // The manager holds a live connection — trust it instead of opening
          // a throwaway probe connection.
          status = "connected";
        } else {
          status = (await checkMachineReadableHealth(id, config)).status;
        }
        const hasOAuth =
          config.transport.type !== "stdio"
            ? await hasMcpOAuthTokens(id)
            : false;

        // Derive auth shape from the stored envelope (literals + refs),
        // falling back to legacy config-level headers. Secret values are
        // never resolved here.
        const envelope = await getMcpHeaderEnvelope(id);
        const configHeaders =
          config.transport.type !== "stdio"
            ? config.transport.headers
            : undefined;
        const { hasStaticAuth, authType, authHeaderName } = summarizeStaticAuth(
          envelopeAuthEntries(envelope, configHeaders),
        );

        // Strip headers from transport — never return secrets
        const { headers: _stripped, ...safeTransport } =
          config.transport as Record<string, unknown>;

        return {
          id,
          status,
          transport: safeTransport as McpServerEntry["transport"],
          enabled,
          defaultRiskLevel: config.defaultRiskLevel ?? "high",
          hasOAuth,
          hasStaticAuth,
          authType,
          ...(authHeaderName && { authHeaderName }),
          ...(config.allowedTools && { allowedTools: config.allowedTools }),
          ...(config.blockedTools && { blockedTools: config.blockedTools }),
        };
      }),
  );

  return { servers: results };
}

// ---------------------------------------------------------------------------
// Tools summary
// ---------------------------------------------------------------------------

interface McpToolEntry {
  name: string;
  description: string;
  estimatedTokens: number;
}

interface McpToolsSummaryServerEntry {
  serverId: string;
  toolCount: number;
  estimatedTokens: number;
  tools: McpToolEntry[];
}

function handleMcpToolsSummary(): {
  servers: McpToolsSummaryServerEntry[];
  totalToolCount: number;
  totalEstimatedTokens: number;
} {
  const byServer = getMcpToolsByServer();
  const servers: McpToolsSummaryServerEntry[] = [];
  let totalToolCount = 0;
  let totalEstimatedTokens = 0;

  for (const [serverId, toolList] of byServer) {
    const prefix = `mcp__${serverId}__`;
    const tools: McpToolEntry[] = toolList.map((tool) => {
      const tokens = estimateToolDefinitionTokens(tool);
      const rawName = tool.name.startsWith(prefix)
        ? tool.name.slice(prefix.length)
        : tool.name;
      return {
        name: rawName,
        description: tool.description,
        estimatedTokens: tokens,
      };
    });
    const serverTokens = tools.reduce((sum, t) => sum + t.estimatedTokens, 0);
    servers.push({
      serverId,
      toolCount: toolList.length,
      estimatedTokens: serverTokens,
      tools,
    });
    totalToolCount += toolList.length;
    totalEstimatedTokens += serverTokens;
  }

  return { servers, totalToolCount, totalEstimatedTokens };
}

// ---------------------------------------------------------------------------
// Static auth header inputs (literals + credential references)
// ---------------------------------------------------------------------------

const CREDENTIAL_PLACEHOLDER = /\{\{\s*credential:([^}]+?)\s*\}\}/;

interface McpAuthHeaderInput {
  headers?: Record<string, string> | null;
  authCredential?: string;
  authHeader?: string;
  authPrefix?: string;
}

function parseServiceField(
  ref: string,
): { service: string; field: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return undefined;
  }
  if (trimmed.indexOf("/", slash + 1) !== -1) {
    return undefined;
  }
  return { service: trimmed.slice(0, slash), field: trimmed.slice(slash + 1) };
}

/**
 * Build a versioned header envelope from CLI/route inputs, validating each
 * value and confirming every credential reference resolves to a stored
 * credential. Returns null when there is nothing to store (the caller clears
 * any existing headers). Throws BadRequestError for invalid input.
 */
function buildMcpHeaderEnvelope(
  input: McpAuthHeaderInput,
): McpHeaderEnvelope | null {
  const literals: Record<string, string> = {};
  const refs: McpHeaderCredentialRef[] = [];

  if (input.headers) {
    for (const [name, value] of Object.entries(input.headers)) {
      if (value.includes("${")) {
        throw new BadRequestError(
          `Header "${name}" contains a shell variable (value "${value}"). Shell environment variables are not available when the assistant stores MCP headers, so the header would be saved empty. Reference a stored vault credential instead with --auth-credential service/field (and --auth-header "${name}" if it is not Authorization), or embed {{credential:service/field}} in the header value.`,
        );
      }

      const match = value.match(CREDENTIAL_PLACEHOLDER);
      if (match) {
        const parsed = parseServiceField(match[1]);
        if (!parsed) {
          throw new BadRequestError(
            `Header "${name}" has an invalid credential placeholder "${match[0]}". Expected {{credential:service/field}}.`,
          );
        }
        const placeholderStart = match.index ?? 0;
        const prefix = value.slice(0, placeholderStart);
        const suffix = value.slice(placeholderStart + match[0].length);
        if (suffix.length > 0) {
          throw new BadRequestError(
            `Header "${name}" has text after the {{credential:...}} placeholder. Only a prefix before the placeholder is supported (e.g. "Bearer {{credential:service/field}}").`,
          );
        }
        refs.push({
          headerName: name,
          service: parsed.service,
          field: parsed.field,
          ...(prefix ? { prefix } : {}),
        });
        continue;
      }

      if (value.trim().length === 0) {
        throw new BadRequestError(
          `Header "${name}" has an empty value and would be stored empty, causing auth failures. Provide a value, or reference a stored credential with --auth-credential or {{credential:service/field}}.`,
        );
      }
      literals[name] = value;
    }
  }

  const authCredential = input.authCredential?.trim();
  if (authCredential) {
    const parsed = parseServiceField(authCredential);
    if (!parsed) {
      throw new BadRequestError(
        `--auth-credential "${input.authCredential}" is invalid. Expected the form service/field, e.g. reducto/api_key.`,
      );
    }
    const headerName =
      input.authHeader && input.authHeader.length > 0
        ? input.authHeader
        : "Authorization";
    const prefix = input.authPrefix ?? "Bearer ";
    refs.push({
      headerName,
      service: parsed.service,
      field: parsed.field,
      ...(prefix ? { prefix } : {}),
    });
  }

  if (Object.keys(literals).length === 0 && refs.length === 0) {
    return null;
  }

  for (const ref of refs) {
    const resolved = resolveCredentialRef(`${ref.service}/${ref.field}`);
    if (!resolved) {
      throw new BadRequestError(
        `Credential "${ref.service}/${ref.field}" (for header "${ref.headerName}") is not stored. Create it first with:\n  ${buildMissingCredentialCommand(ref.service, ref.field)}\nThis prompts for the secret through the client UI — never type it into the conversation.`,
      );
    }
  }

  return { version: 2, literals, refs };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

async function handleMcpUpdate({
  body,
}: {
  body?: Record<string, unknown>;
}): Promise<{ updated: true; status?: McpHealthStatus; error?: string }> {
  const {
    name,
    enabled,
    defaultRiskLevel,
    maxTools,
    allowedTools,
    blockedTools,
    headers,
    authCredential,
    authHeader,
    authPrefix,
    verify,
  } = body as {
    name: string;
    enabled?: boolean;
    defaultRiskLevel?: string;
    maxTools?: number;
    allowedTools?: string[] | null;
    blockedTools?: string[] | null;
    headers?: Record<string, string> | null;
    authCredential?: string;
    authHeader?: string;
    authPrefix?: string;
    verify?: boolean;
  };

  const raw = loadRawConfig();
  const mcpConfig = raw.mcp as Record<string, unknown> | undefined;
  const serverMap = mcpConfig?.servers as
    | Record<string, Record<string, unknown>>
    | undefined;

  if (!serverMap || !serverMap[name]) {
    throw new NotFoundError(`MCP server "${name}" not found.`);
  }

  const server = serverMap[name];

  if (enabled !== undefined) server.enabled = enabled;
  if (defaultRiskLevel !== undefined) {
    if (!["low", "medium", "high"].includes(defaultRiskLevel)) {
      throw new BadRequestError(
        `Invalid risk level: ${defaultRiskLevel}. Must be low, medium, or high`,
      );
    }
    server.defaultRiskLevel = defaultRiskLevel;
  }
  if (maxTools !== undefined) server.maxTools = maxTools;
  if (allowedTools !== undefined) {
    if (allowedTools === null) {
      delete server.allowedTools;
    } else {
      server.allowedTools = allowedTools;
    }
  }
  if (blockedTools !== undefined) {
    if (blockedTools === null) {
      delete server.blockedTools;
    } else {
      server.blockedTools = blockedTools;
    }
  }
  if (headers !== undefined || authCredential !== undefined) {
    const transport = server.transport as Record<string, unknown> | undefined;
    if (
      transport &&
      (transport.type === "sse" || transport.type === "streamable-http")
    ) {
      // Migrate any legacy config-level headers away
      delete transport.headers;

      const envelope = buildMcpHeaderEnvelope({
        headers,
        authCredential,
        authHeader,
        authPrefix,
      });

      // Store in credential store (or delete if clearing)
      if (!envelope) {
        const ok = await deleteMcpHeaders(name);
        if (!ok) {
          throw new InternalError(
            "Failed to clear auth headers from credential store",
          );
        }
      } else {
        const ok = await setMcpHeaderEnvelope(name, envelope);
        if (!ok) {
          throw new InternalError(
            "Failed to persist auth headers to credential store",
          );
        }
      }
    }
  }

  saveRawConfig(raw);
  triggerReload("internal_mcp_update");

  const isEnabled = server.enabled !== false;
  if (verify === false || !isEnabled) {
    return { updated: true };
  }

  const health = await checkMachineReadableHealth(
    name,
    server as unknown as McpServerConfig,
  );
  return {
    updated: true,
    status: health.status,
    ...(health.error ? { error: health.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

async function handleMcpAdd({
  body,
}: {
  body?: Record<string, unknown>;
}): Promise<{ added: true; status?: McpHealthStatus; error?: string }> {
  const {
    name,
    transportType,
    url,
    command,
    args,
    risk,
    disabled,
    headers,
    authCredential,
    authHeader,
    authPrefix,
    verify,
  } = body as {
    name: string;
    transportType: string;
    url?: string;
    command?: string;
    args?: string[];
    risk?: string;
    disabled?: boolean;
    headers?: Record<string, string>;
    authCredential?: string;
    authHeader?: string;
    authPrefix?: string;
    verify?: boolean;
  };

  const riskLevel = risk ?? "high";
  if (!["low", "medium", "high"].includes(riskLevel)) {
    throw new BadRequestError(
      `Invalid risk level: ${riskLevel}. Must be low, medium, or high`,
    );
  }

  let transport: Record<string, unknown>;
  switch (transportType) {
    case "stdio":
      if (!command) {
        throw new BadRequestError("--command is required for stdio transport");
      }
      transport = { type: "stdio", command, args: args ?? [] };
      break;
    case "sse":
    case "streamable-http":
      if (!url) {
        throw new BadRequestError(
          `--url is required for ${transportType} transport`,
        );
      }
      transport = { type: transportType, url };
      break;
    default:
      throw new BadRequestError(
        `Unknown transport type: ${transportType}. Must be stdio, sse, or streamable-http`,
      );
  }

  const raw = loadRawConfig();
  if (!raw.mcp) raw.mcp = { servers: {} };
  const mcpConfig = raw.mcp as Record<string, unknown>;
  if (!mcpConfig.servers) mcpConfig.servers = {};
  const serverMap = mcpConfig.servers as Record<string, unknown>;

  if (serverMap[name]) {
    throw new BadRequestError(
      `MCP server "${name}" already exists. Remove it first with: assistant mcp remove ${name}`,
    );
  }

  const wantsStaticAuth =
    (headers && Object.keys(headers).length > 0) ||
    (authCredential !== undefined && authCredential !== "");
  if (wantsStaticAuth && transportType === "stdio") {
    throw new BadRequestError(
      "Static auth headers are only supported for sse/streamable-http transports.",
    );
  }

  // Validate and build the header envelope before writing config so an
  // invalid credential ref never leaves a half-configured server behind.
  const envelope = buildMcpHeaderEnvelope({
    headers,
    authCredential,
    authHeader,
    authPrefix,
  });

  serverMap[name] = {
    transport,
    enabled: !disabled,
    defaultRiskLevel: riskLevel,
  };

  // Store auth headers in credential store, not config
  if (envelope) {
    const ok = await setMcpHeaderEnvelope(name, envelope);
    if (!ok) {
      throw new InternalError(
        "Failed to persist auth headers to credential store",
      );
    }
  }

  saveRawConfig(raw);
  triggerReload("internal_mcp_add");

  if (verify === false || disabled) {
    return { added: true };
  }

  // Probe the affected server with a bounded health check so the caller learns
  // whether the first connect will succeed, need auth, or fail.
  const health = await checkMachineReadableHealth(
    name,
    serverMap[name] as unknown as McpServerConfig,
  );
  return {
    added: true,
    status: health.status,
    ...(health.error ? { error: health.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Revoke OAuth
// ---------------------------------------------------------------------------

async function handleMcpAuthRevoke({
  body,
}: {
  body?: Record<string, unknown>;
}): Promise<{ revoked: true }> {
  const { serverId } = body as { serverId: string };

  const raw = loadRawConfig();
  const servers = (raw.mcp as Partial<McpConfig> | undefined)?.servers ?? {};
  const serverConfig = servers[serverId];

  if (!serverConfig) {
    throw new NotFoundError(`MCP server "${serverId}" not found`);
  }

  let result: { ok: boolean; failedKeys: string[] };
  try {
    result = await deleteMcpOAuthCredentials(serverId);
  } catch (err) {
    throw new InternalError(
      `Failed to revoke OAuth credentials: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!result.ok) {
    throw new InternalError(
      `Failed to delete OAuth credentials for keys: ${result.failedKeys.join(", ")}`,
    );
  }

  triggerReload("internal_mcp_auth_revoke");
  return { revoked: true };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

async function handleMcpRemove({
  body,
}: {
  body?: Record<string, unknown>;
}): Promise<{ removed: true }> {
  const { name } = body as { name: string };

  const raw = loadRawConfig();
  const mcpConfig = raw.mcp as Record<string, unknown> | undefined;
  const serverMap = mcpConfig?.servers as Record<string, unknown> | undefined;

  if (!serverMap || !serverMap[name]) {
    throw new NotFoundError(`MCP server "${name}" not found.`);
  }

  // Best-effort cleanup of credentials stored for this server
  const serverConfig = serverMap[name] as Record<string, unknown>;
  const transport = serverConfig?.transport as
    | Record<string, unknown>
    | undefined;
  if (transport?.type === "sse" || transport?.type === "streamable-http") {
    try {
      await Promise.all([
        deleteMcpOAuthCredentials(name),
        deleteMcpHeaders(name),
      ]);
    } catch {
      // Ignore — credentials may not exist
    }
  }

  delete serverMap[name];
  saveRawConfig(raw);
  triggerReload("internal_mcp_remove");

  return { removed: true };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "internal_mcp_auth_start",
    endpoint: "internal/mcp/auth/start",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Start MCP OAuth flow",
    description:
      "Starts a daemon-owned MCP OAuth flow and returns the authorization URL for the CLI to open in the browser.",
    tags: ["internal"],
    requestBody: z.object({ serverId: z.string() }),
    handler: handleMcpAuthStart,
  },
  {
    operationId: "internal_mcp_auth_status",
    endpoint: "internal/mcp/auth/status/:serverId",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Poll MCP OAuth flow status",
    description:
      "Returns the current status of an in-flight MCP OAuth flow (pending/complete/error).",
    tags: ["internal"],
    pathParams: [{ name: "serverId" }],
    additionalResponses: {
      "404": { description: "No active OAuth flow for the given serverId" },
    },
    handler: handleMcpAuthStatus,
  },
  {
    operationId: "internal_mcp_reload",
    endpoint: "internal/mcp/reload",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Trigger MCP server reload",
    description:
      "Reloads MCP servers on the daemon. Returns immediately by default; with { wait: true } it awaits the reload and returns per-server connection status.",
    tags: ["internal"],
    requestBody: z.object({ wait: z.boolean().optional() }),
    handler: handleMcpReload,
  },
  {
    operationId: "internal_mcp_list",
    endpoint: "internal/mcp/list",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List MCP servers with health status",
    description:
      "Returns configured MCP servers with live health-check results (connected, needs auth, error, disabled).",
    tags: ["internal"],
    responseBody: z.object({
      servers: z.array(
        z.object({
          id: z.string(),
          status: z.string(),
          transport: z
            .object({
              type: z.enum(["stdio", "sse", "streamable-http"]),
            })
            .passthrough(),
          enabled: z.boolean(),
          defaultRiskLevel: z.string(),
          hasOAuth: z.boolean(),
          allowedTools: z.array(z.string()).optional(),
          blockedTools: z.array(z.string()).optional(),
        }),
      ),
    }),
    handler: handleMcpList,
  },
  {
    operationId: "internal_mcp_tools_summary",
    endpoint: "internal/mcp/tools-summary",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Per-server MCP tool counts and token estimates",
    description:
      "Returns registered tool counts, individual tool details, and estimated token overhead for each connected MCP server.",
    tags: ["internal"],
    responseBody: z.object({
      servers: z.array(
        z.object({
          serverId: z.string(),
          toolCount: z.number(),
          estimatedTokens: z.number(),
          tools: z.array(
            z.object({
              name: z.string(),
              description: z.string(),
              estimatedTokens: z.number(),
            }),
          ),
        }),
      ),
      totalToolCount: z.number(),
      totalEstimatedTokens: z.number(),
    }),
    handler: handleMcpToolsSummary,
  },
  {
    operationId: "internal_mcp_update",
    endpoint: "internal/mcp/update",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update an MCP server configuration",
    description:
      "Updates fields on an existing MCP server config entry and triggers a reload.",
    tags: ["internal"],
    requestBody: z.object({
      name: z.string(),
      enabled: z.boolean().optional(),
      defaultRiskLevel: z.string().optional(),
      maxTools: z.number().optional(),
      allowedTools: z.array(z.string()).nullable().optional(),
      blockedTools: z.array(z.string()).nullable().optional(),
      headers: z.record(z.string(), z.string()).nullable().optional(),
      authCredential: z.string().optional(),
      authHeader: z.string().optional(),
      authPrefix: z.string().optional(),
      verify: z.boolean().optional(),
    }),
    handler: handleMcpUpdate,
  },
  {
    operationId: "internal_mcp_add",
    endpoint: "internal/mcp/add",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Add an MCP server configuration",
    description:
      "Writes a new MCP server entry to config.json and triggers a reload.",
    tags: ["internal"],
    requestBody: z.object({
      name: z.string(),
      transportType: z.string(),
      url: z.string().optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      risk: z.string().optional(),
      disabled: z.boolean().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      authCredential: z.string().optional(),
      authHeader: z.string().optional(),
      authPrefix: z.string().optional(),
      verify: z.boolean().optional(),
    }),
    handler: handleMcpAdd,
  },
  {
    operationId: "internal_mcp_auth_revoke",
    endpoint: "internal/mcp/auth/revoke",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Revoke MCP OAuth credentials",
    description:
      "Deletes stored OAuth tokens for an MCP server and triggers a reload.",
    tags: ["internal"],
    requestBody: z.object({ serverId: z.string() }),
    responseBody: z.object({ revoked: z.boolean() }),
    handler: handleMcpAuthRevoke,
  },
  {
    operationId: "internal_mcp_remove",
    endpoint: "internal/mcp/remove",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Remove an MCP server configuration",
    description:
      "Removes an MCP server from config.json, cleans up OAuth credentials, and triggers a reload.",
    tags: ["internal"],
    requestBody: z.object({ name: z.string() }),
    handler: handleMcpRemove,
  },
];
