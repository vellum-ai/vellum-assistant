/**
 * Bound platform identity for managed-mode edge auth and whoami.
 *
 * Assistant, user, and organization ids are provisioned into the credential
 * vault, but they are not secrets. Successful reads persist to
 * `platform-identity.json` under the gateway security dir so a vault outage
 * (or a vault that answers empty) does not look like a missing owner.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { credentialKey } from "./credential-key.js";
import { readCredentialResult } from "./credential-reader.js";
import { getLogger } from "./logger.js";
import { getGatewaySecurityDir } from "./paths.js";

const log = getLogger("platform-identity");

const IDENTITY_FILENAME = "platform-identity.json";

const ASSISTANT_ID_ACCOUNT = credentialKey("vellum", "platform_assistant_id");
const USER_ID_ACCOUNT = credentialKey("vellum", "platform_user_id");
const ORGANIZATION_ID_ACCOUNT = credentialKey(
  "vellum",
  "platform_organization_id",
);

export type PlatformIdentity = {
  assistantId?: string;
  userId?: string;
  organizationId?: string;
};

let memory: PlatformIdentity | undefined;

function identityPath(): string {
  return join(getGatewaySecurityDir(), IDENTITY_FILENAME);
}

function hasAnyId(identity: PlatformIdentity): boolean {
  return Boolean(
    identity.assistantId || identity.userId || identity.organizationId,
  );
}

function parseStoredIdentity(raw: string): PlatformIdentity {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  const obj = parsed as Record<string, unknown>;
  const identity: PlatformIdentity = {};
  if (typeof obj.assistantId === "string" && obj.assistantId.length > 0) {
    identity.assistantId = obj.assistantId;
  }
  if (typeof obj.userId === "string" && obj.userId.length > 0) {
    identity.userId = obj.userId;
  }
  if (typeof obj.organizationId === "string" && obj.organizationId.length > 0) {
    identity.organizationId = obj.organizationId;
  }
  return identity;
}

function readIdentityFile(): PlatformIdentity {
  try {
    return parseStoredIdentity(readFileSync(identityPath(), "utf-8"));
  } catch {
    return {};
  }
}

function persistIdentity(identity: PlatformIdentity): void {
  memory = identity;
  try {
    mkdirSync(getGatewaySecurityDir(), { recursive: true });
    writeFileSync(
      identityPath(),
      `${JSON.stringify({
        assistantId: identity.assistantId ?? null,
        userId: identity.userId ?? null,
        organizationId: identity.organizationId ?? null,
      })}\n`,
    );
  } catch (err) {
    log.warn({ err }, "failed to persist platform identity");
  }
}

function cachedIdentity(): PlatformIdentity {
  if (memory && hasAnyId(memory)) {
    return memory;
  }
  const fromFile = readIdentityFile();
  if (hasAnyId(fromFile)) {
    memory = fromFile;
  }
  return fromFile;
}

export type PlatformIdentityRead = {
  identity: PlatformIdentity;
  unreachable: boolean;
};

/**
 * Resolve the bound platform assistant/user/organization ids.
 *
 * `unreachable: true` only when the vault is down and no durable identity
 * is cached. A cached identity is returned with `unreachable: false` so
 * callers keep treating the assistant as reachable.
 *
 * A vault that answers successfully with no values does not overwrite a
 * previously persisted identity.
 */
export async function readPlatformIdentity(): Promise<PlatformIdentityRead> {
  const [assistant, user, org] = await Promise.all([
    readCredentialResult(ASSISTANT_ID_ACCOUNT),
    readCredentialResult(USER_ID_ACCOUNT),
    readCredentialResult(ORGANIZATION_ID_ACCOUNT),
  ]);

  if (assistant.unreachable || user.unreachable || org.unreachable) {
    const cached = cachedIdentity();
    if (hasAnyId(cached)) {
      log.warn(
        "platform identity vault unreachable; using last known identity",
      );
      return { identity: cached, unreachable: false };
    }
    return { identity: {}, unreachable: true };
  }

  const live: PlatformIdentity = {
    assistantId: assistant.value,
    userId: user.value,
    organizationId: org.value,
  };
  if (hasAnyId(live)) {
    persistIdentity(live);
    return { identity: live, unreachable: false };
  }

  const cached = cachedIdentity();
  if (hasAnyId(cached)) {
    return { identity: cached, unreachable: false };
  }
  return { identity: {}, unreachable: false };
}

export type StoredPlatformUserId = {
  userId: string | undefined;
  unreachable: boolean;
};

/**
 * Resolve the bound `platform_user_id`.
 *
 * Wrapper over `readPlatformIdentity` for edge auth and the guardian pin.
 */
export async function readStoredPlatformUserId(): Promise<StoredPlatformUserId> {
  const result = await readPlatformIdentity();
  return { userId: result.identity.userId, unreachable: result.unreachable };
}

/** @internal Test-only: drop in-memory identity. The on-disk file stays. */
export function _dropPlatformIdentityMemoryForTest(): void {
  memory = undefined;
}

/** @internal Test-only: drop in-memory and on-disk identity. */
export function _resetLastKnownPlatformUserIdForTest(): void {
  memory = undefined;
  try {
    rmSync(identityPath());
  } catch {
    // missing is fine
  }
}
