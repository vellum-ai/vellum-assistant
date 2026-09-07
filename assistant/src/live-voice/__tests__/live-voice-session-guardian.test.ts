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

const { makeSessionGuardianResolver } =
  await import("../live-voice-session.js");

beforeEach(() => {
  lookups = [];
  lookupResult = undefined;
});

describe("live voice session guardian", () => {
  test("reads past the cache", async () => {
    lookupResult = "principal-guardian";
    const resolve = makeSessionGuardianResolver();

    expect(await resolve()).toBe("principal-guardian");
    expect(lookups).toEqual([{ forceRefresh: true }]);
  });

  /**
   * The whole reason this is session-scoped: a forced read per turn would put
   * a gateway round-trip on every turn's path to the model.
   */
  test("costs one lookup however many turns the session runs", async () => {
    lookupResult = "principal-guardian";
    const resolve = makeSessionGuardianResolver();

    const answers = await Promise.all([resolve(), resolve(), resolve()]);

    expect(answers).toEqual([
      "principal-guardian",
      "principal-guardian",
      "principal-guardian",
    ]);
    expect(lookups.length).toBe(1);
  });

  /** A separate session asks again, or a rebind would never be seen at all. */
  test("a new session reads again", async () => {
    lookupResult = "principal-guardian";
    await makeSessionGuardianResolver()();
    await makeSessionGuardianResolver()();

    expect(lookups.length).toBe(2);
  });

  /**
   * A session that will not start is worse than one running on the cached
   * principal, which is what this path did before the forced read existed.
   */
  test("a gateway that throws leaves the turn to the cached read", async () => {
    lookupResult = new Error("gateway unreachable");
    const resolve = makeSessionGuardianResolver();

    expect(await resolve()).toBeUndefined();
  });

  test("a binding that names nobody leaves the turn to the cached read", async () => {
    lookupResult = undefined;
    const resolve = makeSessionGuardianResolver();

    expect(await resolve()).toBeUndefined();
    expect(lookups).toEqual([{ forceRefresh: true }]);
  });
});
