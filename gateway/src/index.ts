import pino from "pino";
import { loadConfig } from "./config.js";
import { createRuntimeProxyHandler } from "./http/routes/runtime-proxy.js";
import { createTelegramWebhookHandler } from "./http/routes/telegram-webhook.js";
import { sendTelegramReply, sendTelegramAttachments } from "./telegram/send.js";
import { callTelegramApi } from "./telegram/api.js";

const log = pino({ name: "gateway" });

let draining = false;

function main() {
  log.info("Starting Vellum Gateway...");

  const config = loadConfig();

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

  const handleRuntimeProxy = config.runtimeProxyEnabled
    ? createRuntimeProxyHandler(config)
    : null;

  const server = Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz") {
        return Response.json({ status: "ok" });
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

      if (handleRuntimeProxy) {
        return handleRuntimeProxy(req);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
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
