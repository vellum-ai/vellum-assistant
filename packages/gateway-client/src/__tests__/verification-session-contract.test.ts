/**
 * Tests for the shared verification-session contract.
 *
 * The pinned hash vectors below define the hash compatibility contract:
 * `hashVerificationSecret` must produce exactly these outputs because session
 * hashes already stored in the assistant DB (and backfilled to the gateway)
 * were produced with the same SHA-256-hex scheme. Do not update the vectors
 * to "fix" a failure — a mismatch means the hash scheme broke.
 */

import { describe, expect, test } from "bun:test";

import {
  BindSessionIdentityIpcParamsSchema,
  CountRecentSendsIpcParamsSchema,
  CountRecentSendsIpcResponseSchema,
  CreateInboundSessionIpcParamsSchema,
  CreateInboundSessionIpcResponseSchema,
  CreateOutboundSessionIpcParamsSchema,
  CreateOutboundSessionIpcResponseSchema,
  hashVerificationSecret,
  ResolveBootstrapSessionIpcParamsSchema,
  SessionLookupIpcResponseSchema,
  UpdateSessionDeliveryIpcParamsSchema,
  UpdateSessionStatusIpcParamsSchema,
  ValidateConsumeSessionIpcParamsSchema,
  ValidateConsumeSessionIpcResponseSchema,
  VERIFICATION_SESSIONS_IPC_METHODS,
  VerificationSessionSchema,
  type VerificationSessionWire,
} from "../verification-session-contract.js";

describe("hashVerificationSecret — pinned compatibility vectors", () => {
  test("matches channel-verification-service.ts hashSecret output", () => {
    expect(hashVerificationSecret("123456")).toBe(
      "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
    );
    expect(hashVerificationSecret("test-bootstrap-token")).toBe(
      "99ecd312d2f24ffd7011532ba5579dae00103767862bd5b7a79e6efcef99e05e",
    );
    expect(hashVerificationSecret("a3f9")).toBe(
      "a5099480221d1ba2eb1fae7248a0ab2cb15b52ffbe3f3945b3d7e609acd3b2fc",
    );
  });
});

describe("IPC method names", () => {
  test("exposes 11 unique methods under the verification_sessions_ prefix", () => {
    const methods = Object.values(VERIFICATION_SESSIONS_IPC_METHODS);
    expect(methods).toHaveLength(11);
    expect(new Set(methods).size).toBe(11);
    for (const method of methods) {
      // Distinct from the daemon's client-facing
      // `channel_verification_sessions_*` operationIds.
      expect(method).toMatch(/^verification_sessions_[a-z_]+$/);
    }
  });
});

const outboundSession: VerificationSessionWire = {
  id: "sess-1",
  channel: "telegram",
  challengeHash: hashVerificationSecret("123456"),
  expiresAt: 1_700_000_600_000,
  status: "awaiting_response",
  sourceConversationId: null,
  consumedByExternalUserId: null,
  consumedByChatId: null,
  expectedExternalUserId: "tg-user-1",
  expectedChatId: "tg-chat-1",
  expectedPhoneE164: null,
  identityBindingStatus: "bound",
  destinationAddress: "@handle",
  lastSentAt: 1_700_000_000_000,
  sendCount: 1,
  nextResendAt: 1_700_000_060_000,
  codeDigits: 6,
  maxAttempts: 3,
  verificationPurpose: "guardian",
  bootstrapTokenHash: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const inboundSession: VerificationSessionWire = {
  ...outboundSession,
  id: "sess-2",
  status: "pending",
  sourceConversationId: "conv-1",
  expectedExternalUserId: null,
  expectedChatId: null,
  identityBindingStatus: null,
  destinationAddress: null,
  lastSentAt: null,
  sendCount: 0,
  nextResendAt: null,
  verificationPurpose: "trusted_contact",
};

describe("VerificationSessionSchema", () => {
  test("round-trips outbound and inbound sessions", () => {
    expect(VerificationSessionSchema.parse(outboundSession)).toEqual(
      outboundSession,
    );
    expect(VerificationSessionSchema.parse(inboundSession)).toEqual(
      inboundSession,
    );
  });

  test("rejects an unknown status", () => {
    expect(() =>
      VerificationSessionSchema.parse({
        ...outboundSession,
        status: "definitely_not_a_status",
      }),
    ).toThrow();
  });

  test("SessionLookupIpcResponseSchema accepts a session or null", () => {
    expect(SessionLookupIpcResponseSchema.parse(outboundSession)).toEqual(
      outboundSession,
    );
    expect(SessionLookupIpcResponseSchema.parse(null)).toBeNull();
  });
});

describe("create session IPC schemas", () => {
  test("create_inbound round-trips params and response", () => {
    const params = { channel: "telegram", sourceConversationId: "conv-1" };
    expect(CreateInboundSessionIpcParamsSchema.parse(params)).toEqual(params);
    const minimal = { channel: "slack" };
    expect(CreateInboundSessionIpcParamsSchema.parse(minimal)).toEqual(minimal);
    expect(() =>
      CreateInboundSessionIpcParamsSchema.parse({ channel: "" }),
    ).toThrow();

    const response = {
      session: inboundSession,
      secret: "raw-secret",
      verifyCommand: "raw-secret",
      ttlSeconds: 600,
    };
    expect(CreateInboundSessionIpcResponseSchema.parse(response)).toEqual(
      response,
    );
  });

  test("create_outbound round-trips full and minimal params + response", () => {
    const full = {
      channel: "telegram",
      expectedExternalUserId: "tg-user-1",
      expectedChatId: "tg-chat-1",
      expectedPhoneE164: "+15551234567",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@handle",
      codeDigits: 6,
      maxAttempts: 3,
      verificationPurpose: "trusted_contact",
      bootstrapTokenHash: hashVerificationSecret("test-bootstrap-token"),
      sessionId: "sess-1",
    } as const;
    expect(CreateOutboundSessionIpcParamsSchema.parse(full)).toEqual(full);
    const minimal = { channel: "phone" };
    expect(CreateOutboundSessionIpcParamsSchema.parse(minimal)).toEqual(
      minimal,
    );
    expect(() =>
      CreateOutboundSessionIpcParamsSchema.parse({
        channel: "phone",
        identityBindingStatus: "unbound",
      }),
    ).toThrow();

    const response = {
      sessionId: "sess-1",
      secret: "123456",
      challengeHash: hashVerificationSecret("123456"),
      expiresAt: 1_700_000_600_000,
      ttlSeconds: 600,
    };
    expect(CreateOutboundSessionIpcResponseSchema.parse(response)).toEqual(
      response,
    );
  });
});

describe("lifecycle IPC param schemas", () => {
  test("resolve_bootstrap requires channel and raw token", () => {
    const params = { channel: "telegram", token: "raw-deep-link-token" };
    expect(ResolveBootstrapSessionIpcParamsSchema.parse(params)).toEqual(
      params,
    );
    expect(() =>
      ResolveBootstrapSessionIpcParamsSchema.parse({ channel: "telegram" }),
    ).toThrow();
  });

  test("bind_identity requires all three fields", () => {
    const params = {
      sessionId: "sess-1",
      externalUserId: "tg-user-1",
      chatId: "tg-chat-1",
    };
    expect(BindSessionIdentityIpcParamsSchema.parse(params)).toEqual(params);
    expect(() =>
      BindSessionIdentityIpcParamsSchema.parse({ sessionId: "sess-1" }),
    ).toThrow();
  });

  test("update_status accepts consumed-by fields and rejects bad statuses", () => {
    const params = {
      sessionId: "sess-1",
      status: "consumed",
      consumedByExternalUserId: "tg-user-1",
      consumedByChatId: "tg-chat-1",
    } as const;
    expect(UpdateSessionStatusIpcParamsSchema.parse(params)).toEqual(params);
    const minimal = { sessionId: "sess-1", status: "revoked" } as const;
    expect(UpdateSessionStatusIpcParamsSchema.parse(minimal)).toEqual(minimal);
    expect(() =>
      UpdateSessionStatusIpcParamsSchema.parse({
        sessionId: "sess-1",
        status: "nope",
      }),
    ).toThrow();
  });

  test("update_delivery accepts a null nextResendAt", () => {
    const params = {
      sessionId: "sess-1",
      lastSentAt: 1_700_000_000_000,
      sendCount: 2,
      nextResendAt: null,
    };
    expect(UpdateSessionDeliveryIpcParamsSchema.parse(params)).toEqual(params);
    expect(() =>
      UpdateSessionDeliveryIpcParamsSchema.parse({
        sessionId: "sess-1",
        lastSentAt: 1_700_000_000_000,
        sendCount: 2,
      }),
    ).toThrow();
  });

  test("count_recent_sends round-trips params and response", () => {
    const params = {
      channel: "telegram",
      destinationAddress: "@handle",
      windowMs: 900_000,
    };
    expect(CountRecentSendsIpcParamsSchema.parse(params)).toEqual(params);
    expect(CountRecentSendsIpcResponseSchema.parse({ count: 3 })).toEqual({
      count: 3,
    });
    expect(() =>
      CountRecentSendsIpcResponseSchema.parse({ count: 3.5 }),
    ).toThrow();
  });
});

describe("validate_consume IPC schemas", () => {
  test("params require channel and secret", () => {
    const params = {
      channel: "phone",
      secret: "123456",
      actorExternalUserId: "+15551234567",
      actorChatId: "+15551234567",
    };
    expect(ValidateConsumeSessionIpcParamsSchema.parse(params)).toEqual(params);
    expect(() =>
      ValidateConsumeSessionIpcParamsSchema.parse({
        channel: "phone",
        secret: "",
        actorExternalUserId: "x",
        actorChatId: "y",
      }),
    ).toThrow();
  });

  test("response discriminates success from failure", () => {
    const success = { success: true, verificationType: "guardian" } as const;
    expect(ValidateConsumeSessionIpcResponseSchema.parse(success)).toEqual(
      success,
    );
    const failure = {
      success: false,
      reason: "invalid_or_expired_code",
    } as const;
    expect(ValidateConsumeSessionIpcResponseSchema.parse(failure)).toEqual(
      failure,
    );
    expect(() =>
      ValidateConsumeSessionIpcResponseSchema.parse({
        success: true,
        reason: "invalid_or_expired_code",
      }),
    ).toThrow();
  });
});
