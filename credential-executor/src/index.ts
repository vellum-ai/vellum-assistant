#!/usr/bin/env bun
/**
 * @vellumai/credential-executor
 *
 * Credential Execution Service (CES) — an isolated runtime that executes
 * credential-bearing tool operations on behalf of untrusted agents. The CES
 * receives RPC requests from the assistant daemon, materialises credentials
 * from the local credential store, executes the requested operation through
 * the egress proxy, and returns sanitised results.
 *
 * This entrypoint bootstraps the CES process and starts listening for
 * incoming transport connections from the assistant.
 */

import { CES_PROTOCOL_VERSION } from "@vellumai/ces-contracts";

const PORT = parseInt(process.env["CES_PORT"] ?? "7840", 10);

console.log(
  `[credential-executor] Starting CES v${CES_PROTOCOL_VERSION} on port ${PORT}`,
);

// Placeholder — the server implementation will be added in subsequent PRs.
const server = Bun.serve({
  port: PORT,
  fetch(_req) {
    return new Response(
      JSON.stringify({
        service: "credential-executor",
        protocolVersion: CES_PROTOCOL_VERSION,
        status: "ok",
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  },
});

console.log(`[credential-executor] Listening on http://localhost:${server.port}`);
