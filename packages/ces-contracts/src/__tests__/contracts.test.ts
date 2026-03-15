/**
 * Tests for @vellumai/ces-contracts
 *
 * These tests verify:
 * 1. The package can be consumed independently (no assistant/ or CES imports).
 * 2. All exported schemas parse valid payloads and reject invalid ones.
 * 3. The transport message union correctly discriminates by `type`.
 */

import { describe, expect, test } from "bun:test";
import {
  CES_PROTOCOL_VERSION,
  HandshakeAckSchema,
  HandshakeRequestSchema,
  RpcEnvelopeSchema,
  RpcErrorSchema,
  ToolRequestBaseSchema,
  ToolResponseBaseSchema,
  TransportMessageSchema,
} from "../index.js";

// ---------------------------------------------------------------------------
// Independence guard — the package must not pull in assistant or CES modules.
// ---------------------------------------------------------------------------

describe("package independence", () => {
  test("does not import from assistant/ or credential-executor/", () => {
    // Reading our own source is the simplest portable check. If someone
    // accidentally adds an import, this test will catch it.
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../index.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/from\s+['"].*assistant\//);
    expect(src).not.toMatch(/from\s+['"].*credential-executor\//);
    expect(src).not.toMatch(/require\(['"].*assistant\//);
    expect(src).not.toMatch(/require\(['"].*credential-executor\//);
  });
});

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

describe("CES_PROTOCOL_VERSION", () => {
  test("is a valid semver string", () => {
    expect(CES_PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ---------------------------------------------------------------------------
// Handshake schemas
// ---------------------------------------------------------------------------

describe("HandshakeRequestSchema", () => {
  test("parses a valid handshake request", () => {
    const result = HandshakeRequestSchema.parse({
      type: "handshake_request",
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId: "sess-001",
    });
    expect(result.type).toBe("handshake_request");
    expect(result.protocolVersion).toBe(CES_PROTOCOL_VERSION);
    expect(result.sessionId).toBe("sess-001");
  });

  test("rejects a request with wrong type literal", () => {
    expect(() =>
      HandshakeRequestSchema.parse({
        type: "handshake_ack",
        protocolVersion: CES_PROTOCOL_VERSION,
        sessionId: "sess-001",
      }),
    ).toThrow();
  });

  test("rejects a request missing sessionId", () => {
    expect(() =>
      HandshakeRequestSchema.parse({
        type: "handshake_request",
        protocolVersion: CES_PROTOCOL_VERSION,
      }),
    ).toThrow();
  });
});

describe("HandshakeAckSchema", () => {
  test("parses an accepted ack", () => {
    const result = HandshakeAckSchema.parse({
      type: "handshake_ack",
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId: "sess-001",
      accepted: true,
    });
    expect(result.accepted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("parses a rejected ack with reason", () => {
    const result = HandshakeAckSchema.parse({
      type: "handshake_ack",
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId: "sess-001",
      accepted: false,
      reason: "Unsupported protocol version",
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("Unsupported protocol version");
  });
});

// ---------------------------------------------------------------------------
// RPC envelope
// ---------------------------------------------------------------------------

describe("RpcEnvelopeSchema", () => {
  test("parses a valid request envelope", () => {
    const result = RpcEnvelopeSchema.parse({
      id: "1",
      kind: "request",
      method: "tool.execute",
      payload: { foo: "bar" },
      timestamp: new Date().toISOString(),
    });
    expect(result.kind).toBe("request");
    expect(result.method).toBe("tool.execute");
  });

  test("parses a valid response envelope", () => {
    const result = RpcEnvelopeSchema.parse({
      id: "1",
      kind: "response",
      method: "tool.execute",
      payload: { success: true },
      timestamp: new Date().toISOString(),
    });
    expect(result.kind).toBe("response");
  });

  test("rejects an envelope with invalid kind", () => {
    expect(() =>
      RpcEnvelopeSchema.parse({
        id: "1",
        kind: "notification",
        method: "tool.execute",
        payload: null,
        timestamp: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// RPC error
// ---------------------------------------------------------------------------

describe("RpcErrorSchema", () => {
  test("parses a minimal error", () => {
    const result = RpcErrorSchema.parse({
      code: "CREDENTIAL_EXPIRED",
      message: "The credential has expired",
    });
    expect(result.code).toBe("CREDENTIAL_EXPIRED");
    expect(result.details).toBeUndefined();
  });

  test("parses an error with details", () => {
    const result = RpcErrorSchema.parse({
      code: "TOOL_FAILED",
      message: "Execution timed out",
      details: { timeoutMs: 30000 },
    });
    expect(result.details).toEqual({ timeoutMs: 30000 });
  });
});

// ---------------------------------------------------------------------------
// Tool request / response base shapes
// ---------------------------------------------------------------------------

describe("ToolRequestBaseSchema", () => {
  test("parses a valid tool request", () => {
    const result = ToolRequestBaseSchema.parse({
      toolName: "browser.navigate",
      credentialHandle: "cred-abc-123",
      params: { url: "https://example.com" },
    });
    expect(result.toolName).toBe("browser.navigate");
    expect(result.credentialHandle).toBe("cred-abc-123");
    expect(result.params).toEqual({ url: "https://example.com" });
  });

  test("rejects a request missing credentialHandle", () => {
    expect(() =>
      ToolRequestBaseSchema.parse({
        toolName: "browser.navigate",
        params: {},
      }),
    ).toThrow();
  });
});

describe("ToolResponseBaseSchema", () => {
  test("parses a successful response", () => {
    const result = ToolResponseBaseSchema.parse({
      success: true,
      result: { html: "<html></html>" },
    });
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ html: "<html></html>" });
  });

  test("parses a failed response with error", () => {
    const result = ToolResponseBaseSchema.parse({
      success: false,
      error: {
        code: "TOOL_FAILED",
        message: "Network error",
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_FAILED");
  });
});

// ---------------------------------------------------------------------------
// Transport message union
// ---------------------------------------------------------------------------

describe("TransportMessageSchema", () => {
  test("discriminates a handshake request", () => {
    const msg = TransportMessageSchema.parse({
      type: "handshake_request",
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId: "sess-001",
    });
    expect(msg.type).toBe("handshake_request");
  });

  test("discriminates a handshake ack", () => {
    const msg = TransportMessageSchema.parse({
      type: "handshake_ack",
      protocolVersion: CES_PROTOCOL_VERSION,
      sessionId: "sess-001",
      accepted: true,
    });
    expect(msg.type).toBe("handshake_ack");
  });

  test("discriminates an rpc envelope", () => {
    const msg = TransportMessageSchema.parse({
      type: "rpc",
      id: "42",
      kind: "request",
      method: "tool.execute",
      payload: {},
      timestamp: new Date().toISOString(),
    });
    expect(msg.type).toBe("rpc");
  });

  test("rejects an unknown message type", () => {
    expect(() =>
      TransportMessageSchema.parse({
        type: "unknown",
        data: {},
      }),
    ).toThrow();
  });
});
