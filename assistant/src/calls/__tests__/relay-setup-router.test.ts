/**
 * Tests for the inbound admission-floor enforcement in `routeSetup`.
 *
 * `routeSetup` reads several module-level singletons (config, trust resolver,
 * pending verification session, gateway voice-invite reader). Those I/O
 * collaborators are mocked so the tables below can drive trust class, member
 * status, pending challenge, and the gateway's active-voice-invite view
 * directly — no database is touched.
 *
 * The admission floor is exercised through the REAL, pure `enforceAdmissionPolicy`:
 * `phone` is an enforced (non-exempt) channel, so the real function applies the
 * true `rank >= floor` semantics. We deliberately do not reimplement the floor
 * here — a test-local copy of production logic would silently drift from it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AdmissionPolicy, TrustVerdict } from "@vellumai/gateway-client";

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

// Controllable resolved trust context. `resolveActorTrust` is a tracked mock
// so the verdict-source tests can assert the local fallback fires (or not).
// The verdict path uses the REAL, pure `actorTrustContextFromVerdict` /
// `verdictMemberUnresolvable` — no module mock — so this file leaks nothing
// into sibling test files sharing the bun process.
let nextTrust: ActorTrustContext;
const resolveActorTrustMock = mock(() => nextTrust);
// Override only `resolveActorTrust`; the real `trust-verdict-consumer` imports
// `toTrustContext` from this module, so the rest must pass through untouched.
const actorTrustResolverModule =
  await import("../../runtime/actor-trust-resolver.js");
mock.module("../../runtime/actor-trust-resolver.js", () => ({
  ...actorTrustResolverModule,
  resolveActorTrust: resolveActorTrustMock,
}));

// Controllable pending verification challenge.
let pendingChallenge: unknown = null;
mock.module("../../runtime/channel-verification-service.js", () => ({
  getPendingSession: () => pendingChallenge,
}));

// Controllable gateway active-voice-invite view. The real reader fails soft
// to `null` on ANY gateway failure by contract, so `null` covers both "no
// invite" and "gateway unreachable / IPC error".
let activeVoiceInvite: {
  inviteId: string;
  inviteeName: string | null;
  guardianName: string | null;
  codeDigits: number;
} | null = null;
mock.module("../gateway-invite-reader.js", () => ({
  getActiveVoiceInvite: async () => activeVoiceInvite,
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
    inviteId: null,
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
    role: "contact",
    lastInteraction: null,
    interactionCount: 0,
    createdAt: 0,
    updatedAt: 0,
    contactType: "human",
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
        contact: makeContact(),
        channel: makeChannel(),
        status: channel.status,
        policy: channel.policy ?? "allow",
        role: channel.role ?? "contact",
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

function route(
  admissionPolicy?: AdmissionPolicy | null,
  verdict?: TrustVerdict | null,
) {
  return routeSetup({
    callSessionId: "cs_1",
    session: null, // inbound
    from: "+12025550142",
    to: "+12025550199",
    admissionPolicy,
    verdict,
  });
}

beforeEach(() => {
  pendingChallenge = null;
  activeVoiceInvite = null;
  resolveActorTrustMock.mockClear();
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
      test(`${policy} denies ${trustClass}`, async () => {
        setTrust(trustClass);
        const { outcome } = await route(policy);
        expect(outcome.action).toBe("deny");
        if (outcome.action === "deny") {
          expect(outcome.logReason).toBe(
            `Inbound voice admission floor: ${policy}`,
          );
        }
      });
    }
    for (const trustClass of admits) {
      test(`${policy} admits ${trustClass}`, async () => {
        setTrust(trustClass);
        const { outcome } = await route(policy);
        expect(outcome.action).not.toBe("deny");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Blocked / revoked always deny
// ---------------------------------------------------------------------------

describe("routeSetup — blocked / revoked", () => {
  test("blocked caller is denied (pre-floor ACL check)", async () => {
    nextTrust = makeTrust("unknown", { status: "blocked" });
    const { outcome } = await route("strangers");
    expect(outcome.action).toBe("deny");
  });

  test("revoked member is denied under permissive floor", async () => {
    // Revoked → resolver classifies as unknown; the floor mock denies on
    // memberStatus regardless of the permissive policy.
    nextTrust = makeTrust("unknown", { status: "revoked" });
    const { outcome } = await route("strangers");
    expect(outcome.action).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// admissionPolicy null/undefined → current behavior unchanged
// ---------------------------------------------------------------------------

describe("routeSetup — no policy preserves current behavior", () => {
  test("unknown caller → name_capture", async () => {
    nextTrust = makeTrust("unknown");
    expect((await route(null)).outcome.action).toBe("name_capture");
    expect((await route(undefined)).outcome.action).toBe("name_capture");
  });

  test("unverified known caller → unverified_caller", async () => {
    nextTrust = makeTrust("unverified_contact", { status: "unverified" });
    expect((await route(null)).outcome.action).toBe("unverified_caller");
  });

  test("trusted contact → normal_call", async () => {
    nextTrust = makeTrust("trusted_contact", { status: "active" });
    expect((await route(null)).outcome.action).toBe("normal_call");
  });

  test("guardian → normal_call", async () => {
    nextTrust = makeTrust("guardian", { status: "active", role: "guardian" });
    expect((await route(null)).outcome.action).toBe("normal_call");
  });

  test("member policy deny still denies", async () => {
    nextTrust = makeTrust("trusted_contact", {
      status: "active",
      policy: "deny",
    });
    expect((await route(null)).outcome.action).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Active permissive floor admits straight to a normal call
// ---------------------------------------------------------------------------
// When a policy is ACTIVELY set and admits the caller, the floor is the access
// decision: unknown/unverified callers bypass name_capture / unverified_caller
// and connect directly. With a null policy the legacy identity flows persist.

describe("routeSetup — permissive floor admits to normal_call", () => {
  test("any_contact admits an unverified_contact to normal_call (not unverified_caller)", async () => {
    nextTrust = makeTrust("unverified_contact", { status: "unverified" });
    const { outcome } = await route("any_contact");
    expect(outcome.action).toBe("normal_call");
  });

  test("strangers admits an unknown caller to normal_call (not name_capture)", async () => {
    nextTrust = makeTrust("unknown");
    const { outcome } = await route("strangers");
    expect(outcome.action).toBe("normal_call");
  });

  test("strangers admits an unverified_contact to normal_call", async () => {
    nextTrust = makeTrust("unverified_contact", { status: "unverified" });
    const { outcome } = await route("strangers");
    expect(outcome.action).toBe("normal_call");
  });

  test("null policy preserves legacy name_capture for unknown caller", async () => {
    nextTrust = makeTrust("unknown");
    expect((await route(null)).outcome.action).toBe("name_capture");
  });

  test("null policy preserves legacy unverified_caller for unverified caller", async () => {
    nextTrust = makeTrust("unverified_contact", { status: "unverified" });
    expect((await route(null)).outcome.action).toBe("unverified_caller");
  });

  test("trusted_contacts (default) still denies unknown and unverified", async () => {
    nextTrust = makeTrust("unknown");
    expect((await route("trusted_contacts")).outcome.action).toBe("deny");
    nextTrust = makeTrust("unverified_contact", { status: "unverified" });
    expect((await route("trusted_contacts")).outcome.action).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Invites & pending challenges bypass the floor
// ---------------------------------------------------------------------------

describe("routeSetup — floor bypasses", () => {
  test("active voice invite bypasses the floor (no_one policy)", async () => {
    nextTrust = makeTrust("unknown");
    activeVoiceInvite = {
      inviteId: "inv-123",
      inviteeName: "Friend Name",
      guardianName: "Guardian",
      codeDigits: 6,
    };
    const { outcome } = await route("no_one");
    expect(outcome.action).toBe("invite_redemption");
    if (outcome.action === "invite_redemption") {
      expect(outcome.inviteeName).toBe("Friend Name");
    }
  });

  test("pending verification challenge bypasses the floor (no_one policy)", async () => {
    // A pending challenge for a known member routes to verification regardless
    // of the floor.
    nextTrust = makeTrust("trusted_contact", { status: "active" });
    pendingChallenge = { id: "vs_1" };
    const { outcome } = await route("no_one");
    expect(outcome.action).toBe("verification");
  });
});

// ---------------------------------------------------------------------------
// Fail-soft detection: the gateway reader resolves `null` on any gateway
// failure, so an unknown caller falls to the legacy identity flows instead of
// invite_redemption — detection never blocks setup on a gateway blip.
// ---------------------------------------------------------------------------

describe("routeSetup — fail-soft voice-invite detection", () => {
  test("null gateway invite view (no invite / gateway error) → name_capture, not invite_redemption", async () => {
    nextTrust = makeTrust("unknown");
    activeVoiceInvite = null;
    const { outcome } = await route(null);
    expect(outcome.action).toBe("name_capture");
  });

  test("null gateway invite view for an unverified member → unverified_caller, not invite_redemption", async () => {
    nextTrust = makeTrust("unverified_contact", { status: "unverified" });
    activeVoiceInvite = null;
    const { outcome } = await route(null);
    expect(outcome.action).toBe("unverified_caller");
  });

  test("null inviteeName from the gateway keeps the neutral-greeting contract", async () => {
    nextTrust = makeTrust("unknown");
    activeVoiceInvite = {
      inviteId: "inv-124",
      inviteeName: null,
      guardianName: null,
      codeDigits: 6,
    };
    const { outcome } = await route(null);
    expect(outcome.action).toBe("invite_redemption");
    if (outcome.action === "invite_redemption") {
      expect(outcome.inviteeName).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Caller-trust source: gateway verdict first, local fallback
// ---------------------------------------------------------------------------

function makeVerdict(overrides: Partial<TrustVerdict> = {}): TrustVerdict {
  return {
    trustClass: "guardian",
    canonicalSenderId: "+12025550142",
    ...overrides,
  };
}

// A verdict carrying a fully-resolvable member ACL (contactId/channelId + valid
// known status·policy enums). The verdict path builds a memberRecord from
// these, so it enforces blocked/revoked/deny.
function makeMemberVerdict(
  trustClass: TrustVerdict["trustClass"],
  channel: { status: string; policy?: string },
  overrides: Partial<TrustVerdict> = {},
): TrustVerdict {
  return makeVerdict({
    trustClass,
    contactId: "ct_1",
    channelId: "ch_1",
    status: channel.status,
    policy: channel.policy ?? "allow",
    ...overrides,
  });
}

describe("routeSetup — caller-trust source", () => {
  test("present verdict builds trust from the verdict (no local resolve)", async () => {
    const { resolved, outcome } = await route(
      null,
      makeMemberVerdict("guardian", { status: "active" }),
    );

    expect(resolveActorTrustMock).not.toHaveBeenCalled();
    expect(resolved.actorTrust.trustClass).toBe("guardian");
    expect(outcome.action).toBe("normal_call");
  });

  test("resolutionFailed verdict falls back to local resolveActorTrust", async () => {
    nextTrust = makeTrust("guardian", { status: "active", role: "guardian" });
    const { resolved } = await route(null, makeVerdict({ resolutionFailed: true }));

    expect(resolveActorTrustMock).toHaveBeenCalledTimes(1);
    expect(resolved.actorTrust.trustClass).toBe("guardian");
  });

  test("null verdict falls back to local resolveActorTrust", async () => {
    nextTrust = makeTrust("trusted_contact", { status: "active" });
    const { resolved } = await route(null, null);

    expect(resolveActorTrustMock).toHaveBeenCalledTimes(1);
    expect(resolved.actorTrust.trustClass).toBe("trusted_contact");
  });

  test("absent verdict falls back to local resolveActorTrust", async () => {
    nextTrust = makeTrust("guardian", { status: "active", role: "guardian" });
    await route(null);

    expect(resolveActorTrustMock).toHaveBeenCalledTimes(1);
  });

  test("admission floor still applies on the verdict path (guardian_only denies trusted_contact)", async () => {
    const { outcome } = await route(
      "guardian_only",
      makeMemberVerdict("trusted_contact", { status: "active" }),
    );

    expect(resolveActorTrustMock).not.toHaveBeenCalled();
    expect(outcome.action).toBe("deny");
  });

  test("admission floor still applies on the fallback path (guardian_only denies trusted_contact)", async () => {
    nextTrust = makeTrust("trusted_contact", { status: "active" });
    const { outcome } = await route(
      "guardian_only",
      makeVerdict({ resolutionFailed: true }),
    );

    expect(resolveActorTrustMock).toHaveBeenCalledTimes(1);
    expect(outcome.action).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Verdict-path ACL: blocked / revoked / deny enforced from the verdict-derived
// memberRecord (no local fallback). Guards the P1 where a verdict member with
// no memberRecord bypassed these gates.
// ---------------------------------------------------------------------------

describe("routeSetup — verdict path enforces member ACL", () => {
  test("blocked member via verdict is denied (not normal_call) under permissive floor", async () => {
    const { outcome } = await route(
      "strangers",
      makeMemberVerdict("unknown", { status: "blocked" }),
    );

    expect(resolveActorTrustMock).not.toHaveBeenCalled();
    expect(outcome.action).toBe("deny");
  });

  test("revoked member via verdict is denied under permissive floor", async () => {
    const { outcome } = await route(
      "strangers",
      makeMemberVerdict("unknown", { status: "revoked" }),
    );

    expect(resolveActorTrustMock).not.toHaveBeenCalled();
    expect(outcome.action).toBe("deny");
  });

  test("policy deny member via verdict is denied (not normal_call)", async () => {
    const { outcome } = await route(
      null,
      makeMemberVerdict("trusted_contact", {
        status: "active",
        policy: "deny",
      }),
    );

    expect(resolveActorTrustMock).not.toHaveBeenCalled();
    expect(outcome.action).toBe("deny");
  });

  test("policy escalate member via verdict is denied (live call can't await approval)", async () => {
    const { outcome } = await route(
      null,
      makeMemberVerdict("trusted_contact", {
        status: "active",
        policy: "escalate",
      }),
    );

    expect(resolveActorTrustMock).not.toHaveBeenCalled();
    expect(outcome.action).toBe("deny");
  });

  test("trusted/active member via verdict still admits to normal_call", async () => {
    const { outcome } = await route(
      null,
      makeMemberVerdict("trusted_contact", {
        status: "active",
        policy: "allow",
      }),
    );

    expect(resolveActorTrustMock).not.toHaveBeenCalled();
    expect(outcome.action).toBe("normal_call");
  });

  test("guardian via verdict still admits to normal_call", async () => {
    const { outcome } = await route(
      null,
      makeMemberVerdict("guardian", { status: "active" }),
    );

    expect(resolveActorTrustMock).not.toHaveBeenCalled();
    expect(outcome.action).toBe("normal_call");
  });
});

// ---------------------------------------------------------------------------
// Unresolvable member verdict → local fallback (never trust an un-ACL-checkable
// member). A verdict claiming a member (contactId/channelId) whose ACL can't be
// reassembled (missing/unknown status·policy) must take the local resolveActorTrust
// path so the member is ACL-checked locally, not trusted by trustClass.
// ---------------------------------------------------------------------------

describe("routeSetup — unresolvable member verdict falls back to local", () => {
  test("member identity with missing status falls back to local resolveActorTrust", async () => {
    nextTrust = makeTrust("trusted_contact", { status: "active" });
    const { resolved } = await route(
      null,
      makeVerdict({
        trustClass: "trusted_contact",
        contactId: "ct_1",
        channelId: "ch_1",
        policy: "allow",
        // status absent → unresolvable
      }),
    );

    expect(resolveActorTrustMock).toHaveBeenCalledTimes(1);
    expect(resolved.actorTrust.trustClass).toBe("trusted_contact");
  });

  test("member identity with unknown status falls back to local resolveActorTrust", async () => {
    nextTrust = makeTrust("trusted_contact", { status: "active" });
    await route(
      null,
      makeVerdict({
        trustClass: "trusted_contact",
        contactId: "ct_1",
        channelId: "ch_1",
        status: "bogus",
        policy: "allow",
      }),
    );

    expect(resolveActorTrustMock).toHaveBeenCalledTimes(1);
  });

  test("member identity with unknown policy falls back to local resolveActorTrust", async () => {
    nextTrust = makeTrust("trusted_contact", { status: "active" });
    await route(
      null,
      makeVerdict({
        trustClass: "trusted_contact",
        contactId: "ct_1",
        channelId: "ch_1",
        status: "active",
        policy: "bogus",
      }),
    );

    expect(resolveActorTrustMock).toHaveBeenCalledTimes(1);
  });

  test("real stranger verdict (no member identity) still takes the verdict path", async () => {
    const { resolved } = await route(null, makeVerdict({ trustClass: "unknown" }));

    expect(resolveActorTrustMock).not.toHaveBeenCalled();
    expect(resolved.actorTrust.trustClass).toBe("unknown");
  });

  test("valid member verdict (good status+policy) still takes the verdict path", async () => {
    const { outcome } = await route(
      null,
      makeMemberVerdict("trusted_contact", {
        status: "active",
        policy: "allow",
      }),
    );

    expect(resolveActorTrustMock).not.toHaveBeenCalled();
    expect(outcome.action).toBe("normal_call");
  });
});
