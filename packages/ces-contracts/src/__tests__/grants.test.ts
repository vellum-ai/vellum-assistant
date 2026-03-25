/**
 * Tests for CES grants, proposals, handles, rendering, and RPC contracts.
 *
 * Covers:
 * 1. Handle parsing and construction roundtrips.
 * 2. Grant proposal schema validation.
 * 3. Proposal hash determinism — same content, different key order → same hash.
 * 4. Proposal rendering produces stable, human-readable output.
 * 5. Persistent grant record and audit record schema validation.
 * 6. RPC schema validation for all methods.
 * 7. No raw secret-return fields in any schema.
 */

import { describe, expect, test } from "bun:test";
import {
  AuditRecordSummarySchema,
  CommandGrantProposalSchema,
  GrantProposalSchema,
  HttpGrantProposalSchema,
  PersistentGrantRecordSchema,
  TemporaryGrantDecisionSchema,
} from "../grants.js";
import {
  HandleType,
  localOAuthHandle,
  localStaticHandle,
  parseHandle,
  platformOAuthHandle,
  CredentialHandleSchema,
} from "../handles.js";
import { canonicalJsonSerialize, hashProposal, renderProposal } from "../rendering.js";
import {
  ApprovalRequiredSchema,
  CesRpcMethod,
  CesRpcSchemas,
  ListAuditRecordsSchema,
  ListGrantsSchema,
  MakeAuthenticatedRequestResponseSchema,
  MakeAuthenticatedRequestSchema,
  ManageSecureCommandToolSchema,
  RecordGrantSchema,
  RevokeGrantSchema,
  RunAuthenticatedCommandResponseSchema,
  RunAuthenticatedCommandSchema,
} from "../rpc.js";

// ---------------------------------------------------------------------------
// Handle parsing and construction
// ---------------------------------------------------------------------------

describe("handles", () => {
  describe("localStaticHandle", () => {
    test("constructs the expected format", () => {
      expect(localStaticHandle("github", "api_key")).toBe(
        "local_static:github/api_key",
      );
    });

    test("roundtrips through parseHandle", () => {
      const raw = localStaticHandle("fal", "password");
      const result = parseHandle(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.handle.type).toBe(HandleType.LocalStatic);
      if (result.handle.type !== HandleType.LocalStatic) return;
      expect(result.handle.service).toBe("fal");
      expect(result.handle.field).toBe("password");
      expect(result.handle.raw).toBe(raw);
    });
  });

  describe("localOAuthHandle", () => {
    test("constructs the expected format", () => {
      expect(localOAuthHandle("google", "conn-123")).toBe(
        "local_oauth:google/conn-123",
      );
    });

    test("roundtrips through parseHandle", () => {
      const raw = localOAuthHandle("slack", "conn-abc");
      const result = parseHandle(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.handle.type).toBe(HandleType.LocalOAuth);
      if (result.handle.type !== HandleType.LocalOAuth) return;
      expect(result.handle.providerKey).toBe("slack");
      expect(result.handle.connectionId).toBe("conn-abc");
    });
  });

  describe("platformOAuthHandle", () => {
    test("constructs the expected format", () => {
      expect(platformOAuthHandle("plat-conn-456")).toBe(
        "platform_oauth:plat-conn-456",
      );
    });

    test("roundtrips through parseHandle", () => {
      const raw = platformOAuthHandle("plat-conn-789");
      const result = parseHandle(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.handle.type).toBe(HandleType.PlatformOAuth);
      if (result.handle.type !== HandleType.PlatformOAuth) return;
      expect(result.handle.connectionId).toBe("plat-conn-789");
    });
  });

  describe("parseHandle error cases", () => {
    test("rejects a handle with no colon", () => {
      const result = parseHandle("no-prefix");
      expect(result.ok).toBe(false);
    });

    test("rejects an unknown prefix", () => {
      const result = parseHandle("cloud_kms:some-key");
      expect(result.ok).toBe(false);
    });

    test("rejects local_static with no slash", () => {
      const result = parseHandle("local_static:nofield");
      expect(result.ok).toBe(false);
    });

    test("rejects local_static with empty service", () => {
      const result = parseHandle("local_static:/field");
      expect(result.ok).toBe(false);
    });

    test("rejects local_static with empty field", () => {
      const result = parseHandle("local_static:service/");
      expect(result.ok).toBe(false);
    });

    test("rejects local_oauth with no slash", () => {
      const result = parseHandle("local_oauth:google");
      expect(result.ok).toBe(false);
    });

    test("rejects platform_oauth with empty connectionId", () => {
      const result = parseHandle("platform_oauth:");
      expect(result.ok).toBe(false);
    });
  });

  describe("CredentialHandleSchema", () => {
    test("accepts valid handles", () => {
      expect(() =>
        CredentialHandleSchema.parse("local_static:github/api_key"),
      ).not.toThrow();
      expect(() =>
        CredentialHandleSchema.parse(
          "local_oauth:google/conn-1",
        ),
      ).not.toThrow();
      expect(() =>
        CredentialHandleSchema.parse("platform_oauth:conn-2"),
      ).not.toThrow();
    });

    test("rejects invalid handles", () => {
      expect(() => CredentialHandleSchema.parse("bad-handle")).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Grant proposal schemas
// ---------------------------------------------------------------------------

describe("grant proposals", () => {
  const httpProposal = {
    type: "http" as const,
    credentialHandle: "local_static:github/api_key",
    method: "GET",
    url: "https://api.github.com/repos",
    purpose: "List repositories",
  };

  const commandProposal = {
    type: "command" as const,
    credentialHandle: "local_static:aws/access_key",
    command: "aws s3 ls",
    purpose: "List S3 buckets",
  };

  test("HttpGrantProposalSchema parses valid proposal", () => {
    const result = HttpGrantProposalSchema.parse(httpProposal);
    expect(result.type).toBe("http");
    expect(result.method).toBe("GET");
  });

  test("HttpGrantProposalSchema accepts optional allowedUrlPatterns", () => {
    const result = HttpGrantProposalSchema.parse({
      ...httpProposal,
      allowedUrlPatterns: ["https://api.github.com/**"],
    });
    expect(result.allowedUrlPatterns).toEqual(["https://api.github.com/**"]);
  });

  test("CommandGrantProposalSchema parses valid proposal", () => {
    const result = CommandGrantProposalSchema.parse(commandProposal);
    expect(result.type).toBe("command");
    expect(result.command).toBe("aws s3 ls");
  });

  test("GrantProposalSchema discriminates by type", () => {
    const http = GrantProposalSchema.parse(httpProposal);
    expect(http.type).toBe("http");

    const cmd = GrantProposalSchema.parse(commandProposal);
    expect(cmd.type).toBe("command");
  });

  test("GrantProposalSchema rejects unknown type", () => {
    expect(() =>
      GrantProposalSchema.parse({
        type: "browser_fill",
        credentialHandle: "local_static:x/y",
        purpose: "test",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Proposal hash determinism
// ---------------------------------------------------------------------------

describe("proposal hashing", () => {
  test("same proposal produces same hash", () => {
    const proposal = {
      type: "http" as const,
      credentialHandle: "local_static:github/api_key",
      method: "POST",
      url: "https://api.github.com/repos",
      purpose: "Create repository",
    };
    const hash1 = hashProposal(proposal);
    const hash2 = hashProposal(proposal);
    expect(hash1).toBe(hash2);
  });

  test("different key order produces same hash", () => {
    const proposal1 = {
      type: "http" as const,
      credentialHandle: "local_static:github/api_key",
      method: "GET",
      url: "https://api.github.com/repos",
      purpose: "List repos",
    };
    // Same content, different key ordering
    const proposal2 = {
      purpose: "List repos",
      url: "https://api.github.com/repos",
      method: "GET",
      type: "http" as const,
      credentialHandle: "local_static:github/api_key",
    };
    expect(hashProposal(proposal1)).toBe(hashProposal(proposal2));
  });

  test("different proposals produce different hashes", () => {
    const proposal1 = {
      type: "http" as const,
      credentialHandle: "local_static:github/api_key",
      method: "GET",
      url: "https://api.github.com/repos",
      purpose: "List repos",
    };
    const proposal2 = {
      type: "http" as const,
      credentialHandle: "local_static:github/api_key",
      method: "POST",
      url: "https://api.github.com/repos",
      purpose: "Create repo",
    };
    expect(hashProposal(proposal1)).not.toBe(hashProposal(proposal2));
  });

  test("hash is a 64-char lowercase hex string (SHA-256)", () => {
    const hash = hashProposal({
      type: "command" as const,
      credentialHandle: "local_static:aws/key",
      command: "aws s3 ls",
      purpose: "test",
    });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Canonical JSON serialization
// ---------------------------------------------------------------------------

describe("canonicalJsonSerialize", () => {
  test("sorts keys recursively", () => {
    const result = canonicalJsonSerialize({ z: 1, a: { c: 3, b: 2 } });
    expect(result).toBe('{"a":{"b":2,"c":3},"z":1}');
  });

  test("preserves array order", () => {
    const result = canonicalJsonSerialize({ items: [3, 1, 2] });
    expect(result).toBe('{"items":[3,1,2]}');
  });

  test("preserves null", () => {
    const result = canonicalJsonSerialize({ a: null });
    expect(result).toBe('{"a":null}');
  });
});

// ---------------------------------------------------------------------------
// Proposal rendering
// ---------------------------------------------------------------------------

describe("renderProposal", () => {
  test("renders HTTP proposal with expected format", () => {
    const rendered = renderProposal({
      type: "http",
      credentialHandle: "local_static:github/api_key",
      method: "GET",
      url: "https://api.github.com/repos",
      purpose: "List repositories",
    });
    expect(rendered).toContain("Authenticated HTTP Request");
    expect(rendered).toContain("Method: GET");
    expect(rendered).toContain("URL: https://api.github.com/repos");
    expect(rendered).toContain("Credential: local_static:github/api_key");
    expect(rendered).toContain("Purpose: List repositories");
  });

  test("renders HTTP proposal with URL patterns", () => {
    const rendered = renderProposal({
      type: "http",
      credentialHandle: "local_static:github/api_key",
      method: "GET",
      url: "https://api.github.com/repos",
      purpose: "test",
      allowedUrlPatterns: ["https://api.github.com/**"],
    });
    expect(rendered).toContain("Allowed URL patterns:");
    expect(rendered).toContain("- https://api.github.com/**");
  });

  test("renders command proposal with expected format", () => {
    const rendered = renderProposal({
      type: "command",
      credentialHandle: "local_static:aws/key",
      command: "aws s3 ls",
      purpose: "List S3 buckets",
    });
    expect(rendered).toContain("Authenticated Command Execution");
    expect(rendered).toContain("Command: aws s3 ls");
    expect(rendered).toContain("Purpose: List S3 buckets");
  });

  test("rendering is deterministic", () => {
    const proposal = {
      type: "http" as const,
      credentialHandle: "local_static:github/api_key",
      method: "POST",
      url: "https://api.github.com/repos",
      purpose: "Create repo",
    };
    expect(renderProposal(proposal)).toBe(renderProposal(proposal));
  });
});

// ---------------------------------------------------------------------------
// Grant decision and record schemas
// ---------------------------------------------------------------------------

describe("TemporaryGrantDecisionSchema", () => {
  test("parses an approved decision", () => {
    const result = TemporaryGrantDecisionSchema.parse({
      proposal: {
        type: "http",
        credentialHandle: "local_static:github/api_key",
        method: "GET",
        url: "https://api.github.com/repos",
        purpose: "List repos",
      },
      proposalHash: "abcdef1234567890".repeat(4),
      decision: "approved",
      decidedBy: "guardian:user@example.com",
      decidedAt: new Date().toISOString(),
      ttl: "PT1H",
    });
    expect(result.decision).toBe("approved");
  });

  test("parses a denied decision with reason", () => {
    const result = TemporaryGrantDecisionSchema.parse({
      proposal: {
        type: "command",
        credentialHandle: "local_static:aws/key",
        command: "aws s3 rm --recursive",
        purpose: "Clean up bucket",
      },
      proposalHash: "abcdef1234567890".repeat(4),
      decision: "denied",
      decidedBy: "guardian:admin",
      decidedAt: new Date().toISOString(),
      reason: "Destructive operation not permitted",
    });
    expect(result.decision).toBe("denied");
    expect(result.reason).toBe("Destructive operation not permitted");
  });
});

describe("PersistentGrantRecordSchema", () => {
  test("parses a valid active grant", () => {
    const now = new Date().toISOString();
    const result = PersistentGrantRecordSchema.parse({
      grantId: "grant-001",
      sessionId: "sess-001",
      credentialHandle: "local_static:github/api_key",
      proposalType: "http",
      proposalHash: "abcdef1234567890".repeat(4),
      allowedPurposes: ["https://api.github.com/**"],
      status: "active",
      grantedBy: "guardian:user@example.com",
      createdAt: now,
      expiresAt: null,
      consumedAt: null,
      revokedAt: null,
    });
    expect(result.status).toBe("active");
    expect(result.grantId).toBe("grant-001");
  });

  test("rejects a grant with unknown status", () => {
    expect(() =>
      PersistentGrantRecordSchema.parse({
        grantId: "grant-001",
        sessionId: "sess-001",
        credentialHandle: "local_static:github/api_key",
        proposalType: "http",
        proposalHash: "abc",
        allowedPurposes: [],
        status: "pending",
        grantedBy: "guardian:user",
        createdAt: new Date().toISOString(),
        expiresAt: null,
        consumedAt: null,
        revokedAt: null,
      }),
    ).toThrow();
  });
});

describe("AuditRecordSummarySchema", () => {
  test("parses a valid audit record", () => {
    const result = AuditRecordSummarySchema.parse({
      auditId: "audit-001",
      grantId: "grant-001",
      credentialHandle: "local_static:github/api_key",
      toolName: "make_authenticated_request",
      target: "https://api.github.com/repos",
      sessionId: "sess-001",
      success: true,
      timestamp: new Date().toISOString(),
    });
    expect(result.auditId).toBe("audit-001");
    expect(result.success).toBe(true);
  });

  test("parses a failed audit record with error message", () => {
    const result = AuditRecordSummarySchema.parse({
      auditId: "audit-002",
      grantId: "grant-001",
      credentialHandle: "local_static:github/api_key",
      toolName: "make_authenticated_request",
      target: "https://api.github.com/repos",
      sessionId: "sess-001",
      success: false,
      errorMessage: "Connection timeout",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("Connection timeout");
  });
});

// ---------------------------------------------------------------------------
// RPC method schemas
// ---------------------------------------------------------------------------

describe("RPC schemas", () => {
  test("MakeAuthenticatedRequestSchema parses valid request", () => {
    const result = MakeAuthenticatedRequestSchema.parse({
      credentialHandle: "local_static:github/api_key",
      method: "GET",
      url: "https://api.github.com/repos",
      purpose: "List repos",
    });
    expect(result.method).toBe("GET");
  });

  test("MakeAuthenticatedRequestResponseSchema parses success", () => {
    const result = MakeAuthenticatedRequestResponseSchema.parse({
      success: true,
      statusCode: 200,
      responseBody: '{"data": []}',
      auditId: "audit-001",
    });
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  test("RunAuthenticatedCommandSchema parses valid request", () => {
    const result = RunAuthenticatedCommandSchema.parse({
      credentialHandle: "local_static:aws/key",
      command: "aws s3 ls",
      purpose: "List buckets",
    });
    expect(result.command).toBe("aws s3 ls");
  });

  test("RunAuthenticatedCommandResponseSchema parses success", () => {
    const result = RunAuthenticatedCommandResponseSchema.parse({
      success: true,
      exitCode: 0,
      stdout: "bucket-1\nbucket-2\n",
      stderr: "",
      auditId: "audit-002",
    });
    expect(result.exitCode).toBe(0);
  });

  test("ManageSecureCommandToolSchema parses register action", () => {
    const result = ManageSecureCommandToolSchema.parse({
      action: "register",
      toolName: "aws-cli",
      credentialHandle: "local_static:aws/key",
      description: "AWS CLI with credentials",
      bundleId: "aws-cli",
      version: "2.15.0",
      sourceUrl: "https://bundles.example.com/aws-cli-2.15.0.vbundle",
      sha256: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      secureCommandManifest: {
        schemaVersion: "1",
        bundleDigest: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        bundleId: "aws-cli",
        version: "2.15.0",
        entrypoint: "bin/aws",
        commandProfiles: {
          aws: {
            description: "AWS CLI access",
            allowedArgvPatterns: [{ name: "any", tokens: ["<cmd...>"] }],
            deniedSubcommands: [],
          },
        },
        authAdapter: { type: "env_var" as const, envVarName: "AWS_ACCESS_KEY_ID" },
        egressMode: "proxy_required" as const,
      },
    });
    expect(result.action).toBe("register");
    expect(result.bundleId).toBe("aws-cli");
    expect(result.version).toBe("2.15.0");
    expect(result.sourceUrl).toBe("https://bundles.example.com/aws-cli-2.15.0.vbundle");
    expect(result.sha256).toBe("abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890");
    expect(result.secureCommandManifest).toBeDefined();
    expect(result.secureCommandManifest!.entrypoint).toBe("bin/aws");
  });

  test("ManageSecureCommandToolSchema parses unregister action", () => {
    const result = ManageSecureCommandToolSchema.parse({
      action: "unregister",
      toolName: "aws-cli",
    });
    expect(result.action).toBe("unregister");
  });

  test("ApprovalRequiredSchema parses valid notification", () => {
    const result = ApprovalRequiredSchema.parse({
      proposal: {
        type: "http",
        credentialHandle: "local_static:github/api_key",
        method: "DELETE",
        url: "https://api.github.com/repos/test",
        purpose: "Delete repository",
      },
      proposalHash: "abcdef1234567890".repeat(4),
      renderedProposal: "Authenticated HTTP Request\n  Method: DELETE",
      sessionId: "sess-001",
    });
    expect(result.sessionId).toBe("sess-001");
  });

  test("RecordGrantSchema parses valid grant recording", () => {
    const result = RecordGrantSchema.parse({
      decision: {
        proposal: {
          type: "http",
          credentialHandle: "local_static:github/api_key",
          method: "GET",
          url: "https://api.github.com/repos",
          purpose: "List repos",
        },
        proposalHash: "abcdef1234567890".repeat(4),
        decision: "approved",
        decidedBy: "guardian:user",
        decidedAt: new Date().toISOString(),
      },
      sessionId: "sess-001",
    });
    expect(result.sessionId).toBe("sess-001");
  });

  test("ListGrantsSchema accepts empty filter", () => {
    const result = ListGrantsSchema.parse({});
    expect(result.sessionId).toBeUndefined();
  });

  test("RevokeGrantSchema parses valid revocation", () => {
    const result = RevokeGrantSchema.parse({
      grantId: "grant-001",
      reason: "Session ended",
    });
    expect(result.grantId).toBe("grant-001");
  });

  test("ListAuditRecordsSchema parses with pagination", () => {
    const result = ListAuditRecordsSchema.parse({
      sessionId: "sess-001",
      limit: 50,
      cursor: "cursor-abc",
    });
    expect(result.limit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Contract completeness — all methods have schemas
// ---------------------------------------------------------------------------

describe("CesRpcSchemas completeness", () => {
  test("every CesRpcMethod has request and response schemas", () => {
    for (const method of Object.values(CesRpcMethod)) {
      const entry = CesRpcSchemas[method];
      expect(entry).toBeDefined();
      expect(entry.request).toBeDefined();
      expect(entry.response).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// No secret-return fields guard
// ---------------------------------------------------------------------------

describe("no secret-return fields", () => {
  test("PersistentGrantRecordSchema does not have secretValue or credential_value fields", () => {
    const shape = PersistentGrantRecordSchema.shape;
    expect("secretValue" in shape).toBe(false);
    expect("credential_value" in shape).toBe(false);
    expect("secret" in shape).toBe(false);
    expect("accessToken" in shape).toBe(false);
    expect("refreshToken" in shape).toBe(false);
  });

  test("AuditRecordSummarySchema does not have secretValue fields", () => {
    const shape = AuditRecordSummarySchema.shape;
    expect("secretValue" in shape).toBe(false);
    expect("credential_value" in shape).toBe(false);
    expect("secret" in shape).toBe(false);
    expect("accessToken" in shape).toBe(false);
    expect("refreshToken" in shape).toBe(false);
  });

  test("MakeAuthenticatedRequestResponseSchema does not return secrets", () => {
    const shape = MakeAuthenticatedRequestResponseSchema.shape;
    expect("secretValue" in shape).toBe(false);
    expect("credential_value" in shape).toBe(false);
    expect("accessToken" in shape).toBe(false);
  });

  test("RunAuthenticatedCommandResponseSchema does not return secrets", () => {
    const shape = RunAuthenticatedCommandResponseSchema.shape;
    expect("secretValue" in shape).toBe(false);
    expect("credential_value" in shape).toBe(false);
    expect("accessToken" in shape).toBe(false);
  });
});
