/**
 * One-shot endpoint that serves the gateway's actor-token signing key to
 * the daemon during Docker bootstrap. Protected by a lockfile so the key
 * can only be read once (across restarts).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getSigningKeyPath } from "../../auth/token-service.js";
import type { GatewayConfig } from "../../config.js";
import { getRootDir } from "../../credential-reader.js";
import { getLogger } from "../../logger.js";

const log = getLogger("signing-key-bootstrap");

export function createSigningKeyBootstrapHandler(_config: GatewayConfig) {
  let inFlight = false;

  return {
    async handleGetSigningKey(req: Request): Promise<Response> {
      // When GUARDIAN_BOOTSTRAP_SECRET is set (Docker mode), require the
      // caller to present the matching secret. This prevents unauthenticated
      // remote callers from fetching the raw signing key through the gateway.
      const bootstrapSecret = process.env.GUARDIAN_BOOTSTRAP_SECRET;
      if (bootstrapSecret) {
        const provided = req.headers.get("x-bootstrap-secret");
        if (provided !== bootstrapSecret) {
          log.warn("Signing key bootstrap rejected — invalid or missing bootstrap secret");
          return Response.json(
            { error: "Invalid bootstrap secret" },
            { status: 403 },
          );
        }
      }

      const lockDir = process.env.GATEWAY_SECURITY_DIR || getRootDir();
      const lockPath = join(lockDir, "signing-key-bootstrap.lock");

      if (existsSync(lockPath) || inFlight) {
        log.warn("Signing key bootstrap rejected — already completed");
        return Response.json(
          { error: "Bootstrap already completed" },
          { status: 403 },
        );
      }

      inFlight = true;
      try {
        const keyPath = getSigningKeyPath();
        const keyBytes = readFileSync(keyPath);

        const response = Response.json({
          key: Buffer.from(keyBytes).toString("hex"),
        });

        try {
          writeFileSync(lockPath, new Date().toISOString(), { mode: 0o600 });
        } catch (err) {
          inFlight = false;
          log.error({ err }, "Failed to write signing-key-bootstrap lock file");
          return Response.json(
            { error: "Failed to persist bootstrap lock — refusing to serve key" },
            { status: 500 },
          );
        }

        return response;
      } catch (err) {
        inFlight = false;
        log.error({ err }, "Failed to read signing key for bootstrap");
        return Response.json(
          { error: "Internal server error" },
          { status: 500 },
        );
      }
    },
  };
}
