process.title = "vellum-managed-gateway";

import { loadConfig } from "./config.js";
import { createManagedGatewayAppFetch } from "./http.js";

const config = loadConfig();
const appFetch = createManagedGatewayAppFetch(config);

const server = Bun.serve({
  port: config.port,
  async fetch(req) {
    return appFetch(req);
  },
});

console.log(`Managed gateway listening on port ${config.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop(true);
    process.exit(0);
  });
}
