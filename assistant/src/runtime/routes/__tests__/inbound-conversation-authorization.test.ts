/**
 * Authorization tests for the channel conversation reset endpoint
 * (`handleDeleteConversation`).
 *
 * `/new` is handled at the gateway and never runs the inbound message
 * pipeline, so this endpoint is the only place its actor can be checked
 * (LUM-2945). It authorizes with the same runtime primitives a message gets:
 * `verdictUsability`, the per-channel `policy: "deny"` governance rule,
 * `enforceAdmissionPolicy`, and `resolveCapabilities`.
 *
 * Only gateway-principal calls are gated. Actor and local principals are
 * already authenticated by the route policy, so their behavior is unchanged.
 */
import { describe, expect, mock, test } from "bun:test";

import type { TrustVerdict } from "@vellumai/gateway-client";

// The reset itself is exercised by the handler's own suite; these tests are
// about the authorization gate, so the persistence layer is stubbed out.
mock.module("../../../persistence/conversation-key-store.js", () => ({
  deleteConversationKey: () => {},
  getOrCreateConversation: () => ({}),
}));
mock.module("../../../persistence/delivery-crud.js", () => ({
  buildScopedConversationKey: () => "scoped-key",
}));
mock.module("../../../persistence/external-conversation-store.js", () => ({
  deleteBindingByChannelChatNullThread: () => {},
  deleteBindingByChannelChatThread: () => {},
}));

const { handleDeleteConversation } = await import("../inbound-conversation.js");

const GATEWAY_HEADERS = { "x-vellum-principal-type": "svc_gateway" };

function verdict(overrides: Partial<TrustVerdict> = {}): TrustVerdict {
  return {
    trustClass: "trusted_contact",
    canonicalSenderId: "U1",
    contactId: "contact-1",
    channelId: "channel-1",
    type: "telegram",
    address: "U1",
    status: "active",
    policy: "allow",
    ...overrides,
  } as TrustVerdict;
}

/** A sender with no member row at all: the true stranger shape. */
function strangerVerdict(): TrustVerdict {
  return { trustClass: "unknown", canonicalSenderId: "U9" } as TrustVerdict;
}

function reset(
  body: Record<string, unknown>,
  headers: Record<string, string> | undefined = GATEWAY_HEADERS,
) {
  return handleDeleteConversation({
    body: {
      sourceChannel: "telegram",
      conversationExternalId: "C1",
      ...body,
    },
    headers,
  });
}

describe("handleDeleteConversation authorization", () => {
  test("admits an active contact under the default floor", () => {
    const result = reset({
      trustVerdict: verdict(),
      admissionPolicy: "trusted_contacts",
    });

    expect(result).toEqual({ ok: true });
  });

  test("denies a stranger under the default floor", () => {
    const result = reset({
      trustVerdict: strangerVerdict(),
      admissionPolicy: "trusted_contacts",
    });

    expect(result).toMatchObject({ ok: false, denied: true });
  });

  test("denies a stranger even under a `strangers` floor: admission is not capability", () => {
    // The floor admits rank 1, but `resolveCapabilities("unknown")` has
    // `mayBeInteractive: false`, so an admitted stranger still may not reset
    // shared state. This is the check that would be missing entirely if the
    // command were authorized by admission alone.
    const result = reset({
      trustVerdict: strangerVerdict(),
      admissionPolicy: "strangers",
    });

    expect(result).toMatchObject({ ok: false, reason: "not_interactive" });
  });

  test("an unverified member may reset: contacts are interactive", () => {
    const result = reset({
      trustVerdict: verdict({
        trustClass: "unverified_contact",
        status: "unverified",
      }),
      admissionPolicy: "strangers",
    });

    expect(result).toEqual({ ok: true });
  });

  test('honors an explicit per-channel `policy: "deny"`', () => {
    // Parity with `acl-enforcement.ts`: governance outranks classification,
    // so the same actor cannot be denied a message yet reset by command.
    const result = reset({
      trustVerdict: verdict({ policy: "deny" }),
      admissionPolicy: "trusted_contacts",
    });

    expect(result).toMatchObject({ ok: false, reason: "policy_deny" });
  });

  test('`policy: "deny"` denies the guardian too', () => {
    const result = reset({
      trustVerdict: verdict({
        trustClass: "guardian",
        policy: "deny",
        guardianExternalUserId: "U1",
        guardianPrincipalId: "principal-1",
      }),
      admissionPolicy: "trusted_contacts",
    });

    expect(result).toMatchObject({ ok: false, reason: "policy_deny" });
  });

  test("denies a blocked member even under a `strangers` floor", () => {
    const result = reset({
      trustVerdict: verdict({ trustClass: "unknown", status: "blocked" }),
      admissionPolicy: "strangers",
    });

    expect(result).toMatchObject({ ok: false, denied: true });
  });

  test("fails closed on a could-not-vouch verdict", () => {
    const result = reset({
      trustVerdict: verdict({ resolutionFailed: true }),
      admissionPolicy: "trusted_contacts",
    });

    expect(result).toMatchObject({ ok: false });
    expect(String((result as { reason: string }).reason)).toContain("verdict_");
  });

  test("fails closed when the gateway sends no verdict at all", () => {
    const result = reset({ admissionPolicy: "trusted_contacts" });

    expect(result).toMatchObject({ ok: false });
  });

  test("denies a below-floor contact under `guardian_only`", () => {
    const result = reset({
      trustVerdict: verdict(),
      admissionPolicy: "guardian_only",
    });

    expect(result).toMatchObject({ ok: false });
  });

  test("non-gateway principals are unchanged: no verdict required", () => {
    // The desktop/CLI path is authenticated by the route policy itself.
    const result = reset({}, { "x-vellum-principal-type": "actor" });

    expect(result).toEqual({ ok: true });
  });
});
