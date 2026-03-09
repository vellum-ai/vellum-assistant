import { describe, expect, test } from "bun:test";

import { buildIpcAuthContext } from "../../local-actor-identity.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../assistant-scope.js";
import { CURRENT_POLICY_EPOCH } from "../policy.js";
import { resolveScopeProfile } from "../scopes.js";

describe("buildIpcAuthContext", () => {
  test("produces correct subject pattern", () => {
    const ctx = buildIpcAuthContext("session-abc");
    expect(ctx.subject).toBe("ipc:self:session-abc");
  });

  test("sets principalType to ipc", () => {
    const ctx = buildIpcAuthContext("session-abc");
    expect(ctx.principalType).toBe("ipc");
  });

  test("uses DAEMON_INTERNAL_ASSISTANT_ID for assistantId", () => {
    const ctx = buildIpcAuthContext("session-abc");
    expect(ctx.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
    expect(ctx.assistantId).toBe("self");
  });

  test("includes sessionId from argument", () => {
    const ctx = buildIpcAuthContext("my-session-123");
    expect(ctx.sessionId).toBe("my-session-123");
  });

  test("uses ipc_v1 scope profile", () => {
    const ctx = buildIpcAuthContext("session-abc");
    expect(ctx.scopeProfile).toBe("ipc_v1");
  });

  test("resolves scopes from ipc_v1 profile", () => {
    const ctx = buildIpcAuthContext("session-abc");
    const expectedScopes = resolveScopeProfile("ipc_v1");
    expect(ctx.scopes).toBe(expectedScopes);
    expect(ctx.scopes.has("ipc.all")).toBe(true);
  });

  test("uses current policy epoch", () => {
    const ctx = buildIpcAuthContext("session-abc");
    expect(ctx.policyEpoch).toBe(CURRENT_POLICY_EPOCH);
  });

  test("does not set actorPrincipalId", () => {
    const ctx = buildIpcAuthContext("session-abc");
    expect(ctx.actorPrincipalId).toBeUndefined();
  });

  test("matches AuthContext shape from HTTP JWT-derived contexts", () => {
    const ctx = buildIpcAuthContext("session-xyz");

    // Verify all required AuthContext fields are present
    expect(typeof ctx.subject).toBe("string");
    expect(typeof ctx.principalType).toBe("string");
    expect(typeof ctx.assistantId).toBe("string");
    expect(typeof ctx.scopeProfile).toBe("string");
    expect(typeof ctx.policyEpoch).toBe("number");
    expect(ctx.scopes).toBeDefined();
    expect(typeof ctx.scopes.has).toBe("function");
  });

  test("different session IDs produce different subjects", () => {
    const ctx1 = buildIpcAuthContext("session-1");
    const ctx2 = buildIpcAuthContext("session-2");
    expect(ctx1.subject).not.toBe(ctx2.subject);
    expect(ctx1.sessionId).not.toBe(ctx2.sessionId);
  });
});
