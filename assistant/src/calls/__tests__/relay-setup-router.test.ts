/**
 * Tests for the inbound admission-floor enforcement in `routeSetup`.
 *
 * `routeSetup` is pure routing logic but reads several module-level singletons
 * (config, trust resolver, pending verification session, invite store). These
 * are mocked so the table below can drive trust class, member status, pending
 * challenge, and active invites independently of any DB.
 *
 * The floor verdict is exercised through the REAL `enforceAdmissionPolicy`
 * floor tables (`TRUST_CLASS_RANK` × `ADMISSION_FLOOR`), with the exempt-channel
 * short-circuit bypassed in the mock so the tests assert the true floor
 * semantics independent of any channel's exempt status (`phone` is now
 * enforced).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  ADMISSION_FLOOR,
  type AdmissionPolicy,
} from "@vellumai/gateway-client";

import type {
  ChannelPolicy,
  ChannelStatus,
} from "../../contacts/types.js";
import type {
  ActorTrustContext,
  TrustClass,
} from "../../runtime/actor-trust-resolver.js";
import { TRUST_CLASS_RANK } from "../../runtime/actor-trust-resolver.js";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ calls: { verification: { enabled: false } } }),
}));

// Controllable resolved trust context.
let nextTrust: ActorTrustContext;
mock.module("../../runtime/actor-trust-resolver.js", () => ({
  resolveActorTrust: () => nextTrust,
  // Re-export the real rank table; the floor mock below consumes it.
  TRUST_CLASS_RANK,
}));

// Controllable pending verification challenge.
let pendingChallenge: unknown = null;
mock.module("../../runtime/channel-verification-service.js", () => ({
  getPendingSession: () => pendingChallenge,
}));

// Controllable active voice invites.
let activeInvites: Array<{
  friendName: string | null;
  guardianName: string | null;
  expiresAt?: number;
}> = [];
mock.module("../../memory/invite-store.js", () => ({
  findActiveVoiceInvites: () => activeInvites,
}));

// Real floor semantics, exemption bypassed (see file header).
mock.module(
  "../../runtime/routes/inbound-stages/admission-policy.js",
  () => ({
    enforceAdmissionPolicy: (input: {
      trustClass: TrustClass;
      memberStatus: ChannelStatus | undefined;
      policy: AdmissionPolicy;
    }) => {
      if (input.memberStatus === "blocked" || input.memberStatus === "revoked") {
        return {
          admitted: false,
          reason:
            input.memberStatus === "blocked"
              ? "member_blocked"
              : "member_revoked",
          shouldChallenge: false,
          effectivePolicy: input.policy,
        };
      }
      const rank = TRUST_CLASS_RANK[input.trustClass];
      const floor = ADMISSION_FLOOR[input.policy];
      if (rank >= floor) return { admitted: true };
      return {
        admitted: false,
        reason: `admission_policy_${input.policy}`,
        shouldChallenge: false,
        effectivePolicy: input.policy,
      };
    },
  }),
);

const { routeSetup } = await import("../relay-setup-router.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTrust(
  trustClass: TrustClass,
  channel?: { status: ChannelStatus; policy?: ChannelPolicy; role?: string },
): ActorTrustContext {
  const memberRecord = channel
    ? {
        contact: {
          displayName: "Test Caller",
          role: channel.role ?? "trusted_contact",
        } as never,
        channel: {
          id: "ch_1",
          status: channel.status,
          policy: channel.policy ?? "allow",
        } as never,
      }
    : null;
  return {
    canonicalSenderId: "+15551234567",
    guardianBindingMatch: null,
    memberRecord,
    trustClass,
    actorMetadata: {
      identifier: "+15551234567",
      displayName: undefined,
      senderDisplayName: undefined,
      memberDisplayName: undefined,
      username: undefined,
      channel: "phone",
      trustStatus: trustClass,
    },
  } as ActorTrustContext;
}

function route(admissionPolicy?: AdmissionPolicy | null) {
  return routeSetup({
    callSessionId: "cs_1",
    session: null, // inbound
    from: "+15551234567",
    to: "+15559999999",
    admissionPolicy,
  });
}

beforeEach(() => {
  pendingChallenge = null;
  activeInvites = [];
});

// ---------------------------------------------------------------------------
// Floor table: trustClass × policy → admit/deny
// ---------------------------------------------------------------------------

describe("routeSetup — admission floor table", () => {
  // For "known" classes (trusted_contact, guardian) the resolver yields a
  // member channel; unknown/unverified flow through the unknown ACL branch.
  function setTrust(trustClass: TrustClass) {
    if (trustClass === "guardian") {
      nextTrust = makeTrust("guardian", {
        status: "active",
        role: "guardian",
      });
    } else if (trustClass === "trusted_contact") {
      nextTrust = makeTrust("trusted_contact", { status: "active" });
    } else if (trustClass === "unverified_contact") {
      nextTrust = makeTrust("unverified_contact", { status: "unverified" });
    } else {
      nextTrust = makeTrust("unknown");
    }
  }

  const cases: Array<{
    policy: AdmissionPolicy;
    admits: TrustClass[];
    denies: TrustClass[];
  }> = [
    {
      policy: "strangers",
      admits: ["unknown", "unverified_contact", "trusted_contact", "guardian"],
      denies: [],
    },
    {
      policy: "any_contact",
      admits: ["unverified_contact", "trusted_contact", "guardian"],
      denies: ["unknown"],
    },
    {
      policy: "trusted_contacts",
      admits: ["trusted_contact", "guardian"],
      denies: ["unknown", "unverified_contact"],
    },
    {
      policy: "guardian_only",
      admits: ["guardian"],
      denies: ["unknown", "unverified_contact", "trusted_contact"],
    },
    {
      policy: "no_one",
      admits: [],
      denies: ["unknown", "unverified_contact", "trusted_contact", "guardian"],
    },
  ];

  for (const { policy, admits, denies } of cases) {
    for (const trustClass of denies) {
      test(`${policy} denies ${trustClass}`, () => {
        setTrust(trustClass);
        const { outcome } = route(policy);
        expect(outcome.action).toBe("deny");
        if (outcome.action === "deny") {
          expect(outcome.logReason).toBe(
            `Inbound voice admission floor: ${policy}`,
          );
        }
      });
    }
    for (const trustClass of admits) {
      test(`${policy} admits ${trustClass}`, () => {
        setTrust(trustClass);
        const { outcome } = route(policy);
        expect(outcome.action).not.toBe("deny");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Blocked / revoked always deny
// ---------------------------------------------------------------------------

describe("routeSetup — blocked / revoked", () => {
  test("blocked caller is denied (pre-floor ACL check)", () => {
    nextTrust = makeTrust("unknown", { status: "blocked" });
    const { outcome } = route("strangers");
    expect(outcome.action).toBe("deny");
  });

  test("revoked member is denied under permissive floor", () => {
    // Revoked → resolver classifies as unknown; the floor mock denies on
    // memberStatus regardless of the permissive policy.
    nextTrust = makeTrust("unknown", { status: "revoked" });
    const { outcome } = route("strangers");
    expect(outcome.action).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// admissionPolicy null/undefined → current behavior unchanged
// ---------------------------------------------------------------------------

describe("routeSetup — no policy preserves current behavior", () => {
  test("unknown caller → name_capture", () => {
    nextTrust = makeTrust("unknown");
    expect(route(null).outcome.action).toBe("name_capture");
    expect(route(undefined).outcome.action).toBe("name_capture");
  });

  test("unverified known caller → unverified_caller", () => {
    nextTrust = makeTrust("unverified_contact", { status: "unverified" });
    expect(route(null).outcome.action).toBe("unverified_caller");
  });

  test("trusted contact → normal_call", () => {
    nextTrust = makeTrust("trusted_contact", { status: "active" });
    expect(route(null).outcome.action).toBe("normal_call");
  });

  test("guardian → normal_call", () => {
    nextTrust = makeTrust("guardian", { status: "active", role: "guardian" });
    expect(route(null).outcome.action).toBe("normal_call");
  });

  test("member policy deny still denies", () => {
    nextTrust = makeTrust("trusted_contact", {
      status: "active",
      policy: "deny",
    });
    expect(route(null).outcome.action).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Invites & pending challenges bypass the floor
// ---------------------------------------------------------------------------

describe("routeSetup — floor bypasses", () => {
  test("active voice invite bypasses the floor (no_one policy)", () => {
    nextTrust = makeTrust("unknown");
    activeInvites = [{ friendName: "Friend", guardianName: "Guardian" }];
    const { outcome } = route("no_one");
    expect(outcome.action).toBe("invite_redemption");
  });

  test("pending verification challenge bypasses the floor (no_one policy)", () => {
    // A pending challenge for a known member routes to verification regardless
    // of the floor.
    nextTrust = makeTrust("trusted_contact", { status: "active" });
    pendingChallenge = { id: "vs_1" };
    const { outcome } = route("no_one");
    expect(outcome.action).toBe("verification");
  });
});
