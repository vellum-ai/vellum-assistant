/**
 * Security test matrix for channel-agnostic scoped approval grants.
 *
 * This file covers scenarios NOT already tested in:
 *   - scoped-approval-grants.test.ts (CRUD, digest, basic consume semantics)
 *   - voice-scoped-grant-consumer.test.ts (voice bridge integration)
 *   - guardian-grant-minting.test.ts (grant minting on approval decisions)
 *
 * Additional scenarios tested here:
 *   6. Requester identity mismatch denied
 *   8. Concurrent consume attempts: only one succeeds
 *  12. Restart behavior remains fail-closed — grants stored in persistent DB
 *
 * Cross-reference:
 *   1. Voice happy path — voice-scoped-grant-consumer.test.ts
 *   2. Replay denied — scoped-approval-grants.test.ts + voice-scoped-grant-consumer.test.ts
 *   3. Tool mismatch denied — scoped-approval-grants.test.ts + voice-scoped-grant-consumer.test.ts
 *   4. Input mismatch denied — scoped-approval-grants.test.ts
 *   5. Execution-channel mismatch denied — scoped-approval-grants.test.ts
 *   7. Expired grant denied — scoped-approval-grants.test.ts
 *   9. Stale decision cannot mint extra grant — guardian-grant-minting.test.ts
 *  10. Informational ASK_GUARDIAN cannot mint grant — guardian-grant-minting.test.ts
 *  11. Guardian identity mismatch cannot mint grant — guardian-grant-minting.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "scoped-grant-security-matrix-"));

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
} from "../memory/scoped-approval-grants.js";

const { consumeScopedApprovalGrantByToolSignature, createScopedApprovalGrant } =
  _internal;
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";

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
    scopeMode: "tool_signature",
    toolName: "bash",
    inputDigest: computeToolApprovalDigest("bash", { cmd: "ls" }),
    requestChannel: "telegram",
    decisionChannel: "telegram",
    expiresAt: futureExpiry,
    ...overrides,
  };
}

// ===========================================================================
// 6. Requester identity mismatch denied
// ===========================================================================

describe("security matrix: requester identity mismatch", () => {
  beforeEach(() => clearTables());

  test("grant scoped to a specific requester cannot be consumed by a different requester", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
        requesterExternalUserId: "user-alice",
      }),
    );

    // Attempt to consume as a different user
    const wrongUser = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      requesterExternalUserId: "user-bob",
    });
    expect(wrongUser.ok).toBe(false);

    // Correct user succeeds
    const correctUser = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c2",
      requesterExternalUserId: "user-alice",
    });
    expect(correctUser.ok).toBe(true);
  });

  test("grant with null requesterExternalUserId allows any requester (wildcard)", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });
    createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
        requesterExternalUserId: null,
      }),
    );

    // Any user can consume when requester is null (wildcard)
    const result = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      requesterExternalUserId: "user-anyone",
    });
    expect(result.ok).toBe(true);
  });

  test("consume without providing requester only matches grants with null requester", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });

    // Grant scoped to a specific requester
    createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
        requesterExternalUserId: "user-alice",
      }),
    );

    // Consume without specifying requester — should NOT match a requester-scoped grant
    const result = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "c1",
      // No requesterExternalUserId provided
    });
    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
// 8. Concurrent consume attempts: only one succeeds
// ===========================================================================

describe("security matrix: concurrent consume (CAS)", () => {
  beforeEach(() => clearTables());

  test("only one of multiple concurrent consumers succeeds for the same grant", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "rm -rf /" });
    createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
      }),
    );

    // Simulate concurrent consumers racing to consume the same grant.
    // Since SQLite is synchronous in Bun, we simulate by issuing
    // back-to-back consume calls — the CAS mechanism ensures only the
    // first succeeds.
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const result = consumeScopedApprovalGrantByToolSignature({
        toolName: "bash",
        inputDigest: digest,
        consumingRequestId: `concurrent-consumer-${i}`,
      });
      results.push(result.ok);
    }

    // Exactly one should succeed
    const successes = results.filter(Boolean);
    expect(successes.length).toBe(1);

    // The first consumer should win
    expect(results[0]).toBe(true);
  });

  test("with multiple matching grants, each consumer gets at most one grant", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });

    // Create 3 grants for the same tool signature
    for (let i = 0; i < 3; i++) {
      createScopedApprovalGrant(
        grantParams({
          toolName: "bash",
          inputDigest: digest,
        }),
      );
    }

    // 5 consumers compete for 3 grants
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const result = consumeScopedApprovalGrantByToolSignature({
        toolName: "bash",
        inputDigest: digest,
        consumingRequestId: `consumer-${i}`,
      });
      results.push(result.ok);
    }

    // Exactly 3 should succeed (one per grant)
    const successes = results.filter(Boolean);
    expect(successes.length).toBe(3);

    // The last 2 should fail
    expect(results[3]).toBe(false);
    expect(results[4]).toBe(false);
  });
});

// ===========================================================================
// 12. Restart behavior remains fail-closed — grants stored in persistent DB
// ===========================================================================

describe("security matrix: persistence and fail-closed behavior", () => {
  beforeEach(() => clearTables());

  test("grants survive DB re-initialization (simulating daemon restart)", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });

    // Create a grant
    const grant = createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
      }),
    );
    expect(grant.status).toBe("active");

    // Re-initialize the DB (simulates daemon restart — the SQLite file persists)
    initializeDb();

    // The grant should still be consumable after restart
    const result = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "post-restart-consumer",
    });
    expect(result.ok).toBe(true);
    expect(result.grant!.id).toBe(grant.id);
  });

  test("consumed grants remain consumed after DB re-initialization", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });

    createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
      }),
    );

    // Consume the grant
    const first = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "pre-restart-consumer",
    });
    expect(first.ok).toBe(true);

    // Re-initialize the DB (simulates daemon restart)
    initializeDb();

    // The consumed grant must NOT be consumable again after restart
    const second = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "post-restart-consumer",
    });
    expect(second.ok).toBe(false);
  });

  test("no grants means fail-closed (deny by default)", () => {
    // Empty grant table — no grants at all
    const digest = computeToolApprovalDigest("bash", {
      cmd: "dangerous-command",
    });

    const result = consumeScopedApprovalGrantByToolSignature({
      toolName: "bash",
      inputDigest: digest,
      consumingRequestId: "consumer-1",
    });

    // Must fail closed — no grant = no permission
    expect(result.ok).toBe(false);
    expect(result.grant).toBeNull();
  });
});

// ===========================================================================
// Combined cross-scope invariants
// ===========================================================================

describe("security matrix: cross-scope invariants", () => {
  beforeEach(() => clearTables());

  test("all scope fields must match simultaneously for consumption", () => {
    const digest = computeToolApprovalDigest("bash", { cmd: "ls" });

    // Create a maximally-scoped grant
    createScopedApprovalGrant(
      grantParams({
        toolName: "bash",
        inputDigest: digest,
        executionChannel: "voice",
        conversationId: "conv-123",
        callSessionId: "call-456",
        requesterExternalUserId: "user-alice",
      }),
    );

    // Each field mismatch should independently cause failure:

    // Wrong execution channel
    expect(
      consumeScopedApprovalGrantByToolSignature({
        toolName: "bash",
        inputDigest: digest,
        consumingRequestId: "c-chan",
        executionChannel: "telegram",
        conversationId: "conv-123",
        callSessionId: "call-456",
        requesterExternalUserId: "user-alice",
      }).ok,
    ).toBe(false);

    // Wrong conversation
    expect(
      consumeScopedApprovalGrantByToolSignature({
        toolName: "bash",
        inputDigest: digest,
        consumingRequestId: "c-conv",
        executionChannel: "voice",
        conversationId: "conv-999",
        callSessionId: "call-456",
        requesterExternalUserId: "user-alice",
      }).ok,
    ).toBe(false);

    // Wrong call session
    expect(
      consumeScopedApprovalGrantByToolSignature({
        toolName: "bash",
        inputDigest: digest,
        consumingRequestId: "c-call",
        executionChannel: "voice",
        conversationId: "conv-123",
        callSessionId: "call-999",
        requesterExternalUserId: "user-alice",
      }).ok,
    ).toBe(false);

    // Wrong requester
    expect(
      consumeScopedApprovalGrantByToolSignature({
        toolName: "bash",
        inputDigest: digest,
        consumingRequestId: "c-user",
        executionChannel: "voice",
        conversationId: "conv-123",
        callSessionId: "call-456",
        requesterExternalUserId: "user-bob",
      }).ok,
    ).toBe(false);

    // All fields match — succeeds
    expect(
      consumeScopedApprovalGrantByToolSignature({
        toolName: "bash",
        inputDigest: digest,
        consumingRequestId: "c-all",
        executionChannel: "voice",
        conversationId: "conv-123",
        callSessionId: "call-456",
        requesterExternalUserId: "user-alice",
      }).ok,
    ).toBe(true);
  });
});
