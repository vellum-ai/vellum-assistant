import { describe, expect, test } from "bun:test";

import {
  A2AValidationError,
  parseA2AEnvelope,
} from "../runtime/a2a/message-contract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validMessage() {
  return {
    version: "v1" as const,
    type: "message" as const,
    senderAssistantId: "asst_abc123",
    messageId: "msg_001",
    content: "Hello from assistant A",
  };
}

function validPairingRequest() {
  return {
    version: "v1" as const,
    type: "pairing_request" as const,
    senderAssistantId: "asst_abc123",
    senderGatewayUrl: "https://gw.example.com",
    inviteCode: "invite_xyz",
  };
}

function validPairingAccepted() {
  return {
    version: "v1" as const,
    type: "pairing_accepted" as const,
    senderAssistantId: "asst_abc123",
    inviteCode: "invite_xyz",
    inboundToken: "tok_target_abc",
  };
}

function validPairingFinalize() {
  return {
    version: "v1" as const,
    type: "pairing_finalize" as const,
    senderAssistantId: "asst_abc123",
    inviteCode: "invite_xyz",
    inboundToken: "tok_initiator_def",
  };
}

// ---------------------------------------------------------------------------
// Happy-path parsing
// ---------------------------------------------------------------------------

describe("parseA2AEnvelope — valid envelopes", () => {
  test("parses a valid message envelope", () => {
    const result = parseA2AEnvelope(validMessage());
    expect(result).toEqual(validMessage());
  });

  test("parses a valid pairing_request envelope", () => {
    const result = parseA2AEnvelope(validPairingRequest());
    expect(result).toEqual(validPairingRequest());
  });

  test("parses a valid pairing_accepted envelope", () => {
    const result = parseA2AEnvelope(validPairingAccepted());
    expect(result).toEqual(validPairingAccepted());
  });

  test("parses a valid pairing_finalize envelope", () => {
    const result = parseA2AEnvelope(validPairingFinalize());
    expect(result).toEqual(validPairingFinalize());
  });

  test("extra fields are silently ignored", () => {
    const result = parseA2AEnvelope({
      ...validMessage(),
      extraField: "should be dropped",
      nested: { deep: true },
    });
    expect(result).toEqual(validMessage());
    expect((result as any).extraField).toBeUndefined();
  });

  test("message with empty content is valid", () => {
    const msg = { ...validMessage(), content: "" };
    const result = parseA2AEnvelope(msg);
    expect(result.type).toBe("message");
    expect((result as any).content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Payload-level rejections
// ---------------------------------------------------------------------------

describe("parseA2AEnvelope — payload-level rejections", () => {
  test("rejects null", () => {
    expect(() => parseA2AEnvelope(null)).toThrow(A2AValidationError);
  });

  test("rejects undefined", () => {
    expect(() => parseA2AEnvelope(undefined)).toThrow(A2AValidationError);
  });

  test("rejects a primitive string", () => {
    expect(() => parseA2AEnvelope("hello")).toThrow(A2AValidationError);
  });

  test("rejects a number", () => {
    expect(() => parseA2AEnvelope(42)).toThrow(A2AValidationError);
  });

  test("rejects an empty object (missing version)", () => {
    expect(() => parseA2AEnvelope({})).toThrow(A2AValidationError);
  });

  test("rejects unsupported version", () => {
    expect(() =>
      parseA2AEnvelope({ ...validMessage(), version: "v2" }),
    ).toThrow("Unsupported version");
  });

  test("rejects invalid type", () => {
    expect(() =>
      parseA2AEnvelope({ ...validMessage(), type: "unknown_type" }),
    ).toThrow("Invalid type");
  });

  test("rejects missing type", () => {
    const { type: _, ...rest } = validMessage();
    expect(() => parseA2AEnvelope(rest)).toThrow("Invalid type");
  });
});

// ---------------------------------------------------------------------------
// Common field: senderAssistantId
// ---------------------------------------------------------------------------

describe("parseA2AEnvelope — senderAssistantId validation", () => {
  test("rejects missing senderAssistantId", () => {
    const { senderAssistantId: _, ...rest } = validMessage();
    expect(() => parseA2AEnvelope(rest)).toThrow("senderAssistantId");
  });

  test("rejects empty senderAssistantId", () => {
    expect(() =>
      parseA2AEnvelope({ ...validMessage(), senderAssistantId: "" }),
    ).toThrow("senderAssistantId");
  });

  test("rejects non-string senderAssistantId", () => {
    expect(() =>
      parseA2AEnvelope({ ...validMessage(), senderAssistantId: 123 }),
    ).toThrow("senderAssistantId");
  });
});

// ---------------------------------------------------------------------------
// Message-specific validation
// ---------------------------------------------------------------------------

describe("parseA2AEnvelope — message variant", () => {
  test("rejects missing messageId", () => {
    const { messageId: _, ...rest } = validMessage();
    expect(() => parseA2AEnvelope(rest)).toThrow("messageId");
  });

  test("rejects empty messageId", () => {
    expect(() =>
      parseA2AEnvelope({ ...validMessage(), messageId: "" }),
    ).toThrow("messageId");
  });

  test("rejects missing content", () => {
    const { content: _, ...rest } = validMessage();
    expect(() => parseA2AEnvelope(rest)).toThrow("content");
  });

  test("rejects non-string content", () => {
    expect(() => parseA2AEnvelope({ ...validMessage(), content: 42 })).toThrow(
      "content",
    );
  });

  test("rejects oversized content", () => {
    const oversized = "x".repeat(256 * 1024 + 1);
    expect(() =>
      parseA2AEnvelope({ ...validMessage(), content: oversized }),
    ).toThrow("exceeds maximum size");
  });

  test("accepts content at exactly the size limit", () => {
    // 256 KiB of ASCII = exactly 256*1024 bytes
    const maxContent = "x".repeat(256 * 1024);
    const result = parseA2AEnvelope({ ...validMessage(), content: maxContent });
    expect(result.type).toBe("message");
  });
});

// ---------------------------------------------------------------------------
// Pairing request variant
// ---------------------------------------------------------------------------

describe("parseA2AEnvelope — pairing_request variant", () => {
  test("rejects missing senderGatewayUrl", () => {
    const { senderGatewayUrl: _, ...rest } = validPairingRequest();
    expect(() => parseA2AEnvelope(rest)).toThrow("senderGatewayUrl");
  });

  test("rejects empty senderGatewayUrl", () => {
    expect(() =>
      parseA2AEnvelope({ ...validPairingRequest(), senderGatewayUrl: "" }),
    ).toThrow("senderGatewayUrl");
  });

  test("rejects missing inviteCode", () => {
    const { inviteCode: _, ...rest } = validPairingRequest();
    expect(() => parseA2AEnvelope(rest)).toThrow("inviteCode");
  });

  test("rejects empty inviteCode", () => {
    expect(() =>
      parseA2AEnvelope({ ...validPairingRequest(), inviteCode: "" }),
    ).toThrow("inviteCode");
  });
});

// ---------------------------------------------------------------------------
// Pairing accepted variant
// ---------------------------------------------------------------------------

describe("parseA2AEnvelope — pairing_accepted variant", () => {
  test("rejects missing inviteCode", () => {
    const { inviteCode: _, ...rest } = validPairingAccepted();
    expect(() => parseA2AEnvelope(rest)).toThrow("inviteCode");
  });

  test("rejects missing inboundToken", () => {
    const { inboundToken: _, ...rest } = validPairingAccepted();
    expect(() => parseA2AEnvelope(rest)).toThrow("inboundToken");
  });

  test("rejects empty inboundToken", () => {
    expect(() =>
      parseA2AEnvelope({ ...validPairingAccepted(), inboundToken: "" }),
    ).toThrow("inboundToken");
  });
});

// ---------------------------------------------------------------------------
// Pairing finalize variant
// ---------------------------------------------------------------------------

describe("parseA2AEnvelope — pairing_finalize variant", () => {
  test("rejects missing inviteCode", () => {
    const { inviteCode: _, ...rest } = validPairingFinalize();
    expect(() => parseA2AEnvelope(rest)).toThrow("inviteCode");
  });

  test("rejects missing inboundToken", () => {
    const { inboundToken: _, ...rest } = validPairingFinalize();
    expect(() => parseA2AEnvelope(rest)).toThrow("inboundToken");
  });

  test("rejects empty inboundToken", () => {
    expect(() =>
      parseA2AEnvelope({ ...validPairingFinalize(), inboundToken: "" }),
    ).toThrow("inboundToken");
  });
});

// ---------------------------------------------------------------------------
// Variant-specific field presence / absence
// ---------------------------------------------------------------------------

describe("parseA2AEnvelope — variant field boundaries", () => {
  test("message envelope does NOT include senderGatewayUrl", () => {
    const result = parseA2AEnvelope({
      ...validMessage(),
      senderGatewayUrl: "https://should-be-stripped.example.com",
    });
    expect((result as any).senderGatewayUrl).toBeUndefined();
  });

  test("message envelope does NOT include inboundToken", () => {
    const result = parseA2AEnvelope({
      ...validMessage(),
      inboundToken: "tok_should_be_stripped",
    });
    expect((result as any).inboundToken).toBeUndefined();
  });

  test("pairing_request does NOT include inboundToken", () => {
    const result = parseA2AEnvelope({
      ...validPairingRequest(),
      inboundToken: "tok_should_be_stripped",
    });
    expect((result as any).inboundToken).toBeUndefined();
  });

  test("pairing_accepted does NOT include senderGatewayUrl", () => {
    const result = parseA2AEnvelope({
      ...validPairingAccepted(),
      senderGatewayUrl: "https://should-be-stripped.example.com",
    });
    expect((result as any).senderGatewayUrl).toBeUndefined();
  });

  test("pairing_finalize does NOT include senderGatewayUrl", () => {
    const result = parseA2AEnvelope({
      ...validPairingFinalize(),
      senderGatewayUrl: "https://should-be-stripped.example.com",
    });
    expect((result as any).senderGatewayUrl).toBeUndefined();
  });
});
