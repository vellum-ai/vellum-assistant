/**
 * Tests for `routeSetup` — inbound admission-floor enforcement and the
 * fail-closed gateway-verdict trust source.
 *
 * `routeSetup` reads several module-level singletons (config, pending
 * verification session, gateway voice-invite reader). Those I/O collaborators
 * are mocked so the tables below can drive trust class, member status,
 * pending challenge, and the gateway's active-voice-invite view directly —
 * no database is touched. Caller trust is driven entirely through gateway
 * verdicts; `resolveActorTrust` is mocked to throw so any regression back to
 * local resolution fails loudly.
 *
 * The admission floor is exercised through the REAL, pure `enforceAdmissionPolicy`:
 * `phone` is an enforced (non-exempt) channel, so the real function applies the
 * true `rank >= floor` semantics. We deliberately do not reimplement the floor
 * here — a test-local copy of production logic would silently drift from it.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { AdmissionPolicy, TrustVerdict } from "@vellumai/gateway-client";

import type { TrustClass } from "../../runtime/actor-trust-resolver.js";
import type { CallSession } from "../types.js";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({ calls: { verification: { enabled: false } } }),
}));

// `resolveActorTrust` must never be consulted by the router — the gateway
// verdict is the sole trust source. The mock throws so a regression back to
// local resolution fails loudly, and call counts are asserted per test.
const resolveActorTrustMock = mock(() => {
  throw new Error("routeSetup must not call resolveActorTrust");
});
// Override only `resolveActorTrust`; the real `trust-verdict-consumer` imports
// `toTrustContext` from this module, so the rest must pass through untouched.
const actorTrustResolverModule =
  await import("../../runtime/actor-trust-resolver.js");
mock.module("../../runtime/actor-trust-resolver.js", () => ({
  ...actorTrustResolverModule,
  resolveActorTrust: resolveActorTrustMock,
}));

// Controllable pending verification challenge (gateway-backed read). The
// registered mock is process-global and leaks into sibling test files, so it
// spreads the real module and delegates to the real wrapper unless this
// file's tests are active (toggled in beforeAll/afterAll). Calls are counted
// so the verdict session-stamp gating can assert the IPC was skipped.
let pendingChallenge: unknown = null;
let pendingSessionMockActive = false;
let getPendingSessionCalls = 0;
const realGatewaySessionsModule = {
  ...(await import("../../channels/gateway-verification-sessions.js")),
};
mock.module("../../channels/gateway-verification-sessions.js", () => ({
  ...realGatewaySessionsModule,
  getPendingSession: async (channel: string) => {
    if (!pendingSessionMockActive) {
      return realGatewaySessionsModule.getPendingSession(channel);
    }
    getPendingSessionCalls += 1;
    return pendingChallenge;
  },
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
let getActiveVoiceInviteCalls = 0;
mock.module("../gateway-invite-reader.js", () => ({
  getActiveVoiceInvite: async () => {
    getActiveVoiceInviteCalls += 1;
    return activeVoiceInvite;
  },
}));

const { routeSetup } = await import("../call-setup-router.js");

// ---------------------------------------------------------------------------
// Fixtures
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

/** Usable verdict for a given trust class (member ACL for known classes). */
function verdictFor(trustClass: TrustClass): TrustVerdict {
  switch (trustClass) {
    case "guardian":
      return makeMemberVerdict("guardian", { status: "active" });
    case "trusted_contact":
      return makeMemberVerdict("trusted_contact", { status: "active" });
    case "unverified_contact":
      return makeMemberVerdict("unverified_contact", { status: "unverified" });
    default:
      return makeVerdict({ trustClass: "unknown" });
  }
}

function route(
  admissionPolicy: AdmissionPolicy | null | undefined,
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

function routeOutbound(verdict?: TrustVerdict | null) {
  return routeSetup({
    callSessionId: "cs_1",
    session: {
      initiatedFromConversationId: "conv_1",
    } as unknown as CallSession,
    from: "+12025550199",
    to: "+12025550142",
    admissionPolicy: null,
    verdict,
  });
}

beforeAll(() => {
  pendingSessionMockActive = true;
});

afterAll(() => {
  pendingSessionMockActive = false;
});

beforeEach(() => {
  pendingChallenge = null;
  activeVoiceInvite = null;
  getPendingSessionCalls = 0;
  getActiveVoiceInviteCalls = 0;
  resolveActorTrustMock.mockClear();
});

// ---------------------------------------------------------------------------
// Fail-closed verdict source: missing/failed/member-unresolvable verdicts —
// plus unrecognized trust classes and memberless guardian claims — deny
// inbound (no stranger-lane side effects, no verification-read IPC) and abort
// outbound setup loudly.
// ---------------------------------------------------------------------------

describe("routeSetup — unusable verdict fails closed", () => {
  const unusableVerdicts: Array<{ name: string; verdict: TrustVerdict | null }> =
    [
      { name: "null verdict", verdict: null },
      {
        name: "resolutionFailed verdict",
        verdict: makeVerdict({ resolutionFailed: true }),
      },
      {
        name: "member identity with missing status",
        verdict: makeVerdict({
          trustClass: "trusted_contact",
          contactId: "ct_1",
          channelId: "ch_1",
          policy: "allow",
        }),
      },
      {
        name: "member identity with unknown status",
        verdict: makeVerdict({
          trustClass: "trusted_contact",
          contactId: "ct_1",
          channelId: "ch_1",
          status: "bogus",
          policy: "allow",
        }),
      },
      {
        name: "member identity with unknown policy",
        verdict: makeVerdict({
          trustClass: "trusted_contact",
          contactId: "ct_1",
          channelId: "ch_1",
          status: "active",
          policy: "bogus",
        }),
      },
      {
        name: "unrecognized trust class (version skew)",
        verdict: makeVerdict({
          trustClass: "superadmin" as TrustVerdict["trustClass"],
          canonicalSenderId: "+12025550142",
        }),
      },
      {
        // Contradictory: the gateway proves guardian identity via a
        // same-channel member row, so a memberless guardian claim must
        // never confer guardian capabilities (or even a normal_call).
        name: "memberless guardian claim",
        verdict: makeVerdict({ trustClass: "guardian" }),
      },
    ];

  for (const { name, verdict } of unusableVerdicts) {
    test(`inbound ${name} → deny with no local resolve, no session read, no stranger flows`, async () => {
      const { outcome, resolved } = await route(null, verdict);

      expect(outcome.action).toBe("deny");
      if (outcome.action === "deny") {
        expect(outcome.logReason).toContain("trust verdict unavailable");
      }
      expect(resolved.actorTrust.trustClass).toBe("unknown");
      expect(resolveActorTrustMock).not.toHaveBeenCalled();
      expect(getPendingSessionCalls).toBe(0);
      expect(getActiveVoiceInviteCalls).toBe(0);
    });
  }

  test("inbound absent verdict → deny", async () => {
    const { outcome } = await route(null);

    expect(outcome.action).toBe("deny");
    expect(resolveActorTrustMock).not.toHaveBeenCalled();
  });

  test("outbound missing verdict aborts setup loudly", async () => {
    await expect(routeOutbound(null)).rejects.toThrow(
      /trust verdict unavailable.*aborting outbound setup/,
    );
    expect(resolveActorTrustMock).not.toHaveBeenCalled();
  });

  test("outbound resolutionFailed verdict aborts setup loudly", async () => {
    await expect(
      routeOutbound(makeVerdict({ resolutionFailed: true })),
    ).rejects.toThrow(/trust verdict unavailable/);
  });

  test("outbound usable verdict proceeds to a normal outbound call", async () => {
    const { outcome } = await routeOutbound(
      makeMemberVerdict("guardian", { status: "active" }),
    );

    expect(outcome).toEqual({ action: "normal_call", isInbound: false });
    expect(resolveActorTrustMock).not.toHaveBeenCalled();
  });

  test("real stranger verdict (no member identity) is usable — takes the verdict path", async () => {
    const { resolved, outcome } = await route(
      null,
      makeVerdict({ trustClass: "unknown" }),
    );

    expect(resolveActorTrustMock).not.toHaveBeenCalled();
    expect(resolved.actorTrust.trustClass).toBe("unknown");
    expect(outcome.action).toBe("name_capture");
  });
});

// ---------------------------------------------------------------------------
// Verdict session stamp gates the pending-session IPC: `false` is
// authoritative (skip the read entirely); `true`/absent falls back to it.
// ---------------------------------------------------------------------------

describe("routeSetup — verdict session stamp gates getPendingSession", () => {
  test("stamp false skips the pending-session read", async () => {
    const { outcome } = await route(
      null,
      makeMemberVerdict("trusted_contact", { status: "active" }, {
        hasInterceptableVerificationSession: false,
      }),
    );

    expect(getPendingSessionCalls).toBe(0);
    expect(outcome.action).toBe("normal_call");
  });

  test("stamp false + floor deny makes zero verification-read IPC calls", async () => {
    const { outcome } = await route(
      "guardian_only",
      makeMemberVerdict("trusted_contact", { status: "active" }, {
        hasInterceptableVerificationSession: false,
      }),
    );

    expect(outcome.action).toBe("deny");
    expect(getPendingSessionCalls).toBe(0);
  });

  test("stamp false wins even when the (skipped) read would report a challenge", async () => {
    pendingChallenge = { id: "vs_1" };
    const { outcome } = await route(
      null,
      makeMemberVerdict("trusted_contact", { status: "active" }, {
        hasInterceptableVerificationSession: false,
      }),
    );

    expect(getPendingSessionCalls).toBe(0);
    expect(outcome.action).toBe("normal_call");
  });

  test("stamp true still reads the pending session", async () => {
    pendingChallenge = { id: "vs_1" };
    const { outcome } = await route(
      null,
      makeMemberVerdict("trusted_contact", { status: "active" }, {
        hasInterceptableVerificationSession: true,
      }),
    );

    expect(getPendingSessionCalls).toBe(1);
    expect(outcome.action).toBe("verification");
  });

  test("absent stamp still reads the pending session", async () => {
    const { outcome } = await route(
      null,
      makeMemberVerdict("trusted_contact", { status: "active" }),
    );

    expect(getPendingSessionCalls).toBe(1);
    expect(outcome.action).toBe("normal_call");
  });
});

// ---------------------------------------------------------------------------
// Floor table: trustClass × policy → admit/deny
// ---------------------------------------------------------------------------

describe("routeSetup — admission floor table", () => {
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
        const { outcome } = await route(policy, verdictFor(trustClass));
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
        const { outcome } = await route(policy, verdictFor(trustClass));
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
    const { outcome } = await route(
      "strangers",
      makeMemberVerdict("unknown", { status: "blocked" }),
    );
    expect(outcome.action).toBe("deny");
  });

  test("revoked member is denied under permissive floor", async () => {
    // Revoked → the gateway classifies as unknown; the member ACL denies on
    // memberStatus regardless of the permissive policy.
    const { outcome } = await route(
      "strangers",
      makeMemberVerdict("unknown", { status: "revoked" }),
    );
    expect(outcome.action).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// admissionPolicy null/undefined → current behavior unchanged
// ---------------------------------------------------------------------------

describe("routeSetup — no policy preserves current behavior", () => {
  test("unknown caller → name_capture", async () => {
    expect((await route(null, verdictFor("unknown"))).outcome.action).toBe(
      "name_capture",
    );
    expect(
      (await route(undefined, verdictFor("unknown"))).outcome.action,
    ).toBe("name_capture");
  });

  test("unverified known caller → unverified_caller", async () => {
    expect(
      (await route(null, verdictFor("unverified_contact"))).outcome.action,
    ).toBe("unverified_caller");
  });

  test("trusted contact → normal_call", async () => {
    expect(
      (await route(null, verdictFor("trusted_contact"))).outcome.action,
    ).toBe("normal_call");
  });

  test("guardian → normal_call", async () => {
    expect((await route(null, verdictFor("guardian"))).outcome.action).toBe(
      "normal_call",
    );
  });

  test("member policy deny still denies", async () => {
    const { outcome } = await route(
      null,
      makeMemberVerdict("trusted_contact", {
        status: "active",
        policy: "deny",
      }),
    );
    expect(outcome.action).toBe("deny");
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
    const { outcome } = await route(
      "any_contact",
      verdictFor("unverified_contact"),
    );
    expect(outcome.action).toBe("normal_call");
  });

  test("strangers admits an unknown caller to normal_call (not name_capture)", async () => {
    const { outcome } = await route("strangers", verdictFor("unknown"));
    expect(outcome.action).toBe("normal_call");
  });

  test("strangers admits an unverified_contact to normal_call", async () => {
    const { outcome } = await route(
      "strangers",
      verdictFor("unverified_contact"),
    );
    expect(outcome.action).toBe("normal_call");
  });

  test("null policy preserves legacy name_capture for unknown caller", async () => {
    expect((await route(null, verdictFor("unknown"))).outcome.action).toBe(
      "name_capture",
    );
  });

  test("null policy preserves legacy unverified_caller for unverified caller", async () => {
    expect(
      (await route(null, verdictFor("unverified_contact"))).outcome.action,
    ).toBe("unverified_caller");
  });

  test("trusted_contacts (default) still denies unknown and unverified", async () => {
    expect(
      (await route("trusted_contacts", verdictFor("unknown"))).outcome.action,
    ).toBe("deny");
    expect(
      (await route("trusted_contacts", verdictFor("unverified_contact")))
        .outcome.action,
    ).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Invites & pending challenges bypass the floor
// ---------------------------------------------------------------------------

describe("routeSetup — floor bypasses", () => {
  test("active voice invite bypasses the floor (no_one policy)", async () => {
    activeVoiceInvite = {
      inviteId: "inv-123",
      inviteeName: "Friend Name",
      guardianName: "Guardian",
      codeDigits: 6,
    };
    const { outcome } = await route("no_one", verdictFor("unknown"));
    expect(outcome.action).toBe("invite_redemption");
    if (outcome.action === "invite_redemption") {
      expect(outcome.inviteeName).toBe("Friend Name");
    }
  });

  test("pending verification challenge bypasses the floor (no_one policy)", async () => {
    // A pending challenge for a known member routes to verification regardless
    // of the floor.
    pendingChallenge = { id: "vs_1" };
    const { outcome } = await route("no_one", verdictFor("trusted_contact"));
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
    activeVoiceInvite = null;
    const { outcome } = await route(null, verdictFor("unknown"));
    expect(outcome.action).toBe("name_capture");
  });

  test("null gateway invite view for an unverified member → unverified_caller, not invite_redemption", async () => {
    activeVoiceInvite = null;
    const { outcome } = await route(null, verdictFor("unverified_contact"));
    expect(outcome.action).toBe("unverified_caller");
  });

  test("null inviteeName from the gateway keeps the neutral-greeting contract", async () => {
    activeVoiceInvite = {
      inviteId: "inv-124",
      inviteeName: null,
      guardianName: null,
      codeDigits: 6,
    };
    const { outcome } = await route(null, verdictFor("unknown"));
    expect(outcome.action).toBe("invite_redemption");
    if (outcome.action === "invite_redemption") {
      expect(outcome.inviteeName).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Verdict-path ACL: blocked / revoked / deny enforced from the verdict-derived
// memberRecord. Guards the P1 where a verdict member with no memberRecord
// bypassed these gates.
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
