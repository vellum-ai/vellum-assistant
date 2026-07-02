import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianDelivery } from "@vellumai/gateway-client";

import type { ContactChannel } from "../../../contacts/types.js";

let mockGuardians: GuardianDelivery[] | null = null;
let mockBinding: {
  guardianExternalUserId: string;
  guardianDeliveryChatId: string;
} | null = null;
let mockContactChannel: { channel: ContactChannel } | null = null;
let mockChannel: ContactChannel | null = null;
let mockGwContactChannels: Array<{
  id: string;
  status: string;
  verifiedAt: number | null;
}> | null = null;
let ipcCalls: Array<{ method: string; payload: unknown }> = [];

mock.module("../../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async (input?: { channelTypes?: string[] }) => {
    if (mockGuardians == null) return null;
    if (!input?.channelTypes) return mockGuardians;
    return mockGuardians.filter((g) =>
      input.channelTypes!.includes(g.channelType),
    );
  },
  guardianForChannel: (list: GuardianDelivery[], channelType: string) =>
    list.find((g) => g.channelType === channelType && g.status === "active"),
}));

mock.module("../../../contacts/contact-store.js", () => ({
  findContactChannel: () => mockContactChannel,
  getChannelById: () => mockChannel,
  getContact: () => ({ id: "contact-1", displayName: "Pat" }),
}));

mock.module("../../../contacts/notify-contacts-changed.js", () => ({
  notifyContactsChanged: () => {},
}));

mock.module("../../../ipc/gateway-client.js", () => ({
  ipcCallPersistent: async (method: string, payload: unknown) => {
    ipcCalls.push({ method, payload });
    if (method === "contacts_get_rich") {
      if (mockGwContactChannels == null) return { ok: true, contact: null };
      return {
        ok: true,
        contact: {
          id: "contact-1",
          displayName: "Pat",
          role: "contact",
          interactionCount: 0,
          createdAt: 0,
          updatedAt: 0,
          channels: mockGwContactChannels.map((c) => ({
            id: c.id,
            contactId: "contact-1",
            type: "telegram",
            address: "user-123",
            isPrimary: true,
            externalUserId: null,
            status: c.status,
            policy: "allow",
            verifiedAt: c.verifiedAt,
            verifiedVia: null,
            lastSeenAt: null,
            interactionCount: 0,
            lastInteraction: null,
            revokedReason: null,
            blockedReason: null,
          })),
        },
      };
    }
    return {
      ok: true,
      didWrite: true,
      channel: {
        id: "ch-1",
        contactId: "contact-1",
        type: "telegram",
        address: "user-123",
        status: "revoked",
        revokedReason: "guardian_binding_revoked",
      },
    };
  },
  ipcCall: async () => null,
}));

mock.module("../../../runtime/channel-verification-service.js", () => ({
  getGuardianBinding: () => mockBinding,
  revokePendingSessions: () => {},
  createOutboundSession: () => ({
    sessionId: "sess",
    secret: "code",
    expiresAt: Date.now() + 1000,
  }),
  countRecentSendsToDestination: () => 0,
  isGuardianBoundForChannel: async () => false,
  updateSessionDelivery: () => {},
}));

mock.module("../../../runtime/verification-outbound-actions.js", () => ({
  cancelOutbound: () => {},
  deliverVerificationEmail: () => {},
  deliverVerificationSlack: () => {},
  deliverVerificationTelegram: () => {},
  DESTINATION_RATE_WINDOW_MS: 1000,
  MAX_SENDS_PER_DESTINATION_WINDOW: 5,
  normalizeTelegramDestination: (d: string) => d,
  resendOutbound: () => ({}),
  startOutbound: async () => ({}),
}));

import {
  revokeVerificationForChannel,
  verifyTrustedContact,
} from "../config-channels.js";

function channel(overrides: Partial<ContactChannel> = {}): ContactChannel {
  return {
    id: "ch-1",
    contactId: "contact-1",
    type: "telegram",
    address: "user-123",
    isPrimary: true,
    externalChatId: "chat-123",
    updatedAt: null,
    createdAt: 0,
    ...overrides,
  };
}

function delivery(overrides: Partial<GuardianDelivery> = {}): GuardianDelivery {
  return {
    channelType: "telegram",
    contactId: "contact-1",
    address: "user-123",
    externalChatId: "chat-123",
    status: "active",
    verifiedAt: 1700000000,
    ...overrides,
  };
}

describe("revokeVerificationForChannel", () => {
  beforeEach(() => {
    mockGuardians = null;
    mockBinding = {
      guardianExternalUserId: "user-123",
      guardianDeliveryChatId: "chat-123",
    };
    mockContactChannel = { channel: channel() };
    ipcCalls = [];
  });

  test("relays mark_channel_revoked when the gateway delivery is live", async () => {
    mockGuardians = [delivery({ status: "active" })];
    await revokeVerificationForChannel("telegram");
    expect(ipcCalls.map((c) => c.method)).toContain("mark_channel_revoked");
  });

  test("skips a redundant revoke when the gateway delivery is already revoked", async () => {
    // The gateway (SoT) says revoked — the gate must follow the gateway and
    // not relay regardless of local state.
    mockContactChannel = { channel: channel() };
    mockGuardians = [delivery({ status: "revoked" })];
    await revokeVerificationForChannel("telegram");
    expect(ipcCalls.map((c) => c.method)).not.toContain("mark_channel_revoked");
  });

  test("skips the relay when the gateway has no delivery for the channel", async () => {
    mockGuardians = [];
    await revokeVerificationForChannel("telegram");
    expect(ipcCalls.map((c) => c.method)).not.toContain("mark_channel_revoked");
  });

  test("skips the relay when the gateway is unreachable", async () => {
    mockGuardians = null;
    await revokeVerificationForChannel("telegram");
    expect(ipcCalls.map((c) => c.method)).not.toContain("mark_channel_revoked");
  });
});

describe("verifyTrustedContact already-verified gate", () => {
  beforeEach(() => {
    mockGuardians = null;
    mockGwContactChannels = null;
    mockChannel = channel();
  });

  test("short-circuits when the gateway contact channel is active and verified", async () => {
    // Arbitrary trusted contact (non-guardian) — read from the contact-channel
    // gateway read, which covers all contacts.
    mockGwContactChannels = [
      { id: "ch-1", status: "active", verifiedAt: 1700000000 },
    ];
    const result = await verifyTrustedContact("ch-1", "assistant-1");
    expect(result.success).toBe(false);
    expect(result.error).toBe("already_verified");
  });

  test("does not short-circuit when the gateway channel has no verifiedAt", async () => {
    // The gateway channel is unverified — proceed regardless of local state.
    mockChannel = channel();
    mockGwContactChannels = [
      { id: "ch-1", status: "pending", verifiedAt: null },
    ];
    const result = await verifyTrustedContact("ch-1", "assistant-1");
    expect(result.error).not.toBe("already_verified");
  });

  test("does not short-circuit when the gateway has no matching channel", async () => {
    mockGwContactChannels = [];
    const result = await verifyTrustedContact("ch-1", "assistant-1");
    expect(result.error).not.toBe("already_verified");
  });
});
