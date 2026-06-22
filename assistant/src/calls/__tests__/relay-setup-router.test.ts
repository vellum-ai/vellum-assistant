/**
 * Tests for the inbound admission-floor enforcement in `routeSetup`.
 *
 * `routeSetup` reads several module-level singletons (config, trust resolver,
 * pending verification session, invite store, contact store). Those I/O
 * collaborators are mocked so the tables below can drive trust class, member
 * status, pending challenge, active invites, and the bound invite contact
 * directly — no database is touched.
 *
 * The admission floor is exercised through the REAL, pure `enforceAdmissionPolicy`:
 * `phone` is an enforced (non-exempt) channel, so the real function applies the
 * true `rank >= floor` semantics. We deliberately do not reimplement the floor
 * here — a test-local copy of production logic would silently drift from it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AdmissionPolicy } from "@vellumai/gateway-client";

import type {
  ChannelPolicy,
  ChannelStatus,
  ContactChannel,
  ContactRole,
  ContactWithChannels,
} from "../../contacts/types.js";
import type {
  ActorTrustContext,
  TrustClass,
} from "../../runtime/actor-trust-resolver.js";

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
}));

// Controllable pending verification challenge.
let pendingChallenge: unknown = null;
mock.module("../../runtime/channel-verification-service.js", () => ({
  getPendingSession: () => pendingChallenge,
}));

// Controllable active voice invites.
let activeInvites: Array<{
  contactId: string;
  friendName: string | null;
  guardianName: string | null;
  expiresAt?: number;
}> = [];
mock.module("../../memory/invite-store.js", () => ({
  findActiveVoiceInvites: () => activeInvites,
}));

// Controllable bound contact for invite-redemption name resolution.
let boundContact: { displayName?: string | null } | null = null;
mock.module("../../contacts/contact-store.js", () => ({
  getContact: () => boundContact,
}));

const { routeSetup } = await import("../relay-setup-router.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChannel(overrides: Partial<ContactChannel> = {}): ContactChannel {
  return {
    id: "ch_1",
    contactId: "ct_1",
    type: "phone",
    address: "+12025550142",
    isPrimary: true,
    externalChatId: null,
    status: "active",
    policy: "allow",
    verifiedAt: null,
    verifiedVia: null,
    inviteId: null,
    revokedReason: null,
    blockedReason: null,
    lastSeenAt: null,
    interactionCount: 0,
    lastInteraction: null,
    updatedAt: null,
    createdAt: 0,
    ...overrides,
  };
}

function makeContact(
  overrides: Partial<ContactWithChannels> = {},
): ContactWithChannels {
  return {
    id: "ct_1",
    displayName: "Test Caller",
    notes: null,
    lastInteraction: null,
    interactionCount: 0,
    createdAt: 0,
    updatedAt: 0,
    role: "contact",
    contactType: "human",
    principalId: null,
    userFile: null,
    channels: [],
    ...overrides,
  };
}

function makeTrust(
  trustClass: TrustClass,
  channel?: {
    status: ChannelStatus;
    policy?: ChannelPolicy;
    role?: ContactRole;
  },
): ActorTrustContext {
  const memberRecord = channel
    ? {
        contact: makeContact({ role: channel.role ?? "contact" }),
        channel: makeChannel({
          status: channel.status,
          policy: channel.policy ?? "allow",
        }),
      }
    : null;
  return {
    canonicalSenderId: "+12025550142",
    guardianBindingMatch: null,
    memberRecord,
    trustClass,
    actorMetadata: {
      identifier: "+12025550142",
      displayName: undefined,
      senderDisplayName: undefined,
      memberDisplayName: undefined,
      username: undefined,
      channel: "phone",
      trustStatus: trustClass,
    },
  };
}

function route(admissionPolicy?: AdmissionPolicy | null) {
  return routeSetup({
    callSessionId: "cs_1",
    session: null, // inbound
    from: "+12025550142",
    to: "+12025550199",
    admissionPolicy,
  });
}

beforeEach(() => {
  pendingChallenge = null;
  activeInvites = [];
  boundContact = null;
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
// Active permissive floor admits straight to a normal call
// ---------------------------------------------------------------------------
// When a policy is ACTIVELY set and admits the caller, the floor is the access
// decision: unknown/unverified callers bypass name_capture / unverified_caller
// and connect directly. With a null policy the legacy identity flows persist.

describe("routeSetup — permissive floor admits to normal_call", () => {
  test("any_contact admits an unverified_contact to normal_call (not unverified_caller)", () => {
    nextTrust = makeTrust("unverified_contact", { status: "unverified" });
    const { outcome } = route("any_contact");
    expect(outcome.action).toBe("normal_call");
  });

  test("strangers admits an unknown caller to normal_call (not name_capture)", () => {
    nextTrust = makeTrust("unknown");
    const { outcome } = route("strangers");
    expect(outcome.action).toBe("normal_call");
  });

  test("strangers admits an unverified_contact to normal_call", () => {
    nextTrust = makeTrust("unverified_contact", { status: "unverified" });
    const { outcome } = route("strangers");
    expect(outcome.action).toBe("normal_call");
  });

  test("null policy preserves legacy name_capture for unknown caller", () => {
    nextTrust = makeTrust("unknown");
    expect(route(null).outcome.action).toBe("name_capture");
  });

  test("null policy preserves legacy unverified_caller for unverified caller", () => {
    nextTrust = makeTrust("unverified_contact", { status: "unverified" });
    expect(route(null).outcome.action).toBe("unverified_caller");
  });

  test("trusted_contacts (default) still denies unknown and unverified", () => {
    nextTrust = makeTrust("unknown");
    expect(route("trusted_contacts").outcome.action).toBe("deny");
    nextTrust = makeTrust("unverified_contact", { status: "unverified" });
    expect(route("trusted_contacts").outcome.action).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Invites & pending challenges bypass the floor
// ---------------------------------------------------------------------------

describe("routeSetup — floor bypasses", () => {
  test("active voice invite bypasses the floor (no_one policy)", () => {
    nextTrust = makeTrust("unknown");
    activeInvites = [
      {
        contactId: "contact-123",
        friendName: "Friend",
        guardianName: "Guardian",
      },
    ];
    boundContact = { displayName: "Friend Name" };
    const { outcome } = route("no_one");
    expect(outcome.action).toBe("invite_redemption");
    if (outcome.action === "invite_redemption") {
      expect(outcome.inviteeName).toBe("Friend Name");
    }
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
