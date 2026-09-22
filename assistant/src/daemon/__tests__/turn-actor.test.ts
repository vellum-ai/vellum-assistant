/**
 * Who a turn runs as for host-proxy routing, and when the walk to the
 * conversation's resting identity is allowed.
 */
import { describe, expect, test } from "bun:test";

import { turnActorPrincipalId } from "../turn-actor.js";

describe("turn actor principal", () => {
  test("the turn's own actor wins", () => {
    expect(
      turnActorPrincipalId({
        currentTurnSourceActorPrincipalId: "principal-turn",
        currentTurnAuthContext: { actorPrincipalId: "principal-turn-auth" },
        authContext: { actorPrincipalId: "principal-resting" },
      }),
    ).toBe("principal-turn");
  });

  /** A `/v1/messages` turn sets only the turn-scoped auth context. */
  test("falls back to the turn's auth context", () => {
    expect(
      turnActorPrincipalId({
        currentTurnAuthContext: { actorPrincipalId: "principal-turn-auth" },
        authContext: { actorPrincipalId: "principal-resting" },
      }),
    ).toBe("principal-turn-auth");
  });

  test("falls back to the conversation's resting actor", () => {
    expect(
      turnActorPrincipalId({
        authContext: { actorPrincipalId: "principal-resting" },
      }),
    ).toBe("principal-resting");
  });

  test("answers nobody when nothing names an actor", () => {
    expect(turnActorPrincipalId({})).toBeUndefined();
  });

  /**
   * The case the suppression exists for. An ordinary text turn leaves both
   * fallback fields populated, so a live-voice turn that resolved its own
   * actor and found none would otherwise inherit that turn's principal and,
   * through it, that user's connected desktop.
   */
  test("a turn that found no actor of its own inherits none", () => {
    expect(
      turnActorPrincipalId({
        currentTurnActorFallbackSuppressed: true,
        currentTurnAuthContext: { actorPrincipalId: "principal-text-turn" },
        authContext: { actorPrincipalId: "principal-resting" },
      }),
    ).toBeUndefined();
  });

  /** Suppression stops the walk; it does not discard an actor the turn has. */
  test("a suppressed turn still keeps its own actor", () => {
    expect(
      turnActorPrincipalId({
        currentTurnActorFallbackSuppressed: true,
        currentTurnSourceActorPrincipalId: "principal-turn",
        authContext: { actorPrincipalId: "principal-resting" },
      }),
    ).toBe("principal-turn");
  });
});
