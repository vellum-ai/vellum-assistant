/**
 * Invocation grants for plugin-resident skill scripts and skill tools.
 *
 * The daemon is the only issuer. Plugin identity is copied from the skill
 * catalog's `owner` descriptor (install-directory basename), never from a
 * caller-supplied name, path, or environment value. The child receives a
 * short-lived bearer and presents it on later plugin-api calls; the daemon
 * scopes those calls to the grant's plugin service.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import { credentialKey } from "@vellumai/credential-storage";

import { credentialInPluginScope } from "../plugin-api/credential-scope.js";
import {
  formatPluginSkillGrantToken,
  parsePluginSkillGrantToken,
} from "../plugin-api/plugin-skill-grant.js";
import { getSecureKeyResultAsync } from "../security/secure-keys.js";
import {
  type CredentialMetadata,
  listCredentialRecordsLive,
} from "../tools/credentials/metadata-store.js";
import { parseServiceFieldRef } from "../tools/credentials/ref-parse.js";
import { resolveCredentialRef } from "../tools/credentials/resolve.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("plugin-skill-invocation");

export const DEFAULT_PLUGIN_SKILL_GRANT_TTL_MS = 120_000;
export const DEFAULT_PLUGIN_SKILL_GRANT_MAX_RESOLVES = 64;

export interface PluginSkillInvocationGrant {
  grantId: string;
  conversationId: string;
  pluginName: string;
  skillId: string;
  expiresAt: number;
  resolveCount: number;
  maxResolves: number;
}

interface StoredGrant extends PluginSkillInvocationGrant {
  secret: string;
}

const grants = new Map<string, StoredGrant>();

export interface IssuePluginSkillGrantInput {
  conversationId: string;
  pluginName: string;
  skillId: string;
  ttlMs?: number;
  maxResolves?: number;
  nowMs?: number;
}

export interface IssuedPluginSkillGrant {
  token: string;
  grant: PluginSkillInvocationGrant;
}

function sweepExpiredGrants(nowMs: number): void {
  for (const [grantId, grant] of grants) {
    if (grant.expiresAt <= nowMs) {
      grants.delete(grantId);
    }
  }
}

function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function publicGrant(stored: StoredGrant): PluginSkillInvocationGrant {
  return {
    grantId: stored.grantId,
    conversationId: stored.conversationId,
    pluginName: stored.pluginName,
    skillId: stored.skillId,
    expiresAt: stored.expiresAt,
    resolveCount: stored.resolveCount,
    maxResolves: stored.maxResolves,
  };
}

/**
 * Mint a conversation-bound grant for one plugin-owned skill invocation.
 * `pluginName` must already be the catalog owner id.
 */
export function issuePluginSkillGrant(
  input: IssuePluginSkillGrantInput,
): IssuedPluginSkillGrant {
  const nowMs = input.nowMs ?? Date.now();
  sweepExpiredGrants(nowMs);

  const grantId = randomBytes(16).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const stored: StoredGrant = {
    grantId,
    secret,
    conversationId: input.conversationId,
    pluginName: input.pluginName,
    skillId: input.skillId,
    expiresAt: nowMs + (input.ttlMs ?? DEFAULT_PLUGIN_SKILL_GRANT_TTL_MS),
    resolveCount: 0,
    maxResolves: input.maxResolves ?? DEFAULT_PLUGIN_SKILL_GRANT_MAX_RESOLVES,
  };
  grants.set(grantId, stored);

  log.info(
    {
      grantId,
      conversationId: input.conversationId,
      pluginName: input.pluginName,
      skillId: input.skillId,
    },
    "Issued plugin-skill invocation grant",
  );

  return {
    token: formatPluginSkillGrantToken(grantId, secret),
    grant: publicGrant(stored),
  };
}

export type GrantValidationFailure =
  | "malformed"
  | "unknown"
  | "expired"
  | "revoked"
  | "wrong_conversation"
  | "exhausted";

export type GrantValidationResult =
  | { ok: true; grant: PluginSkillInvocationGrant }
  | { ok: false; reason: GrantValidationFailure };

/**
 * Validate a child-presented token. Conversation is an optional extra check:
 * when the child sends one, it must match the grant. Plugin identity is never
 * taken from the child.
 */
export function validatePluginSkillGrant(
  token: string,
  options?: { conversationId?: string; nowMs?: number },
): GrantValidationResult {
  const parsed = parsePluginSkillGrantToken(token);
  if (!parsed) {
    return { ok: false, reason: "malformed" };
  }

  const nowMs = options?.nowMs ?? Date.now();
  const stored = grants.get(parsed.grantId);
  if (!stored) {
    sweepExpiredGrants(nowMs);
    return { ok: false, reason: "unknown" };
  }
  if (!secretsEqual(stored.secret, parsed.secret)) {
    return { ok: false, reason: "unknown" };
  }
  if (stored.expiresAt <= nowMs) {
    grants.delete(stored.grantId);
    sweepExpiredGrants(nowMs);
    return { ok: false, reason: "expired" };
  }
  sweepExpiredGrants(nowMs);
  if (
    options?.conversationId !== undefined &&
    options.conversationId !== stored.conversationId
  ) {
    return { ok: false, reason: "wrong_conversation" };
  }
  if (stored.resolveCount >= stored.maxResolves) {
    return { ok: false, reason: "exhausted" };
  }
  return { ok: true, grant: publicGrant(stored) };
}

/** Drop a grant so a later present is rejected as reused. */
export function revokePluginSkillGrant(token: string): void {
  const parsed = parsePluginSkillGrantToken(token);
  if (!parsed) {
    return;
  }
  const stored = grants.get(parsed.grantId);
  if (!stored || !secretsEqual(stored.secret, parsed.secret)) {
    return;
  }
  grants.delete(parsed.grantId);
}

function incrementResolveCount(grantId: string): void {
  const stored = grants.get(grantId);
  if (!stored) {
    return;
  }
  stored.resolveCount += 1;
}

export type PluginSkillCredentialFailure =
  | "invalid_grant"
  | "out_of_scope"
  | "not_found"
  | "unreachable";

export type PluginSkillCredentialResult =
  | { ok: true; value: string; service: string; field: string }
  | { ok: false; reason: PluginSkillCredentialFailure; message: string };

function findLiveRecord(
  records: CredentialMetadata[],
  ref: string,
): CredentialMetadata | undefined {
  const byId = records.find((record) => record.credentialId === ref);
  if (byId) {
    return byId;
  }
  const parsed = parseServiceFieldRef(ref);
  if (!parsed) {
    return undefined;
  }
  return records.find(
    (record) =>
      record.service === parsed.service && record.field === parsed.field,
  );
}

/**
 * Resolve a credential for a validated grant. The grant's plugin name is the
 * only owner. Live CES listing is consulted when the in-process cache misses,
 * so an empty local catalog cannot be reported as "not found".
 */
export async function resolveCredentialForPluginSkillGrant(
  token: string,
  ref: string,
  options?: { conversationId?: string; nowMs?: number },
): Promise<PluginSkillCredentialResult> {
  const validated = validatePluginSkillGrant(token, options);
  if (!validated.ok) {
    return {
      ok: false,
      reason: "invalid_grant",
      message: grantFailureMessage(validated.reason),
    };
  }

  const parsedRef = parseServiceFieldRef(ref);
  if (
    parsedRef !== undefined &&
    !credentialInPluginScope(validated.grant.pluginName, parsedRef.service)
  ) {
    return {
      ok: false,
      reason: "out_of_scope",
      message:
        `Plugin "${validated.grant.pluginName}" may only resolve credentials ` +
        `under its own service; "${parsedRef.service}/${parsedRef.field}" is out of scope.`,
    };
  }

  let service = parsedRef?.service;
  let field = parsedRef?.field;
  let storageKey: string | undefined;

  const cached = resolveCredentialRef(ref);
  if (cached) {
    service = cached.service;
    field = cached.field;
    storageKey = cached.storageKey;
  } else {
    const live = await listCredentialRecordsLive();
    if (live.unreachable) {
      return {
        ok: false,
        reason: "unreachable",
        message:
          "Credential store is unreachable. Ensure the assistant is running and can reach the credential store.",
      };
    }
    const record = findLiveRecord(live.records, ref);
    if (!record) {
      return {
        ok: false,
        reason: "not_found",
        message: `Credential not found: ${ref}`,
      };
    }
    service = record.service;
    field = record.field;
    storageKey = credentialKey(record.service, record.field);
  }

  if (
    service === undefined ||
    field === undefined ||
    storageKey === undefined
  ) {
    return {
      ok: false,
      reason: "not_found",
      message: `Credential not found: ${ref}`,
    };
  }

  if (!credentialInPluginScope(validated.grant.pluginName, service)) {
    return {
      ok: false,
      reason: "out_of_scope",
      message:
        `Plugin "${validated.grant.pluginName}" may only resolve credentials ` +
        `under its own service; "${service}/${field}" is out of scope.`,
    };
  }

  incrementResolveCount(validated.grant.grantId);

  const { value, unreachable } = await getSecureKeyResultAsync(storageKey);
  if (value == null || value.length === 0) {
    if (unreachable) {
      return {
        ok: false,
        reason: "unreachable",
        message:
          "Credential store is unreachable. Ensure the assistant is running and can reach the credential store.",
      };
    }
    return {
      ok: false,
      reason: "not_found",
      message: `Credential not found: ${ref}`,
    };
  }

  return { ok: true, value, service, field };
}

export function grantFailureMessage(reason: GrantValidationFailure): string {
  switch (reason) {
    case "malformed":
      return "Plugin skill invocation grant is malformed.";
    case "unknown":
    case "revoked":
      return "Plugin skill invocation grant is unknown or has already been revoked.";
    case "expired":
      return "Plugin skill invocation grant has expired.";
    case "wrong_conversation":
      return "Plugin skill invocation grant does not match this conversation.";
    case "exhausted":
      return "Plugin skill invocation grant has no remaining credential resolutions.";
  }
}

/** @internal Test-only: drop every grant. */
export function _resetPluginSkillGrantsForTest(): void {
  grants.clear();
}

/** @internal Test-only: expire a grant immediately. */
export function _expirePluginSkillGrantForTest(token: string): void {
  const parsed = parsePluginSkillGrantToken(token);
  if (!parsed) {
    return;
  }
  const stored = grants.get(parsed.grantId);
  if (!stored || !secretsEqual(stored.secret, parsed.secret)) {
    return;
  }
  stored.expiresAt = 0;
}
