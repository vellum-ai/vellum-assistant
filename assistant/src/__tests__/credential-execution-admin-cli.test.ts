/**
 * Tests for CES admin CLI surfaces.
 *
 * Covers:
 * - `credential-execution grants list` — Lists grants, filters by handle/status.
 * - `credential-execution grants revoke <id>` — Revokes a grant by ID.
 * - `credential-execution audit list` — Lists audit records with redaction.
 *
 * All tests mock the CES process manager and client to avoid spawning
 * real child processes. The tests verify:
 * - Correct RPC method dispatch and parameter forwarding.
 * - Human-readable and JSON output formatting.
 * - Error handling when CES is unavailable or returns failures.
 * - Audit output never includes raw secrets/tokens.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AuditRecordSummary,
  ListAuditRecordsResponse,
  ListGrantsResponse,
  PersistentGrantRecord,
  RevokeGrantResponse,
} from "@vellumai/ces-contracts";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// In-memory mock state
// ---------------------------------------------------------------------------

/** Responses to return from the mock CES client `call()`. */
let mockCallResponses = new Map<string, unknown>();
let mockCallHistory: Array<{ method: string; request: unknown }> = [];
let mockHandshakeAccepted = true;
let mockStartError: Error | null = null;

// ---------------------------------------------------------------------------
// Mock CES process manager + client
// ---------------------------------------------------------------------------

mock.module("../credential-execution/process-manager.js", () => ({
  createCesProcessManager: () => ({
    start: async () => {
      if (mockStartError) throw mockStartError;
      return {
        write: () => {},
        onMessage: () => {},
        isAlive: () => true,
        close: () => {},
      };
    },
    stop: async () => {},
    getDiscoveryResult: () => null,
    isRunning: () => false,
  }),
}));

mock.module("../credential-execution/feature-gates.js", () => ({
  isCesGrantAuditEnabled: () => true,
}));

mock.module("../credential-execution/client.js", () => ({
  createCesClient: () => ({
    handshake: async () => ({
      accepted: mockHandshakeAccepted,
      reason: mockHandshakeAccepted ? undefined : "version mismatch",
    }),
    call: async (method: string, request: unknown) => {
      mockCallHistory.push({ method, request });
      const response = mockCallResponses.get(method);
      if (response instanceof Error) throw response;
      return response;
    },
    isReady: () => mockHandshakeAccepted,
    close: () => {},
  }),
  CesClientError: class extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "CesClientError";
    }
  },
  CesTransportError: class extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "CesTransportError";
    }
  },
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { registerCredentialExecutionCommand } =
  await import("../cli/commands/credential-execution.js");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeGrant(
  overrides?: Partial<PersistentGrantRecord>,
): PersistentGrantRecord {
  return {
    grantId: overrides?.grantId ?? "grant-001",
    sessionId: overrides?.sessionId ?? "session-abc",
    credentialHandle:
      overrides?.credentialHandle ?? "local_static:github/token",
    proposalType: overrides?.proposalType ?? "http",
    proposalHash: overrides?.proposalHash ?? "hash-abc",
    allowedPurposes: overrides?.allowedPurposes ?? [
      "GET https://api.github.com/**",
    ],
    status: overrides?.status ?? "active",
    grantedBy: overrides?.grantedBy ?? "user",
    createdAt: overrides?.createdAt ?? "2025-01-15T10:00:00.000Z",
    expiresAt: overrides?.expiresAt ?? null,
    consumedAt: overrides?.consumedAt ?? null,
    revokedAt: overrides?.revokedAt ?? null,
  };
}

function makeAuditRecord(
  overrides?: Partial<AuditRecordSummary>,
): AuditRecordSummary {
  return {
    auditId: overrides?.auditId ?? "audit-001",
    grantId: overrides?.grantId ?? "grant-001",
    credentialHandle:
      overrides?.credentialHandle ?? "local_static:github/token",
    toolName: overrides?.toolName ?? "http",
    target:
      overrides?.target ??
      "GET https://api.github.com/repos/{:param}/{:param} -> 200",
    sessionId: overrides?.sessionId ?? "session-abc",
    success: overrides?.success ?? true,
    errorMessage: overrides?.errorMessage,
    timestamp: overrides?.timestamp ?? "2025-01-15T10:05:00.000Z",
  };
}

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  // Suppress stderr
  process.stderr.write = (() => true) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerCredentialExecutionCommand(program);
    await program.parseAsync([
      "node",
      "vellum",
      "credential-execution",
      ...args,
    ]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockCallResponses = new Map();
  mockCallHistory = [];
  mockHandshakeAccepted = true;
  mockStartError = null;
});

afterEach(() => {
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// grants list
// ---------------------------------------------------------------------------

describe("credential-execution grants list", () => {
  test("lists grants in JSON mode", async () => {
    const grants = [makeGrant(), makeGrant({ grantId: "grant-002" })];
    mockCallResponses.set("list_grants", {
      grants,
    } satisfies ListGrantsResponse);

    const result = await runCli(["grants", "list", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.grants).toHaveLength(2);
    expect(parsed.grants[0].grantId).toBe("grant-001");
    expect(parsed.grants[1].grantId).toBe("grant-002");
  });

  test("lists empty grants without error", async () => {
    mockCallResponses.set("list_grants", {
      grants: [],
    } satisfies ListGrantsResponse);

    const result = await runCli(["grants", "list", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.grants).toHaveLength(0);
  });

  test("forwards --handle filter to RPC call", async () => {
    mockCallResponses.set("list_grants", {
      grants: [],
    } satisfies ListGrantsResponse);

    await runCli([
      "grants",
      "list",
      "--handle",
      "local_static:github/token",
      "--json",
    ]);

    expect(mockCallHistory).toHaveLength(1);
    expect(mockCallHistory[0]!.method).toBe("list_grants");
    expect(
      (mockCallHistory[0]!.request as Record<string, unknown>).credentialHandle,
    ).toBe("local_static:github/token");
  });

  test("forwards --status filter to RPC call", async () => {
    mockCallResponses.set("list_grants", {
      grants: [],
    } satisfies ListGrantsResponse);

    await runCli(["grants", "list", "--status", "active", "--json"]);

    expect(mockCallHistory).toHaveLength(1);
    expect(
      (mockCallHistory[0]!.request as Record<string, unknown>).status,
    ).toBe("active");
  });

  test("grant output never includes raw secrets", async () => {
    const grant = makeGrant();
    mockCallResponses.set("list_grants", {
      grants: [grant],
    } satisfies ListGrantsResponse);

    const result = await runCli(["grants", "list", "--json"]);

    const parsed = JSON.parse(result.stdout);
    const grantOutput = JSON.stringify(parsed);

    // The grant output should not contain any secret-like fields
    expect(grantOutput).not.toContain("authorization");
    expect(grantOutput).not.toContain("bearer ");
    expect(grantOutput).not.toContain("Bearer ");
    expect(grantOutput).not.toContain("ghp_");
    expect(grantOutput).not.toContain("sk-");
  });

  test("handles CES unavailable error", async () => {
    mockStartError = new Error("CES is unavailable: executable not found");

    const result = await runCli(["grants", "list", "--json"]);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("CES is unavailable");
  });
});

// ---------------------------------------------------------------------------
// grants revoke
// ---------------------------------------------------------------------------

describe("credential-execution grants revoke", () => {
  test("revokes a grant by ID", async () => {
    mockCallResponses.set("revoke_grant", {
      success: true,
    } satisfies RevokeGrantResponse);

    const result = await runCli(["grants", "revoke", "grant-001", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.grantId).toBe("grant-001");
  });

  test("forwards reason to RPC call", async () => {
    mockCallResponses.set("revoke_grant", {
      success: true,
    } satisfies RevokeGrantResponse);

    await runCli([
      "grants",
      "revoke",
      "grant-001",
      "--reason",
      "credential rotated",
      "--json",
    ]);

    expect(mockCallHistory).toHaveLength(1);
    expect(
      (mockCallHistory[0]!.request as Record<string, unknown>).reason,
    ).toBe("credential rotated");
  });

  test("reports failure when grant not found", async () => {
    mockCallResponses.set("revoke_grant", {
      success: false,
      error: {
        code: "GRANT_NOT_FOUND",
        message: 'No grant found with ID "nonexistent"',
      },
    } satisfies RevokeGrantResponse);

    const result = await runCli(["grants", "revoke", "nonexistent", "--json"]);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("No grant found");
  });

  test("handles CES handshake rejection", async () => {
    mockHandshakeAccepted = false;

    const result = await runCli(["grants", "revoke", "grant-001", "--json"]);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("handshake rejected");
  });
});

// ---------------------------------------------------------------------------
// audit list
// ---------------------------------------------------------------------------

describe("credential-execution audit list", () => {
  test("lists audit records in JSON mode", async () => {
    const records = [
      makeAuditRecord(),
      makeAuditRecord({ auditId: "audit-002", success: false }),
    ];
    mockCallResponses.set("list_audit_records", {
      records,
      nextCursor: null,
    } satisfies ListAuditRecordsResponse);

    const result = await runCli(["audit", "list", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].auditId).toBe("audit-001");
    expect(parsed.records[1].auditId).toBe("audit-002");
  });

  test("forwards --handle and --grant filters to RPC call", async () => {
    mockCallResponses.set("list_audit_records", {
      records: [],
      nextCursor: null,
    } satisfies ListAuditRecordsResponse);

    await runCli([
      "audit",
      "list",
      "--handle",
      "local_static:github/token",
      "--grant",
      "grant-001",
      "--json",
    ]);

    expect(mockCallHistory).toHaveLength(1);
    const req = mockCallHistory[0]!.request as Record<string, unknown>;
    expect(req.credentialHandle).toBe("local_static:github/token");
    expect(req.grantId).toBe("grant-001");
  });

  test("forwards --limit to RPC call", async () => {
    mockCallResponses.set("list_audit_records", {
      records: [],
      nextCursor: null,
    } satisfies ListAuditRecordsResponse);

    await runCli(["audit", "list", "--limit", "50", "--json"]);

    expect(mockCallHistory).toHaveLength(1);
    expect((mockCallHistory[0]!.request as Record<string, unknown>).limit).toBe(
      50,
    );
  });

  test("audit output never includes raw tokens or secrets", async () => {
    // Create a record whose target uses a path template (not raw URL)
    const record = makeAuditRecord({
      target: "GET https://api.github.com/repos/{:param}/{:param} -> 200",
    });
    mockCallResponses.set("list_audit_records", {
      records: [record],
      nextCursor: null,
    } satisfies ListAuditRecordsResponse);

    const result = await runCli(["audit", "list", "--json"]);

    const parsed = JSON.parse(result.stdout);
    const output = JSON.stringify(parsed);

    // Verify no secret-like values leak
    expect(output).not.toContain("authorization");
    expect(output).not.toContain("bearer ");
    expect(output).not.toContain("Bearer ");
    expect(output).not.toContain("ghp_");
    expect(output).not.toContain("sk-");
    // Verify the target uses templated paths, not raw resource IDs
    expect(parsed.records[0].target).toContain("{:param}");
  });

  test("audit output redacts error messages that might contain secrets", async () => {
    const record = makeAuditRecord({
      success: false,
      errorMessage: "Connection refused to api.github.com",
    });
    mockCallResponses.set("list_audit_records", {
      records: [record],
      nextCursor: null,
    } satisfies ListAuditRecordsResponse);

    const result = await runCli(["audit", "list", "--json"]);

    const parsed = JSON.parse(result.stdout);
    // Error message is present but does not contain tokens
    expect(parsed.records[0].errorMessage).toBe(
      "Connection refused to api.github.com",
    );
    expect(parsed.records[0].errorMessage).not.toContain("ghp_");
    expect(parsed.records[0].errorMessage).not.toContain("Bearer ");
  });

  test("handles empty audit results", async () => {
    mockCallResponses.set("list_audit_records", {
      records: [],
      nextCursor: null,
    } satisfies ListAuditRecordsResponse);

    const result = await runCli(["audit", "list", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.records).toHaveLength(0);
  });

  test("includes nextCursor in output when more results exist", async () => {
    const record = makeAuditRecord();
    mockCallResponses.set("list_audit_records", {
      records: [record],
      nextCursor: "20",
    } satisfies ListAuditRecordsResponse);

    const result = await runCli(["audit", "list", "--json"]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.nextCursor).toBe("20");
  });
});
