import { describe, expect, mock, test } from "bun:test";

import {
  isTrustCheckedScopeProfile,
  routeAdmitsTrustClass,
  tokenMayReachRoute,
  TRUST_EXEMPT_SCOPE_PROFILES,
} from "../route-trust-class.js";

const CONTACT_ROUTE = ["guardian", "trusted_contact", "unverified_contact"];

const contactMayReach = (
  allowed: readonly string[] | undefined,
  resolve: () => Promise<string | undefined>,
) => tokenMayReachRoute("contact_client_v1", allowed, resolve);

describe("routeAdmitsTrustClass", () => {
  test("an absent list admits the guardian only", () => {
    expect(routeAdmitsTrustClass(undefined, "guardian")).toBe(true);
    expect(routeAdmitsTrustClass(undefined, "trusted_contact")).toBe(false);
    expect(routeAdmitsTrustClass(undefined, "unknown")).toBe(false);
  });

  test("a listed class is admitted and an unlisted one refused", () => {
    expect(routeAdmitsTrustClass(CONTACT_ROUTE, "trusted_contact")).toBe(true);
    expect(routeAdmitsTrustClass(CONTACT_ROUTE, "unknown")).toBe(false);
  });

  test("a value outside the vocabulary is refused even when listed", () => {
    expect(routeAdmitsTrustClass(["owner"], "owner")).toBe(false);
    expect(routeAdmitsTrustClass(CONTACT_ROUTE, undefined)).toBe(false);
  });
});

describe("tokenMayReachRoute for a contact token", () => {
  test("a route admitting only the guardian refuses without resolving", async () => {
    const resolve = mock(async () => "trusted_contact");
    expect(await contactMayReach(undefined, resolve)).toBe(false);
    expect(await contactMayReach(["guardian"], resolve)).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  test.each([
    ["trusted_contact", true],
    ["unverified_contact", true],
    ["unknown", false],
    ["guardian", false],
    [undefined, false],
  ] as const)(
    "a contact route resolving %p admits: %p",
    async (trustClass, admitted) => {
      expect(await contactMayReach(CONTACT_ROUTE, async () => trustClass)).toBe(
        admitted,
      );
    },
  );

  test("a class the route does not list is refused", async () => {
    expect(
      await contactMayReach(
        ["guardian", "trusted_contact"],
        async () => "unverified_contact",
      ),
    ).toBe(false);
  });

  test("a resolver that throws refuses", async () => {
    expect(
      await contactMayReach(CONTACT_ROUTE, async () => {
        throw new Error("gateway unreachable");
      }),
    ).toBe(false);
  });
});

describe("isTrustCheckedScopeProfile", () => {
  test("an exempt profile is not trust-checked", () => {
    for (const profile of TRUST_EXEMPT_SCOPE_PROFILES) {
      expect(isTrustCheckedScopeProfile(profile)).toBe(false);
    }
  });

  test("the contact profile, unknown profiles and prototype keys are", () => {
    for (const profile of [
      "contact_client_v1",
      "bogus_v1",
      "toString",
      "constructor",
      "__proto__",
    ]) {
      expect(isTrustCheckedScopeProfile(profile)).toBe(true);
    }
  });
});

describe("tokenMayReachRoute for a trust-exempt token", () => {
  test.each([...TRUST_EXEMPT_SCOPE_PROFILES])(
    "%s counts as the guardian without a lookup",
    async (profile) => {
      const resolve = mock(async () => "trusted_contact");
      expect(await tokenMayReachRoute(profile, undefined, resolve)).toBe(true);
      expect(await tokenMayReachRoute(profile, CONTACT_ROUTE, resolve)).toBe(
        true,
      );
      expect(
        await tokenMayReachRoute(profile, ["trusted_contact"], resolve),
      ).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
    },
  );
});
