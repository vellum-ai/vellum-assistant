import pino from "pino";
import { loadConfig } from "./config.js";

const log = pino({ name: "gateway" });

function main() {
  log.info("Starting Vellum Gateway...");

  const config = loadConfig();

  const server = Bun.serve({
    port: config.port,
    fetch(_req) {
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  log.info({ port: server.port }, "Gateway HTTP server listening");
}

main();
