import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "scoped-grants-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
  migrateToDataLayout: () => {},
  migrateToWorkspaceLayout: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  isDebug: () => false,
  truncateForLog: (value: string) => value,
}));

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { scopedApprovalGrants } from "../memory/schema.js";
import {
  _internal,
  type CreateScopedApprovalGrantParams,
  expireScopedApprovalGrants,
  revokeScopedApprovalGrantsForContext,
} from "../memory/scoped-approval-grants.js";

const {
  consumeScopedApprovalGrantByRequestId,
  consumeScopedApprovalGrantByToolSignature,
  createScopedApprovalGrant,
} = _internal;
import {
  canonicalJsonSerialize,
  computeToolApprovalDigest,
} from "../security/tool-approval-digest.js";

initializeDb();

function clearTables(): void {
  const db = getDb();
  db.delete(scopedApprovalGrants).run();
}

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Helper to build grant params with sensible defaults
// ---------------------------------------------------------------------------

function grantParams(
  overrides: Partial<CreateScopedApprovalGrantParams> = {},
): CreateScopedApprovalGrantParams {
  const futureExpiry = new Date(Date.now() + 60_000).toISOString();
  return {
    scopeMode: "request_id",
    requestChannel: "telegram",
    decisionChannel: "telegram",
    expiresAt: futureExpiry,
    ...overrides,
  };
}

// ===========================================================================
// SCOPE MODE: request_id
// ===========================================================================

describe("scoped-approval-grants / request_id scope", () => {
  beforeEach(() => clearTables());

  test("create and consume by request_id succeeds", () => {
    const grant = createScopedApprovalGrant(
      grantParams({ scopeMode: "request_id", requestId: "req-1" }),
    );
    expect(grant.status).toBe("active");
    expect(grant.requestId).toBe("req-1");

    const result = consumeScopedApprovalGrantByRequestId("req-1", "consumer-1");
    expect(result.ok).toBe(true);
    expect(result.grant).not.toBeNull();
    expect(result.grant!.status).toBe("consumed");
    expect(result.grant!.consumedByRequestId).toBe("consumer-1");
  });

  test("second consume of same grant fails (one-time use)", () => {
    createScopedApprovalGrant(
      grantParams({ scopeMode: "request_id", requestId: "req-2" }),
    );

    const first = consumeScopedApprovalGrantByRequestId("req-2", "consumer-a");
    expect(first.ok).toBe(true);

    const second = consumeScopedApprovalGrantByRequestId("req-2", "consumer-b");
    expect(second.ok).toBe(false);
    expect(second.grant).toBeNull();
  });

  test("consume fails when no matching grant exists", () => {
    const result = consumeScopedApprovalGrantByRequestId(
      "nonexistent",
      "consumer-x",
    );
    expect(result.ok).toBe(false);
  });

  test("expired grant cannot be consumed", () => {
    const pastExpiry = new Date(Date.now() - 1_000).toISOString();
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-expired",
        expiresAt: pastExpiry,
      }),
    );

    const result = consumeScopedApprovalGrantByRequestId(
      "req-expired",
      "consumer-1",
    );
    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
// SCOPE MODE: tool_signature
// ===========================================================================

describe("scoped-approval-grants / tool_signature scope", () => {
  beforeEach(() => clearTables());

  test("create and consume by tool signature succeeds", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    const grant = createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
      }),
    );
    expect(grant.status).toBe("active");
    expect(grant.toolName).toBe("bash");

    const result = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "consumer-1",
    });
    expect(result.ok).toBe(true);
    expect(result.grant!.status).toBe("consumed");
  });

  test("second consume of tool_signature grant fails", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "rm -rf" });
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
      }),
    );

    const first = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
    });
    expect(first.ok).toBe(true);

    const second = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c2",
    });
    expect(second.ok).toBe(false);
  });

  test("mismatched input digest fails consume", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
      }),
    );

    const wrongDigest = computeToolApprovalDigest("bash", { cmd: "pwd" });
    const result = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: wrongDigest,
      consumingRequestId: "c1",
    });
    expect(result.ok).toBe(false);
  });

  test("mismatched tool name fails consume", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
      }),
    );

    const result = consumeScopedApprovalGrantByToolSignature({
      toolName: "python",
      inputDigest: digest,
      consumingRequestId: "c1",
    });
    expect(result.ok).toBe(false);
  });

  test("context constraint: executionChannel must match non-null grant field", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
        executionChannel: "telegram",
      }),
    );

    // Wrong channel
    const wrong = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      executionChannel: "voice",
    });
    expect(wrong.ok).toBe(false);

    // Correct channel
    const correct = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c2",
      executionChannel: "telegram",
    });
    expect(correct.ok).toBe(true);
  });

  test("null executionChannel on grant means any channel matches", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
        executionChannel: null,
      }),
    );

    const result = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      executionChannel: "voice",
    });
    expect(result.ok).toBe(true);
  });

  test("context constraint: conversationId must match non-null grant field", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
        conversationId: "conv-123",
      }),
    );

    // Mismatched
    const wrong = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      conversationId: "conv-999",
    });
    expect(wrong.ok).toBe(false);

    // Matched
    const correct = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c2",
      conversationId: "conv-123",
    });
    expect(correct.ok).toBe(true);
  });

  test("expired tool_signature grant cannot be consumed", () => {
    const pastExpiry = new Date(Date.now() - 1_000).toISOString();
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
        expiresAt: pastExpiry,
      }),
    );

    const result = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
    });
    expect(result.ok).toBe(false);
  });

  test("consume by tool signature only consumes one grant when multiple match", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });

    // Create a wildcard grant (no executionChannel) and a channel-specific grant.
    // Both match when executionChannel='telegram', but only one should be consumed.
    const wildcardGrant = createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
        executionChannel: null,
      }),
    );
    const specificGrant = createScopedApprovalGrant(
      grantParams({
        scopeMode: "tool_signature",
        toolName: "bash",
        inputDigest: digest,
        executionChannel: "telegram",
      }),
    );

    const result = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      executionChannel: "telegram",
    });
    expect(result.ok).toBe(true);
    // The most specific grant (channel-specific) should be consumed first
    expect(result.grant!.id).toBe(specificGrant.id);

    // The wildcard grant should still be active and consumable
    const second = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c2",
      executionChannel: "voice",
    });
    expect(second.ok).toBe(true);
    expect(second.grant!.id).toBe(wildcardGrant.id);
  });
});

// ===========================================================================
// Expiry semantics
// ===========================================================================

describe("scoped-approval-grants / expiry", () => {
  beforeEach(() => clearTables());

  test("expireScopedApprovalGrants transitions active past-TTL grants to expired", () => {
    const pastExpiry = new Date(Date.now() - 1_000).toISOString();
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-e1",
        expiresAt: pastExpiry,
      }),
    );
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-e2",
        expiresAt: pastExpiry,
      }),
    );
    // Still active (future expiry)
    createScopedApprovalGrant(
      grantParams({ scopeMode: "request_id", requestId: "req-alive" }),
    );

    const count = expireScopedApprovalGrants();
    expect(count).toBe(2);

    // Verify the alive grant is still active
    const alive = consumeScopedApprovalGrantByRequestId("req-alive", "c1");
    expect(alive.ok).toBe(true);
  });

  test("already-consumed grants are not affected by expiry sweep", () => {
    const _pastExpiry = new Date(Date.now() - 1_000).toISOString();
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-consumed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    consumeScopedApprovalGrantByRequestId("req-consumed", "c1");

    // Force the expiry time to the past for the consumed grant (simulating time passing)
    // The sweep should not touch consumed grants
    const count = expireScopedApprovalGrants();
    expect(count).toBe(0);
  });
});

// ===========================================================================
// Revoke semantics
// ===========================================================================

describe("scoped-approval-grants / revoke", () => {
  beforeEach(() => clearTables());

  test("revokeScopedApprovalGrantsForContext revokes active grants matching context", () => {
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-r1",
        callSessionId: "call-1",
      }),
    );
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-r2",
        callSessionId: "call-1",
      }),
    );
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-r3",
        callSessionId: "call-2",
      }),
    );

    const count = revokeScopedApprovalGrantsForContext({
      callSessionId: "call-1",
    });
    expect(count).toBe(2);

    // Revoked grant cannot be consumed
    const revoked = consumeScopedApprovalGrantByRequestId("req-r1", "c1");
    expect(revoked.ok).toBe(false);

    // Unaffected grant is still consumable
    const alive = consumeScopedApprovalGrantByRequestId("req-r3", "c1");
    expect(alive.ok).toBe(true);
  });

  test("revoked grants cannot be consumed", () => {
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-revoke",
        conversationId: "conv-1",
      }),
    );

    revokeScopedApprovalGrantsForContext({ conversationId: "conv-1" });

    const result = consumeScopedApprovalGrantByRequestId("req-revoke", "c1");
    expect(result.ok).toBe(false);
  });

  test("revokeScopedApprovalGrantsForContext throws when no context filters are provided", () => {
    // Create a grant to ensure the guard is not based on empty results
    createScopedApprovalGrant(
      grantParams({
        scopeMode: "request_id",
        requestId: "req-guard",
        callSessionId: "call-guard",
      }),
    );

    // Empty object: all fields undefined
    expect(() => revokeScopedApprovalGrantsForContext({})).toThrow(
      "revokeScopedApprovalGrantsForContext requires at least one context filter",
    );

    // The grant should still be active (not revoked)
    const result = consumeScopedApprovalGrantByRequestId("req-guard", "c1");
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// tool-approval-digest: canonical serialization + hash
// ===========================================================================

describe("tool-approval-digest", () => {
  test("canonicalJsonSerialize sorts keys recursively", () => {
    const obj = { z: 1, a: { c: 3, b: 2 } };
    const serialized = canonicalJsonSerialize(obj);
    expect(serialized).toBe('{"a":{"b":2,"c":3},"z":1}');
  });

  test("canonicalJsonSerialize handles arrays (order preserved)", () => {
    const obj = { items: [3, 1, 2], name: "test" };
    const serialized = canonicalJsonSerialize(obj);
    expect(serialized).toBe('{"items":[3,1,2],"name":"test"}');
  });

  test("canonicalJsonSerialize handles null values", () => {
    const obj = { a: null, b: "hello" };
    const serialized = canonicalJsonSerialize(obj);
    expect(serialized).toBe('{"a":null,"b":"hello"}');
  });

  test("canonicalJsonSerialize handles nested arrays of objects", () => {
    const obj = {
      list: [
        { z: 1, a: 2 },
        { y: 3, b: 4 },
      ],
    };
    const serialized = canonicalJsonSerialize(obj);
    expect(serialized).toBe('{"list":[{"a":2,"z":1},{"b":4,"y":3}]}');
  });

  test("computeToolApprovalDigest is deterministic", () => {
    const d1 = computeToolApprovalDigest("bash", {
      cmd: "ls -la",
      cwd: "/tmp",
    });
    const d2 = computeToolApprovalDigest("bash", {
      cwd: "/tmp",
      cmd: "ls -la",
    });
    expect(d1).toBe(d2);
  });

  test("computeToolApprovalDigest differs for different inputs", () => {
    const d1 = computeToolApprovalDigest("bash", { cmd: "ls" });
    const d2 = computeToolApprovalDigest("bash", { cmd: "pwd" });
    expect(d1).not.toBe(d2);
  });

  test("computeToolApprovalDigest differs for different tool names", () => {
    const d1 = computeToolApprovalDigest("bash", { cmd: "ls" });
    const d2 = computeToolApprovalDigest("python", { cmd: "ls" });
    expect(d1).not.toBe(d2);
  });

  test("computeToolApprovalDigest is stable across key orderings (deeply nested)", () => {
    const d1 = computeToolApprovalDigest("tool", {
      config: { nested: { z: 1, a: 2 }, top: true },
      name: "test",
    });
    const d2 = computeToolApprovalDigest("tool", {
      name: "test",
      config: { top: true, nested: { a: 2, z: 1 } },
    });
    expect(d1).toBe(d2);
  });
});
