import { randomBytes } from "node:crypto";
import { ConfigFileWatcher } from "./config-file-watcher.js";
import { loadConfig } from "./config.js";
import { CredentialWatcher } from "./credential-watcher.js";
import { createRuntimeProxyHandler } from "./http/routes/runtime-proxy.js";
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
import { createOAuthCallbackHandler } from "./http/routes/oauth-callback.js";
import { getLogger, initLogger } from "./logger.js";
import { buildSchema } from "./schema.js";
import { callTelegramApi } from "./telegram/api.js";
import { reconcileTelegramWebhook } from "./telegram/webhook-manager.js";

const log = getLogger("main");

function generateTraceId(): string {
  return randomBytes(8).toString("hex");
}

let draining = false;

function main() {
  const config = loadConfig();
  initLogger(config.logFile);

  log.info("Starting Vellum Gateway...");

  const handleTelegramWebhook = createTelegramWebhookHandler(config);
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
  const handleTwilioSmsWebhook = createTwilioSmsWebhookHandler(config);
  const handleSmsDeliver = createSmsDeliverHandler(config);
  const handleWhatsAppWebhook = createWhatsAppWebhookHandler(config);
  const handleWhatsAppDeliver = createWhatsAppDeliverHandler(config);
  const handleOAuthCallback = createOAuthCallbackHandler(config);

  const handleRuntimeProxy = config.runtimeProxyEnabled
    ? createRuntimeProxyHandler(config)
    : null;

  const server = Bun.serve({
    port: config.port,
    websocket: getRelayWebsocketHandlers(),
    error(err) {
      log.error({ err }, "Unhandled gateway error");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    },
    async fetch(req) {
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
        return handleTelegramDeliver(tracedReq);
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
        return handleSmsDeliver(tracedReq);
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
        return handleWhatsAppDeliver(tracedReq);
      }

      if (url.pathname === "/webhooks/twilio/relay" || url.pathname === "/v1/calls/relay") {
        const upgradeResult = handleTwilioRelayWs(req, server);
        if (upgradeResult !== undefined) return upgradeResult;
        // If upgrade was handled, Bun doesn't need a response
        return undefined as unknown as Response;
      }

      if (url.pathname === "/webhooks/oauth/callback" && tracedReq.method === "GET") {
        return handleOAuthCallback(tracedReq);
      }

      if (url.pathname === "/integrations/status" && req.method === "GET") {
        return Response.json({
          email: {
            address: config.assistantEmail ?? null,
          },
        });
      }

      if (handleRuntimeProxy) {
        return handleRuntimeProxy(tracedReq);
      }

      return Response.json({ error: "Not found", source: "gateway" }, { status: 404 });
    },
  });

  log.info({ port: server.port }, "Gateway HTTP server listening");

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

  const telegramFromEnv = isTelegramConfigured();

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

  const drainMs = config.shutdownDrainMs;

  process.on("SIGTERM", () => {
    log.info("SIGTERM received, starting graceful shutdown");
    draining = true;
    credentialWatcher.stop();
    configFileWatcher.stop();
    setTimeout(() => {
      log.info("Drain window elapsed, stopping server");
      server.stop(true);
      process.exit(0);
    }, drainMs);
  });
}

main();
