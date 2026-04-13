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
  runtimeProxyEnabled: boolean;
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

  // Read operational settings from workspace config (Docker) or env vars (CLI).
  const wsConfig = readWorkspaceConfig();
  const gw = (wsConfig.gateway ?? {}) as Record<string, unknown>;

  // Env vars take precedence over workspace config values. This allows the
  // CLI to pass gateway settings directly via the process environment instead
  // of writing to the workspace config file.
  const runtimeProxyEnabled =
    process.env.RUNTIME_PROXY_ENABLED === "true" ||
    gw.runtimeProxyEnabled === true ||
    gw.runtimeProxyEnabled === "true";
  const runtimeProxyRequireAuth =
    process.env.RUNTIME_PROXY_REQUIRE_AUTH !== undefined
      ? process.env.RUNTIME_PROXY_REQUIRE_AUTH !== "false"
      : gw.runtimeProxyRequireAuth !== false &&
        gw.runtimeProxyRequireAuth !== "false";
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
      port,
      runtimeProxyEnabled,
      runtimeProxyRequireAuth,
      trustProxy: false,
    },
    "Configuration loaded",
  );

  return {
    assistantRuntimeBaseUrl,
    defaultAssistantId,
    gatewayInternalBaseUrl,
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
    runtimeProxyEnabled,
    runtimeProxyRequireAuth,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    unmappedPolicy,
    trustProxy: false,
  };
}
