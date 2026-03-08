import { getLogger, type LogFileConfig } from "./logger.js";

const log = getLogger("config");

export type RoutingEntry = {
  type: "conversation_id" | "actor_id";
  key: string;
  assistantId: string;
};

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

function parseRoutingJson(raw: string): RoutingEntry[] {
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GATEWAY_ASSISTANT_ROUTING_JSON is not valid JSON");
  }

  const entries: RoutingEntry[] = [];
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("GATEWAY_ASSISTANT_ROUTING_JSON must be a JSON object");
  }
  for (const [key, assistantId] of Object.entries(parsed)) {
    if (typeof assistantId !== "string" || !assistantId) {
      throw new Error(`Invalid assistant ID for routing key "${key}"`);
    }
    if (key.startsWith("conversation:")) {
      entries.push({
        type: "conversation_id",
        key: key.slice(13),
        assistantId,
      });
    } else if (key.startsWith("actor:")) {
      entries.push({ type: "actor_id", key: key.slice(6), assistantId });
    } else {
      throw new Error(
        `Invalid routing key "${key}": must start with "conversation:" or "actor:"`,
      );
    }
  }
  return entries;
}

export function loadConfig(): GatewayConfig {
  // Port-based routing: each gateway instance reads RUNTIME_HTTP_PORT to
  // discover its co-located daemon's HTTP port. In multi-instance setups,
  // the CLI passes a per-instance daemon port so each gateway proxies to
  // the correct daemon process (see cli/src/lib/local.ts startGateway).
  const runtimePort = process.env.RUNTIME_HTTP_PORT || "7821";
  const assistantRuntimeBaseUrl =
    process.env.ASSISTANT_RUNTIME_BASE_URL || `http://localhost:${runtimePort}`;

  const routingJson = process.env.GATEWAY_ASSISTANT_ROUTING_JSON || "{}";
  const routingEntries = parseRoutingJson(routingJson);

  const defaultAssistantId =
    process.env.GATEWAY_DEFAULT_ASSISTANT_ID || undefined;

  const unmappedPolicyRaw = process.env.GATEWAY_UNMAPPED_POLICY || "reject";
  if (unmappedPolicyRaw !== "reject" && unmappedPolicyRaw !== "default") {
    throw new Error(
      `GATEWAY_UNMAPPED_POLICY must be "reject" or "default", got "${unmappedPolicyRaw}"`,
    );
  }
  const unmappedPolicy = unmappedPolicyRaw;

  if (unmappedPolicy === "default" && !defaultAssistantId) {
    throw new Error(
      'GATEWAY_DEFAULT_ASSISTANT_ID is required when GATEWAY_UNMAPPED_POLICY is "default"',
    );
  }

  const portRaw = process.env.GATEWAY_PORT || "7830";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("GATEWAY_PORT must be a valid port number");
  }

  const gatewayInternalBaseUrl = (
    process.env.GATEWAY_INTERNAL_BASE_URL || `http://127.0.0.1:${port}`
  ).replace(/\/+$/, "");

  const proxyEnabledRaw = process.env.GATEWAY_RUNTIME_PROXY_ENABLED;
  if (
    proxyEnabledRaw !== undefined &&
    proxyEnabledRaw !== "true" &&
    proxyEnabledRaw !== "false"
  ) {
    throw new Error(
      `GATEWAY_RUNTIME_PROXY_ENABLED must be "true" or "false", got "${proxyEnabledRaw}"`,
    );
  }
  const runtimeProxyEnabled = proxyEnabledRaw === "true";

  const proxyRequireAuthRaw = process.env.GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH;
  if (
    proxyRequireAuthRaw !== undefined &&
    proxyRequireAuthRaw !== "true" &&
    proxyRequireAuthRaw !== "false"
  ) {
    throw new Error(
      `GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH must be "true" or "false", got "${proxyRequireAuthRaw}"`,
    );
  }
  const runtimeProxyRequireAuth = proxyRequireAuthRaw !== "false";

  const MAX_TIMEOUT_MS = 2_147_483_647; // 2^31 - 1, max safe setTimeout delay

  const shutdownDrainMsRaw = process.env.GATEWAY_SHUTDOWN_DRAIN_MS || "5000";
  const shutdownDrainMs = Number(shutdownDrainMsRaw);
  if (!Number.isFinite(shutdownDrainMs) || shutdownDrainMs < 0) {
    throw new Error("GATEWAY_SHUTDOWN_DRAIN_MS must be a non-negative number");
  }
  if (shutdownDrainMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `GATEWAY_SHUTDOWN_DRAIN_MS must not exceed ${MAX_TIMEOUT_MS} (setTimeout max safe delay)`,
    );
  }

  const runtimeTimeoutMs = Number(
    process.env.GATEWAY_RUNTIME_TIMEOUT_MS || "30000",
  );
  if (!Number.isFinite(runtimeTimeoutMs) || runtimeTimeoutMs <= 0) {
    throw new Error("GATEWAY_RUNTIME_TIMEOUT_MS must be a positive number");
  }

  const runtimeMaxRetries = Number(
    process.env.GATEWAY_RUNTIME_MAX_RETRIES || "2",
  );
  if (!Number.isInteger(runtimeMaxRetries) || runtimeMaxRetries < 0) {
    throw new Error(
      "GATEWAY_RUNTIME_MAX_RETRIES must be a non-negative integer",
    );
  }

  const runtimeInitialBackoffMs = Number(
    process.env.GATEWAY_RUNTIME_INITIAL_BACKOFF_MS || "500",
  );
  if (
    !Number.isFinite(runtimeInitialBackoffMs) ||
    runtimeInitialBackoffMs <= 0
  ) {
    throw new Error(
      "GATEWAY_RUNTIME_INITIAL_BACKOFF_MS must be a positive number",
    );
  }

  const maxWebhookPayloadBytes = Number(
    process.env.GATEWAY_MAX_WEBHOOK_PAYLOAD_BYTES || String(1024 * 1024),
  );
  if (!Number.isFinite(maxWebhookPayloadBytes) || maxWebhookPayloadBytes <= 0) {
    throw new Error(
      "GATEWAY_MAX_WEBHOOK_PAYLOAD_BYTES must be a positive number",
    );
  }

  const maxAttachmentBytes = Number(
    process.env.GATEWAY_MAX_ATTACHMENT_BYTES || String(20 * 1024 * 1024),
  );
  if (!Number.isFinite(maxAttachmentBytes) || maxAttachmentBytes <= 0) {
    throw new Error("GATEWAY_MAX_ATTACHMENT_BYTES must be a positive number");
  }

  const maxAttachmentConcurrency = Number(
    process.env.GATEWAY_MAX_ATTACHMENT_CONCURRENCY || "3",
  );
  if (
    !Number.isInteger(maxAttachmentConcurrency) ||
    maxAttachmentConcurrency < 1
  ) {
    throw new Error(
      "GATEWAY_MAX_ATTACHMENT_CONCURRENCY must be a positive integer",
    );
  }

  const trustProxyRaw = process.env.GATEWAY_TRUST_PROXY;
  if (
    trustProxyRaw !== undefined &&
    trustProxyRaw !== "true" &&
    trustProxyRaw !== "false"
  ) {
    throw new Error(
      `GATEWAY_TRUST_PROXY must be "true" or "false", got "${trustProxyRaw}"`,
    );
  }
  const trustProxy = trustProxyRaw === "true";

  const logFileDir = process.env.GATEWAY_LOG_DIR || undefined;

  const logFileRetentionDays = Number(
    process.env.GATEWAY_LOG_RETENTION_DAYS || "30",
  );
  if (!Number.isInteger(logFileRetentionDays) || logFileRetentionDays < 1) {
    throw new Error("GATEWAY_LOG_RETENTION_DAYS must be a positive integer");
  }

  const logFile: LogFileConfig = {
    dir: logFileDir,
    retentionDays: logFileRetentionDays,
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
      trustProxy,
    },
    "Configuration loaded",
  );

  return {
    assistantRuntimeBaseUrl,
    defaultAssistantId,
    gatewayInternalBaseUrl,
    logFile,
    maxAttachmentBytes,
    maxAttachmentConcurrency,
    maxWebhookPayloadBytes,
    port,
    routingEntries,
    runtimeInitialBackoffMs,
    runtimeMaxRetries,
    runtimeProxyEnabled,
    runtimeProxyRequireAuth,
    runtimeTimeoutMs,
    shutdownDrainMs,
    unmappedPolicy,
    trustProxy,
  };
}
