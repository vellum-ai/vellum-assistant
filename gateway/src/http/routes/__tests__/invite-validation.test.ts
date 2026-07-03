import { describe, it, expect } from "bun:test";

import {
  parseCreateInviteBody,
  parseRedeemInviteBody,
  parseListInviteQuery,
} from "../invite-validation.js";

describe("parseCreateInviteBody", () => {
  it("accepts a minimal valid body", () => {
    const result = parseCreateInviteBody({
      contactId: "contact-1",
      sourceChannel: "telegram",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.contactId).toBe("contact-1");
      expect(result.value.sourceChannel).toBe("telegram");
    }
  });

  it("rejects a missing sourceChannel", () => {
    const result = parseCreateInviteBody({ contactId: "contact-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("sourceChannel");
    }
  });

  it("rejects an empty/whitespace sourceChannel", () => {
    const result = parseCreateInviteBody({
      contactId: "contact-1",
      sourceChannel: "   ",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("sourceChannel");
    }
  });

  it("accepts the full set of optional fields", () => {
    const result = parseCreateInviteBody({
      contactId: "contact-1",
      sourceChannel: "phone",
      note: "hello",
      maxUses: 3,
      expiresInMs: 60_000,
      expectedExternalUserId: "+12025550100",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourceChannel).toBe("phone");
      expect(result.value.maxUses).toBe(3);
    }
  });

  it("rejects a missing contactId", () => {
    const result = parseCreateInviteBody({ note: "no contact" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("contactId");
    }
  });

  it("rejects an empty/whitespace contactId", () => {
    const result = parseCreateInviteBody({ contactId: "   " });
    expect(result.ok).toBe(false);
  });

  it("rejects a negative maxUses", () => {
    const result = parseCreateInviteBody({
      contactId: "contact-1",
      sourceChannel: "telegram",
      maxUses: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("maxUses");
    }
  });

  it("rejects a zero expiresInMs", () => {
    const result = parseCreateInviteBody({
      contactId: "contact-1",
      sourceChannel: "telegram",
      expiresInMs: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("expiresInMs");
    }
  });

  it("rejects a non-object body", () => {
    const result = parseCreateInviteBody("nope");
    expect(result.ok).toBe(false);
  });
});

describe("parseRedeemInviteBody", () => {
  it("discriminates the voice-code path", () => {
    const result = parseRedeemInviteBody({
      code: "1234",
      callerExternalUserId: "+12025550101",
      assistantId: "asst-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("voice");
      if (result.value.kind === "voice") {
        expect(result.value.code).toBe("1234");
        expect(result.value.callerExternalUserId).toBe("+12025550101");
      }
    }
  });

  it("rejects a voice-code body missing callerExternalUserId", () => {
    const result = parseRedeemInviteBody({ code: "1234" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("callerExternalUserId");
    }
  });

  it("discriminates the token path", () => {
    const result = parseRedeemInviteBody({
      token: "tok-abc",
      externalUserId: "user-1",
      sourceChannel: "telegram",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("token");
      if (result.value.kind === "token") {
        expect(result.value.token).toBe("tok-abc");
        expect(result.value.sourceChannel).toBe("telegram");
      }
    }
  });

  it("rejects a token body missing sourceChannel", () => {
    const result = parseRedeemInviteBody({ token: "tok-abc" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("sourceChannel");
    }
  });

  it("rejects a token body with empty/whitespace sourceChannel", () => {
    const result = parseRedeemInviteBody({
      token: "tok-abc",
      sourceChannel: "   ",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("sourceChannel");
    }
  });

  it("rejects a body with neither code nor token", () => {
    const result = parseRedeemInviteBody({ sourceChannel: "telegram" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("token");
    }
  });
});

describe("parseListInviteQuery", () => {
  it("returns an empty object for an empty query", () => {
    const result = parseListInviteQuery(new URLSearchParams());
    expect(result).toEqual({});
  });

  it("extracts sourceChannel and status when present", () => {
    const result = parseListInviteQuery(
      new URLSearchParams({ sourceChannel: "phone", status: "active" }),
    );
    expect(result).toEqual({ sourceChannel: "phone", status: "active" });
  });
});
