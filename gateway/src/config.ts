import { getLogger, type LogFileConfig } from "./logger.js";

const log = getLogger("config");

export type GatewayConfig = {
  assistantRuntimeBaseUrl: string;
  defaultAssistantId: string | undefined;
  gatewayInternalBaseUrl: string;
  logFile: LogFileConfig;
  maxAttachmentBytes: number;
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

  const logFile: LogFileConfig = {
    dir: undefined,
    retentionDays: 30,
  };

  log.info(
    {
      assistantRuntimeBaseUrl,
      gatewayInternalBaseUrl,
      routingEntryCount: 0,
      unmappedPolicy: "reject",
      hasDefaultAssistant: false,
      port,
      runtimeProxyEnabled: false,
      runtimeProxyRequireAuth: true,
      trustProxy: false,
    },
    "Configuration loaded",
  );

  return {
    assistantRuntimeBaseUrl,
    defaultAssistantId: undefined,
    gatewayInternalBaseUrl,
    logFile,
    maxAttachmentBytes: 20 * 1024 * 1024,
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1024 * 1024,
    port,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: true,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    unmappedPolicy: "reject",
    trustProxy: false,
  };
}
