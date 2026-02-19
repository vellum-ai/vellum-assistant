import { loadConfig } from "./config.js";
import { createRuntimeProxyHandler } from "./http/routes/runtime-proxy.js";
import { createTelegramWebhookHandler } from "./http/routes/telegram-webhook.js";
import { createTwilioVoiceWebhookHandler } from "./http/routes/twilio-voice-webhook.js";
import { createTwilioStatusWebhookHandler } from "./http/routes/twilio-status-webhook.js";
import { createTwilioConnectActionWebhookHandler } from "./http/routes/twilio-connect-action-webhook.js";
import { createTwilioRelayWebsocketHandler, getRelayWebsocketHandlers } from "./http/routes/twilio-relay-websocket.js";
import { getLogger, initLogger } from "./logger.js";
import { buildSchema } from "./schema.js";
import { callTelegramApi } from "./telegram/api.js";
import { sendTelegramAttachments, sendTelegramReply } from "./telegram/send.js";

const log = getLogger("main");

let draining = false;

function main() {
  const config = loadConfig();
  initLogger(config.logFile);

  log.info("Starting Vellum Gateway...");

  const telegramConfigured = !!(config.telegramBotToken && config.telegramWebhookSecret);

  const handleTelegramWebhook = telegramConfigured
    ? createTelegramWebhookHandler(
        config,
        async (chatId, result, assistantId) => {
          const msg = result.runtimeResponse?.assistantMessage;
          const content = msg?.content;
          const attachments = msg?.attachments ?? [];

          if (!content && attachments.length === 0) {
            return;
          }

          try {
            if (content) {
              await sendTelegramReply(config, chatId, content);
            }
          } catch (err) {
            log.error({ err, chatId }, "Failed to send Telegram reply");
          }

          if (attachments.length > 0) {
            try {
              await sendTelegramAttachments(config, chatId, assistantId, attachments);
            } catch (err) {
              log.error({ err, chatId }, "Failed to send Telegram attachments");
            }
          }
        },
      )
    : null;

  const handleTwilioVoiceWebhook = createTwilioVoiceWebhookHandler(config);
  const handleTwilioStatusWebhook = createTwilioStatusWebhookHandler(config);
  const handleTwilioConnectActionWebhook = createTwilioConnectActionWebhookHandler(config);
  const handleTwilioRelayWs = createTwilioRelayWebsocketHandler(config);

  const handleRuntimeProxy = config.runtimeProxyEnabled
    ? createRuntimeProxyHandler(config)
    : null;

  const server = Bun.serve({
    port: config.port,
    websocket: getRelayWebsocketHandlers(),
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

      if (url.pathname === "/webhooks/telegram") {
        if (!handleTelegramWebhook) {
          return Response.json(
            { error: "Telegram integration not configured" },
            { status: 503 },
          );
        }
        return handleTelegramWebhook(req);
      }

      if (
        url.pathname === "/webhooks/twilio/voice" ||
        url.pathname === "/v1/calls/twilio/voice-webhook"
      ) {
        return handleTwilioVoiceWebhook(req);
      }

      if (
        url.pathname === "/webhooks/twilio/status" ||
        url.pathname === "/v1/calls/twilio/status"
      ) {
        return handleTwilioStatusWebhook(req);
      }

      if (
        url.pathname === "/webhooks/twilio/connect-action" ||
        url.pathname === "/v1/calls/twilio/connect-action"
      ) {
        return handleTwilioConnectActionWebhook(req);
      }

      if (url.pathname === "/webhooks/twilio/relay") {
        const upgradeResult = handleTwilioRelayWs(req, server);
        if (upgradeResult !== undefined) return upgradeResult;
        // If upgrade was handled, Bun doesn't need a response
        return undefined as unknown as Response;
      }

      if (handleRuntimeProxy) {
        return handleRuntimeProxy(req);
      }

      return Response.json({ error: "Not found", source: "gateway" }, { status: 404 });
    },
  });

  log.info({ port: server.port }, "Gateway HTTP server listening");

  if (telegramConfigured) {
    callTelegramApi(config, "setMyCommands", {
      commands: [{ command: "new", description: "Start a new conversation" }],
    }).catch((err) => {
      log.error({ err }, "Failed to register Telegram bot commands");
    });
  }

  const drainMs = config.shutdownDrainMs;

  process.on("SIGTERM", () => {
    log.info("SIGTERM received, starting graceful shutdown");
    draining = true;
    setTimeout(() => {
      log.info("Drain window elapsed, stopping server");
      server.stop(true);
      process.exit(0);
    }, drainMs);
  });
}

main();
