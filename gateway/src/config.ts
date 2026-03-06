import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger, type LogFileConfig } from "./logger.js";
import {
  getRootDir,
  readCredential,
  readTwilioCredentials,
  readWhatsAppCredentials,
  readSlackChannelCredentials,
} from "./credential-reader.js";

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
  /** WhatsApp Business phone number ID (numeric string, e.g. "123456789012345"). */
  whatsappPhoneNumberId: string | undefined;
  /** WhatsApp access token (System User token or temporary token from Meta developer portal). */
  whatsappAccessToken: string | undefined;
  /** WhatsApp app secret used to verify X-Hub-Signature-256 on incoming webhooks. */
  whatsappAppSecret: string | undefined;
  /** Webhook verify token used during the Meta webhook subscription handshake. */
  whatsappWebhookVerifyToken: string | undefined;
  /**
   * When true, the /deliver/whatsapp endpoint allows unauthenticated access
   * even when no bearer token is configured. Intended for local development only.
   */
  whatsappDeliverAuthBypass: boolean;
  whatsappTimeoutMs: number;
  whatsappMaxRetries: number;
  whatsappInitialBackoffMs: number;
  /** Slack Bot User OAuth Token (xoxb-...) for Slack as a channel. */
  slackChannelBotToken: string | undefined;
  /** Slack App-Level Token (xapp-...) for Socket Mode. */
  slackChannelAppToken: string | undefined;
  /**
   * When true, the /deliver/slack endpoint allows unauthenticated access
   * even when no bearer token is configured. Intended for local development only.
   */
  slackDeliverAuthBypass: boolean;
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

export async function loadConfig(): Promise<GatewayConfig> {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || undefined;
  const telegramWebhookSecret =
    process.env.TELEGRAM_WEBHOOK_SECRET || undefined;

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

  const telegramDeliverAuthBypassRaw =
    process.env.GATEWAY_TELEGRAM_DELIVER_AUTH_BYPASS;
  if (
    telegramDeliverAuthBypassRaw !== undefined &&
    telegramDeliverAuthBypassRaw !== "true" &&
    telegramDeliverAuthBypassRaw !== "false"
  ) {
    throw new Error(
      `GATEWAY_TELEGRAM_DELIVER_AUTH_BYPASS must be "true" or "false", got "${telegramDeliverAuthBypassRaw}"`,
    );
  }
  let telegramDeliverAuthBypass = telegramDeliverAuthBypassRaw === "true";

  const telegramTimeoutMs = Number(
    process.env.GATEWAY_TELEGRAM_TIMEOUT_MS || "15000",
  );
  if (!Number.isFinite(telegramTimeoutMs) || telegramTimeoutMs <= 0) {
    throw new Error("GATEWAY_TELEGRAM_TIMEOUT_MS must be a positive number");
  }

  const telegramMaxRetries = Number(
    process.env.GATEWAY_TELEGRAM_MAX_RETRIES || "3",
  );
  if (!Number.isInteger(telegramMaxRetries) || telegramMaxRetries < 0) {
    throw new Error(
      "GATEWAY_TELEGRAM_MAX_RETRIES must be a non-negative integer",
    );
  }

  const telegramInitialBackoffMs = Number(
    process.env.GATEWAY_TELEGRAM_INITIAL_BACKOFF_MS || "1000",
  );
  if (
    !Number.isFinite(telegramInitialBackoffMs) ||
    telegramInitialBackoffMs <= 0
  ) {
    throw new Error(
      "GATEWAY_TELEGRAM_INITIAL_BACKOFF_MS must be a positive number",
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

  // Twilio credentials: env var > credential store (encrypted file)
  const twilioCreds = await readTwilioCredentials();
  const twilioAuthToken =
    process.env.TWILIO_AUTH_TOKEN || twilioCreds?.authToken || undefined;
  let twilioAccountSid =
    process.env.TWILIO_ACCOUNT_SID || twilioCreds?.accountSid || undefined;

  // Phone number: env var > config file sms.phoneNumber > credential store
  let twilioPhoneNumber: string | undefined =
    process.env.TWILIO_PHONE_NUMBER || undefined;
  let assistantPhoneNumbers: Record<string, string> | undefined;
  try {
    const cfgPath = join(getRootDir(), "workspace", "config.json");
    const raw = readFileSync(cfgPath, "utf-8");
    const data = JSON.parse(raw);
    if (
      !twilioPhoneNumber &&
      data?.sms?.phoneNumber &&
      typeof data.sms.phoneNumber === "string"
    ) {
      twilioPhoneNumber = data.sms.phoneNumber;
    }
    if (
      !twilioAccountSid &&
      data?.twilio?.accountSid &&
      typeof data.twilio.accountSid === "string"
    ) {
      twilioAccountSid = data.twilio.accountSid;
    }
    const rawMapping = data?.sms?.assistantPhoneNumbers;
    if (
      rawMapping &&
      typeof rawMapping === "object" &&
      !Array.isArray(rawMapping)
    ) {
      const normalized: Record<string, string> = {};
      for (const [assistantId, phoneNumber] of Object.entries(
        rawMapping as Record<string, unknown>,
      )) {
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
      (await readCredential("credential:twilio:phone_number")) || undefined;
  }

  // WhatsApp credentials: env var > credential store (encrypted file)
  const whatsappCreds = await readWhatsAppCredentials();
  const whatsappPhoneNumberId =
    process.env.WHATSAPP_PHONE_NUMBER_ID ||
    whatsappCreds?.phoneNumberId ||
    undefined;
  const whatsappAccessToken =
    process.env.WHATSAPP_ACCESS_TOKEN ||
    whatsappCreds?.accessToken ||
    undefined;
  const whatsappAppSecret =
    process.env.WHATSAPP_APP_SECRET || whatsappCreds?.appSecret || undefined;
  const whatsappWebhookVerifyToken =
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ||
    whatsappCreds?.webhookVerifyToken ||
    undefined;

  const whatsappDeliverAuthBypassRaw =
    process.env.GATEWAY_WHATSAPP_DELIVER_AUTH_BYPASS;
  if (
    whatsappDeliverAuthBypassRaw !== undefined &&
    whatsappDeliverAuthBypassRaw !== "true" &&
    whatsappDeliverAuthBypassRaw !== "false"
  ) {
    throw new Error(
      `GATEWAY_WHATSAPP_DELIVER_AUTH_BYPASS must be "true" or "false", got "${whatsappDeliverAuthBypassRaw}"`,
    );
  }
  let whatsappDeliverAuthBypass = whatsappDeliverAuthBypassRaw === "true";

  const whatsappTimeoutMs = Number(
    process.env.GATEWAY_WHATSAPP_TIMEOUT_MS || "15000",
  );
  if (!Number.isFinite(whatsappTimeoutMs) || whatsappTimeoutMs <= 0) {
    throw new Error("GATEWAY_WHATSAPP_TIMEOUT_MS must be a positive number");
  }

  const whatsappMaxRetries = Number(
    process.env.GATEWAY_WHATSAPP_MAX_RETRIES || "3",
  );
  if (!Number.isInteger(whatsappMaxRetries) || whatsappMaxRetries < 0) {
    throw new Error(
      "GATEWAY_WHATSAPP_MAX_RETRIES must be a non-negative integer",
    );
  }

  const whatsappInitialBackoffMs = Number(
    process.env.GATEWAY_WHATSAPP_INITIAL_BACKOFF_MS || "1000",
  );
  if (
    !Number.isFinite(whatsappInitialBackoffMs) ||
    whatsappInitialBackoffMs <= 0
  ) {
    throw new Error(
      "GATEWAY_WHATSAPP_INITIAL_BACKOFF_MS must be a positive number",
    );
  }

  // Slack channel credentials: env var > credential store (encrypted file)
  const slackChannelCreds = await readSlackChannelCredentials();
  const slackChannelBotToken =
    process.env.SLACK_CHANNEL_BOT_TOKEN ||
    slackChannelCreds?.botToken ||
    undefined;
  const slackChannelAppToken =
    process.env.SLACK_CHANNEL_APP_TOKEN ||
    slackChannelCreds?.appToken ||
    undefined;

  const slackDeliverAuthBypassRaw =
    process.env.GATEWAY_SLACK_DELIVER_AUTH_BYPASS;
  if (
    slackDeliverAuthBypassRaw !== undefined &&
    slackDeliverAuthBypassRaw !== "true" &&
    slackDeliverAuthBypassRaw !== "false"
  ) {
    throw new Error(
      `GATEWAY_SLACK_DELIVER_AUTH_BYPASS must be "true" or "false", got "${slackDeliverAuthBypassRaw}"`,
    );
  }
  let slackDeliverAuthBypass = slackDeliverAuthBypassRaw === "true";

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
  let smsDeliverAuthBypass = smsDeliverAuthBypassRaw === "true";

  // Production guard: auth bypass flags must never be active outside dev mode.
  // Fail closed: treat missing APP_VERSION as production, since the gateway
  // release pipeline does not inject it (unlike the daemon build).
  const appVersion = process.env.APP_VERSION;
  const isDevMode = appVersion === "0.0.0-dev";
  if (!isDevMode) {
    if (telegramDeliverAuthBypass) {
      log.warn(
        "GATEWAY_TELEGRAM_DELIVER_AUTH_BYPASS is set but ignored in production (APP_VERSION=%s)",
        appVersion,
      );
      telegramDeliverAuthBypass = false;
    }
    if (smsDeliverAuthBypass) {
      log.warn(
        "GATEWAY_SMS_DELIVER_AUTH_BYPASS is set but ignored in production (APP_VERSION=%s)",
        appVersion,
      );
      smsDeliverAuthBypass = false;
    }
    if (whatsappDeliverAuthBypass) {
      log.warn(
        "GATEWAY_WHATSAPP_DELIVER_AUTH_BYPASS is set but ignored in production (APP_VERSION=%s)",
        appVersion,
      );
      whatsappDeliverAuthBypass = false;
    }
    if (slackDeliverAuthBypass) {
      log.warn(
        "GATEWAY_SLACK_DELIVER_AUTH_BYPASS is set but ignored in production (APP_VERSION=%s)",
        appVersion,
      );
      slackDeliverAuthBypass = false;
    }
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
      assistantPhoneNumberCount: assistantPhoneNumbers
        ? Object.keys(assistantPhoneNumbers).length
        : 0,
      smsDeliverAuthBypass,
      ingressPublicBaseUrl,
      hasWhatsAppPhoneNumberId: !!whatsappPhoneNumberId,
      hasWhatsAppAccessToken: !!whatsappAccessToken,
      hasWhatsAppAppSecret: !!whatsappAppSecret,
      hasWhatsAppWebhookVerifyToken: !!whatsappWebhookVerifyToken,
      whatsappDeliverAuthBypass,
      hasSlackChannelBotToken: !!slackChannelBotToken,
      hasSlackChannelAppToken: !!slackChannelAppToken,
      slackDeliverAuthBypass,
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
    whatsappPhoneNumberId,
    whatsappAccessToken,
    whatsappAppSecret,
    whatsappWebhookVerifyToken,
    whatsappDeliverAuthBypass,
    whatsappTimeoutMs,
    whatsappMaxRetries,
    whatsappInitialBackoffMs,
    slackChannelBotToken,
    slackChannelAppToken,
    slackDeliverAuthBypass,
    trustProxy,
  };
}

/** Returns true when both Slack channel tokens are present. */
export function isSlackChannelConfigured(config: GatewayConfig): boolean {
  return !!config.slackChannelBotToken && !!config.slackChannelAppToken;
}
