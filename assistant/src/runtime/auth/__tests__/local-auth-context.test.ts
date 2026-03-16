import { describe, expect, test } from "bun:test";

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../assistant-scope.js";
import { buildLocalAuthContext } from "../../local-actor-identity.js";
import { CURRENT_POLICY_EPOCH } from "../policy.js";
import { resolveScopeProfile } from "../scopes.js";

describe("buildLocalAuthContext", () => {
  test("produces correct subject pattern", () => {
    const ctx = buildLocalAuthContext("session-abc");
    expect(ctx.subject).toBe("local:self:session-abc");
  });

  test("sets principalType to local", () => {
    const ctx = buildLocalAuthContext("session-abc");
    expect(ctx.principalType).toBe("local");
  });

  test("uses DAEMON_INTERNAL_ASSISTANT_ID for assistantId", () => {
    const ctx = buildLocalAuthContext("session-abc");
    expect(ctx.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
    expect(ctx.assistantId).toBe("self");
  });

  test("includes conversationId from argument", () => {
    const ctx = buildLocalAuthContext("my-session-123");
    expect(ctx.conversationId).toBe("my-session-123");
  });

  test("uses local_v1 scope profile", () => {
    const ctx = buildLocalAuthContext("session-abc");
    expect(ctx.scopeProfile).toBe("local_v1");
  });

  test("resolves scopes from local_v1 profile", () => {
    const ctx = buildLocalAuthContext("session-abc");
    const expectedScopes = resolveScopeProfile("local_v1");
    expect(ctx.scopes).toBe(expectedScopes);
    expect(ctx.scopes.has("local.all")).toBe(true);
  });

  test("uses current policy epoch", () => {
    const ctx = buildLocalAuthContext("session-abc");
    expect(ctx.policyEpoch).toBe(CURRENT_POLICY_EPOCH);
  });

  test("does not set actorPrincipalId", () => {
    const ctx = buildLocalAuthContext("session-abc");
    expect(ctx.actorPrincipalId).toBeUndefined();
  });

  test("matches AuthContext shape from HTTP JWT-derived contexts", () => {
    const ctx = buildLocalAuthContext("session-xyz");

    // Verify all required AuthContext fields are present
    expect(typeof ctx.subject).toBe("string");
    expect(typeof ctx.principalType).toBe("string");
    expect(typeof ctx.assistantId).toBe("string");
    expect(typeof ctx.scopeProfile).toBe("string");
    expect(typeof ctx.policyEpoch).toBe("number");
    expect(ctx.scopes).toBeDefined();
    expect(typeof ctx.scopes.has).toBe("function");
  });

  test("different conversation IDs produce different subjects", () => {
    const ctx1 = buildLocalAuthContext("session-1");
    const ctx2 = buildLocalAuthContext("session-2");
    expect(ctx1.subject).not.toBe(ctx2.subject);
    expect(ctx1.conversationId).not.toBe(ctx2.conversationId);
  });
});
