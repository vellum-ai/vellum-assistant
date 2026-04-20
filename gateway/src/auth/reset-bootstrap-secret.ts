/**
 * Reset-bootstrap secret management for the gateway.
 *
 * Used by `POST /v1/guardian/reset-bootstrap` as a caller-bound proof on top
 * of the loopback-origin check: the request is only accepted if the caller
 * sends a matching `X-Reset-Bootstrap-Secret` header whose value is also
 * stored at {getGatewaySecurityDir()}/reset-bootstrap-secret with mode 0600.
 *
 * This mirrors the signing-key pattern in `auth/token-service.ts` — the CLI
 * owns the value (generated during hatch, persisted in the lockfile) and
 * forwards it as `RESET_BOOTSTRAP_SECRET`. The gateway reconciles the env
 * var onto disk so both the recovery handler and the macOS recovery UI can
 * read it.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../logger.js";
import { getGatewaySecurityDir } from "../paths.js";

const log = getLogger("auth-reset-bootstrap-secret");

export function getResetBootstrapSecretPath(): string {
  return join(getGatewaySecurityDir(), "reset-bootstrap-secret");
}

function atomicWrite(path: string, value: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, value, { mode: 0o600 });
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
}

/**
 * Resolve the reset-bootstrap secret for the gateway and persist it to disk.
 *
 * Resolution order:
 *   1. `RESET_BOOTSTRAP_SECRET` env var (hex, set by CLI). Takes precedence
 *      over any on-disk value so the CLI can rotate the secret.
 *   2. Existing on-disk secret (`<security-dir>/reset-bootstrap-secret`).
 *   3. Generate a fresh secret and persist it (dev / standalone gateway).
 */
export function loadOrCreateResetBootstrapSecret(): string {
  const envSecret = process.env.RESET_BOOTSTRAP_SECRET;
  if (envSecret) {
    if (!/^[0-9a-f]{64}$/i.test(envSecret)) {
      throw new Error(
        `Invalid RESET_BOOTSTRAP_SECRET: expected 64 hex characters, got ${envSecret.length} chars`,
      );
    }
    try {
      atomicWrite(getResetBootstrapSecretPath(), envSecret + "\n");
      log.info(
        "Reset-bootstrap secret loaded from RESET_BOOTSTRAP_SECRET env var",
      );
    } catch (err) {
      log.error(
        { err },
        "Failed to persist reset-bootstrap secret to disk — recovery UI will fail",
      );
    }
    return envSecret;
  }

  const secretPath = getResetBootstrapSecretPath();
  if (existsSync(secretPath)) {
    try {
      const raw = readFileSync(secretPath, "utf-8").trim();
      if (raw.length > 0) {
        log.info("Reset-bootstrap secret loaded from disk");
        return raw;
      }
      log.warn("Reset-bootstrap secret file is empty, regenerating");
    } catch (err) {
      log.warn({ err }, "Failed to read reset-bootstrap secret, regenerating");
    }
  }

  const value = randomBytes(32).toString("hex");
  try {
    atomicWrite(secretPath, value + "\n");
    log.info("Reset-bootstrap secret generated and persisted");
  } catch (err) {
    log.error(
      { err },
      "Failed to persist reset-bootstrap secret — recovery endpoint will 403",
    );
  }
  return value;
}
