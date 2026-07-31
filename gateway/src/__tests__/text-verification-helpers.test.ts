import { describe, test, expect } from "bun:test";

import {
  extractEmailReplyBody,
  parseVerificationCode,
  hashVerificationSecret,
} from "../verification/code-parsing.js";
import { canonicalizeInboundIdentity } from "../verification/identity.js";
import type { IdentityMatchSession } from "../verification/identity-match.js";
import { checkIdentityMatch } from "../verification/identity-match.js";

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

describe("extractEmailReplyBody", () => {
  test("returns bare code from plain reply", () => {
    expect(extractEmailReplyBody("421063")).toBe("421063");
  });

  test("strips Gmail-style quoted reply", () => {
    const body =
      "421063\n\nOn Mon, Jun 9, 2026 at 2:30 PM Vellum Assistant wrote:\n> Your verification code is: 421063";
    expect(extractEmailReplyBody(body)).toBe("421063");
  });

  test("strips standard > quoted lines", () => {
    const body = "421063\n\n> Original message content\n> More quoted text";
    expect(extractEmailReplyBody(body)).toBe("421063");
  });

  test("strips RFC 3676 signature delimiter", () => {
    const body = "421063\n\n-- \nJohn Doe\njohn@example.com";
    expect(extractEmailReplyBody(body)).toBe("421063");
  });

  test("strips bare -- signature delimiter", () => {
    const body = "421063\n--\nJohn Doe";
    expect(extractEmailReplyBody(body)).toBe("421063");
  });

  test("strips Outlook original message header", () => {
    const body = "421063\n\n-----Original Message-----\nFrom: Vellum Assistant";
    expect(extractEmailReplyBody(body)).toBe("421063");
  });

  test("strips Outlook From:/Sent: block", () => {
    const body =
      "421063\n\nFrom: Vellum Assistant <hi@credence.vellum.me>\nSent: Monday, June 9, 2026";
    expect(extractEmailReplyBody(body)).toBe("421063");
  });

  test("handles empty body", () => {
    expect(extractEmailReplyBody("")).toBe("");
  });

  test("handles body with only quoted text", () => {
    expect(extractEmailReplyBody("> quoted text only")).toBe("");
  });

  test("preserves multiline fresh content before quote", () => {
    const body = "line 1\nline 2\n\nOn Jun 9 wrote:\n> quote";
    expect(extractEmailReplyBody(body)).toBe("line 1\nline 2");
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
    expect(canonicalizeInboundIdentity("phone", "2125550100")).toBe(
      "+12125550100",
    );
    expect(canonicalizeInboundIdentity("whatsapp", "2125550100")).toBe(
      "+12125550100",
    );
  });

  test("phone channel: passes through already-E.164", () => {
    expect(canonicalizeInboundIdentity("phone", "+12125550100")).toBe(
      "+12125550100",
    );
  });

  test("phone channel: strips formatting", () => {
    expect(canonicalizeInboundIdentity("phone", "(212) 555-0100")).toBe(
      "+12125550100",
    );
  });

  test("non-phone channel: trims only", () => {
    expect(canonicalizeInboundIdentity("telegram", "  user123  ")).toBe(
      "user123",
    );
    expect(canonicalizeInboundIdentity("slack", "U12345")).toBe("U12345");
  });

  test("email channel: lowercases address", () => {
    expect(canonicalizeInboundIdentity("email", "Alice@example.com")).toBe(
      "alice@example.com",
    );
    expect(canonicalizeInboundIdentity("email", "  USER@example.org  ")).toBe(
      "user@example.org",
    );
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
  const baseSession: IdentityMatchSession = {
    expectedExternalUserId: null,
    expectedChatId: null,
    expectedPhoneE164: null,
    identityBindingStatus: "bound",
  };

  test("matches when session has no expected identity (inbound)", () => {
    expect(checkIdentityMatch(baseSession, "any-user", "any-chat")).toBe(true);
  });

  test("matches when binding status is not bound", () => {
    const session: IdentityMatchSession = {
      ...baseSession,
      expectedExternalUserId: "user-1",
      identityBindingStatus: "pending_bootstrap",
    };
    expect(checkIdentityMatch(session, "different-user", "any-chat")).toBe(
      true,
    );
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
    const session = {
      ...baseSession,
      expectedExternalUserId: "user-1",
      expectedChatId: "chat-1",
    };
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
