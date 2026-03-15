/**
 * Inlined platform utilities used by the DoorDash skill.
 * Subset of assistant/src/util/platform.ts — kept minimal.
 */

import {
  createDecipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";

function getRootDir(): string {
  const base = process.env.BASE_DATA_DIR?.trim();
  return join(base || homedir(), ".vellum");
}

export function getDataDir(): string {
  return join(getRootDir(), "workspace", "data");
}

/** Default daemon HTTP port — matches cli/src/lib/constants.ts. */
const DEFAULT_DAEMON_PORT = 7821;

/**
 * Resolve the daemon HTTP port from RUNTIME_HTTP_PORT env var or default.
 */
export function getHttpPort(): number {
  const envPort = process.env.RUNTIME_HTTP_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return DEFAULT_DAEMON_PORT;
}

/**
 * Build the base URL for the daemon HTTP server.
 */
export function buildDaemonUrl(port?: number): string {
  return `http://127.0.0.1:${port ?? getHttpPort()}`;
}

/** Must stay in sync with assistant/src/runtime/auth/policy.ts. */
const CURRENT_POLICY_EPOCH = 1;

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return buf.toString("base64url");
}

const JWT_HEADER = base64urlEncode(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
);

// ---------------------------------------------------------------------------
// Credential store reader (inlined subset of assistant/src/security/encrypted-store.ts)
// ---------------------------------------------------------------------------

const CREDENTIAL_KEY = "credential/bootstrapped_actor/http_token";

function getMachineEntropy(): string {
  const parts: string[] = [];
  try {
    parts.push(hostname());
  } catch {
    parts.push("unknown-host");
  }
  try {
    parts.push(userInfo().username);
  } catch {
    parts.push("unknown-user");
  }
  parts.push(process.platform);
  parts.push(arch());
  try {
    parts.push(userInfo().homedir);
  } catch {
    parts.push("/tmp");
  }
  return parts.join(":");
}

/**
 * Read the bootstrapped actor HTTP token from the encrypted credential store.
 * Returns null if the store doesn't exist or the token isn't found.
 */
export function readCredentialToken(): string | null {
  try {
    const storePath = join(getRootDir(), "protected", "keys.enc");
    const raw = readFileSync(storePath, "utf-8");
    const store = JSON.parse(raw) as {
      version: number;
      salt: string;
      entries: Record<string, { iv: string; tag: string; data: string }>;
    };
    if (
      store.version !== 1 ||
      typeof store.salt !== "string" ||
      typeof store.entries !== "object"
    )
      return null;

    const entry = store.entries[CREDENTIAL_KEY];
    if (!entry) return null;

    const salt = Buffer.from(store.salt, "hex");
    const key = pbkdf2Sync(getMachineEntropy(), salt, 100_000, 32, "sha512");
    const iv = Buffer.from(entry.iv, "hex");
    const tag = Buffer.from(entry.tag, "hex");
    const data = Buffer.from(entry.data, "hex");
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: 16,
    });
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(data),
      decipher.final(),
    ]);
    return decrypted.toString("utf-8") || null;
  } catch {
    return null;
  }
}

/**
 * @deprecated Prefer {@link readCredentialToken} which reads from the
 * encrypted credential store instead of minting a JWT from the signing key.
 */
export function readHttpToken(): string | null {
  try {
    const keyPath = join(getRootDir(), "protected", "actor-token-signing-key");
    const key = readFileSync(keyPath);
    if (key.length !== 32) return null;

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "vellum-auth",
      aud: "vellum-gateway",
      sub: "local:cli:cli",
      scope_profile: "actor_client_v1",
      exp: now + 300,
      policy_epoch: CURRENT_POLICY_EPOCH,
      iat: now,
      jti: randomBytes(16).toString("hex"),
    };

    const payload = base64urlEncode(JSON.stringify(claims));
    const sigInput = JWT_HEADER + "." + payload;
    const sig = createHmac("sha256", key).update(sigInput).digest();
    return sigInput + "." + base64urlEncode(sig);
  } catch {
    return null;
  }
}
