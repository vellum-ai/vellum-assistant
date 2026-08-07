/**
 * The precedence that decides who may redeem a code.
 *
 * Both directions of getting it wrong are silent. Too loose and a stranger in
 * a shared chat spends someone else's code. Too narrow and a mint supersedes
 * nothing, leaving every earlier code live for its full TTL while the consume
 * path still accepts them. Neither shows up as an error, so these assert the
 * rule directly rather than through a flow.
 */

import { describe, expect, test } from "bun:test";

import { bindsSameIdentity, boundIdentity } from "@vellumai/gateway-client";
import type { IdentityBindingStatus } from "@vellumai/gateway-client";

import type { IdentityMatchSession } from "../identity-match.js";
import { checkIdentityMatch } from "../identity-match.js";

const ALICE = "U-ALICE";
const BOB = "U-BOB";
const ROOM = "C-ROOM";
const PHONE = "+15555550101";

/** A bound session carrying whichever identity fields a case needs. */
function session(fields: {
  expectedExternalUserId?: string;
  expectedChatId?: string;
  expectedPhoneE164?: string;
  identityBindingStatus?: IdentityBindingStatus;
}): IdentityMatchSession {
  return { identityBindingStatus: "bound", ...fields };
}

describe("boundIdentity", () => {
  test("a phone session is bound to the number", () => {
    // Both columns carry the same value at every mint site, so this is the
    // one identity rather than two that happen to agree.
    expect(
      boundIdentity(
        session({ expectedPhoneE164: PHONE, expectedExternalUserId: PHONE }),
      ),
    ).toEqual({ field: "phoneE164", value: PHONE });
  });

  test("a person outranks the room they are in", () => {
    expect(
      boundIdentity(
        session({ expectedExternalUserId: ALICE, expectedChatId: ROOM }),
      ),
    ).toEqual({ field: "externalUserId", value: ALICE });
  });

  test("a room counts only when nothing identifies a person", () => {
    expect(boundIdentity(session({ expectedChatId: ROOM }))).toEqual({
      field: "chatId",
      value: ROOM,
    });
  });

  test("a session with no identity is bound to none", () => {
    // Inbound challenges and bootstrap sessions before redemption.
    expect(boundIdentity(session({}))).toBeNull();
  });
});

describe("checkIdentityMatch", () => {
  test("the bound person may redeem, anyone else may not", () => {
    const s = session({ expectedExternalUserId: ALICE });
    expect(checkIdentityMatch(s, ALICE, ROOM)).toBe(true);
    expect(checkIdentityMatch(s, BOB, ROOM)).toBe(false);
  });

  test("sharing the room is not enough when the session names a person", () => {
    // The case the precedence exists for: Bob is in the same channel and
    // must not be able to spend Alice's code.
    const s = session({ expectedExternalUserId: ALICE, expectedChatId: ROOM });
    expect(checkIdentityMatch(s, BOB, ROOM)).toBe(false);
  });

  test("a room-bound session is satisfied by the room", () => {
    const s = session({ expectedChatId: ROOM });
    expect(checkIdentityMatch(s, BOB, ROOM)).toBe(true);
    expect(checkIdentityMatch(s, BOB, "C-OTHER")).toBe(false);
  });

  test("a caller with one identifier passes it as both axes", () => {
    // How voice calls this: `fromNumber` is the whole identity it has.
    const s = session({
      expectedPhoneE164: PHONE,
      expectedExternalUserId: PHONE,
    });
    expect(checkIdentityMatch(s, PHONE, PHONE)).toBe(true);
    expect(checkIdentityMatch(s, "+15555550102", "+15555550102")).toBe(false);
  });

  test("an empty identity admits nobody, rather than everybody", () => {
    // Truthiness here would report the session unbound, and an unbound
    // session admits any holder of the code. A set-but-empty identity is a
    // broken session, and a broken session must fail closed.
    const s = session({ expectedExternalUserId: "" });
    expect(boundIdentity(s)).toEqual({ field: "externalUserId", value: "" });
    expect(checkIdentityMatch(s, ALICE, ROOM)).toBe(false);
  });

  test("an unbound session admits anyone", () => {
    // Inbound challenges rely on code secrecy alone, and a bootstrap session
    // is bound by the bootstrap path rather than here.
    expect(checkIdentityMatch(session({}), BOB, ROOM)).toBe(true);
    expect(
      checkIdentityMatch(
        {
          expectedExternalUserId: ALICE,
          identityBindingStatus: "pending_bootstrap",
        },
        BOB,
        ROOM,
      ),
    ).toBe(true);
  });
});

describe("bindsSameIdentity", () => {
  test("two people on one channel are not the same identity", () => {
    expect(
      bindsSameIdentity(
        boundIdentity(session({ expectedExternalUserId: ALICE })),
        boundIdentity(session({ expectedExternalUserId: BOB })),
      ),
    ).toBe(false);
  });

  test("a room-bound session is not the same as a person in that room", () => {
    // Otherwise a mint for the room would supersede Alice's own code, which
    // is the group-chat case the precedence protects.
    expect(
      bindsSameIdentity(
        boundIdentity(
          session({ expectedExternalUserId: ALICE, expectedChatId: ROOM }),
        ),
        boundIdentity(session({ expectedChatId: ROOM })),
      ),
    ).toBe(false);
  });

  test("the same room twice is the same identity", () => {
    expect(
      bindsSameIdentity(
        boundIdentity(session({ expectedChatId: ROOM })),
        boundIdentity(session({ expectedChatId: ROOM })),
      ),
    ).toBe(true);
  });

  test("no identity is never the same as anything, including itself", () => {
    // Bootstrap sessions are claimed by id, not superseded by identity, so
    // an unbound mint must not sweep up every other unbound row.
    expect(bindsSameIdentity(null, null)).toBe(false);
    expect(
      bindsSameIdentity(null, boundIdentity(session({ expectedChatId: ROOM }))),
    ).toBe(false);
  });
});

describe("the supersede scope and the consume path agree", () => {
  // The property this file exists to hold. A mint supersedes prior sessions
  // bound to the same identity, and the consume path decides who may redeem
  // one. If those two ever disagree, a code survives a mint that should have
  // killed it and stays spendable by the same actor.
  const CASES: Array<{ name: string; fields: Parameters<typeof session>[0] }> =
    [
      { name: "person", fields: { expectedExternalUserId: ALICE } },
      {
        name: "person in a room",
        fields: { expectedExternalUserId: ALICE, expectedChatId: ROOM },
      },
      { name: "room only", fields: { expectedChatId: ROOM } },
      {
        name: "phone",
        fields: { expectedPhoneE164: PHONE, expectedExternalUserId: PHONE },
      },
    ];

  for (const { name, fields } of CASES) {
    test(`${name}: whoever can redeem it is who a re-mint supersedes`, () => {
      const existing = session(fields);
      const identity = boundIdentity(existing)!;

      // A fresh mint for the same identity supersedes the existing session.
      expect(bindsSameIdentity(boundIdentity(session(fields)), identity)).toBe(
        true,
      );

      // And the actor that identity describes is the one the consume path
      // admits, on the axis the identity is carried by.
      const actorUserId =
        identity.field === "chatId" ? "U-ANYONE" : identity.value;
      const actorChatId = identity.field === "chatId" ? identity.value : ROOM;
      expect(checkIdentityMatch(existing, actorUserId, actorChatId)).toBe(true);
    });
  }
});

describe("invariants across every session shape", () => {
  // Example-based cases test the shapes someone thought of. These sweep the
  // whole space, because the bugs this file guards have twice been a shape
  // nobody had in mind: a mint identified by a field the rule did not check,
  // and an empty identity read as no identity at all.
  const VALUES = [null, "A", "B", ""];
  const ACTORS = ["A", "B", ""];

  function everyShape(
    visit: (
      session: {
        expectedPhoneE164: string | null;
        expectedExternalUserId: string | null;
        expectedChatId: string | null;
        identityBindingStatus: IdentityBindingStatus;
      },
      actorUserId: string,
      actorChatId: string,
    ) => void,
  ): void {
    for (const p of VALUES) {
      for (const u of VALUES) {
        for (const c of VALUES) {
          for (const au of ACTORS) {
            for (const ac of ACTORS) {
              visit(
                {
                  expectedPhoneE164: p,
                  expectedExternalUserId: u,
                  expectedChatId: c,
                  identityBindingStatus: "bound" as IdentityBindingStatus,
                },
                au,
                ac,
              );
            }
          }
        }
      }
    }
  }

  test("a session naming a person is never satisfied by a different person", () => {
    // Generalized #10593: sharing a chat, or a phone column, must never
    // stand in for being the person the session names. Asserted for every
    // combination of the other fields rather than the ones we remembered.
    const violations: string[] = [];
    everyShape((s, actorUserId, actorChatId) => {
      if (s.expectedPhoneE164 !== null) return;
      if (s.expectedExternalUserId === null) return;
      if (actorUserId === s.expectedExternalUserId) return;
      if (checkIdentityMatch(s, actorUserId, actorChatId)) {
        violations.push(
          `${JSON.stringify(s)} admitted user=${actorUserId} chat=${actorChatId}`,
        );
      }
    });
    expect(violations).toEqual([]);
  });

  test("a bound session is never satisfied by an actor matching nothing on it", () => {
    // The fail-open shape: something about the session makes the check
    // decide there is nothing to check, and any holder of the code gets in.
    const violations: string[] = [];
    everyShape((s, actorUserId, actorChatId) => {
      const values = [
        s.expectedPhoneE164,
        s.expectedExternalUserId,
        s.expectedChatId,
      ].filter((v): v is string => v !== null);
      if (values.length === 0) return;
      if (values.includes(actorUserId) || values.includes(actorChatId)) return;
      if (checkIdentityMatch(s, actorUserId, actorChatId)) {
        violations.push(
          `${JSON.stringify(s)} admitted user=${actorUserId} chat=${actorChatId}`,
        );
      }
    });
    expect(violations).toEqual([]);
  });

  test("whoever is admitted matches the identity the supersede scopes on", () => {
    // The two sides cannot part company: the actor the consume path lets in
    // is the one whose earlier codes a fresh mint kills.
    const violations: string[] = [];
    everyShape((s, actorUserId, actorChatId) => {
      if (!checkIdentityMatch(s, actorUserId, actorChatId)) return;
      const identity = boundIdentity(s);
      if (identity === null) return;
      const presented = identity.field === "chatId" ? actorChatId : actorUserId;
      if (presented !== identity.value) {
        violations.push(
          `${JSON.stringify(s)} admitted ${presented} but scopes on ${identity.field}=${identity.value}`,
        );
      }
    });
    expect(violations).toEqual([]);
  });
});
