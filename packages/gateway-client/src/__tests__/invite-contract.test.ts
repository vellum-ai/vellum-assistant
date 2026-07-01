/**
 * Tests for the shared invite contract.
 *
 * The pinned hash vectors below define the hash compatibility contract:
 * `hashInviteToken` and `hashInviteCode` must produce exactly these outputs
 * because invite hashes already stored in the assistant and gateway DBs were
 * produced with them. Do not update the vectors to "fix" a failure — a
 * mismatch means the hash scheme broke.
 */

import { describe, expect, test } from "bun:test";

import {
  ActiveVoiceInviteSchema,
  generateInviteCode,
  generateInviteToken,
  GetActiveVoiceInviteRequestSchema,
  hashInviteCode,
  hashInviteToken,
  INVITE_CODE_REDEMPTION_CHANNELS,
  InviteRedeemedNotificationSchema,
  InviteRedemptionOutcomeSchema,
  isInviteCodeRedemptionEnabled,
  RedeemInviteByCodeRequestSchema,
  RedeemInviteByTokenRequestSchema,
  RedeemVoiceInviteRequestSchema,
  type InviteRedemptionOutcome,
} from "../invite-contract.js";

describe("hash helpers — pinned compatibility vectors", () => {
  test("hashInviteToken matches invite-store.ts hashToken output", () => {
    expect(hashInviteToken("test-raw-token")).toBe(
      "7ef58e99b3406554f5ce0c0055b8ed3ea4db2c8a36613092d644c57c6a033330",
    );
    expect(hashInviteToken("AbC123_-xyz")).toBe(
      "860c47c13bb8d13decd6815b20be7de8cf11597e4b704af58b00048e90a5a337",
    );
  });

  test("hashInviteCode matches voice-code.ts hashVoiceCode output", () => {
    expect(hashInviteCode("123456")).toBe(
      "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
    );
    expect(hashInviteCode("0000")).toBe(
      "9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0",
    );
    expect(hashInviteCode("987654321")).toBe(
      "8a9bcf1e51e812d0af8465a8dbcc9f741064bf0af3b3d08e6b0246437c19f7fb",
    );
  });
});

describe("generateInviteToken", () => {
  test("produces a 43-character base64url token", () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("produces unique tokens", () => {
    expect(generateInviteToken()).not.toBe(generateInviteToken());
  });
});

describe("generateInviteCode", () => {
  test("defaults to 6 digits with no leading zero", () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[1-9]\d{5}$/);
  });

  test("honors the digit count at both bounds", () => {
    expect(generateInviteCode(4)).toMatch(/^[1-9]\d{3}$/);
    expect(generateInviteCode(10)).toMatch(/^[1-9]\d{9}$/);
  });

  test("rejects out-of-range digit counts", () => {
    expect(() => generateInviteCode(3)).toThrow();
    expect(() => generateInviteCode(11)).toThrow();
  });
});

describe("invite-code channel gating", () => {
  test("allows exactly the redemption-enabled channels", () => {
    expect([...INVITE_CODE_REDEMPTION_CHANNELS].sort()).toEqual([
      "email",
      "slack",
      "telegram",
      "whatsapp",
    ]);
  });

  test("isInviteCodeRedemptionEnabled matches the allowlist", () => {
    for (const channel of ["telegram", "whatsapp", "slack", "email"]) {
      expect(isInviteCodeRedemptionEnabled(channel)).toBe(true);
    }
    for (const channel of ["vellum", "platform", "phone", "a2a", "nope"]) {
      expect(isInviteCodeRedemptionEnabled(channel)).toBe(false);
    }
  });
});

const fullOutcome: InviteRedemptionOutcome = {
  inviteId: "inv-1",
  contactId: "c-1",
  sourceChannel: "telegram",
  memberExternalUserId: "tg-user-1",
  memberExternalChatId: "tg-chat-1",
  displayName: "Member Name",
  username: "member",
  sourceConversationId: "conv-1",
  result: "redeemed",
};

describe("InviteRedemptionOutcomeSchema", () => {
  test("round-trips a fully-populated outcome", () => {
    expect(InviteRedemptionOutcomeSchema.parse(fullOutcome)).toEqual(
      fullOutcome,
    );
  });

  test("parses a minimal outcome", () => {
    const minimal = {
      inviteId: "inv-1",
      contactId: "c-1",
      sourceChannel: "slack",
      memberExternalUserId: "U123",
      result: "already_member",
    } satisfies InviteRedemptionOutcome;
    expect(InviteRedemptionOutcomeSchema.parse(minimal)).toEqual(minimal);
  });

  test("rejects an invalid result", () => {
    expect(() =>
      InviteRedemptionOutcomeSchema.parse({
        ...fullOutcome,
        result: "definitely_not_a_result",
      }),
    ).toThrow();
  });

  test("InviteRedeemedNotificationSchema carries the outcome verbatim", () => {
    expect(InviteRedeemedNotificationSchema.parse(fullOutcome)).toEqual(
      fullOutcome,
    );
  });
});

describe("invite IPC request schemas", () => {
  test("RedeemInviteByCodeRequestSchema round-trips full and minimal requests", () => {
    const full = {
      code: "123456",
      sourceChannel: "telegram",
      externalUserId: "tg-user-1",
      externalChatId: "tg-chat-1",
      displayName: "Member Name",
      username: "member",
    };
    expect(RedeemInviteByCodeRequestSchema.parse(full)).toEqual(full);
    const minimal = { code: "123456", sourceChannel: "email" };
    expect(RedeemInviteByCodeRequestSchema.parse(minimal)).toEqual(minimal);
    expect(() =>
      RedeemInviteByCodeRequestSchema.parse({ code: "", sourceChannel: "" }),
    ).toThrow();
  });

  test("RedeemInviteByTokenRequestSchema round-trips full and minimal requests", () => {
    const full = {
      rawToken: "raw-token",
      sourceChannel: "slack",
      externalUserId: "U123",
      externalChatId: "D456",
      displayName: "Member Name",
      username: "member",
    };
    expect(RedeemInviteByTokenRequestSchema.parse(full)).toEqual(full);
    const minimal = { rawToken: "raw-token", sourceChannel: "slack" };
    expect(RedeemInviteByTokenRequestSchema.parse(minimal)).toEqual(minimal);
    expect(() =>
      RedeemInviteByTokenRequestSchema.parse({ sourceChannel: "slack" }),
    ).toThrow();
  });

  test("RedeemVoiceInviteRequestSchema requires caller and code", () => {
    const request = { callerExternalUserId: "+15555550100", code: "123456" };
    expect(RedeemVoiceInviteRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      RedeemVoiceInviteRequestSchema.parse({ callerExternalUserId: "+1555" }),
    ).toThrow();
  });

  test("GetActiveVoiceInviteRequestSchema requires the caller", () => {
    const request = { callerExternalUserId: "+15555550100" };
    expect(GetActiveVoiceInviteRequestSchema.parse(request)).toEqual(request);
    expect(() => GetActiveVoiceInviteRequestSchema.parse({})).toThrow();
  });
});

describe("ActiveVoiceInviteSchema", () => {
  test("round-trips populated and null display fields", () => {
    const populated = {
      inviteId: "inv-1",
      inviteeName: "Friend",
      guardianName: "Guardian",
      codeDigits: 6,
    };
    expect(ActiveVoiceInviteSchema.parse(populated)).toEqual(populated);
    const anonymous = {
      inviteId: "inv-2",
      inviteeName: null,
      guardianName: null,
      codeDigits: 6,
    };
    expect(ActiveVoiceInviteSchema.parse(anonymous)).toEqual(anonymous);
  });

  test("rejects a non-integer codeDigits", () => {
    expect(() =>
      ActiveVoiceInviteSchema.parse({
        inviteId: "inv-1",
        inviteeName: null,
        guardianName: null,
        codeDigits: 6.5,
      }),
    ).toThrow();
  });
});
