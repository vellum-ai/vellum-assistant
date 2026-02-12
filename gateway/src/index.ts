import pino from "pino";
import { loadConfig } from "./config.js";
import { createTelegramWebhookHandler } from "./http/routes/telegram-webhook.js";

const log = pino({ name: "gateway" });

function main() {
  log.info("Starting Vellum Gateway...");

  const config = loadConfig();

  const handleTelegramWebhook = createTelegramWebhookHandler(config);

  const server = Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/webhooks/telegram") {
        return handleTelegramWebhook(req);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  log.info({ port: server.port }, "Gateway HTTP server listening");
}

main();
