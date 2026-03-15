import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger, type LogFileConfig } from "./logger.js";
import { getRootDir } from "./credential-reader.js";

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
 * settings. The CLI writes these values before starting the gateway.
 */
function readWorkspaceConfig(): Record<string, unknown> {
  try {
    const configPath = join(getRootDir(), "workspace", "config.json");
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
  const runtimePort = process.env.RUNTIME_HTTP_PORT || "7821";
  const assistantRuntimeBaseUrl = `http://localhost:${runtimePort}`;

  const gatewayInternalBaseUrl = `http://127.0.0.1:${port}`;

  // Read operational settings from workspace config. The CLI writes these
  // before spawning the gateway (see cli/src/lib/local.ts writeGatewayConfig).
  const wsConfig = readWorkspaceConfig();
  const gw = (wsConfig.gateway ?? {}) as Record<string, unknown>;

  const runtimeProxyEnabled =
    gw.runtimeProxyEnabled === true || gw.runtimeProxyEnabled === "true";
  const runtimeProxyRequireAuth =
    gw.runtimeProxyRequireAuth !== false &&
    gw.runtimeProxyRequireAuth !== "false";
  const unmappedPolicy = gw.unmappedPolicy === "default" ? "default" : "reject";
  const defaultAssistantId =
    typeof gw.defaultAssistantId === "string" && gw.defaultAssistantId
      ? gw.defaultAssistantId
      : undefined;
  const routingEntries = parseRoutingEntries(gw.routingEntries);

  const logFile: LogFileConfig = {
    dir: undefined,
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
      telegram: 20 * 1024 * 1024, // Telegram Bot API getFile limit
      slack: 100 * 1024 * 1024, // Slack standard plan
      whatsapp: 16 * 1024 * 1024, // WhatsApp Business API limit
      default: 50 * 1024 * 1024, // Fallback; capped by runtime MAX_UPLOAD_BYTES (50 MB)
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
