/**
 * The guardian a live-voice turn runs as.
 *
 * The gateway admits the socket against its own binding and hands the
 * principal down, so nothing here resolves one: a second reading taken later
 * in the daemon is how an admitted session came to run as a guardian the
 * gateway never let in.
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

const { resolveLocalLiveVoiceIdentity } =
  await import("../live-voice-session.js");

beforeEach(() => {
  lookups = [];
  trustLookups = [];
  lookupResult = undefined;
});

/**
 * What a turn is stamped with, given what the gateway admitted.
 *
 * The two answers fail apart on purpose. A socket the gateway admitted
 * without naming a guardian still has a cached binding to say what the turn
 * may DO, and nothing to say whose desktop it may reach.
 */
describe("live voice turn identity", () => {
  test("stamps the guardian the gateway admitted", async () => {
    lookupResult = "principal-cached";

    const identity = await resolveLocalLiveVoiceIdentity("conv-1", {
      principalId: "principal-admitted",
    });

    expect(identity.actorPrincipalId).toBe("principal-admitted");
    expect(identity.trustContext).toBeDefined();
    // The gateway's answer, never a second read behind its back. Resolving
    // one here is what let an admitted session run as a different guardian.
    expect(lookups.length).toBe(0);
    expect(trustLookups).toEqual(["principal-admitted"]);
  });

  /**
   * The whole point of failing closed. Stamping the cached principal here
   * risks reaching another user's desktop; stamping nothing costs this
   * session its host proxies and nothing else.
   */
  test("leaves the actor unset when the gateway named no guardian", async () => {
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
