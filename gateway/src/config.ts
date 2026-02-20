import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLogger, type LogFileConfig } from "./logger.js";

const log = getLogger("config");

export type RoutingEntry = {
  type: "chat_id" | "user_id";
  key: string;
  assistantId: string;
};

export type GatewayConfig = {
  assistantRuntimeBaseUrl: string;
  defaultAssistantId: string | undefined;
  logFile: LogFileConfig;
  maxAttachmentBytes: number;
  maxAttachmentConcurrency: number;
  maxWebhookPayloadBytes: number;
  port: number;
  routingEntries: RoutingEntry[];
  /** Bearer token sent to the assistant runtime on gateway-to-runtime calls. */
  runtimeBearerToken: string | undefined;
  runtimeInitialBackoffMs: number;
  runtimeMaxRetries: number;
  runtimeProxyBearerToken: string | undefined;
  runtimeProxyEnabled: boolean;
  runtimeProxyRequireAuth: boolean;
  runtimeTimeoutMs: number;
  shutdownDrainMs: number;
  telegramApiBaseUrl: string;
  telegramBotToken: string | undefined;
  telegramInitialBackoffMs: number;
  telegramMaxRetries: number;
  telegramTimeoutMs: number;
  telegramWebhookSecret: string | undefined;
  /** Twilio auth token for validating webhook signatures at the gateway boundary. */
  twilioAuthToken: string | undefined;
  /** Public base URL that Twilio uses when computing webhook signatures. */
  twilioWebhookBaseUrl: string | undefined;
  unmappedPolicy: "reject" | "default";
  /** The gateway's own public-facing URL (e.g. http://<external-ip>:7830). */
  publicUrl: string | undefined;
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
    if (key.startsWith("chat:")) {
      entries.push({ type: "chat_id", key: key.slice(5), assistantId });
    } else if (key.startsWith("user:")) {
      entries.push({ type: "user_id", key: key.slice(5), assistantId });
    } else {
      throw new Error(
        `Invalid routing key "${key}": must start with "chat:" or "user:"`,
      );
    }
  }
  return entries;
}

function readHttpTokenFile(): string | null {
  const tokenPath = process.env.VELLUM_HTTP_TOKEN_PATH
    ?? join(process.env.BASE_DATA_DIR?.trim() || homedir(), ".vellum", "http-token");
  try {
    return readFileSync(tokenPath, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function loadConfig(): GatewayConfig {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || undefined;
  const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || undefined;

  const telegramApiBaseUrl =
    process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org";

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

  const proxyEnabledRaw = process.env.GATEWAY_RUNTIME_PROXY_ENABLED;
  if (proxyEnabledRaw !== undefined && proxyEnabledRaw !== "true" && proxyEnabledRaw !== "false") {
    throw new Error(
      `GATEWAY_RUNTIME_PROXY_ENABLED must be "true" or "false", got "${proxyEnabledRaw}"`,
    );
  }
  const runtimeProxyEnabled = proxyEnabledRaw === "true";

  const proxyRequireAuthRaw = process.env.GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH;
  if (proxyRequireAuthRaw !== undefined && proxyRequireAuthRaw !== "true" && proxyRequireAuthRaw !== "false") {
    throw new Error(
      `GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH must be "true" or "false", got "${proxyRequireAuthRaw}"`,
    );
  }
  const runtimeProxyRequireAuth = proxyRequireAuthRaw !== "false";

  const runtimeBearerToken =
    process.env.RUNTIME_BEARER_TOKEN || undefined;

  const runtimeProxyBearerToken =
    process.env.RUNTIME_PROXY_BEARER_TOKEN || readHttpTokenFile() || undefined;

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

  const runtimeTimeoutMs = Number(process.env.GATEWAY_RUNTIME_TIMEOUT_MS || "30000");
  if (!Number.isFinite(runtimeTimeoutMs) || runtimeTimeoutMs <= 0) {
    throw new Error("GATEWAY_RUNTIME_TIMEOUT_MS must be a positive number");
  }

  const runtimeMaxRetries = Number(process.env.GATEWAY_RUNTIME_MAX_RETRIES || "2");
  if (!Number.isInteger(runtimeMaxRetries) || runtimeMaxRetries < 0) {
    throw new Error("GATEWAY_RUNTIME_MAX_RETRIES must be a non-negative integer");
  }

  const runtimeInitialBackoffMs = Number(process.env.GATEWAY_RUNTIME_INITIAL_BACKOFF_MS || "500");
  if (!Number.isFinite(runtimeInitialBackoffMs) || runtimeInitialBackoffMs <= 0) {
    throw new Error("GATEWAY_RUNTIME_INITIAL_BACKOFF_MS must be a positive number");
  }

  const telegramTimeoutMs = Number(process.env.GATEWAY_TELEGRAM_TIMEOUT_MS || "15000");
  if (!Number.isFinite(telegramTimeoutMs) || telegramTimeoutMs <= 0) {
    throw new Error("GATEWAY_TELEGRAM_TIMEOUT_MS must be a positive number");
  }

  const telegramMaxRetries = Number(process.env.GATEWAY_TELEGRAM_MAX_RETRIES || "3");
  if (!Number.isInteger(telegramMaxRetries) || telegramMaxRetries < 0) {
    throw new Error("GATEWAY_TELEGRAM_MAX_RETRIES must be a non-negative integer");
  }

  const telegramInitialBackoffMs = Number(process.env.GATEWAY_TELEGRAM_INITIAL_BACKOFF_MS || "1000");
  if (!Number.isFinite(telegramInitialBackoffMs) || telegramInitialBackoffMs <= 0) {
    throw new Error("GATEWAY_TELEGRAM_INITIAL_BACKOFF_MS must be a positive number");
  }

  const maxWebhookPayloadBytes = Number(process.env.GATEWAY_MAX_WEBHOOK_PAYLOAD_BYTES || String(1024 * 1024));
  if (!Number.isFinite(maxWebhookPayloadBytes) || maxWebhookPayloadBytes <= 0) {
    throw new Error("GATEWAY_MAX_WEBHOOK_PAYLOAD_BYTES must be a positive number");
  }

  const maxAttachmentBytes = Number(process.env.GATEWAY_MAX_ATTACHMENT_BYTES || String(20 * 1024 * 1024));
  if (!Number.isFinite(maxAttachmentBytes) || maxAttachmentBytes <= 0) {
    throw new Error("GATEWAY_MAX_ATTACHMENT_BYTES must be a positive number");
  }

  const maxAttachmentConcurrency = Number(process.env.GATEWAY_MAX_ATTACHMENT_CONCURRENCY || "3");
  if (!Number.isInteger(maxAttachmentConcurrency) || maxAttachmentConcurrency < 1) {
    throw new Error("GATEWAY_MAX_ATTACHMENT_CONCURRENCY must be a positive integer");
  }

  if (runtimeProxyEnabled && runtimeProxyRequireAuth && !runtimeProxyBearerToken) {
    throw new Error(
      "RUNTIME_PROXY_BEARER_TOKEN is required when proxy is enabled with auth required",
    );
  }

  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || undefined;
  const twilioWebhookBaseUrl = process.env.TWILIO_WEBHOOK_BASE_URL || undefined;
  const publicUrl = process.env.GATEWAY_PUBLIC_URL || undefined;

  const logFileDir = process.env.GATEWAY_LOG_DIR || undefined;

  const logFileRetentionDays = Number(process.env.GATEWAY_LOG_RETENTION_DAYS || "30");
  if (!Number.isInteger(logFileRetentionDays) || logFileRetentionDays < 1) {
    throw new Error("GATEWAY_LOG_RETENTION_DAYS must be a positive integer");
  }

  const logFile: LogFileConfig = {
    dir: logFileDir,
    retentionDays: logFileRetentionDays,
  };

  log.info(
    {
      telegramApiBaseUrl,
      assistantRuntimeBaseUrl,
      routingEntryCount: routingEntries.length,
      unmappedPolicy,
      hasDefaultAssistant: !!defaultAssistantId,
      port,
      runtimeProxyEnabled,
      runtimeProxyRequireAuth,
      hasTwilioAuthToken: !!twilioAuthToken,
      publicUrl,
    },
    "Configuration loaded",
  );

  return {
    assistantRuntimeBaseUrl,
    defaultAssistantId,
    logFile,
    maxAttachmentBytes,
    maxAttachmentConcurrency,
    maxWebhookPayloadBytes,
    port,
    routingEntries,
    runtimeBearerToken,
    runtimeInitialBackoffMs,
    runtimeMaxRetries,
    runtimeProxyBearerToken,
    runtimeProxyEnabled,
    runtimeProxyRequireAuth,
    runtimeTimeoutMs,
    shutdownDrainMs,
    telegramApiBaseUrl,
    telegramBotToken,
    telegramInitialBackoffMs,
    telegramMaxRetries,
    telegramTimeoutMs,
    telegramWebhookSecret,
    publicUrl,
    twilioAuthToken,
    twilioWebhookBaseUrl,
    unmappedPolicy,
  };
}
