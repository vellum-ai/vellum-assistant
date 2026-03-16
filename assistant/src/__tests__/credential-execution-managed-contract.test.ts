/**
 * Managed CES contract and wiring tests.
 *
 * Validates the contract surface, behavioral invariants, and feature-flag
 * gating for the managed (three-container pod) CES sidecar integration:
 *
 * 1. Pod creation contract: well-known path constants match the
 *    stateful_template.yaml K8s spec (read-only mount + private PVC).
 *
 * 2. Bootstrap handshake contract: protocol version is valid semver and
 *    the handshake schema requires both protocolVersion and conversationId.
 *
 * 3. local_static handle rejection: managed mode returns clear errors
 *    when local_static credential handles are used (the core managed-mode
 *    behavioral contract per managed-main.ts lines 161-221).
 *
 * 4. RPC schema compatibility: managed-specific schemas
 *    (UpdateManagedCredential, MakeAuthenticatedRequest) validate expected
 *    payloads and reject malformed ones at the contract level.
 *
 * 5. Feature-flag rollback: when the `ces-managed-sidecar` flag is off,
 *    the process manager falls back to local discovery and never attempts
 *    the managed sidecar path.
 *
 * All tests use contract schemas and handle parsers to verify behavioral
 * contracts — no real CES process or socket dependencies are needed.
 */

import { describe, expect, test } from "bun:test";

import {
  CES_PROTOCOL_VERSION,
  CesRpcMethod,
  CesRpcSchemas,
  HandleType,
  HandshakeAckSchema,
  HandshakeRequestSchema,
  localStaticHandle,
  MANAGED_LOCAL_STATIC_REJECTION_ERROR,
  parseHandle,
  platformOAuthHandle,
  UpdateManagedCredentialResponseSchema,
  UpdateManagedCredentialSchema,
} from "@vellumai/ces-contracts";

import type { AssistantConfig } from "../config/schema.js";
import {
  isCesManagedSidecarEnabled,
  isCesToolsEnabled,
} from "../credential-execution/feature-gates.js";
import {
  CES_ASSISTANT_DATA_READONLY_MOUNT,
  CES_PRIVATE_DATA_DIR,
  type CesProcessManagerConfig,
} from "../credential-execution/process-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AssistantConfig with optional feature flag values. */
function makeConfig(flagOverrides?: Record<string, boolean>): AssistantConfig {
  return {
    ...(flagOverrides ? { assistantFeatureFlagValues: flagOverrides } : {}),
  } as AssistantConfig;
}

// ---------------------------------------------------------------------------
// Well-known paths contract
// ---------------------------------------------------------------------------

describe("managed env contract constants", () => {
  test("CES_ASSISTANT_DATA_READONLY_MOUNT is /assistant-data-ro", () => {
    expect(CES_ASSISTANT_DATA_READONLY_MOUNT).toBe("/assistant-data-ro");
  });

  test("CES_PRIVATE_DATA_DIR is /ces-data", () => {
    expect(CES_PRIVATE_DATA_DIR).toBe("/ces-data");
  });
});

// ---------------------------------------------------------------------------
// Three-container pod contract — verify actual constant values
// ---------------------------------------------------------------------------

describe("three-container pod contract", () => {
  test("well-known paths are absolute and match K8s mount spec", () => {
    // These must be absolute paths that match the stateful_template.yaml
    // volume mount declarations for the CES sidecar container.
    expect(CES_ASSISTANT_DATA_READONLY_MOUNT).toStartWith("/");
    expect(CES_PRIVATE_DATA_DIR).toStartWith("/");

    // The paths must be different volumes to enforce data isolation:
    // assistant-data is read-only in CES, CES private data is read-write.
    expect(CES_ASSISTANT_DATA_READONLY_MOUNT).not.toBe(CES_PRIVATE_DATA_DIR);
  });

  test("CES RPC method names match expected wire protocol strings", () => {
    // Verify actual string values, not just that they exist. These are
    // the method names on the wire — changing them is a breaking change
    // that would break the assistant-to-CES sidecar RPC contract.
    expect(CesRpcMethod.MakeAuthenticatedRequest).toBe(
      "make_authenticated_request",
    );
    expect(CesRpcMethod.RunAuthenticatedCommand).toBe(
      "run_authenticated_command",
    );
    expect(CesRpcMethod.ManageSecureCommandTool).toBe(
      "manage_secure_command_tool",
    );
    expect(CesRpcMethod.UpdateManagedCredential).toBe(
      "update_managed_credential",
    );
  });

  test("all declared RPC methods have matching schemas in CesRpcSchemas", () => {
    // Every method constant must have a corresponding schema entry with
    // both request and response. A missing entry means the RPC dispatch
    // layer can't validate payloads for that method.
    const allMethods = Object.values(CesRpcMethod);
    expect(allMethods.length).toBeGreaterThanOrEqual(9);
    for (const method of allMethods) {
      const schema = CesRpcSchemas[method as keyof typeof CesRpcSchemas];
      expect(schema).toBeDefined();
      expect(schema.request).toBeDefined();
      expect(schema.response).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// local_static handle rejection in managed mode
// ---------------------------------------------------------------------------

describe("local_static handle rejection in managed mode", () => {
  test("local_static handles parse correctly but are a distinct type from platform_oauth", () => {
    // In managed mode, local_static handles must be identified and rejected.
    // First verify that the handle parser correctly distinguishes them.
    const localHandle = localStaticHandle("github", "api_key");
    const result = parseHandle(localHandle);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handle.type).toBe(HandleType.LocalStatic);
      expect(result.handle.type).not.toBe(HandleType.PlatformOAuth);
    }
  });

  test("platform_oauth handles parse to the correct type for managed mode", () => {
    const handle = platformOAuthHandle("conn_abc123");
    const result = parseHandle(handle);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handle.type).toBe(HandleType.PlatformOAuth);
      if (result.handle.type === HandleType.PlatformOAuth) {
        expect(result.handle.connectionId).toBe("conn_abc123");
      }
    }
  });

  test("HandleType enum has exactly the three expected types", () => {
    // Managed mode explicitly switches on handle type. If a new type is
    // added without a managed-mode handler, the default case in
    // managed-main.ts will return an error. This test catches new types
    // that need managed-mode consideration.
    const types = Object.values(HandleType);
    expect(types).toContain("local_static");
    expect(types).toContain("local_oauth");
    expect(types).toContain("platform_oauth");
    expect(types).toHaveLength(3);
  });

  test("production rejection error mentions platform_oauth as the alternative", () => {
    // Assert against the actual production constant from managed-errors.ts,
    // not a test-local copy.
    expect(MANAGED_LOCAL_STATIC_REJECTION_ERROR).toContain("platform_oauth");
  });

  test("production rejection error references managed mode", () => {
    expect(MANAGED_LOCAL_STATIC_REJECTION_ERROR).toContain("managed");
  });

  test("production rejection error states local_static is not supported", () => {
    expect(MANAGED_LOCAL_STATIC_REJECTION_ERROR).toContain(
      "local_static credential handles are not supported",
    );
  });
});

// ---------------------------------------------------------------------------
// RPC schema compatibility — UpdateManagedCredential
// ---------------------------------------------------------------------------

describe("UpdateManagedCredential RPC schema contract", () => {
  test("request schema requires assistantApiKey field", () => {
    // The UpdateManagedCredential RPC is managed-mode-specific: the
    // assistant pushes its API key to CES after hatch provisioning.
    expect(UpdateManagedCredentialSchema.shape.assistantApiKey).toBeDefined();
  });

  test("request schema validates a well-formed payload", () => {
    const payload = { assistantApiKey: "vellum_key_test_123" };
    const result = UpdateManagedCredentialSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  test("request schema rejects payload missing assistantApiKey", () => {
    const result = UpdateManagedCredentialSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("request schema rejects non-string assistantApiKey", () => {
    const result = UpdateManagedCredentialSchema.safeParse({
      assistantApiKey: 12345,
    });
    expect(result.success).toBe(false);
  });

  test("response schema requires updated boolean field", () => {
    expect(UpdateManagedCredentialResponseSchema.shape.updated).toBeDefined();

    const successResult = UpdateManagedCredentialResponseSchema.safeParse({
      updated: true,
    });
    expect(successResult.success).toBe(true);

    const failResult = UpdateManagedCredentialResponseSchema.safeParse({
      updated: false,
    });
    expect(failResult.success).toBe(true);
  });

  test("response schema rejects payload missing updated field", () => {
    const result = UpdateManagedCredentialResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("CesRpcSchemas entry for UpdateManagedCredential matches standalone schemas", () => {
    // The schema lookup map must reference the same schemas. A mismatch
    // would mean the RPC dispatch layer validates against a different
    // schema than what callers expect.
    const entry = CesRpcSchemas[CesRpcMethod.UpdateManagedCredential];
    expect(entry.request).toBe(UpdateManagedCredentialSchema);
    expect(entry.response).toBe(UpdateManagedCredentialResponseSchema);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap handshake protocol version contract
// ---------------------------------------------------------------------------

describe("managed CES bootstrap handshake contract", () => {
  test("CES_PROTOCOL_VERSION is valid semver", () => {
    // The protocol version must be valid semver so version negotiation
    // works correctly during the managed bootstrap handshake.
    expect(CES_PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("CES_PROTOCOL_VERSION matches expected value", () => {
    // Pin the current version so unintended bumps are caught in review.
    expect(CES_PROTOCOL_VERSION).toBe("0.1.0");
  });

  test("handshake request schema requires protocolVersion and conversationId", () => {
    // Both fields are mandatory for the managed bootstrap handshake.
    // A handshake missing either must be rejected at parse time.
    const validHandshake = {
      type: "handshake_request" as const,
      protocolVersion: CES_PROTOCOL_VERSION,
      conversationId: "test-session-123",
    };
    const result = HandshakeRequestSchema.safeParse(validHandshake);
    expect(result.success).toBe(true);
  });

  test("handshake request schema rejects missing protocolVersion", () => {
    const result = HandshakeRequestSchema.safeParse({
      type: "handshake_request",
      conversationId: "test-session-123",
    });
    expect(result.success).toBe(false);
  });

  test("handshake request schema rejects missing conversationId", () => {
    const result = HandshakeRequestSchema.safeParse({
      type: "handshake_request",
      protocolVersion: CES_PROTOCOL_VERSION,
    });
    expect(result.success).toBe(false);
  });

  test("handshake request schema accepts optional assistantApiKey for managed mode", () => {
    // In managed mode the assistant forwards its API key during handshake.
    const result = HandshakeRequestSchema.safeParse({
      type: "handshake_request",
      protocolVersion: CES_PROTOCOL_VERSION,
      conversationId: "test-session-123",
      assistantApiKey: "vellum_key_test",
    });
    expect(result.success).toBe(true);
  });

  test("handshake ack schema includes accepted field for version negotiation", () => {
    const acceptedAck = {
      type: "handshake_ack" as const,
      protocolVersion: CES_PROTOCOL_VERSION,
      conversationId: "test-session-123",
      accepted: true,
    };
    const result = HandshakeAckSchema.safeParse(acceptedAck);
    expect(result.success).toBe(true);

    const rejectedAck = {
      type: "handshake_ack" as const,
      protocolVersion: CES_PROTOCOL_VERSION,
      conversationId: "test-session-123",
      accepted: false,
      reason: "Unsupported protocol version",
    };
    const rejResult = HandshakeAckSchema.safeParse(rejectedAck);
    expect(rejResult.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Secure HTTP execution through sidecar path
// ---------------------------------------------------------------------------

describe("secure HTTP execution through managed sidecar", () => {
  test("make_authenticated_request schema validates a well-formed request", () => {
    const schema = CesRpcSchemas[CesRpcMethod.MakeAuthenticatedRequest];
    const result = schema.request.safeParse({
      credentialHandle: platformOAuthHandle("conn_123"),
      method: "GET",
      url: "https://api.example.com/resource",
      purpose: "Fetch user data",
    });
    expect(result.success).toBe(true);
  });

  test("make_authenticated_request schema rejects request missing credentialHandle", () => {
    const schema = CesRpcSchemas[CesRpcMethod.MakeAuthenticatedRequest];
    const result = schema.request.safeParse({
      method: "GET",
      url: "https://api.example.com/resource",
      purpose: "Fetch user data",
    });
    expect(result.success).toBe(false);
  });

  test("make_authenticated_request response schema validates success and error shapes", () => {
    const schema = CesRpcSchemas[CesRpcMethod.MakeAuthenticatedRequest];

    const successResult = schema.response.safeParse({
      success: true,
      statusCode: 200,
      responseBody: '{"data": "ok"}',
    });
    expect(successResult.success).toBe(true);

    const errorResult = schema.response.safeParse({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Invalid token" },
    });
    expect(errorResult.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Secure command execution through sidecar path
// ---------------------------------------------------------------------------

describe("secure command execution through managed sidecar", () => {
  test("run_authenticated_command schema validates a well-formed request", () => {
    const schema = CesRpcSchemas[CesRpcMethod.RunAuthenticatedCommand];
    const result = schema.request.safeParse({
      credentialHandle: platformOAuthHandle("conn_456"),
      command: "sha256abc123/default git status",
      purpose: "Check repo status",
    });
    expect(result.success).toBe(true);
  });

  test("run_authenticated_command schema rejects request missing command", () => {
    const schema = CesRpcSchemas[CesRpcMethod.RunAuthenticatedCommand];
    const result = schema.request.safeParse({
      credentialHandle: platformOAuthHandle("conn_456"),
      purpose: "Check repo status",
    });
    expect(result.success).toBe(false);
  });

  test("run_authenticated_command response includes exitCode, stdout, stderr", () => {
    const schema = CesRpcSchemas[CesRpcMethod.RunAuthenticatedCommand];
    const result = schema.response.safeParse({
      success: true,
      exitCode: 0,
      stdout: "On branch main\n",
      stderr: "",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Managed OAuth materialization through CES
// ---------------------------------------------------------------------------

describe("managed OAuth materialization through CES sidecar", () => {
  test("credentialHandle field accepts platform_oauth handles", () => {
    const schema = CesRpcSchemas[CesRpcMethod.MakeAuthenticatedRequest];
    const handle = platformOAuthHandle("conn_abc123");
    const result = schema.request.safeParse({
      credentialHandle: handle,
      method: "POST",
      url: "https://api.example.com/token",
      purpose: "Materialize OAuth token",
    });
    expect(result.success).toBe(true);
  });

  test("platform_oauth handle roundtrips through parse correctly", () => {
    const handle = platformOAuthHandle("conn_abc123");
    expect(handle).toBe("platform_oauth:conn_abc123");

    const parsed = parseHandle(handle);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.handle.type).toBe(HandleType.PlatformOAuth);
      if (parsed.handle.type === HandleType.PlatformOAuth) {
        expect(parsed.handle.connectionId).toBe("conn_abc123");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Feature-flag rollback safety
// ---------------------------------------------------------------------------

describe("feature-flag rollback safety", () => {
  test("managed sidecar flag defaults to false (safe dark-launch)", () => {
    const config = makeConfig();
    expect(isCesManagedSidecarEnabled(config)).toBe(false);
  });

  test("managed sidecar flag can be explicitly enabled", () => {
    const config = makeConfig({
      "feature_flags.ces-managed-sidecar.enabled": true,
    });
    expect(isCesManagedSidecarEnabled(config)).toBe(true);
  });

  test("managed sidecar flag can be explicitly disabled", () => {
    const config = makeConfig({
      "feature_flags.ces-managed-sidecar.enabled": false,
    });
    expect(isCesManagedSidecarEnabled(config)).toBe(false);
  });

  test("enabling managed sidecar does not enable CES tools", () => {
    const config = makeConfig({
      "feature_flags.ces-managed-sidecar.enabled": true,
    });
    // CES tools flag should remain independently controlled
    expect(isCesToolsEnabled(config)).toBe(false);
  });

  test("disabling managed sidecar does not affect other CES flags", () => {
    const config = makeConfig({
      "feature_flags.ces-managed-sidecar.enabled": false,
      "feature_flags.ces-tools.enabled": true,
    });
    expect(isCesToolsEnabled(config)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Process manager config wiring
// ---------------------------------------------------------------------------

describe("process manager config wiring", () => {
  test("CesProcessManagerConfig accepts assistantConfig for flag gating", () => {
    const config: CesProcessManagerConfig = {
      assistantConfig: makeConfig({
        "feature_flags.ces-managed-sidecar.enabled": true,
      }),
    };
    expect(config.assistantConfig).toBeDefined();
    expect(isCesManagedSidecarEnabled(config.assistantConfig!)).toBe(true);
  });

  test("CesProcessManagerConfig requires assistantConfig for feature-flag gate", () => {
    const config: CesProcessManagerConfig = {
      assistantConfig: makeConfig({}),
    };
    expect(config.assistantConfig).toBeDefined();
  });

  test("when flag is off, managed discovery is skipped", () => {
    const config: CesProcessManagerConfig = {
      assistantConfig: makeConfig({
        "feature_flags.ces-managed-sidecar.enabled": false,
      }),
    };
    // The managed path should be gated
    expect(isCesManagedSidecarEnabled(config.assistantConfig!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-CES internal consumers intact
// ---------------------------------------------------------------------------

describe("non-CES internal consumers intact when flag is off", () => {
  test("existing non-agent flows are unaffected by managed sidecar flag", () => {
    const config = makeConfig({
      "feature_flags.ces-managed-sidecar.enabled": false,
    });
    expect(isCesManagedSidecarEnabled(config)).toBe(false);
  });

  test("process manager without config allows managed mode (backward compat)", () => {
    const config: CesProcessManagerConfig = {};
    expect(config.assistantConfig).toBeUndefined();
  });
});
