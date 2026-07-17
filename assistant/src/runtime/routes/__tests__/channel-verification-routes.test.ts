/**
 * Tests for the trusted-contact branch of the channel-verification create
 * route.
 *
 * Pins the invariant that the trusted-contact create path performs no
 * assistant-side activation write (no `updateChannelStatus`): it only creates an
 * outbound session and sends a code. The verified outcome flows exclusively
 * through the inbound gateway code-match path, so it is never double-written.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const verifyTrustedContactCalls: Array<[string, string]> = [];
let verifyTrustedContactImpl: (
  contactChannelId: string,
  assistantId: string,
) => Promise<Record<string, unknown>> = async () => ({ success: true });

const updateChannelStatusCalls: unknown[] = [];
const ipcCalls: Array<[string, unknown]> = [];

mock.module("../../../daemon/handlers/config-channels.js", () => ({
  verifyTrustedContact: async (
    contactChannelId: string,
    assistantId: string,
  ) => {
    verifyTrustedContactCalls.push([contactChannelId, assistantId]);
    return verifyTrustedContactImpl(contactChannelId, assistantId);
  },
  createInboundChallenge: async () => ({ success: true }),
  getVerificationStatus: () => ({ success: true }),
  revokeVerificationForChannel: () => ({ success: true }),
}));

mock.module("../../../contacts/contact-store.js", () => ({
  updateChannelStatus: (...args: unknown[]) => {
    updateChannelStatusCalls.push(args);
    return null;
  },
}));

mock.module("../../ipc/gateway-client.js", () => ({
  ipcCallPersistent: async (method: string, params: unknown) => {
    ipcCalls.push([method, params]);
    return { ok: true, didWrite: true, channel: {} };
  },
}));

import { handleCreateVerificationSession } from "../channel-verification-routes.js";
import { ConflictError, TooManyRequestsError } from "../errors.js";

beforeEach(() => {
  verifyTrustedContactCalls.length = 0;
  updateChannelStatusCalls.length = 0;
  ipcCalls.length = 0;
  verifyTrustedContactImpl = async () => ({ success: true });
});

describe("handleCreateVerificationSession — trusted_contact", () => {
  test("sends the verification session without writing the activation outcome assistant-side", async () => {
    verifyTrustedContactImpl = async () => ({
      success: true,
      verificationSessionId: "sess-1",
      expiresAt: Date.now() + 600_000,
      sendCount: 1,
      channel: "phone",
    });

    const result = (await handleCreateVerificationSession({
      body: { purpose: "trusted_contact", contactChannelId: "cc-1" },
    })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.verificationSessionId).toBe("sess-1");
    expect(verifyTrustedContactCalls).toEqual([["cc-1", expect.any(String)]]);

    // No assistant-side activation outcome write on the create path — the
    // outcome flows through the inbound gateway code-match path instead.
    expect(updateChannelStatusCalls).toEqual([]);
  });

  test("does not double-write the outcome via the gateway relay on the create path", async () => {
    verifyTrustedContactImpl = async () => ({
      success: true,
      verificationSessionId: "sess-2",
      channel: "telegram",
    });

    await handleCreateVerificationSession({
      body: { purpose: "trusted_contact", contactChannelId: "cc-2" },
    });

    // The activation outcome is owned by the inbound gateway path; the create
    // path must not relay a `mark_channel_verified` write (no double-write).
    expect(
      ipcCalls.filter(([method]) => method === "mark_channel_verified"),
    ).toEqual([]);
  });

  test("propagates an already-verified short-circuit as a ConflictError (no silent success)", async () => {
    verifyTrustedContactImpl = async () => ({
      success: false,
      error: "already_verified",
      message: "Channel is already verified",
    });

    await expect(
      handleCreateVerificationSession({
        body: { purpose: "trusted_contact", contactChannelId: "cc-3" },
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(updateChannelStatusCalls).toEqual([]);
  });

  test("propagates a rate-limit failure rather than silently succeeding", async () => {
    verifyTrustedContactImpl = async () => ({
      success: false,
      error: "rate_limited",
      message: "Too many attempts",
    });

    await expect(
      handleCreateVerificationSession({
        body: { purpose: "trusted_contact", contactChannelId: "cc-4" },
      }),
    ).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  test("a failure in the trusted-contact path propagates, never a silent success", async () => {
    verifyTrustedContactImpl = async () => {
      throw new Error("gateway relay failed");
    };

    await expect(
      handleCreateVerificationSession({
        body: { purpose: "trusted_contact", contactChannelId: "cc-5" },
      }),
    ).rejects.toThrow("gateway relay failed");

    expect(updateChannelStatusCalls).toEqual([]);
  });
});
