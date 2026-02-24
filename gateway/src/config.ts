import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLogger, type LogFileConfig } from "./logger.js";
import { getRootDir, readKeychainCredential, readCredential, readTwilioCredentials } from "./credential-reader.js";

const log = getLogger("config");

export type RoutingEntry = {
  type: "chat_id" | "user_id";
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
  /** Bearer token sent to the assistant runtime on gateway-to-runtime calls. */
  runtimeBearerToken: string | undefined;
  /** Dedicated secret for the X-Gateway-Origin proof header. Falls back to runtimeBearerToken when not set. */
  runtimeGatewayOriginSecret: string | undefined;
  runtimeInitialBackoffMs: number;
  runtimeMaxRetries: number;
  runtimeProxyBearerToken: string | undefined;
  runtimeProxyEnabled: boolean;
  runtimeProxyRequireAuth: boolean;
  runtimeTimeoutMs: number;
  shutdownDrainMs: number;
  telegramApiBaseUrl: string;
  telegramBotToken: string | undefined;
  /**
   * When true, the /deliver/telegram endpoint allows unauthenticated access
   * even when no bearer token is configured. Intended for local development only.
   */
  telegramDeliverAuthBypass: boolean;
  telegramInitialBackoffMs: number;
  telegramMaxRetries: number;
  telegramTimeoutMs: number;
  telegramWebhookSecret: string | undefined;
  /** Twilio auth token for validating webhook signatures at the gateway boundary. */
  twilioAuthToken: string | undefined;
  /** Twilio account SID for sending SMS via the Messages API. */
  twilioAccountSid: string | undefined;
  /** Twilio phone number (E.164) used as the "From" for outbound SMS. */
  twilioPhoneNumber: string | undefined;
  /** Per-assistant phone number mapping (assistantId -> E.164 phone number). */
  assistantPhoneNumbers?: Record<string, string>;
  /**
   * When true, the /deliver/sms endpoint allows unauthenticated access
   * even when no bearer token is configured. Intended for local development only.
   */
  smsDeliverAuthBypass: boolean;
  /** Canonical public ingress base URL, used for webhook signature reconstruction. */
  ingressPublicBaseUrl: string | undefined;
  /** The assistant's own email address, persisted by the email setup skill. */
  assistantEmail?: string | undefined;
  unmappedPolicy: "reject" | "default";
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

  const gatewayInternalBaseUrl = (
    process.env.GATEWAY_INTERNAL_BASE_URL || `http://127.0.0.1:${port}`
  ).replace(/\/+$/, "");

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

  // Gateway -> runtime auth should use the same daemon-issued token source as
  // runtime-proxy auth, unless explicitly overridden by env vars.
  const runtimeTokenFromFile = readHttpTokenFile() || undefined;
  const runtimeBearerToken =
    process.env.RUNTIME_BEARER_TOKEN || runtimeTokenFromFile;

  const runtimeProxyBearerToken =
    process.env.RUNTIME_PROXY_BEARER_TOKEN || runtimeTokenFromFile;

  // Dedicated gateway-origin secret. Falls back to runtimeBearerToken for
  // backward compatibility so existing deployments continue working.
  const runtimeGatewayOriginSecret =
    process.env.RUNTIME_GATEWAY_ORIGIN_SECRET || runtimeBearerToken;

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

  const telegramDeliverAuthBypassRaw = process.env.GATEWAY_TELEGRAM_DELIVER_AUTH_BYPASS;
  if (
    telegramDeliverAuthBypassRaw !== undefined &&
    telegramDeliverAuthBypassRaw !== "true" &&
    telegramDeliverAuthBypassRaw !== "false"
  ) {
    throw new Error(
      `GATEWAY_TELEGRAM_DELIVER_AUTH_BYPASS must be "true" or "false", got "${telegramDeliverAuthBypassRaw}"`,
    );
  }
  const telegramDeliverAuthBypass = telegramDeliverAuthBypassRaw === "true";

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

  // Twilio credentials: env var > credential store (keychain / encrypted file)
  const twilioCreds = readTwilioCredentials();
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || twilioCreds?.authToken || undefined;
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID || twilioCreds?.accountSid || undefined;

  // Phone number: env var > config file sms.phoneNumber > credential store
  let twilioPhoneNumber: string | undefined = process.env.TWILIO_PHONE_NUMBER || undefined;
  let assistantPhoneNumbers: Record<string, string> | undefined;
  try {
    const cfgPath = join(getRootDir(), "workspace", "config.json");
    const raw = readFileSync(cfgPath, "utf-8");
    const data = JSON.parse(raw);
    if (!twilioPhoneNumber && data?.sms?.phoneNumber && typeof data.sms.phoneNumber === "string") {
      twilioPhoneNumber = data.sms.phoneNumber;
    }
    const rawMapping = data?.sms?.assistantPhoneNumbers;
    if (rawMapping && typeof rawMapping === "object" && !Array.isArray(rawMapping)) {
      const normalized: Record<string, string> = {};
      for (const [assistantId, phoneNumber] of Object.entries(rawMapping as Record<string, unknown>)) {
        if (typeof phoneNumber === "string" && phoneNumber.trim().length > 0) {
          normalized[assistantId] = phoneNumber;
        }
      }
      assistantPhoneNumbers = normalized;
    }
  } catch {
    // config file may not exist yet
  }
  if (!twilioPhoneNumber) {
    twilioPhoneNumber =
      readKeychainCredential("credential:twilio:phone_number")
      || readCredential("credential:twilio:phone_number")
      || undefined;
  }

  const smsDeliverAuthBypassRaw = process.env.GATEWAY_SMS_DELIVER_AUTH_BYPASS;
  if (
    smsDeliverAuthBypassRaw !== undefined &&
    smsDeliverAuthBypassRaw !== "true" &&
    smsDeliverAuthBypassRaw !== "false"
  ) {
    throw new Error(
      `GATEWAY_SMS_DELIVER_AUTH_BYPASS must be "true" or "false", got "${smsDeliverAuthBypassRaw}"`,
    );
  }
  const smsDeliverAuthBypass = smsDeliverAuthBypassRaw === "true";

  const ingressPublicBaseUrl = process.env.INGRESS_PUBLIC_BASE_URL || undefined;

  // Assistant email from workspace config file
  let assistantEmail: string | undefined;
  try {
    const cfgPath = join(getRootDir(), "workspace", "config.json");
    const raw = readFileSync(cfgPath, "utf-8");
    const data = JSON.parse(raw);
    if (data?.email?.address && typeof data.email.address === "string") {
      assistantEmail = data.email.address;
    }
  } catch {
    // config file may not exist yet
  }

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
      gatewayInternalBaseUrl,
      routingEntryCount: routingEntries.length,
      unmappedPolicy,
      hasDefaultAssistant: !!defaultAssistantId,
      port,
      runtimeProxyEnabled,
      runtimeProxyRequireAuth,
      telegramDeliverAuthBypass,
      hasTwilioAuthToken: !!twilioAuthToken,
      hasTwilioAccountSid: !!twilioAccountSid,
      hasTwilioPhoneNumber: !!twilioPhoneNumber,
      assistantPhoneNumberCount: assistantPhoneNumbers ? Object.keys(assistantPhoneNumbers).length : 0,
      smsDeliverAuthBypass,
      ingressPublicBaseUrl,
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
    runtimeBearerToken,
    runtimeGatewayOriginSecret,
    runtimeInitialBackoffMs,
    runtimeMaxRetries,
    runtimeProxyBearerToken,
    runtimeProxyEnabled,
    runtimeProxyRequireAuth,
    runtimeTimeoutMs,
    shutdownDrainMs,
    telegramApiBaseUrl,
    telegramBotToken,
    telegramDeliverAuthBypass,
    telegramInitialBackoffMs,
    telegramMaxRetries,
    telegramTimeoutMs,
    telegramWebhookSecret,
    twilioAuthToken,
    twilioAccountSid,
    twilioPhoneNumber,
    assistantPhoneNumbers,
    smsDeliverAuthBypass,
    ingressPublicBaseUrl,
    assistantEmail,
    unmappedPolicy,
  };
}
