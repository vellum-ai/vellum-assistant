/**
 * Route handlers for OAuth CLI command operations: disconnect, mode, status,
 * ping, token, and request.
 *
 * These routes back the thin IPC wrappers in assistant/src/cli/commands/oauth/.
 */

import { readFileSync } from "node:fs";

import {
  getConfig,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import {
  getServiceMode,
  type Services,
  ServicesSchema,
} from "../../config/schemas/services.js";
import type { OAuthConnectionRequest } from "../../oauth/connection.js";
import {
  resolveOAuthConnection,
  type ResolveOAuthConnectionOptions,
  resolveOAuthConnectionWithMeta,
} from "../../oauth/connection-resolver.js";
import { syncManualTokenConnection } from "../../oauth/manual-token-connection.js";
import {
  disconnectOAuthProvider,
  getActiveConnection,
  getAppByProviderAndClientId,
  getConnection,
  getProvider,
  listActiveConnectionsByProvider,
  listConnections,
  type OAuthProviderRow,
} from "../../oauth/oauth-store.js";
import { VellumPlatformClient } from "../../platform/client.js";
import { withValidToken } from "../../security/token-manager.js";
import { matchHostPattern } from "../../tools/credentials/host-pattern-match.js";
import { getLogger } from "../../util/logger.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("oauth-commands-routes");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface PlatformConnectionEntry {
  id: string;
  account_label?: string;
  scopes_granted?: string[];
  status?: string;
}

function getManagedServiceConfigKey(provider: string): string | null {
  const providerRow = getProvider(provider);
  const managedKey = providerRow?.managedServiceConfigKey;
  if (!managedKey || !(managedKey in ServicesSchema.shape)) return null;
  return managedKey;
}

function isManagedMode(provider: string): boolean {
  const managedKey = getManagedServiceConfigKey(provider);
  if (!managedKey) return false;
  try {
    const services: Services = getConfig().services;
    return getServiceMode(services, managedKey as keyof Services) === "managed";
  } catch {
    return false;
  }
}

async function requirePlatformClient(): Promise<VellumPlatformClient> {
  const client = await VellumPlatformClient.create();
  if (!client) {
    throw new BadRequestError(
      "Not connected to Vellum platform. Run `vellum platform connect` to connect first.",
    );
  }
  if (!client.platformAssistantId) {
    throw new BadRequestError(
      "Connected to Vellum platform but no assistant ID is configured. Ensure the assistant is registered on the platform.",
    );
  }
  return client;
}

async function fetchActiveConnections(
  client: VellumPlatformClient,
  provider: string,
): Promise<PlatformConnectionEntry[]> {
  const params = new URLSearchParams();
  params.set("provider", provider);
  params.set("status", "ACTIVE");

  const path = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/connections/?${params.toString()}`;
  const response = await client.fetch(path);

  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? `. Your platform session may have expired. Run \`vellum platform connect\` to reconnect.`
        : "";
    throw new InternalError(`Platform returned HTTP ${response.status}${hint}`);
  }

  const body = (await response.json()) as unknown;
  return (
    Array.isArray(body)
      ? body
      : ((body as Record<string, unknown>).results ?? [])
  ) as PlatformConnectionEntry[];
}

/**
 * Best-effort helper to count active platform connections for a provider.
 * Returns 0 if the platform client cannot be created or the fetch fails.
 */
async function countManagedConnections(provider: string): Promise<number> {
  try {
    const client = await VellumPlatformClient.create();
    if (!client || !client.platformAssistantId) return 0;
    const entries = await fetchActiveConnections(client, provider);
    return entries.length;
  } catch {
    return 0;
  }
}

function parseUrl(value: string | null | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function getAllowedRequestHostPatterns(
  providerRow: OAuthProviderRow,
): string[] {
  const patterns: string[] = [];

  if (providerRow.injectionTemplates) {
    try {
      const parsed = JSON.parse(providerRow.injectionTemplates) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (
            entry &&
            typeof entry === "object" &&
            typeof (entry as { hostPattern?: unknown }).hostPattern === "string"
          ) {
            const hostPattern = (
              entry as { hostPattern: string }
            ).hostPattern.trim();
            if (hostPattern) patterns.push(hostPattern);
          }
        }
      }
    } catch {
      // Fall back to the provider's base URL host below.
    }
  }

  if (patterns.length === 0) {
    const baseUrl = parseUrl(providerRow.baseUrl);
    if (baseUrl) patterns.push(baseUrl.hostname);
  }

  return [...new Set(patterns)];
}

function assertOAuthRequestUrlAllowed(
  providerRow: OAuthProviderRow,
  parsedUrl: URL,
): void {
  const providerBaseUrl = parseUrl(providerRow.baseUrl);
  const allowedProtocol = providerBaseUrl?.protocol ?? "https:";
  if (parsedUrl.protocol !== allowedProtocol) {
    throw new BadRequestError(
      `OAuth request URL for "${providerRow.provider}" must use ${allowedProtocol.replace(/:$/, "")}.`,
    );
  }

  const allowedHostPatterns = getAllowedRequestHostPatterns(providerRow);
  if (allowedHostPatterns.length === 0) {
    throw new BadRequestError(
      `OAuth provider "${providerRow.provider}" does not define an allowed request host.`,
    );
  }

  const allowed = allowedHostPatterns.some(
    (pattern) =>
      matchHostPattern(parsedUrl.hostname, pattern, {
        includeApexForWildcard: true,
      }) !== "none",
  );
  if (!allowed) {
    throw new BadRequestError(
      `OAuth request URL host "${parsedUrl.hostname}" is not allowed for "${providerRow.provider}". Allowed hosts: ${allowedHostPatterns.join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Disconnect handler
// ---------------------------------------------------------------------------

async function handleDisconnect({ body = {} }: RouteHandlerArgs) {
  const b = body as {
    provider: string;
    account?: string;
    connection_id?: string;
  };

  if (!b.provider) throw new BadRequestError("provider is required");

  const providerRow = getProvider(b.provider);
  if (!providerRow) {
    throw new NotFoundError(
      `Unknown provider "${b.provider}". Run 'assistant oauth providers list' to see available providers.`,
    );
  }

  if (b.account && b.connection_id) {
    throw new BadRequestError(
      `Cannot specify both account and connection_id. Use one or the other.`,
    );
  }

  const managed = isManagedMode(b.provider);

  if (managed) {
    const client = await requirePlatformClient();
    const entries = await fetchActiveConnections(client, b.provider);

    let connectionId: string | undefined;
    let accountLabel: string | undefined;

    if (b.account) {
      const matching = entries.filter((c) => c.account_label === b.account);
      if (matching.length === 0) {
        throw new NotFoundError(
          `No active connection found for "${b.provider}" with account "${b.account}".`,
        );
      }
      connectionId = matching[0].id;
      accountLabel = matching[0].account_label;
    } else if (b.connection_id) {
      const match = entries.find((c) => c.id === b.connection_id);
      if (!match) {
        throw new NotFoundError(
          `Connection "${b.connection_id}" is not an active ${b.provider} connection.`,
        );
      }
      connectionId = match.id;
      accountLabel = match.account_label;
    } else {
      if (entries.length === 0) {
        throw new NotFoundError(
          `No active connections found for "${b.provider}".`,
        );
      }
      if (entries.length > 1) {
        throw new BadRequestError(
          `Multiple active connections for "${b.provider}". Specify which one to disconnect with account or connection_id. ` +
            `Run 'assistant oauth status ${b.provider}' to see connected accounts and IDs.`,
        );
      }
      connectionId = entries[0].id;
      accountLabel = entries[0].account_label;
    }

    const disconnectPath = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/connections/${encodeURIComponent(connectionId!)}/disconnect/`;
    const disconnectResponse = await client.fetch(disconnectPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!disconnectResponse.ok) {
      const errorText = await disconnectResponse.text().catch(() => "");
      throw new InternalError(
        `Platform returned HTTP ${disconnectResponse.status}${errorText ? `: ${errorText}` : ""}`,
      );
    }

    const result: Record<string, unknown> = {
      ok: true,
      provider: b.provider,
      connectionId,
    };
    if (accountLabel) result.account = accountLabel;
    return result;
  }

  // BYO path
  let connectionId: string | undefined;
  let accountLabel: string | undefined;

  if (b.account) {
    const conn = getActiveConnection(b.provider, { account: b.account });
    if (!conn) {
      throw new NotFoundError(
        `No active connection found for "${b.provider}" with account "${b.account}".`,
      );
    }
    connectionId = conn.id;
    accountLabel = conn.accountInfo ?? undefined;
  } else if (b.connection_id) {
    const conn = getConnection(b.connection_id);
    if (!conn || conn.provider !== b.provider) {
      throw new NotFoundError(
        `Connection "${b.connection_id}" is not an active ${b.provider} connection.`,
      );
    }
    connectionId = conn.id;
    accountLabel = conn.accountInfo ?? undefined;
  } else {
    const active = listActiveConnectionsByProvider(b.provider);
    if (active.length === 0) {
      throw new NotFoundError(
        `No active connections found for "${b.provider}".`,
      );
    }
    if (active.length > 1) {
      throw new BadRequestError(
        `Multiple active connections for "${b.provider}". Specify which one to disconnect with account or connection_id. ` +
          `Run 'assistant oauth status ${b.provider}' to see connected accounts and IDs.`,
      );
    }
    connectionId = active[0].id;
    accountLabel = active[0].accountInfo ?? undefined;
  }

  const oauthResult = await disconnectOAuthProvider(
    b.provider,
    undefined,
    connectionId,
  );
  if (oauthResult === "error") {
    throw new InternalError(
      `Failed to disconnect OAuth provider "${b.provider}" — please try again.`,
    );
  }

  const result: Record<string, unknown> = {
    ok: true,
    provider: b.provider,
    connectionId,
  };
  if (accountLabel) result.account = accountLabel;
  return result;
}

// ---------------------------------------------------------------------------
// Mode handlers
// ---------------------------------------------------------------------------

function handleModeGet({ queryParams = {} }: RouteHandlerArgs) {
  const provider = queryParams.provider;
  if (!provider) throw new BadRequestError("provider query param is required");

  const providerRow = getProvider(provider);
  if (!providerRow) {
    throw new NotFoundError(
      `Unknown provider "${provider}". Run 'assistant oauth providers list' to see available providers.`,
    );
  }

  const managedKey = getManagedServiceConfigKey(provider);
  if (managedKey === null) {
    return {
      ok: true,
      provider,
      mode: "your-own",
      managedModeSupported: false,
    };
  }

  const services: Services = getConfig().services;
  const currentMode = getServiceMode(services, managedKey as keyof Services);

  return {
    ok: true,
    provider,
    mode: currentMode,
    managedModeSupported: true,
  };
}

async function handleModeSet({ body = {} }: RouteHandlerArgs) {
  const b = body as { provider: string; mode: string };
  if (!b.provider) throw new BadRequestError("provider is required");
  if (!b.mode) throw new BadRequestError("mode is required");

  const providerRow = getProvider(b.provider);
  if (!providerRow) {
    throw new NotFoundError(
      `Unknown provider "${b.provider}". Run 'assistant oauth providers list' to see available providers.`,
    );
  }

  if (b.mode !== "managed" && b.mode !== "your-own") {
    throw new BadRequestError(
      `Invalid mode "${b.mode}". Valid values are "managed" or "your-own".`,
    );
  }

  const managedKey = getManagedServiceConfigKey(b.provider);

  if (managedKey === null) {
    if (b.mode === "your-own") {
      return {
        ok: true,
        provider: b.provider,
        mode: "your-own",
        changed: false,
        managedModeSupported: false,
      };
    }
    throw new BadRequestError(
      `Managed mode is not available for ${b.provider}. Only providers with platform-managed OAuth support can be switched to managed mode.`,
    );
  }

  // Require platform connection when switching to managed mode
  if (b.mode === "managed") {
    const client = await VellumPlatformClient.create();
    if (!client) {
      throw new BadRequestError(
        "Not connected to Vellum platform. Run `vellum platform connect` to connect first.",
      );
    }
  }

  const services: Services = getConfig().services;
  const currentMode = getServiceMode(services, managedKey as keyof Services);

  if (currentMode === b.mode) {
    return {
      ok: true,
      provider: b.provider,
      mode: b.mode,
      changed: false,
      managedModeSupported: true,
    };
  }

  const raw = loadRawConfig();
  setNestedValue(raw, `services.${managedKey}.mode`, b.mode);
  saveRawConfig(raw);

  // Best-effort check for active connections on old and new modes
  let oldModeConnections = 0;
  let newModeConnections = 0;
  if (currentMode === "managed") {
    oldModeConnections = await countManagedConnections(b.provider);
    newModeConnections = listActiveConnectionsByProvider(b.provider).length;
  } else {
    oldModeConnections = listActiveConnectionsByProvider(b.provider).length;
    newModeConnections = await countManagedConnections(b.provider);
  }

  let hint: string | undefined;
  if (oldModeConnections > 0 && newModeConnections === 0) {
    hint = `No active connections in ${b.mode} mode. Run 'assistant oauth connect ${b.provider}' to connect.`;
  }

  const result: Record<string, unknown> = {
    ok: true,
    provider: b.provider,
    mode: b.mode,
    changed: true,
    managedModeSupported: true,
  };
  if (hint) result.hint = hint;
  return result;
}

// ---------------------------------------------------------------------------
// Status handler
// ---------------------------------------------------------------------------

async function handleStatus({ queryParams = {} }: RouteHandlerArgs) {
  const provider = queryParams.provider;
  if (!provider) throw new BadRequestError("provider query param is required");

  const providerRow = getProvider(provider);
  if (!providerRow) {
    throw new NotFoundError(
      `Unknown provider "${provider}". Run 'assistant oauth providers list' to see available providers.`,
    );
  }

  const managed = isManagedMode(provider);

  if (managed) {
    const client = await requirePlatformClient();
    const rawEntries = await fetchActiveConnections(client, provider);

    const connections = rawEntries.map((c) => ({
      id: c.id,
      account: c.account_label ?? null,
      grantedScopes: c.scopes_granted ?? [],
      status: c.status ?? "ACTIVE",
    }));

    return {
      ok: true,
      provider,
      mode: "managed",
      connections,
    };
  }

  // BYO path
  if (providerRow.authorizeUrl === "urn:manual-token") {
    await syncManualTokenConnection(provider);
  }

  const allConnections = listConnections(provider);
  const activeRows = allConnections.filter((r) => r.status === "active");

  const connections = activeRows.map((r) => {
    let grantedScopes: string[] = [];
    try {
      grantedScopes = r.grantedScopes ? JSON.parse(r.grantedScopes) : [];
    } catch {
      // Malformed JSON — default to empty
    }

    return {
      id: r.id,
      account: r.accountInfo ?? null,
      grantedScopes,
      expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
      hasRefreshToken: r.hasRefreshToken === 1,
      status: r.status,
    };
  });

  return {
    ok: true,
    provider,
    mode: "byo",
    connections,
  };
}

// ---------------------------------------------------------------------------
// Ping handler
// ---------------------------------------------------------------------------

async function handlePing({ body = {} }: RouteHandlerArgs) {
  const b = body as {
    provider: string;
    account?: string;
    client_id?: string;
  };

  if (!b.provider) throw new BadRequestError("provider is required");

  const providerRow = getProvider(b.provider);
  if (!providerRow) {
    throw new NotFoundError(
      `Unknown provider "${b.provider}". Run 'assistant oauth providers list' to see available providers.`,
    );
  }

  if (!providerRow.pingUrl) {
    throw new BadRequestError(
      `No ping URL configured for "${b.provider}". Register one with 'assistant oauth providers register --ping-url <url>'.`,
    );
  }

  const pingUrl = providerRow.pingUrl as string;
  const parsed = new URL(pingUrl);
  const baseUrl = `${parsed.protocol}//${parsed.host}`;
  const path = parsed.pathname;

  const query: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) {
    query[key] = value;
  }

  const resolveOptions: ResolveOAuthConnectionOptions = {};
  if (b.account) resolveOptions.account = b.account;
  if (b.client_id) resolveOptions.clientId = b.client_id;

  const connection = await resolveOAuthConnection(b.provider, resolveOptions);

  const method = (providerRow.pingMethod as string | null) ?? "GET";

  const pingHeaders: Record<string, string> = providerRow.pingHeaders
    ? JSON.parse(providerRow.pingHeaders as string)
    : {};

  const pingBody: unknown = providerRow.pingBody
    ? JSON.parse(providerRow.pingBody as string)
    : undefined;

  const response = await connection.request({
    method,
    path,
    baseUrl,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(pingHeaders).length > 0 ? { headers: pingHeaders } : {}),
    ...(pingBody !== undefined ? { body: pingBody } : {}),
  });

  if (response.status >= 200 && response.status < 300) {
    return { ok: true, provider: b.provider, status: response.status };
  }

  const payload: Record<string, unknown> = {
    ok: false,
    provider: b.provider,
    status: response.status,
    error: `Ping failed with HTTP ${response.status}`,
  };

  if (response.status === 401 || response.status === 403) {
    payload.hint =
      `Run 'assistant oauth status ${b.provider}' to check connection health. ` +
      `To reconnect, run 'assistant oauth connect --help'.`;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Token handler
// ---------------------------------------------------------------------------

async function handleToken({ body = {} }: RouteHandlerArgs) {
  const b = body as {
    provider: string;
    account?: string;
    client_id?: string;
  };

  if (!b.provider) throw new BadRequestError("provider is required");

  if (isManagedMode(b.provider)) {
    throw new BadRequestError(
      "Token retrieval is not supported for platform-managed providers. " +
        "When a provider is in managed mode, Vellum handles OAuth tokens on your behalf — " +
        "they are not exposed directly.\n\n" +
        `To verify your connection is working, run 'assistant oauth ping ${b.provider}'.\n` +
        `To make authenticated requests, use 'assistant oauth request --provider ${b.provider} <url>'.`,
    );
  }

  let tokenOpts: string | { connectionId: string } | undefined;

  if (b.account || b.client_id) {
    const conn = getActiveConnection(b.provider, {
      clientId: b.client_id,
      account: b.account,
    });
    if (!conn) {
      const hint = b.account
        ? ` for account "${b.account}"`
        : b.client_id
          ? ` with client ID "${b.client_id}"`
          : "";
      throw new NotFoundError(
        `No active connection found for "${b.provider}"${hint}. Connect first with 'assistant oauth connect ${b.provider}'.`,
      );
    }
    tokenOpts = { connectionId: conn.id };
  }

  const token = await withValidToken(b.provider, async (t) => t, tokenOpts);

  return { ok: true, token };
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function tryJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readBodyData(data: string): unknown {
  if (data === "@-") {
    const raw = readFileSync("/dev/stdin", "utf-8");
    return tryJsonParse(raw);
  }

  if (data.startsWith("@")) {
    const filePath = data.slice(1);
    const raw = readFileSync(filePath, "utf-8");
    return tryJsonParse(raw);
  }

  return tryJsonParse(data);
}

async function handleRequest({ body = {} }: RouteHandlerArgs) {
  const b = body as {
    provider: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    /** Pre-parsed body data (file/stdin reading happens CLI-side). */
    parsed_data?: unknown;
    /** Raw data string (for direct API callers, not the CLI). */
    data?: string;
    force_get?: boolean;
    head?: boolean;
    account?: string;
    client_id?: string;
  };

  if (!b.provider) throw new BadRequestError("provider is required");
  if (!b.url) throw new BadRequestError("url is required");

  const providerRow = getProvider(b.provider);
  if (!providerRow) {
    throw new NotFoundError(
      `Unknown provider "${b.provider}". Run 'assistant oauth providers list' to see available providers.`,
    );
  }

  const managed = isManagedMode(b.provider);

  if (b.client_id) {
    if (managed) {
      log.info("--client-id is ignored for platform-managed providers");
    } else {
      const app = getAppByProviderAndClientId(b.provider, b.client_id);
      if (!app) {
        throw new NotFoundError(
          `No registered OAuth app found for "${b.provider}" with client ID "${b.client_id}".`,
        );
      }
    }
  }

  // Parse URL
  let baseUrl: string | undefined;
  let requestPath: string;
  const queryFromUrl: Record<string, string | string[]> = {};

  if (b.url.startsWith("http://") || b.url.startsWith("https://")) {
    const parsed = new URL(b.url);
    assertOAuthRequestUrlAllowed(providerRow, parsed);
    baseUrl = `${parsed.protocol}//${parsed.host}`;
    requestPath = parsed.pathname;
    for (const [key, value] of parsed.searchParams.entries()) {
      const existing = queryFromUrl[key];
      if (existing !== undefined) {
        queryFromUrl[key] = Array.isArray(existing)
          ? [...existing, value]
          : [existing, value];
      } else {
        queryFromUrl[key] = value;
      }
    }
  } else {
    const qIdx = b.url.indexOf("?");
    if (qIdx !== -1) {
      requestPath = b.url.slice(0, qIdx);
      const embeddedParams = new URLSearchParams(b.url.slice(qIdx + 1));
      for (const [key, value] of embeddedParams.entries()) {
        const existing = queryFromUrl[key];
        if (existing !== undefined) {
          queryFromUrl[key] = Array.isArray(existing)
            ? [...existing, value]
            : [existing, value];
        } else {
          queryFromUrl[key] = value;
        }
      }
    } else {
      requestPath = b.url;
    }
  }

  // Resolve method
  let method: string;
  if (b.head) {
    method = "HEAD";
  } else if (b.method) {
    method = b.method.toUpperCase();
  } else if (b.force_get) {
    method = "GET";
  } else if (b.data !== undefined || b.parsed_data !== undefined) {
    method = "POST";
  } else {
    method = "GET";
  }

  // Handle body / query params
  let reqBody: unknown = undefined;
  const query: Record<string, string | string[]> = { ...queryFromUrl };

  // Use pre-parsed data from CLI, or fall back to raw data string for direct API callers
  const resolvedData =
    b.parsed_data !== undefined
      ? b.parsed_data
      : b.data !== undefined
        ? readBodyData(b.data)
        : undefined;

  if (resolvedData !== undefined) {
    const rawBody = resolvedData;

    if (b.force_get) {
      if (typeof rawBody === "string") {
        const bodyParams = new URLSearchParams(rawBody);
        for (const [key, value] of bodyParams.entries()) {
          const existing = query[key];
          if (existing !== undefined) {
            query[key] = Array.isArray(existing)
              ? [...existing, value]
              : [existing, value];
          } else {
            query[key] = value;
          }
        }
      } else if (
        rawBody !== null &&
        typeof rawBody === "object" &&
        !Array.isArray(rawBody)
      ) {
        for (const [key, value] of Object.entries(
          rawBody as Record<string, unknown>,
        )) {
          const existing = query[key];
          const strValue = String(value);
          if (existing !== undefined) {
            query[key] = Array.isArray(existing)
              ? [...existing, strValue]
              : [existing, strValue];
          } else {
            query[key] = strValue;
          }
        }
      }
    } else {
      reqBody = rawBody;
    }
  }

  // Resolve connection and make request
  const resolveOptions: ResolveOAuthConnectionOptions = {};
  if (b.client_id && !managed) {
    resolveOptions.clientId = b.client_id;
  }
  if (b.account) {
    resolveOptions.account = b.account;
  }

  const { connection, ambiguous, allAccounts } =
    await resolveOAuthConnectionWithMeta(b.provider, resolveOptions);

  const headers = b.headers ?? {};

  const req: OAuthConnectionRequest = {
    method,
    path: requestPath,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(reqBody !== undefined ? { body: reqBody } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };

  const response = await connection.request(req);

  const result: Record<string, unknown> = {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: response.headers,
    body: response.body,
    // Which connected account actually served the request, so the caller can
    // tell whether the intended account was used.
    account: connection.accountInfo,
  };

  // Surface a caller-visible warning when the provider had several active
  // connections and no account was pinned — the model must see that a
  // silent pick happened, not just the daemon log.
  if (ambiguous && allAccounts.length > 1) {
    const selected = allAccounts[0];
    result.accountWarning =
      `Multiple ${b.provider} accounts are connected (${allAccounts.join(", ")}); ` +
      `used "${selected}". Pass --account to select a specific one.`;
  }

  if (response.status === 401 || response.status === 403) {
    result.hint = managed
      ? `Request returned HTTP ${response.status}. The OAuth token may be expired or revoked.\n\n` +
        `Run 'assistant oauth status ${b.provider}' to check connection health.\n` +
        `To reconnect, run 'assistant oauth connect --help'.`
      : `Request returned HTTP ${response.status}. The OAuth token may be expired or revoked.\n\n` +
        `Run 'assistant oauth status ${b.provider}' to check connection status.\n` +
        `To reconnect, run 'assistant oauth connect --help'.`;
  } else if (response.status === 404 && isHtmlResponse(response.headers)) {
    // An HTML 404 (rather than a JSON API error) is the signature of a request
    // reaching a valid host but a path that host does not serve — e.g. a
    // relative path resolved against a base URL that points at the wrong
    // product. Surface the resolved base so the caller can tell where the path
    // landed, and steer them to an absolute URL for non-default services.
    const resolvedBaseUrl =
      baseUrl ?? providerRow.baseUrl ?? "(none configured)";
    result.hint =
      `Request returned HTTP ${response.status} with an HTML body, which usually means ` +
      `the path does not exist on the base URL it resolved against.\n\n` +
      `This request used base URL "${resolvedBaseUrl}" (relative paths are joined onto it). ` +
      `If you meant a different service on this provider, pass an absolute URL ` +
      `(e.g. https://host/full/path) so the host and full path are set explicitly.`;
  }

  return result;
}

/** True when the response's Content-Type header indicates an HTML body. */
function isHtmlResponse(headers: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "content-type") {
      return value.toLowerCase().includes("text/html");
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Connect handler (managed path for platform OAuth)
// ---------------------------------------------------------------------------

async function handleManagedConnect({ body = {} }: RouteHandlerArgs) {
  const b = body as {
    provider: string;
    scopes?: string[];
    redirect_after_connect?: string;
  };

  if (!b.provider) throw new BadRequestError("provider is required");

  const client = await requirePlatformClient();

  const startPath = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/${encodeURIComponent(b.provider)}/start/`;

  const reqBody: Record<string, unknown> = {};
  if (b.scopes && b.scopes.length > 0) {
    reqBody.requested_scopes = b.scopes;
  }
  reqBody.redirect_after_connect =
    b.redirect_after_connect ?? "/account/oauth/complete";

  const response = await client.fetch(startPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const baseMsg = `Platform returned HTTP ${response.status}${errorText ? `: ${errorText}` : ""}`;
    if (response.status === 401 || response.status === 403) {
      throw new InternalError(
        `${baseMsg}. Your platform session may have expired. Run \`vellum platform connect\` to reconnect.`,
      );
    }
    throw new InternalError(baseMsg);
  }

  const result = (await response.json()) as { connect_url?: string };

  if (!result.connect_url) {
    throw new InternalError(
      "Platform did not return a connect URL — the OAuth flow could not be started",
    );
  }

  return { ok: true, connect_url: result.connect_url };
}

async function handleManagedConnectPoll({
  queryParams = {},
}: RouteHandlerArgs) {
  const provider = queryParams.provider;
  if (!provider) throw new BadRequestError("provider query param is required");

  const client = await requirePlatformClient();
  const entries = await fetchActiveConnections(client, provider);

  return {
    ok: true,
    connections: entries.map((e) => ({
      id: e.id,
      account_label: e.account_label ?? null,
      scopes_granted: e.scopes_granted ?? [],
    })),
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "oauth_disconnect",
    endpoint: "oauth/disconnect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Disconnect OAuth provider",
    description:
      "Disconnect an OAuth provider and remove associated credentials (BYO or managed).",
    tags: ["oauth"],
    handler: handleDisconnect,
  },
  {
    operationId: "oauth_mode_get",
    endpoint: "oauth/mode",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Get OAuth mode",
    description:
      "Get the current OAuth mode (managed or your-own) for a provider.",
    tags: ["oauth"],
    queryParams: [
      {
        name: "provider",
        type: "string",
        required: true,
        description: "Provider key",
      },
    ],
    handler: handleModeGet,
  },
  {
    operationId: "oauth_mode_set",
    endpoint: "oauth/mode",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Set OAuth mode",
    description: "Set the OAuth mode (managed or your-own) for a provider.",
    tags: ["oauth"],
    handler: handleModeSet,
  },
  {
    operationId: "oauth_status",
    endpoint: "oauth/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Get OAuth status",
    description:
      "Show OAuth connection status for a specified provider (BYO or managed).",
    tags: ["oauth"],
    queryParams: [
      {
        name: "provider",
        type: "string",
        required: true,
        description: "Provider key",
      },
    ],
    handler: handleStatus,
  },
  {
    operationId: "oauth_ping",
    endpoint: "oauth/ping",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Ping OAuth provider",
    description:
      "Verify an OAuth token is valid by hitting the provider's configured health-check endpoint.",
    tags: ["oauth"],
    handler: handlePing,
  },
  {
    operationId: "oauth_token",
    endpoint: "oauth/token",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Get OAuth token",
    description: "Retrieve a valid OAuth access token for a BYO-mode provider.",
    tags: ["oauth"],
    handler: handleToken,
  },
  {
    operationId: "oauth_request",
    endpoint: "oauth/request",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Make authenticated OAuth request",
    description:
      "Make an authenticated HTTP request through an OAuth connection (supports curl-like interface).",
    tags: ["oauth"],
    handler: handleRequest,
  },
  {
    operationId: "oauth_managed_connect_start",
    endpoint: "oauth/managed-connect/start",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Start managed OAuth connect",
    description:
      "Start a managed (platform) OAuth connect flow and return the connect URL.",
    tags: ["oauth"],
    handler: handleManagedConnect,
  },
  {
    operationId: "oauth_managed_connect_poll",
    endpoint: "oauth/managed-connect/poll",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Poll managed OAuth connections",
    description:
      "Fetch active platform connections for a provider (used to detect new connections after managed connect).",
    tags: ["oauth"],
    queryParams: [
      {
        name: "provider",
        type: "string",
        required: true,
        description: "Provider key",
      },
    ],
    handler: handleManagedConnectPoll,
  },
];
