import { randomBytes } from "node:crypto";
import { readFileSync, watch, existsSync, mkdirSync, type FSWatcher } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { AuthRateLimiter } from "./auth-rate-limiter.js";
import { ConfigFileWatcher } from "./config-file-watcher.js";
import { loadConfig, isSlackChannelConfigured, type GatewayConfig } from "./config.js";
import { CredentialWatcher } from "./credential-watcher.js";
import { createRuntimeProxyHandler } from "./http/routes/runtime-proxy.js";
import {
  createBrowserRelayWebsocketHandler,
  getBrowserRelayWebsocketHandlers,
  type BrowserRelaySocketData,
} from "./http/routes/browser-relay-websocket.js";
import { createTelegramDeliverHandler } from "./http/routes/telegram-deliver.js";
import { createTelegramReconcileHandler } from "./http/routes/telegram-reconcile.js";
import { createTelegramWebhookHandler } from "./http/routes/telegram-webhook.js";
import { createTwilioVoiceWebhookHandler } from "./http/routes/twilio-voice-webhook.js";
import { createTwilioStatusWebhookHandler } from "./http/routes/twilio-status-webhook.js";
import { createTwilioConnectActionWebhookHandler } from "./http/routes/twilio-connect-action-webhook.js";
import { createTwilioRelayWebsocketHandler, getRelayWebsocketHandlers } from "./http/routes/twilio-relay-websocket.js";
import { createTwilioSmsWebhookHandler } from "./http/routes/twilio-sms-webhook.js";
import { createSmsDeliverHandler } from "./http/routes/sms-deliver.js";
import { createWhatsAppWebhookHandler } from "./http/routes/whatsapp-webhook.js";
import { createWhatsAppDeliverHandler } from "./http/routes/whatsapp-deliver.js";
import { createSlackDeliverHandler } from "./http/routes/slack-deliver.js";
import { createOAuthCallbackHandler } from "./http/routes/oauth-callback.js";
import { createPairingProxyHandler } from "./http/routes/pairing-proxy.js";
import { validateBearerToken } from "./http/auth/bearer.js";
import { getLogger, initLogger } from "./logger.js";
import { CircuitBreakerOpenError } from "./runtime/client.js";
import { buildSchema } from "./schema.js";
import { createSlackSocketModeClient, type SlackSocketModeClient } from "./slack/socket-mode.js";
import { handleInbound } from "./handlers/handle-inbound.js";
import { callTelegramApi } from "./telegram/api.js";
import { reconcileTelegramWebhook } from "./telegram/webhook-manager.js";

const log = getLogger("main");

function generateTraceId(): string {
  return randomBytes(8).toString("hex");
}

let draining = false;

// Shared rate limiter for auth failures and unauthenticated endpoints
const authRateLimiter = new AuthRateLimiter();

function isBrowserRelaySocketData(data: unknown): data is BrowserRelaySocketData {
  return !!data && typeof data === "object" && (data as { wsType?: unknown }).wsType === "browser-relay";
}

function getClientIp(req: Request, server: ReturnType<typeof Bun.serve>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0].trim();
      if (first) return first;
    }
  }
  const addr = server.requestIP(req);
  return addr?.address ?? "unknown";
}

/**
 * Watch `~/.vellum/http-token` and update the config when the daemon
 * writes a new token. Without this, a gateway started before the daemon
 * would hold a stale bearer token and reject authenticated requests (401).
 */
function startHttpTokenWatcher(cfg: GatewayConfig): FSWatcher | null {
  const tokenPath = process.env.VELLUM_HTTP_TOKEN_PATH
    ?? join(process.env.BASE_DATA_DIR?.trim() || homedir(), ".vellum", "http-token");

  const dir = dirname(tokenPath);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch (err) {
    log.warn({ err, path: dir }, "Cannot create token directory, skipping http-token watcher");
    return null;
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function refresh(): void {
    // Skip file-based refresh when env vars explicitly pin the tokens —
    // respect the same precedence as loadConfig().
    if (process.env.RUNTIME_BEARER_TOKEN) return;

    try {
      const token = readFileSync(tokenPath, "utf-8").trim() || undefined;
      if (token && token !== cfg.runtimeBearerToken) {
        cfg.runtimeBearerToken = token;
        cfg.runtimeProxyBearerToken = process.env.RUNTIME_PROXY_BEARER_TOKEN || token;
        cfg.runtimeGatewayOriginSecret = process.env.RUNTIME_GATEWAY_ORIGIN_SECRET || token;
        log.info("Runtime bearer token refreshed from http-token file");
      }
    } catch {
      // File doesn't exist yet — will be created by the daemon
    }
  }

  try {
    const watcher = watch(existsSync(tokenPath) ? tokenPath : dir, { persistent: false }, (_event, filename) => {
      if (!existsSync(tokenPath) && filename !== "http-token") return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refresh, 500);
    });
    log.info({ path: tokenPath }, "Watching http-token for runtime bearer token changes");
    return watcher;
  } catch (err) {
    log.warn({ err, path: tokenPath }, "Failed to watch http-token file");
    return null;
  }
}

function main() {
  const config = loadConfig();
  initLogger(config.logFile);

  log.info("Starting Vellum Gateway...");

  const { handler: handleTelegramWebhook, dedupCache: telegramDedupCache } = createTelegramWebhookHandler(config);
  const handleTelegramDeliver = createTelegramDeliverHandler(config);
  const handleTelegramReconcile = createTelegramReconcileHandler(config);

  const isTelegramConfigured = () =>
    !!(config.telegramBotToken && config.telegramWebhookSecret);

  const isWhatsAppConfigured = () =>
    !!(config.whatsappPhoneNumberId && config.whatsappAccessToken);

  const handleTwilioVoiceWebhook = createTwilioVoiceWebhookHandler(config);
  const handleTwilioStatusWebhook = createTwilioStatusWebhookHandler(config);
  const handleTwilioConnectActionWebhook = createTwilioConnectActionWebhookHandler(config);
  const handleTwilioRelayWs = createTwilioRelayWebsocketHandler(config);
  const handleBrowserRelayWs = createBrowserRelayWebsocketHandler(config);
  const twilioRelayWebsocketHandlers = getRelayWebsocketHandlers();
  const browserRelayWebsocketHandlers = getBrowserRelayWebsocketHandlers();
  const { handler: handleTwilioSmsWebhook, dedupCache: smsDedupCache } = createTwilioSmsWebhookHandler(config);
  const handleSmsDeliver = createSmsDeliverHandler(config);
  const { handler: handleWhatsAppWebhook, dedupCache: whatsappDedupCache } = createWhatsAppWebhookHandler(config);
  const handleWhatsAppDeliver = createWhatsAppDeliverHandler(config);
  const handleSlackDeliver = createSlackDeliverHandler(config);
  const handleOAuthCallback = createOAuthCallbackHandler(config);
  const pairingProxy = createPairingProxyHandler(config);

  const handleRuntimeProxy = config.runtimeProxyEnabled
    ? createRuntimeProxyHandler(config)
    : null;

  const server = Bun.serve({
    port: config.port,
    websocket: {
      open(ws) {
        if (isBrowserRelaySocketData(ws.data)) {
          browserRelayWebsocketHandlers.open(ws as never);
          return;
        }
        twilioRelayWebsocketHandlers.open(ws as never);
      },
      message(ws, message) {
        if (isBrowserRelaySocketData(ws.data)) {
          browserRelayWebsocketHandlers.message(ws as never, message);
          return;
        }
        twilioRelayWebsocketHandlers.message(ws as never, message);
      },
      close(ws, code, reason) {
        if (isBrowserRelaySocketData(ws.data)) {
          browserRelayWebsocketHandlers.close(ws as never, code, reason);
          return;
        }
        twilioRelayWebsocketHandlers.close(ws as never, code, reason);
      },
    },
    error(err) {
      if (err instanceof CircuitBreakerOpenError) {
        return Response.json(
          { error: "Service temporarily unavailable — runtime is unreachable" },
          { status: 503, headers: { "Retry-After": String(err.retryAfterSecs) } },
        );
      }
      log.error({ err }, "Unhandled gateway error");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    },
    async fetch(req, svr) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz") {
        return Response.json({ status: "ok" });
      }

      if (url.pathname === "/schema") {
        return Response.json(buildSchema());
      }

      if (url.pathname === "/readyz") {
        if (draining) {
          return Response.json({ status: "draining" }, { status: 503 });
        }
        return Response.json({ status: "ok" });
      }

      // Rate-limit check for auth-protected, pairing, and unauthenticated
      // endpoints that forward to the runtime (OAuth callback is publicly
      // reachable and forwards every valid-looking request).
      const isRateLimitedRoute = url.pathname === "/integrations/status" ||
        url.pathname === "/deliver/telegram" ||
        url.pathname === "/deliver/sms" ||
        url.pathname === "/deliver/whatsapp" ||
        url.pathname === "/deliver/slack" ||
        url.pathname.startsWith("/pairing/") ||
        url.pathname === "/webhooks/oauth/callback" ||
        (url.pathname.startsWith("/v1/") &&
          url.pathname !== "/v1/calls/twilio/voice-webhook" &&
          url.pathname !== "/v1/calls/twilio/status" &&
          url.pathname !== "/v1/calls/twilio/connect-action" &&
          url.pathname !== "/v1/browser-relay" &&
          url.pathname !== "/v1/calls/relay");
      if (isRateLimitedRoute) {
        const clientIp = getClientIp(req, svr, config.trustProxy);
        if (authRateLimiter.isBlocked(clientIp)) {
          log.warn({ ip: clientIp, path: url.pathname }, "Auth rate limit exceeded");
          return Response.json(
            { error: "Too many failed attempts. Try again later." },
            { status: 429, headers: { "Retry-After": "60" } },
          );
        }
      }

      // Attach a trace ID to every non-healthcheck request for
      // end-to-end correlation across webhook → runtime → reply.
      const traceId = req.headers.get("x-trace-id") || generateTraceId();
      const headers = new Headers(req.headers);
      headers.set("x-trace-id", traceId);
      const tracedReq = new Request(req, { headers });

      if (url.pathname === "/internal/telegram/reconcile") {
        return handleTelegramReconcile(tracedReq);
      }

      if (url.pathname === "/webhooks/telegram") {
        if (!isTelegramConfigured()) {
          return Response.json(
            { error: "Telegram integration not configured" },
            { status: 503 },
          );
        }
        return handleTelegramWebhook(tracedReq);
      }

      if (url.pathname === "/deliver/telegram") {
        if (!isTelegramConfigured()) {
          return Response.json(
            { error: "Telegram integration not configured" },
            { status: 503 },
          );
        }
        const res = await handleTelegramDeliver(tracedReq);
        if (res.status === 401) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      if (
        url.pathname === "/webhooks/twilio/voice" ||
        url.pathname === "/v1/calls/twilio/voice-webhook"
      ) {
        return handleTwilioVoiceWebhook(tracedReq);
      }

      if (
        url.pathname === "/webhooks/twilio/status" ||
        url.pathname === "/v1/calls/twilio/status"
      ) {
        return handleTwilioStatusWebhook(tracedReq);
      }

      if (
        url.pathname === "/webhooks/twilio/connect-action" ||
        url.pathname === "/v1/calls/twilio/connect-action"
      ) {
        return handleTwilioConnectActionWebhook(tracedReq);
      }

      if (url.pathname === "/webhooks/twilio/sms") {
        return handleTwilioSmsWebhook(tracedReq);
      }

      if (url.pathname === "/deliver/sms") {
        const res = await handleSmsDeliver(tracedReq);
        if (res.status === 401) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      if (url.pathname === "/webhooks/whatsapp") {
        if (!isWhatsAppConfigured()) {
          return Response.json(
            { error: "WhatsApp integration not configured" },
            { status: 503 },
          );
        }
        return handleWhatsAppWebhook(tracedReq);
      }

      if (url.pathname === "/deliver/whatsapp") {
        if (!isWhatsAppConfigured()) {
          return Response.json(
            { error: "WhatsApp integration not configured" },
            { status: 503 },
          );
        }
        const res = await handleWhatsAppDeliver(tracedReq);
        if (res.status === 401) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      if (url.pathname === "/deliver/slack") {
        if (!config.slackChannelBotToken) {
          return Response.json(
            { error: "Slack integration not configured" },
            { status: 503 },
          );
        }
        const res = await handleSlackDeliver(tracedReq);
        if (res.status === 401) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      if (url.pathname === "/webhooks/twilio/relay" || url.pathname === "/v1/calls/relay") {
        const upgradeResult = handleTwilioRelayWs(req, server);
        if (upgradeResult !== undefined) return upgradeResult;
        // If upgrade was handled, Bun doesn't need a response
        return undefined as unknown as Response;
      }

      if (config.runtimeProxyEnabled && url.pathname === "/v1/browser-relay") {
        const upgradeResult = handleBrowserRelayWs(req, server);
        if (upgradeResult !== undefined) return upgradeResult;
        // If upgrade was handled, Bun doesn't need a response
        return undefined as unknown as Response;
      }

      if (url.pathname === "/webhooks/oauth/callback" && tracedReq.method === "GET") {
        const res = await handleOAuthCallback(tracedReq);
        if (res.status === 400) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      if (url.pathname === "/integrations/status" && req.method === "GET") {
        if (!config.runtimeBearerToken) {
          return Response.json(
            { error: "Service not configured: bearer token required" },
            { status: 503 },
          );
        }
        const authResult = validateBearerToken(
          tracedReq.headers.get("authorization"),
          config.runtimeBearerToken,
        );
        if (!authResult.authorized) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        return Response.json({
          email: {
            address: config.assistantEmail ?? null,
          },
        });
      }

      // ── Pairing proxy (unauthenticated at gateway, secret-gated) ──
      // Record auth failures when the daemon rejects the pairing secret
      if (url.pathname === "/pairing/request" && tracedReq.method === "POST") {
        const res = await pairingProxy.handlePairingRequest(tracedReq);
        if (res.status === 401 || res.status === 403) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }
      if (url.pathname === "/pairing/status" && tracedReq.method === "GET") {
        const res = await pairingProxy.handlePairingStatus(tracedReq);
        if (res.status === 401 || res.status === 403) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      if (handleRuntimeProxy) {
        const res = await handleRuntimeProxy(tracedReq, getClientIp(req, svr, config.trustProxy));
        if (res.status === 401) {
          authRateLimiter.recordFailure(getClientIp(req, svr, config.trustProxy));
        }
        return res;
      }

      return Response.json({ error: "Not found", source: "gateway" }, { status: 404 });
    },
  });

  log.info({ port: server.port }, "Gateway HTTP server listening");

  // Start periodic background cleanup for dedup caches
  telegramDedupCache.startCleanup();
  smsDedupCache.startCleanup();
  whatsappDedupCache.startCleanup();

  function registerTelegramCommands(): void {
    callTelegramApi(config, "setMyCommands", {
      commands: [
        { command: "new", description: "Start a new conversation" },
        { command: "help", description: "Show available commands" },
      ],
    }).catch((err) => {
      log.error({ err }, "Failed to register Telegram bot commands");
    });
  }

  if (isTelegramConfigured()) {
    registerTelegramCommands();
    reconcileTelegramWebhook(config).catch((err) => {
      log.error({ err }, "Failed to reconcile Telegram webhook on startup");
    });
  }

  // ── Slack Socket Mode lifecycle ──
  let slackSocketClient: SlackSocketModeClient | null = null;

  function startSlackSocket(): void {
    if (slackSocketClient) {
      slackSocketClient.stop();
      slackSocketClient = null;
    }
    if (!isSlackChannelConfigured(config)) return;

    slackSocketClient = createSlackSocketModeClient(
      {
        appToken: config.slackChannelAppToken!,
        botToken: config.slackChannelBotToken!,
        gatewayConfig: config,
      },
      (normalized) => {
        const { threadTs, channel } = normalized;
        const replyCallbackUrl =
          `${config.gatewayInternalBaseUrl}/deliver/slack?threadTs=${encodeURIComponent(threadTs)}&channel=${encodeURIComponent(channel)}`;

        handleInbound(config, normalized.event, {
          replyCallbackUrl,
          routingOverride: normalized.routing,
        }).catch((err) => {
          log.error({ err, channel, threadTs }, "Failed to forward Slack event to runtime");
        });
      },
    );

    slackSocketClient.start().catch((err) => {
      log.error({ err }, "Failed to start Slack Socket Mode client");
    });
    log.info("Slack Socket Mode client started");
  }

  if (isSlackChannelConfigured(config)) {
    startSlackSocket();
  }

  const telegramFromEnv = isTelegramConfigured();
  const slackFromEnv = !!(process.env.SLACK_CHANNEL_BOT_TOKEN && process.env.SLACK_CHANNEL_APP_TOKEN);

  const credentialWatcher = new CredentialWatcher((event) => {
    if (event.telegramChanged && !telegramFromEnv) {
      if (event.telegramCredentials) {
        config.telegramBotToken = event.telegramCredentials.botToken;
        config.telegramWebhookSecret = event.telegramCredentials.webhookSecret;
        log.info("Telegram credentials loaded from credential vault");
        registerTelegramCommands();
        reconcileTelegramWebhook(config).catch((err) => {
          log.error({ err }, "Failed to reconcile Telegram webhook after credential change");
        });
      } else {
        config.telegramBotToken = undefined;
        config.telegramWebhookSecret = undefined;
        log.info("Telegram credentials cleared");
      }
    }

    if (event.twilioChanged) {
      if (event.twilioCredentials) {
        config.twilioAccountSid = event.twilioCredentials.accountSid;
        config.twilioAuthToken = event.twilioCredentials.authToken;
        log.info("Twilio credentials loaded from credential vault");
      } else {
        config.twilioAccountSid = undefined;
        config.twilioAuthToken = undefined;
        log.info("Twilio credentials cleared");
      }
    }

    if (event.whatsappChanged) {
      if (event.whatsappCredentials) {
        config.whatsappPhoneNumberId = event.whatsappCredentials.phoneNumberId;
        config.whatsappAccessToken = event.whatsappCredentials.accessToken;
        config.whatsappAppSecret = event.whatsappCredentials.appSecret;
        config.whatsappWebhookVerifyToken = event.whatsappCredentials.webhookVerifyToken;
        log.info("WhatsApp credentials loaded from credential vault");
      } else {
        config.whatsappPhoneNumberId = undefined;
        config.whatsappAccessToken = undefined;
        config.whatsappAppSecret = undefined;
        config.whatsappWebhookVerifyToken = undefined;
        log.info("WhatsApp credentials cleared");
      }
    }

    if (event.slackChannelChanged && !slackFromEnv) {
      if (event.slackChannelCredentials) {
        config.slackChannelBotToken = event.slackChannelCredentials.botToken;
        config.slackChannelAppToken = event.slackChannelCredentials.appToken;
        log.info("Slack channel credentials loaded from credential vault");
      } else {
        config.slackChannelBotToken = undefined;
        config.slackChannelAppToken = undefined;
        log.info("Slack channel credentials cleared");
      }
      startSlackSocket();
    }
  });

  credentialWatcher.start();

  const configFileWatcher = new ConfigFileWatcher((event) => {
    if (event.smsPhoneNumberChanged) {
      config.twilioPhoneNumber = event.smsPhoneNumber;
    }

    if (event.assistantPhoneNumbersChanged) {
      config.assistantPhoneNumbers = event.assistantPhoneNumbers;
    }

    if (event.assistantEmailChanged) {
      config.assistantEmail = event.assistantEmail;
    }

    if (event.ingressChanged) {
      config.ingressPublicBaseUrl = event.ingressPublicBaseUrl;
      if (isTelegramConfigured()) {
        reconcileTelegramWebhook(config).catch((err) => {
          log.error({ err }, "Failed to reconcile Telegram webhook after ingress URL change");
        });
      }
    }
  });

  configFileWatcher.start();

  const httpTokenWatcher = startHttpTokenWatcher(config);

  const drainMs = config.shutdownDrainMs;

  process.on("SIGTERM", () => {
    log.info("SIGTERM received, starting graceful shutdown");
    draining = true;
    credentialWatcher.stop();
    configFileWatcher.stop();
    httpTokenWatcher?.close();
    telegramDedupCache.stopCleanup();
    smsDedupCache.stopCleanup();
    whatsappDedupCache.stopCleanup();
    if (slackSocketClient) {
      slackSocketClient.stop();
      slackSocketClient = null;
    }
    setTimeout(() => {
      log.info("Drain window elapsed, stopping server");
      server.stop(true);
      process.exit(0);
    }, drainMs);
  });
}

main();
