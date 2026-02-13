import pino from "pino";

const log = pino({ name: "gateway:config" });

export type RoutingEntry = {
  type: "chat_id" | "user_id";
  key: string;
  assistantId: string;
};

export type GatewayConfig = {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  telegramApiBaseUrl: string;
  assistantRuntimeBaseUrl: string;
  routingEntries: RoutingEntry[];
  defaultAssistantId: string | undefined;
  unmappedPolicy: "reject" | "default";
  port: number;
  runtimeProxyEnabled: boolean;
  runtimeProxyRequireAuth: boolean;
  runtimeProxyBearerToken: string | undefined;
  shutdownDrainMs: number;
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

export function loadConfig(): GatewayConfig {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!telegramWebhookSecret) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET is required");
  }

  const telegramApiBaseUrl =
    process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org";

  const assistantRuntimeBaseUrl = process.env.ASSISTANT_RUNTIME_BASE_URL;
  if (!assistantRuntimeBaseUrl) {
    throw new Error("ASSISTANT_RUNTIME_BASE_URL is required");
  }

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

  const runtimeProxyBearerToken =
    process.env.RUNTIME_PROXY_BEARER_TOKEN || undefined;

  const shutdownDrainMsRaw = process.env.GATEWAY_SHUTDOWN_DRAIN_MS || "5000";
  const shutdownDrainMs = Number(shutdownDrainMsRaw);
  if (!Number.isFinite(shutdownDrainMs) || shutdownDrainMs < 0) {
    throw new Error("GATEWAY_SHUTDOWN_DRAIN_MS must be a non-negative number");
  }

  if (runtimeProxyEnabled && runtimeProxyRequireAuth && !runtimeProxyBearerToken) {
    throw new Error(
      "RUNTIME_PROXY_BEARER_TOKEN is required when proxy is enabled with auth required",
    );
  }

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
    },
    "Configuration loaded",
  );

  return {
    telegramBotToken,
    telegramWebhookSecret,
    telegramApiBaseUrl,
    assistantRuntimeBaseUrl,
    routingEntries,
    defaultAssistantId,
    unmappedPolicy,
    port,
    runtimeProxyEnabled,
    runtimeProxyRequireAuth,
    runtimeProxyBearerToken,
    shutdownDrainMs,
  };
}
