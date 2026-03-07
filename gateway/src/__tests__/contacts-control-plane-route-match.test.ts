import { describe, expect, test } from "bun:test";
import { matchContactsControlPlaneRoute } from "../http/routes/contacts-control-plane-route-match.js";

describe("matchContactsControlPlaneRoute", () => {
  test("matches contact CRUD routes", () => {
    expect(matchContactsControlPlaneRoute("/v1/contacts", "GET")).toEqual({
      kind: "listContacts",
    });
    expect(matchContactsControlPlaneRoute("/v1/contacts", "POST")).toEqual({
      kind: "upsertContact",
    });
    expect(
      matchContactsControlPlaneRoute("/v1/contacts/merge", "POST"),
    ).toEqual({ kind: "mergeContacts" });
    expect(
      matchContactsControlPlaneRoute("/v1/contact-channels/ch_1", "PATCH"),
    ).toEqual({ kind: "updateContactChannel", contactChannelId: "ch_1" });
    expect(matchContactsControlPlaneRoute("/v1/contacts/ct_1", "GET")).toEqual({
      kind: "getContact",
      contactId: "ct_1",
    });
  });

  test("matches verify contact channel route", () => {
    expect(
      matchContactsControlPlaneRoute(
        "/v1/contact-channels/ch_1/verify",
        "POST",
      ),
    ).toEqual({
      kind: "verifyContactChannel",
      contactChannelId: "ch_1",
    });

    // Only POST is supported
    expect(
      matchContactsControlPlaneRoute("/v1/contact-channels/ch_1/verify", "GET"),
    ).toBeNull();
  });

  test("returns null for unsupported methods on contact routes", () => {
    expect(matchContactsControlPlaneRoute("/v1/contacts", "DELETE")).toBeNull();
    // GET /v1/contact-channels/ch_1 does not match (PATCH only)
    expect(
      matchContactsControlPlaneRoute("/v1/contact-channels/ch_1", "GET"),
    ).toBeNull();
  });

  test("GET /v1/contacts/merge falls through to getContact", () => {
    // No GET handler for /merge, so the contactId catch-all picks it up
    expect(matchContactsControlPlaneRoute("/v1/contacts/merge", "GET")).toEqual(
      {
        kind: "getContact",
        contactId: "merge",
      },
    );
  });

  test("matches redeem invite only for POST", () => {
    expect(
      matchContactsControlPlaneRoute("/v1/contacts/invites/redeem", "POST"),
    ).toEqual({
      kind: "redeemInvite",
    });

    // DELETE should treat `redeem` as an invite ID so revoke routing still works.
    expect(
      matchContactsControlPlaneRoute("/v1/contacts/invites/redeem", "DELETE"),
    ).toEqual({
      kind: "revokeInvite",
      inviteId: "redeem",
    });
  });

  test("matches contacts invite routes", () => {
    expect(
      matchContactsControlPlaneRoute("/v1/contacts/invites", "GET"),
    ).toEqual({
      kind: "listInvites",
    });
    expect(
      matchContactsControlPlaneRoute("/v1/contacts/invites", "POST"),
    ).toEqual({
      kind: "createInvite",
    });
    expect(
      matchContactsControlPlaneRoute("/v1/contacts/invites/inv_1", "DELETE"),
    ).toEqual({
      kind: "revokeInvite",
      inviteId: "inv_1",
    });
  });

  test("returns null for unsupported method/path combinations", () => {
    expect(
      matchContactsControlPlaneRoute("/v1/contacts/invites", "DELETE"),
    ).toBeNull();
    expect(
      matchContactsControlPlaneRoute("/v1/contacts/invites/redeem", "GET"),
    ).toBeNull();
    expect(
      matchContactsControlPlaneRoute("/v1/contacts/invites/inv_1", "POST"),
    ).toBeNull();
    expect(
      matchContactsControlPlaneRoute("/v1/ingress/unknown", "GET"),
    ).toBeNull();
  });
});
