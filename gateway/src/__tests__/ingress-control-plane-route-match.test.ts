import { describe, expect, test } from "bun:test";
import { matchIngressControlPlaneRoute } from "../http/routes/ingress-control-plane-route-match.js";

describe("matchIngressControlPlaneRoute", () => {
  test("matches contact CRUD routes", () => {
    expect(matchIngressControlPlaneRoute("/v1/contacts", "GET")).toEqual({
      kind: "listContacts",
    });
    expect(matchIngressControlPlaneRoute("/v1/contacts", "POST")).toEqual({
      kind: "upsertContact",
    });
    expect(matchIngressControlPlaneRoute("/v1/contacts/merge", "POST")).toEqual(
      { kind: "mergeContacts" },
    );
    expect(
      matchIngressControlPlaneRoute("/v1/contacts/channels/ch_1", "PATCH"),
    ).toEqual({ kind: "updateContactChannel", channelId: "ch_1" });
    expect(matchIngressControlPlaneRoute("/v1/contacts/ct_1", "GET")).toEqual({
      kind: "getContact",
      contactId: "ct_1",
    });
  });

  test("returns null for unsupported methods on contact routes", () => {
    expect(matchIngressControlPlaneRoute("/v1/contacts", "DELETE")).toBeNull();
    // GET /v1/contacts/channels/ch_1 does not match (PATCH only)
    expect(
      matchIngressControlPlaneRoute("/v1/contacts/channels/ch_1", "GET"),
    ).toBeNull();
  });

  test("GET /v1/contacts/merge falls through to getContact", () => {
    // No GET handler for /merge, so the contactId catch-all picks it up
    expect(matchIngressControlPlaneRoute("/v1/contacts/merge", "GET")).toEqual({
      kind: "getContact",
      contactId: "merge",
    });
  });

  test("matches redeem invite only for POST", () => {
    expect(
      matchIngressControlPlaneRoute("/v1/contacts/invites/redeem", "POST"),
    ).toEqual({
      kind: "redeemInvite",
    });

    // DELETE should treat `redeem` as an invite ID so revoke routing still works.
    expect(
      matchIngressControlPlaneRoute("/v1/contacts/invites/redeem", "DELETE"),
    ).toEqual({
      kind: "revokeInvite",
      inviteId: "redeem",
    });
  });

  test("matches contacts invite routes", () => {
    expect(
      matchIngressControlPlaneRoute("/v1/contacts/invites", "GET"),
    ).toEqual({
      kind: "listInvites",
    });
    expect(
      matchIngressControlPlaneRoute("/v1/contacts/invites", "POST"),
    ).toEqual({
      kind: "createInvite",
    });
    expect(
      matchIngressControlPlaneRoute("/v1/contacts/invites/inv_1", "DELETE"),
    ).toEqual({
      kind: "revokeInvite",
      inviteId: "inv_1",
    });
  });

  test("returns null for unsupported method/path combinations", () => {
    expect(
      matchIngressControlPlaneRoute("/v1/contacts/invites/redeem", "GET"),
    ).toBeNull();
    expect(
      matchIngressControlPlaneRoute("/v1/contacts/invites/inv_1", "POST"),
    ).toBeNull();
    expect(
      matchIngressControlPlaneRoute("/v1/ingress/unknown", "GET"),
    ).toBeNull();
  });
});
