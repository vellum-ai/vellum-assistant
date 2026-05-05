import { describe, test, expect } from "bun:test";

import { parseVerificationCode, hashVerificationSecret } from "../verification/code-parsing.js";
import { canonicalizeInboundIdentity } from "../verification/identity.js";
import { checkIdentityMatch } from "../verification/identity-match.js";
import type { VerificationSession } from "../verification/session-helpers.js";

// ---------------------------------------------------------------------------
// Code parsing
// ---------------------------------------------------------------------------

describe("parseVerificationCode", () => {
  test("accepts 6-digit numeric code", () => {
    expect(parseVerificationCode("123456")).toBe("123456");
  });

  test("accepts 64-char hex string", () => {
    const hex = "a".repeat(64);
    expect(parseVerificationCode(hex)).toBe(hex);
  });

  test("strips mrkdwn formatting", () => {
    expect(parseVerificationCode("*123456*")).toBe("123456");
    expect(parseVerificationCode("_123456_")).toBe("123456");
    expect(parseVerificationCode("`123456`")).toBe("123456");
    expect(parseVerificationCode("~123456~")).toBe("123456");
  });

  test("rejects non-code messages", () => {
    expect(parseVerificationCode("hello")).toBeUndefined();
    expect(parseVerificationCode("12345")).toBeUndefined(); // too short
    expect(parseVerificationCode("1234567")).toBeUndefined(); // too long for numeric
    expect(parseVerificationCode("verify 123456")).toBeUndefined(); // not bare
  });

  test("trims whitespace", () => {
    expect(parseVerificationCode("  123456  ")).toBe("123456");
  });
});

describe("hashVerificationSecret", () => {
  test("produces a 64-char hex sha256", () => {
    const hash = hashVerificationSecret("test");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic", () => {
    expect(hashVerificationSecret("abc")).toBe(hashVerificationSecret("abc"));
  });
});

// ---------------------------------------------------------------------------
// Identity canonicalization
// ---------------------------------------------------------------------------

describe("canonicalizeInboundIdentity", () => {
  test("phone channel: normalizes US 10-digit to E.164", () => {
    expect(canonicalizeInboundIdentity("phone", "5551234567")).toBe("+15551234567");
    expect(canonicalizeInboundIdentity("whatsapp", "5551234567")).toBe("+15551234567");
  });

  test("phone channel: passes through already-E.164", () => {
    expect(canonicalizeInboundIdentity("phone", "+15551234567")).toBe("+15551234567");
  });

  test("phone channel: strips formatting", () => {
    expect(canonicalizeInboundIdentity("phone", "(555) 123-4567")).toBe("+15551234567");
  });

  test("non-phone channel: trims only", () => {
    expect(canonicalizeInboundIdentity("telegram", "  user123  ")).toBe("user123");
    expect(canonicalizeInboundIdentity("slack", "U12345")).toBe("U12345");
  });

  test("returns null for empty/whitespace", () => {
    expect(canonicalizeInboundIdentity("telegram", "")).toBeNull();
    expect(canonicalizeInboundIdentity("telegram", "   ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Identity matching
// ---------------------------------------------------------------------------

describe("checkIdentityMatch", () => {
  const baseSession: VerificationSession = {
    id: "sess-1",
    challengeHash: "abc",
    expiresAt: Date.now() + 60_000,
    status: "pending",
    verificationPurpose: "guardian",
    expectedExternalUserId: null,
    expectedChatId: null,
    expectedPhoneE164: null,
    identityBindingStatus: "bound",
    codeDigits: 6,
    maxAttempts: 3,
  };

  test("matches when session has no expected identity (inbound)", () => {
    expect(checkIdentityMatch(baseSession, "any-user", "any-chat")).toBe(true);
  });

  test("matches when binding status is not bound", () => {
    const session = { ...baseSession, expectedExternalUserId: "user-1", identityBindingStatus: "pending_bootstrap" };
    expect(checkIdentityMatch(session, "different-user", "any-chat")).toBe(true);
  });

  test("matches by phone E.164", () => {
    const session = { ...baseSession, expectedPhoneE164: "+15551234567" };
    expect(checkIdentityMatch(session, "+15551234567", "chat-1")).toBe(true);
  });

  test("rejects phone mismatch", () => {
    const session = { ...baseSession, expectedPhoneE164: "+15551234567" };
    expect(checkIdentityMatch(session, "+19999999999", "chat-1")).toBe(false);
  });

  test("matches by externalUserId when expectedChatId is set", () => {
    const session = { ...baseSession, expectedExternalUserId: "user-1", expectedChatId: "chat-1" };
    expect(checkIdentityMatch(session, "user-1", "different-chat")).toBe(true);
  });

  test("matches by chatId alone when no expectedExternalUserId", () => {
    const session = { ...baseSession, expectedChatId: "chat-1" };
    expect(checkIdentityMatch(session, "any-user", "chat-1")).toBe(true);
  });

  test("rejects chatId-only mismatch", () => {
    const session = { ...baseSession, expectedChatId: "chat-1" };
    expect(checkIdentityMatch(session, "any-user", "wrong-chat")).toBe(false);
  });
});


