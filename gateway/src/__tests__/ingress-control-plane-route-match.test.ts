import { describe, expect, test } from "bun:test";
import { matchIngressControlPlaneRoute } from "../http/routes/ingress-control-plane-route-match.js";

describe("matchIngressControlPlaneRoute", () => {
  test("matches redeem invite only for POST", () => {
    expect(
      matchIngressControlPlaneRoute("/v1/ingress/invites/redeem", "POST"),
    ).toEqual({
      kind: "redeemInvite",
    });

    // DELETE should treat `redeem` as an invite ID so revoke routing still works.
    expect(
      matchIngressControlPlaneRoute("/v1/ingress/invites/redeem", "DELETE"),
    ).toEqual({
      kind: "revokeInvite",
      inviteId: "redeem",
    });
  });

  test("matches ingress invite routes", () => {
    expect(matchIngressControlPlaneRoute("/v1/ingress/invites", "GET")).toEqual(
      {
        kind: "listInvites",
      },
    );
    expect(
      matchIngressControlPlaneRoute("/v1/ingress/invites", "POST"),
    ).toEqual({
      kind: "createInvite",
    });
    expect(
      matchIngressControlPlaneRoute("/v1/ingress/invites/inv_1", "DELETE"),
    ).toEqual({
      kind: "revokeInvite",
      inviteId: "inv_1",
    });
  });

  test("returns null for unsupported method/path combinations", () => {
    expect(
      matchIngressControlPlaneRoute("/v1/ingress/invites/redeem", "GET"),
    ).toBeNull();
    expect(
      matchIngressControlPlaneRoute("/v1/ingress/invites/inv_1", "POST"),
    ).toBeNull();
    expect(
      matchIngressControlPlaneRoute("/v1/ingress/unknown", "GET"),
    ).toBeNull();
  });
});
