/**
 * Minimal JWT minting for the external CLI.
 *
 * Loads the shared HMAC signing key from disk and mints short-lived JWTs
 * so the CLI can authenticate with the daemon's HTTP server without reading
 * the deprecated http-token file.
 */

import { createHmac, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

import { CURRENT_POLICY_EPOCH } from "./policy.js";

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return buf.toString("base64url");
}

const JWT_HEADER = base64urlEncode(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
);

/**
 * Mint a short-lived JWT bearer token for the given instance directory.
 *
 * Reads the signing key from `<instanceDir>/.vellum/protected/actor-token-signing-key`
 * and mints a 30-day JWT with `aud=vellum-gateway`.
 *
 * Returns undefined if the signing key doesn't exist yet (daemon not started).
 */
export function mintLocalBearerToken(instanceDir: string): string | undefined {
  try {
    const keyPath = join(
      instanceDir,
      ".vellum",
      "protected",
      "actor-token-signing-key",
    );
    const key = readFileSync(keyPath);
    if (key.length !== 32) return undefined;

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "vellum-auth",
      aud: "vellum-gateway",
      sub: "local:cli:cli",
      scope_profile: "actor_client_v1",
      exp: now + 30 * 24 * 60 * 60,
      policy_epoch: CURRENT_POLICY_EPOCH,
      iat: now,
      jti: randomBytes(16).toString("hex"),
    };

    const payload = base64urlEncode(JSON.stringify(claims));
    const sigInput = JWT_HEADER + "." + payload;
    const sig = createHmac("sha256", key).update(sigInput).digest();
    return sigInput + "." + base64urlEncode(sig);
  } catch {
    return undefined;
  }
}
