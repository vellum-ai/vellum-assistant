import pino from "pino";
import { loadConfig } from "./config.js";
import { createRuntimeProxyHandler } from "./http/routes/runtime-proxy.js";
import { createTelegramWebhookHandler } from "./http/routes/telegram-webhook.js";
import { sendTelegramReply } from "./telegram/send.js";

const log = pino({ name: "gateway" });

function main() {
  log.info("Starting Vellum Gateway...");

  const config = loadConfig();

  const handleTelegramWebhook = createTelegramWebhookHandler(
    config,
    async (chatId, result) => {
      const content = result.runtimeResponse?.assistantMessage?.content;
      if (!content) return;

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
}

main();
