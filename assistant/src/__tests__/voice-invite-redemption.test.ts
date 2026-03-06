import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "voice-invite-redemption-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { findContactChannel } from "../contacts/contact-store.js";
import { upsertContactChannel } from "../contacts/contacts-write.js";
import { getSqlite, initializeDb, resetDb } from "../memory/db.js";
import { createInvite, revokeInvite } from "../memory/invite-store.js";
import { redeemVoiceInviteCode } from "../runtime/invite-redemption-service.js";
import { generateVoiceCode, hashVoiceCode } from "../util/voice-code.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

function resetTables() {
  getSqlite().run("DELETE FROM assistant_ingress_invites");
  getSqlite().run("DELETE FROM contact_channels");
  getSqlite().run("DELETE FROM contacts");
}

// ---------------------------------------------------------------------------
// generateVoiceCode
// ---------------------------------------------------------------------------

describe("generateVoiceCode", () => {
  test("generates a code with the default 6 digits", () => {
    const code = generateVoiceCode();
    expect(code.length).toBe(6);
    expect(/^\d{6}$/.test(code)).toBe(true);
  });

  test("generates a code with the requested digit count", () => {
    for (const digits of [4, 5, 6, 7, 8, 9, 10]) {
      const code = generateVoiceCode(digits);
      expect(code.length).toBe(digits);
      expect(new RegExp(`^\\d{${digits}}$`).test(code)).toBe(true);
    }
  });

  test("throws for digit count below 4", () => {
    expect(() => generateVoiceCode(3)).toThrow(/between 4 and 10/);
  });

  test("throws for digit count above 10", () => {
    expect(() => generateVoiceCode(11)).toThrow(/between 4 and 10/);
  });

  test("produces different codes across multiple calls (randomness)", () => {
    // Generate many codes and check that we don't get the same one every time.
    // With 6 digits there are 900,000 possibilities, so getting 10 identical
    // codes would be astronomically unlikely.
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      codes.add(generateVoiceCode());
    }
    // At least 2 distinct values in 10 tries
    expect(codes.size).toBeGreaterThanOrEqual(2);
  });

  test("generated code is within the valid numeric range", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateVoiceCode(6);
      const num = parseInt(code, 10);
      // 6 digits: range [100000, 999999]
      expect(num).toBeGreaterThanOrEqual(100000);
      expect(num).toBeLessThanOrEqual(999999);
    }
  });
});

// ---------------------------------------------------------------------------
// hashVoiceCode
// ---------------------------------------------------------------------------

describe("hashVoiceCode", () => {
  test("produces a deterministic hash", () => {
    const code = "123456";
    const hash1 = hashVoiceCode(code);
    const hash2 = hashVoiceCode(code);
    expect(hash1).toBe(hash2);
  });

  test("produces a hex-encoded SHA-256 hash (64 chars)", () => {
    const hash = hashVoiceCode("654321");
    expect(hash.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  test("different codes produce different hashes", () => {
    const hash1 = hashVoiceCode("111111");
    const hash2 = hashVoiceCode("222222");
    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// redeemVoiceInviteCode
// ---------------------------------------------------------------------------

describe("redeemVoiceInviteCode", () => {
  beforeEach(resetTables);

  /**
   * Helper: create a voice invite with a known code and return the
   * invite record plus the plaintext code.
   */
  function createVoiceInvite(
    opts: {
      callerPhone?: string;
      maxUses?: number;
      expiresInMs?: number;
      voiceCodeDigits?: number;
      assistantId?: string;
    } = {},
  ) {
    const digits = opts.voiceCodeDigits ?? 6;
    const code = generateVoiceCode(digits);
    const codeHash = hashVoiceCode(code);

    const { invite } = createInvite({
      sourceChannel: "voice",
      maxUses: opts.maxUses ?? 1,
      expiresInMs: opts.expiresInMs,
      expectedExternalUserId: opts.callerPhone ?? "+15551234567",
      voiceCodeHash: codeHash,
      voiceCodeDigits: digits,
    });

    return { invite, code };
  }

  test("happy path: correct caller + correct code redeems successfully", () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone });

    const result = redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "voice",
      code,
    });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      type: "redeemed",
      memberId: expect.any(String),
      inviteId: expect.any(String),
    });
  });

  test("marks channel as verified via invite on voice redemption", () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone });

    const result = redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "voice",
      code,
    });

    expect(result.ok).toBe(true);

    const channelResult = findContactChannel({
      channelType: "voice",
      externalUserId: phone,
    });

    expect(channelResult).not.toBeNull();
    expect(channelResult!.channel.verifiedAt).toBeGreaterThan(0);
    expect(channelResult!.channel.verifiedVia).toBe("invite");
    expect(channelResult!.channel.status).toBe("active");
  });

  test("wrong caller identity fails with generic error", () => {
    const { code } = createVoiceInvite({ callerPhone: "+15551234567" });

    const result = redeemVoiceInviteCode({
      callerExternalUserId: "+19999999999",
      sourceChannel: "voice",
      code,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("wrong code fails with generic error", () => {
    createVoiceInvite({ callerPhone: "+15551234567" });

    const result = redeemVoiceInviteCode({
      callerExternalUserId: "+15551234567",
      sourceChannel: "voice",
      code: "000000",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("expired invite fails", () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone, expiresInMs: -1 });

    const result = redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "voice",
      code,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("max uses exhausted fails", () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone, maxUses: 1 });

    // First redemption succeeds
    const first = redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "voice",
      code,
    });
    expect(first.ok).toBe(true);

    // Second redemption fails — max uses exhausted
    const second = redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "voice",
      code,
    });
    expect(second).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("revoked invite fails", () => {
    const phone = "+15551234567";
    const { invite, code } = createVoiceInvite({ callerPhone: phone });

    revokeInvite(invite.id);

    const result = redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "voice",
      code,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("voice-only invite cannot be redeemed if sourceChannel on invite is not voice", () => {
    // Create a non-voice invite with voice code metadata to simulate a
    // hypothetical misconfiguration. The redemption service filters by
    // sourceChannel='voice', so non-voice invites are invisible.
    const code = generateVoiceCode(6);
    const codeHash = hashVoiceCode(code);

    createInvite({
      sourceChannel: "telegram",
      maxUses: 1,
      expectedExternalUserId: "+15551234567",
      voiceCodeHash: codeHash,
      voiceCodeDigits: 6,
    });

    const result = redeemVoiceInviteCode({
      callerExternalUserId: "+15551234567",
      sourceChannel: "voice",
      code,
    });

    // findActiveVoiceInvites filters by sourceChannel='voice', so the
    // telegram invite won't be found.
    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("already-member caller gets already_member outcome", () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone });

    // Pre-create an active member for this phone on voice channel
    upsertContactChannel({
      sourceChannel: "voice",
      externalUserId: phone,
      status: "active",
      policy: "allow",
    });

    const result = redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "voice",
      code,
    });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      type: "already_member",
      memberId: expect.any(String),
    });
  });

  test("blocked member gets generic failure to avoid leaking membership status", () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone });

    upsertContactChannel({
      sourceChannel: "voice",
      externalUserId: phone,
      status: "blocked",
      policy: "deny",
    });

    const result = redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "voice",
      code,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("empty callerExternalUserId fails", () => {
    const result = redeemVoiceInviteCode({
      callerExternalUserId: "",
      sourceChannel: "voice",
      code: "123456",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });
});
