import pino from "pino";
import { loadConfig } from "./config.js";
import { createRuntimeProxyHandler } from "./http/routes/runtime-proxy.js";
import { createTelegramWebhookHandler } from "./http/routes/telegram-webhook.js";
import { sendTelegramReply } from "./telegram/send.js";
import { callTelegramApi } from "./telegram/api.js";

const log = pino({ name: "gateway" });

let draining = false;

function main() {
  log.info("Starting Vellum Gateway...");

  const config = loadConfig();

  const handleTelegramWebhook = createTelegramWebhookHandler(
    config,
    async (chatId, result) => {
      const content = result.runtimeResponse?.assistantMessage?.content;
      if (!content) {
        return;
      }

      try {
        await sendTelegramReply(config, chatId, content);
      } catch (err) {
        log.error({ err, chatId }, "Failed to send Telegram reply");
      }
    },
  );

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
        return handleTelegramWebhook(req);
      }

      if (handleRuntimeProxy) {
        return handleRuntimeProxy(req);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  log.info({ port: server.port }, "Gateway HTTP server listening");

  // Register bot commands with Telegram (fire-and-forget)
  callTelegramApi(config, "setMyCommands", {
    commands: [{ command: "new", description: "Start a new conversation" }],
  }).catch((err) => {
    log.error({ err }, "Failed to register Telegram bot commands");
  });

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
