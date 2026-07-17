/**
 * Managed CES contract and wiring tests.
 *
 * Validates the contract surface and behavioral invariants for the managed
 * (three-container pod) CES sidecar integration:
 *
 * 1. Pod creation contract: well-known path constants match the
 *    stateful_template.yaml K8s spec (read-only mount + private PVC).
 *
 * 2. Bootstrap handshake contract: protocol version is valid semver and
 *    the handshake schema requires both protocolVersion and sessionId.
 *
 * 3. local_static handle rejection: managed mode returns clear errors
 *    when local_static credential handles are used (the core managed-mode
 *    behavioral contract per main.ts managed-mode handler builder).
 *
 * 4. RPC schema compatibility: managed-specific schemas
 *    (UpdateManagedCredential, MakeAuthenticatedRequest) validate expected
 *    payloads and reject malformed ones at the contract level.
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
} from "@vellumai/service-contracts/credential-rpc";

import {
  CES_ASSISTANT_DATA_READONLY_MOUNT,
  CES_PRIVATE_DATA_DIR,
} from "../credential-execution/process-manager.js";

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
    expect(CesRpcMethod.UpdateManagedCredential).toBe(
      "update_managed_credential",
    );
    expect(CesRpcMethod.GetCredential).toBe("get_credential");
    expect(CesRpcMethod.SetCredential).toBe("set_credential");
    expect(CesRpcMethod.DeleteCredential).toBe("delete_credential");
    expect(CesRpcMethod.ListCredentials).toBe("list_credentials");
    expect(CesRpcMethod.BulkSetCredentials).toBe("bulk_set_credentials");
  });

  test("all declared RPC methods have matching schemas in CesRpcSchemas", () => {
    // Every method constant must have a corresponding schema entry with
    // both request and response. A missing entry means the RPC dispatch
    // layer can't validate payloads for that method.
    const allMethods = Object.values(CesRpcMethod);
    expect(allMethods.length).toBeGreaterThanOrEqual(6);
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
    // main.ts will return an error. This test catches new types
    // that need managed-mode consideration.
    const types = Object.values(HandleType);
    expect(types).toContain("local_static");
    expect(types).toContain("local_oauth");
    expect(types).toContain("platform_oauth");
    expect(types).toHaveLength(3);
  });

  test("production rejection error mentions platform_oauth as the alternative", () => {
    // Assert against the actual shared constant from service-contracts,
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

  test("handshake request schema requires protocolVersion and sessionId", () => {
    // Both fields are mandatory for the managed bootstrap handshake.
    // A handshake missing either must be rejected at parse time.
    const validHandshake = {
      type: "handshake_request" as const,
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId: "test-session-123",
    };
    const result = HandshakeRequestSchema.safeParse(validHandshake);
    expect(result.success).toBe(true);
  });

  test("handshake request schema rejects missing protocolVersion", () => {
    const result = HandshakeRequestSchema.safeParse({
      type: "handshake_request",
      sessionId: "test-session-123",
    });
    expect(result.success).toBe(false);
  });

  test("handshake request schema rejects missing sessionId", () => {
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
      sessionId: "test-session-123",
      assistantApiKey: "vellum_key_test",
    });
    expect(result.success).toBe(true);
  });

  test("handshake ack schema includes accepted field for version negotiation", () => {
    const acceptedAck = {
      type: "handshake_ack" as const,
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId: "test-session-123",
      accepted: true,
    };
    const result = HandshakeAckSchema.safeParse(acceptedAck);
    expect(result.success).toBe(true);

    const rejectedAck = {
      type: "handshake_ack" as const,
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId: "test-session-123",
      accepted: false,
      reason: "Unsupported protocol version",
    };
    const rejResult = HandshakeAckSchema.safeParse(rejectedAck);
    expect(rejResult.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Managed OAuth handle parsing
// ---------------------------------------------------------------------------

describe("managed OAuth materialization through CES sidecar", () => {
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
