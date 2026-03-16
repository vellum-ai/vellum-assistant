/**
 * Sub (subject) pattern parser for JWT tokens.
 *
 * The sub claim encodes principal type, assistant scope, and optional
 * actor/conversation identifiers in a colon-delimited string.
 */

import type { PrincipalType } from "./types.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ParseSubResult =
  | {
      ok: true;
      principalType: PrincipalType;
      assistantId: string;
      actorPrincipalId?: string;
      conversationId?: string;
    }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a JWT sub claim into its constituent parts.
 *
 * Supported patterns:
 *   actor:<assistantId>:<actorPrincipalId>
 *   svc:gateway:<assistantId>
 *   svc:daemon:<identifier>
 *   local:<assistantId>:<conversationId>
 */
export function parseSub(sub: string): ParseSubResult {
  if (!sub || typeof sub !== "string") {
    return { ok: false, reason: "sub is empty or not a string" };
  }

  const parts = sub.split(":");

  if (parts[0] === "actor" && parts.length === 3) {
    const [, assistantId, actorPrincipalId] = parts;
    if (!assistantId || !actorPrincipalId) {
      return {
        ok: false,
        reason: "actor sub has empty assistantId or actorPrincipalId",
      };
    }
    return { ok: true, principalType: "actor", assistantId, actorPrincipalId };
  }

  if (parts[0] === "svc" && parts[1] === "gateway" && parts.length === 3) {
    const assistantId = parts[2];
    if (!assistantId) {
      return { ok: false, reason: "svc:gateway sub has empty assistantId" };
    }
    return { ok: true, principalType: "svc_gateway", assistantId };
  }

  if (parts[0] === "svc" && parts[1] === "daemon" && parts.length === 3) {
    const identifier = parts[2];
    if (!identifier) {
      return { ok: false, reason: "svc:daemon sub has empty identifier" };
    }
    return { ok: true, principalType: "svc_daemon", assistantId: identifier };
  }

  if (parts[0] === "local" && parts.length === 3) {
    const [, assistantId, conversationId] = parts;
    if (!assistantId || !conversationId) {
      return {
        ok: false,
        reason: "local sub has empty assistantId or conversationId",
      };
    }
    return { ok: true, principalType: "local", assistantId, conversationId };
  }

  return { ok: false, reason: `unrecognized sub pattern: ${sub}` };
}
