import { beforeEach, describe, expect, mock, test } from "bun:test";

type InboundTrustReadResult =
  | {
      ok: true;
      verdict: {
        trustClass: string;
        canonicalSenderId: string | null;
        contactId?: string;
        status?: string;
        resolutionFailed?: boolean;
      };
      admissionPolicy: string | null;
    }
  | { ok: false };

let nextRead: InboundTrustReadResult = { ok: false };

mock.module("../calls/inbound-trust-reader.js", () => ({
  readInboundTrust: async () => nextRead,
}));

import {
  PluginTurnNotAdmittedError,
  resolvePluginChannelTurnTrust,
} from "./plugin-channel-turn-trust.js";

const CHANNEL = {
  sourceChannel: "plugin" as const,
  externalChatId: "imessage:+12025550142",
  externalUserId: "imessage:+12025550142",
  displayName: "Ada",
};

beforeEach(() => {
  nextRead = { ok: false };
});

describe("resolvePluginChannelTurnTrust", () => {
  test("returns the gateway verdict as the turn trust context", async () => {
    nextRead = {
      ok: true,
      verdict: {
        trustClass: "trusted_contact",
        canonicalSenderId: "imessage:+12025550142",
        contactId: "c-ada",
        status: "active",
      },
      admissionPolicy: "trusted_contacts",
    };

    const trust = await resolvePluginChannelTurnTrust(CHANNEL);
    expect(trust.trustClass).toBe("trusted_contact");
    expect(trust.sourceChannel).toBe("plugin");
    expect(trust.requesterChatId).toBe(CHANNEL.externalChatId);
  });

  test("fails closed when the gateway could not vouch for the sender", async () => {
    nextRead = {
      ok: true,
      verdict: {
        trustClass: "unknown",
        canonicalSenderId: null,
        resolutionFailed: true,
      },
      admissionPolicy: "strangers",
    };

    await expect(resolvePluginChannelTurnTrust(CHANNEL)).rejects.toMatchObject({
      name: "PluginTurnNotAdmittedError",
      reason: "trust_resolution_failed",
    });
  });

  test("fails closed when the gateway trust read fails", async () => {
    nextRead = { ok: false };
    await expect(resolvePluginChannelTurnTrust(CHANNEL)).rejects.toMatchObject({
      name: "PluginTurnNotAdmittedError",
      reason: "trust_resolution_failed",
    });
  });

  test("rejects a sender below the channel admission floor", async () => {
    nextRead = {
      ok: true,
      verdict: { trustClass: "unknown", canonicalSenderId: null },
      admissionPolicy: "guardian_only",
    };

    await expect(resolvePluginChannelTurnTrust(CHANNEL)).rejects.toEqual(
      expect.objectContaining({
        name: "PluginTurnNotAdmittedError",
        reason: "admission_policy_guardian_only",
      }),
    );
  });

  test("rejects a blocked member regardless of floor", async () => {
    nextRead = {
      ok: true,
      verdict: {
        trustClass: "trusted_contact",
        canonicalSenderId: "imessage:+12025550142",
        contactId: "c-ada",
        status: "blocked",
      },
      admissionPolicy: "strangers",
    };

    await expect(resolvePluginChannelTurnTrust(CHANNEL)).rejects.toMatchObject({
      name: "PluginTurnNotAdmittedError",
      reason: "member_blocked",
    });
  });

  test("admits when the gateway reports no admission policy", async () => {
    nextRead = {
      ok: true,
      verdict: { trustClass: "unknown", canonicalSenderId: null },
      admissionPolicy: null,
    };

    const trust = await resolvePluginChannelTurnTrust(CHANNEL);
    expect(trust.trustClass).toBe("unknown");
  });

  test("PluginTurnNotAdmittedError names the deny reason", () => {
    const err = new PluginTurnNotAdmittedError("admission_policy_no_one");
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe("admission_policy_no_one");
    expect(err.message).toContain("admission_policy_no_one");
  });
});
