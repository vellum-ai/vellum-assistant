import type { OAuthConnection } from "@/generated/api/types.gen";
import type { PlatformGateState } from "@/hooks/use-platform-gate";

import {
  integrationHostname,
  type IntegrationItem,
  type McpPluginDefinition,
  type McpPluginMethod,
} from "./integration-items";
import type { McpServerEntry } from "./mcp/mcp-api";

/**
 * Every way a user can connect an integration, collapsed to the four shapes
 * the UI has to explain differently:
 *
 * - `mcp-oauth`: the provider's remote MCP server runs its own sign-in.
 *   Works the same on platform-hosted and self-hosted assistants, so it
 *   leads whenever the catalog has one.
 * - `mcp-manual`: a remote MCP server whose provider must allowlist our
 *   callback URL before sign-in can work.
 * - `managed-oauth`: sign in through Vellum's hosted OAuth app. Needs a
 *   platform session.
 * - `own-oauth`: register an OAuth app at the provider and paste its client
 *   credentials. Self-hosted assistants only.
 */
export type ConnectMethodKind =
  | "mcp-oauth"
  | "mcp-manual"
  | "managed-oauth"
  | "own-oauth";

export type ConnectAvailability = "available" | "login-required";

/** MCP methods carry an endpoint and a tool list; the OAuth ones do not. */
export function isMcpMethodKind(kind: ConnectMethodKind): boolean {
  return kind === "mcp-oauth" || kind === "mcp-manual";
}

export type ConnectionStatus =
  | "connected"
  | "connecting"
  | "needs-attention"
  | "pending";

export interface ConnectionSummary {
  id: string;
  methodId: string;
  methodKind: ConnectMethodKind;
  /** Account email or workspace name. Null falls back to a method label. */
  label: string | null;
  /** Secondary line: endpoint hostname for MCP servers. */
  detail?: string;
  status: ConnectionStatus;
  /** Set for MCP servers a plugin owns. Disconnecting removes that plugin. */
  pluginName?: string;
  serverId?: string;
  canReconnect: boolean;
}

export interface ConnectMethod {
  id: string;
  kind: ConnectMethodKind;
  availability: ConnectAvailability;
  /**
   * The catalog's own setup text for this method, verbatim. It mixes sign-in
   * guidance with provider preconditions in one free-text field, and nothing
   * here guesses which is which: splitting prose by keyword decides, on the
   * user's behalf, what to hide from them.
   */
  instructions?: string;
  setupGuideUrl?: string;
  connections: ConnectionSummary[];
  plugin?: McpPluginDefinition;
}

export interface ConnectPlan {
  name: string;
  description: string | null;
  iconKey: string;
  logoUrl: string | null;
  /** The recommended path. Rendered as the one obvious action. */
  primary: ConnectMethod;
  /** Every other path, behind the chevron on the connect button. */
  alternatives: ConnectMethod[];
}

export interface ConnectPlanContext {
  platformGate: PlatformGateState;
  /** Bring-your-own OAuth apps only exist on self-hosted assistants. */
  ownOAuthAvailable: boolean;
}

export type ConnectableIntegrationItem = Exclude<
  IntegrationItem,
  { kind: "mcp" }
>;

function mcpConnectionStatus(server: McpServerEntry): ConnectionStatus {
  switch (server.status) {
    case "connected":
      return "connected";
    case "connecting":
    case "starting":
      return "connecting";
    case "declared":
      return "pending";
    default:
      return "needs-attention";
  }
}

function mcpConnections(
  method: McpPluginMethod,
  methodId: string,
  kind: ConnectMethodKind,
): ConnectionSummary[] {
  return method.servers.map((server) => {
    const status = mcpConnectionStatus(server);
    return {
      id: `mcp:${server.id}`,
      methodId,
      methodKind: kind,
      label: null,
      detail: integrationHostname(server),
      status,
      pluginName: server.pluginName,
      serverId: server.id,
      canReconnect:
        status !== "connected" &&
        status !== "connecting" &&
        server.transport.type !== "stdio" &&
        !server.hasStaticAuth,
    };
  });
}

function oauthConnections(
  connections: OAuthConnection[],
  methodId: string,
): ConnectionSummary[] {
  return connections.map((connection) => ({
    id: `oauth:${connection.id}`,
    methodId,
    methodKind: "managed-oauth",
    label: connection.account_label,
    status: connection.connected ? "connected" : "needs-attention",
    canReconnect: !connection.connected,
  }));
}

function pluginMethod(method: McpPluginMethod): ConnectMethod {
  const { definition } = method;
  const kind: ConnectMethodKind =
    definition.setup.mode === "manual" ? "mcp-manual" : "mcp-oauth";
  const id = `mcp:${definition.pluginName}`;
  return {
    id,
    kind,
    availability: "available",
    instructions: definition.setup.instructions,
    setupGuideUrl: definition.documentationUrl,
    connections: mcpConnections(method, id, kind),
    plugin: definition,
  };
}

/**
 * Decide which path to put in front of the user and which to tuck away.
 *
 * Order of preference: the provider's MCP server (works everywhere, the
 * provider maintains it), then Vellum's managed OAuth, then bring-your-own
 * OAuth. Managed OAuth still leads when it is the only path and the user
 * only needs to log in, because logging in is the fix. A managed method
 * that cannot work here at all (gated) is dropped.
 *
 * Returns `null` when every path was dropped, which a gated organization can
 * reach with an ordinary catalog. The caller leaves the integration out of
 * the list rather than offering an action that goes nowhere.
 */
export function buildConnectPlan(
  item: ConnectableIntegrationItem,
  context: ConnectPlanContext,
): ConnectPlan | null {
  const methods: ConnectMethod[] = [];
  let iconKey: string;
  let logoUrl: string | null = null;
  let description: string | null;

  if (item.kind === "oauth") {
    iconKey = item.provider.provider_key;
    logoUrl = item.provider.logo_url;
    description = item.provider.description;
    for (const method of item.methods) {
      methods.push(pluginMethod(method));
    }
    if (context.platformGate !== "gated") {
      const managedId = `managed:${item.provider.provider_key}`;
      methods.push({
        id: managedId,
        kind: "managed-oauth",
        availability:
          context.platformGate === "full" ? "available" : "login-required",
        connections: oauthConnections(item.connections, managedId),
      });
    }
    if (context.ownOAuthAvailable) {
      methods.push({
        id: `own:${item.provider.provider_key}`,
        kind: "own-oauth",
        availability: "available",
        setupGuideUrl: item.provider.dashboard_url ?? undefined,
        connections: [],
      });
    }
  } else {
    const { definition } = item.method;
    iconKey = definition.pluginName;
    logoUrl = definition.logo || null;
    description = definition.description;
    methods.push(pluginMethod(item.method));
  }

  const [primary, ...alternatives] = methods;
  if (!primary) {
    return null;
  }
  return {
    name: item.name,
    description,
    iconKey,
    logoUrl,
    primary,
    alternatives,
  };
}

export function planMethods(plan: ConnectPlan): ConnectMethod[] {
  return [plan.primary, ...plan.alternatives];
}

export function planConnections(plan: ConnectPlan): ConnectionSummary[] {
  return planMethods(plan).flatMap((method) => method.connections);
}

/**
 * The methods that can still take a connection of their own.
 *
 * A catalog plugin declares its MCP server and installs once, so an MCP
 * method that already has a connection has no second one to offer: pointing
 * a user back at it leads nowhere. OAuth methods hold as many accounts as the
 * user signs in with, so they stay on offer.
 */
export function connectableMethods(plan: ConnectPlan): ConnectMethod[] {
  return planMethods(plan).filter(
    (method) =>
      !isMcpMethodKind(method.kind) || method.connections.length === 0,
  );
}
