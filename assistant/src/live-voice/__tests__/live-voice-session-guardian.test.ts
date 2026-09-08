/**
 * The guardian a live-voice session runs as, resolved once at session scope.
 *
 * The gateway pins the `/v1/live-voice` upgrade to the bound guardian, so the
 * daemon reconciles its own view with a forced read rather than trusting the
 * guardian-delivery cache, which holds a successful answer for minutes and
 * would otherwise stamp a turn with a principal the gateway did not admit.
 * Once per session rather than per turn is what keeps that round-trip off the
 * path to the model.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const realLocalActorIdentityModule = {
  ...(await import("../../runtime/local-actor-identity.js")),
};

/** Calls the module under test made, with the options it passed. */
let lookups: { forceRefresh?: boolean }[] = [];
/** What the next lookup answers, or throws when set to an Error. */
let lookupResult: string | undefined | Error = undefined;

const realLocalPrincipalTrustModule = {
  ...(await import("../../runtime/local-principal-trust.js")),
};

/** Principals the trust resolver was asked about. */
let trustLookups: string[] = [];

mock.module("../../runtime/local-principal-trust.js", () => ({
  ...realLocalPrincipalTrustModule,
  resolveLocalPrincipalTrustContext: async (input: {
    actorPrincipalId: string;
    sourceChannel: string;
  }) => {
    trustLookups.push(input.actorPrincipalId);
    return {
      sourceChannel: input.sourceChannel,
      trustClass: "guardian",
      requesterExternalUserId: input.actorPrincipalId,
    };
  },
}));

mock.module("../../runtime/local-actor-identity.js", () => ({
  ...realLocalActorIdentityModule,
  findLocalGuardianPrincipalId: async (options?: {
    forceRefresh?: boolean;
  }) => {
    lookups.push({ forceRefresh: options?.forceRefresh });
    if (lookupResult instanceof Error) {
      throw lookupResult;
    }
    return lookupResult;
  },
}));

const { makeDefaultStartVoiceTurn, resolveLocalLiveVoiceIdentity } =
  await import("../live-voice-session.js");

/** Let the session's own read settle before asserting on it. */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  lookups = [];
  trustLookups = [];
  lookupResult = undefined;
});

describe("live voice session guardian", () => {
  /**
   * The gateway admits a guardian at upgrade and revalidates nothing after,
   * so the identity is bound as the session is built. Deferring to the first
   * utterance would read a binding that changed in the silence between.
   */
  test("reads past the cache as the session is built", async () => {
    lookupResult = "principal-guardian";

    makeDefaultStartVoiceTurn();
    await flushMicrotasks();

    expect(lookups).toEqual([{ forceRefresh: true }]);
  });

  /**
   * The whole reason this is session-scoped: a forced read per turn would put
   * a gateway round-trip on every turn's path to the model.
   */
  test("costs one lookup however many turns the session runs", async () => {
    lookupResult = "principal-guardian";

    const start = makeDefaultStartVoiceTurn();
    await flushMicrotasks();
    void start;
    await flushMicrotasks();

    expect(lookups.length).toBe(1);
  });

  /** A separate session asks again, or a rebind would never be seen at all. */
  test("a new session reads again", async () => {
    lookupResult = "principal-guardian";

    makeDefaultStartVoiceTurn();
    makeDefaultStartVoiceTurn();
    await flushMicrotasks();

    expect(lookups.length).toBe(2);
  });

  /**
   * A session that will not start is worse than one whose computer use is
   * unavailable, so an unreachable gateway answers nobody rather than
   * throwing.
   */
  test("a gateway that throws does not reject", async () => {
    lookupResult = new Error("gateway unreachable");

    makeDefaultStartVoiceTurn();
    await flushMicrotasks();

    expect(lookups.length).toBe(1);
  });
});

/**
 * What a turn is stamped with once the session's read has settled.
 *
 * The two answers fail apart on purpose. A read that settles nothing still
 * knows the cached binding, which is enough to say what the turn may DO, and
 * not enough to say whose desktop it may reach: the gateway may have admitted
 * a guardian the cache has not caught up with.
 */
describe("live voice turn identity", () => {
  test("stamps the actor the session's read settled", async () => {
    lookupResult = "principal-cached";

    const identity = await resolveLocalLiveVoiceIdentity("conv-1", {
      principalId: "principal-admitted",
    });

    expect(identity.actorPrincipalId).toBe("principal-admitted");
    expect(identity.trustContext).toBeDefined();
    // The session's answer, never a second read behind its back.
    expect(lookups.length).toBe(0);
    expect(trustLookups).toEqual(["principal-admitted"]);
  });

  /**
   * The whole point of failing closed. Stamping the cached principal here
   * risks reaching another user's desktop; stamping nothing costs this
   * session its host proxies and nothing else.
   */
  test("leaves the actor unset when the session's read settled nothing", async () => {
    lookupResult = "principal-cached";

    const identity = await resolveLocalLiveVoiceIdentity("conv-2", {
      principalId: undefined,
    });

    expect(identity.actorPrincipalId).toBeUndefined();
  });

  /**
   * The call still runs in that state: trust is answered from the cached
   * binding, so the turn keeps the capabilities it always had and only the
   * host proxies go quiet.
   */
  test("still answers trust when the actor is left unset", async () => {
    lookupResult = "principal-cached";

    const identity = await resolveLocalLiveVoiceIdentity("conv-3", {
      principalId: undefined,
    });

    expect(identity.trustContext?.trustClass).toBe("guardian");
    expect(trustLookups).toEqual(["principal-cached"]);
  });

  /** The background continuation asks nothing and uses only the trust answer. */
  test("a caller with no session read is answered from the cache", async () => {
    lookupResult = "principal-cached";

    const identity = await resolveLocalLiveVoiceIdentity("conv-4");

    expect(identity.actorPrincipalId).toBe("principal-cached");
    expect(identity.trustContext?.trustClass).toBe("guardian");
  });
});
