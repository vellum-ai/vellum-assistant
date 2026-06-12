import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger, type LogFileConfig } from "./logger.js";
import { getWorkspaceDir } from "./credential-reader.js";
import { getGatewaySecurityDir } from "./paths.js";

const log = getLogger("config");

export type GatewayConfig = {
  assistantRuntimeBaseUrl: string;
  defaultAssistantId: string | undefined;
  gatewayInternalBaseUrl: string;
  velayBaseUrl?: string;
  logFile: LogFileConfig;
  maxAttachmentBytes: Record<
    "telegram" | "slack" | "whatsapp" | "default",
    number
  > &
    Record<string, number>;
  maxAttachmentConcurrency: number;
  maxWebhookPayloadBytes: number;
  port: number;
  routingEntries: RoutingEntry[];
  runtimeInitialBackoffMs: number;
  runtimeMaxRetries: number;
  runtimeProxyRequireAuth: boolean;
  runtimeTimeoutMs: number;
  shutdownDrainMs: number;
  unmappedPolicy: "reject" | "default";
  /** When true, trust X-Forwarded-For for client IP resolution (set when behind a reverse proxy). */
  trustProxy: boolean;
};

type RoutingEntry = {
  type: "conversation_id" | "actor_id";
  key: string;
  assistantId: string;
};

/**
 * Read the workspace config file at startup to populate gateway operational
 * settings. In Docker, the daemon writes these values. In local mode, the
 * CLI passes them via env vars (which take precedence in loadConfig()).
 */
function readWorkspaceConfig(): Record<string, unknown> {
  try {
    const configPath = join(getWorkspaceDir(), "config.json");
    if (!existsSync(configPath)) return {};
    const raw = readFileSync(configPath, "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseRoutingEntries(raw: unknown): RoutingEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: RoutingEntry[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      (item.type === "conversation_id" || item.type === "actor_id") &&
      typeof item.key === "string" &&
      typeof item.assistantId === "string"
    ) {
      entries.push({
        type: item.type,
        key: item.key,
        assistantId: item.assistantId,
      });
    }
  }
  return entries;
}

function parsePositiveInteger(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;

  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`${name} must be a positive integer`);
    }
    parsed = Number(trimmed);
  } else {
    throw new Error(`${name} must be a positive integer`);
  }

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(): GatewayConfig {
  const portRaw = process.env.GATEWAY_PORT || "7830";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("GATEWAY_PORT must be a valid port number");
  }

  // Port-based routing: each gateway instance reads RUNTIME_HTTP_PORT to
  // discover its co-located daemon's HTTP port. In multi-instance setups,
  // the CLI passes a per-instance daemon port so each gateway proxies to
  // the correct daemon process (see cli/src/lib/local.ts startGateway).
  const assistantHost = process.env.ASSISTANT_HOST || "localhost";
  const runtimePort = process.env.RUNTIME_HTTP_PORT || "7821";
  const assistantRuntimeBaseUrl = `http://${assistantHost}:${runtimePort}`;

  const gatewayInternalBaseUrl = `http://127.0.0.1:${port}`;
  const velayBaseUrl = process.env.VELAY_BASE_URL?.trim() || undefined;

  // Read operational settings from workspace config (Docker) or env vars (CLI).
  const wsConfig = readWorkspaceConfig();
  const gw = (wsConfig.gateway ?? {}) as Record<string, unknown>;

  // Env vars take precedence over workspace config values. This allows the
  // CLI to pass gateway settings directly via the process environment instead
  // of writing to the workspace config file.
  const runtimeProxyRequireAuth =
    process.env.RUNTIME_PROXY_REQUIRE_AUTH !== undefined
      ? process.env.RUNTIME_PROXY_REQUIRE_AUTH !== "false"
      : gw.runtimeProxyRequireAuth !== false &&
        gw.runtimeProxyRequireAuth !== "false";

  // When the gateway is fronted by a trusted reverse proxy (e.g. the
  // self-hosted nginx edge), enable this so the real client IP is resolved
  // from X-Forwarded-For for logging and rate limiting instead of the proxy's
  // loopback socket address. Defaults OFF — it must be explicitly opted into,
  // and only behind a proxy that overwrites client-supplied X-Forwarded-For.
  // The loopback auth fallback (allowLegacyLoopbackFallback) and the
  // /auth/token loopback gate also honor this flag via isLoopbackPeer, so a
  // proxied remote caller is judged by its real X-Forwarded-For IP rather than
  // the proxy's loopback socket (X-Forwarded-For is only trusted when the raw
  // peer is itself loopback). The strictly loopback-only mint endpoints
  // (/v1/guardian/init, /v1/pair) do NOT rely on this flag — they use the
  // unspoofable edge marker, see gateway/src/http/edge-forwarded-header.ts.
  const trustProxy =
    process.env.GATEWAY_TRUST_PROXY !== undefined
      ? process.env.GATEWAY_TRUST_PROXY === "true" ||
        process.env.GATEWAY_TRUST_PROXY === "1"
      : gw.trustProxy === true || gw.trustProxy === "true";
  const unmappedPolicyEnv = process.env.UNMAPPED_POLICY?.trim();
  const unmappedPolicy: "reject" | "default" =
    unmappedPolicyEnv === "default" || unmappedPolicyEnv === "reject"
      ? unmappedPolicyEnv
      : gw.unmappedPolicy === "default"
        ? "default"
        : "reject";
  const defaultAssistantId =
    process.env.DEFAULT_ASSISTANT_ID?.trim() ||
    (typeof gw.defaultAssistantId === "string" && gw.defaultAssistantId
      ? gw.defaultAssistantId
      : undefined);
  const runtimeTimeoutMs =
    parsePositiveInteger(
      process.env.RUNTIME_TIMEOUT_MS,
      "RUNTIME_TIMEOUT_MS",
    ) ??
    parsePositiveInteger(gw.runtimeTimeoutMs, "gateway.runtimeTimeoutMs") ??
    30000;
  let routingEntries: RoutingEntry[] = [];
  if (process.env.ROUTING_ENTRIES) {
    try {
      routingEntries = parseRoutingEntries(
        JSON.parse(process.env.ROUTING_ENTRIES),
      );
    } catch {
      log.warn("Invalid JSON in ROUTING_ENTRIES env var — ignoring");
    }
  } else {
    routingEntries = parseRoutingEntries(gw.routingEntries);
  }

  const logFile: LogFileConfig = {
    dir: join(getGatewaySecurityDir(), "logs"),
    retentionDays: 30,
  };

  log.info(
    {
      assistantRuntimeBaseUrl,
      gatewayInternalBaseUrl,
      routingEntryCount: routingEntries.length,
      unmappedPolicy,
      hasDefaultAssistant: !!defaultAssistantId,
      hasVelayBaseUrl: !!velayBaseUrl,
      port,
      runtimeProxyRequireAuth,
      runtimeTimeoutMs,
      trustProxy,
    },
    "Configuration loaded",
  );

  return {
    assistantRuntimeBaseUrl,
    defaultAssistantId,
    gatewayInternalBaseUrl,
    velayBaseUrl,
    logFile,
    maxAttachmentBytes: {
      telegram: 20 * 1024 * 1024, // Telegram Bot API getFile (download) limit
      telegramOutbound: 50 * 1024 * 1024, // Telegram Bot API sendDocument (upload) limit
      slack: 100 * 1024 * 1024, // Slack standard plan
      whatsapp: 16 * 1024 * 1024, // WhatsApp Business API limit
      default: 100 * 1024 * 1024, // Fallback; capped by runtime MAX_UPLOAD_BYTES (100 MB)
    },
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1024 * 1024,
    port,
    routingEntries,
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyRequireAuth,
    runtimeTimeoutMs,
    shutdownDrainMs: 5000,
    unmappedPolicy,
    trustProxy,
  };
}
