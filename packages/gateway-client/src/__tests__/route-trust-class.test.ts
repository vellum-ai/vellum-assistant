import { describe, expect, mock, test } from "bun:test";

import {
  contactTokenMayReachRoute,
  routeAdmitsTrustClass,
} from "../route-trust-class.js";

const CONTACT_ROUTE = ["guardian", "trusted_contact", "unverified_contact"];

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

describe("contactTokenMayReachRoute", () => {
  test("a route admitting only the guardian refuses without resolving", async () => {
    const resolve = mock(async () => "trusted_contact");
    expect(await contactTokenMayReachRoute(undefined, resolve)).toBe(false);
    expect(await contactTokenMayReachRoute(["guardian"], resolve)).toBe(false);
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
      expect(
        await contactTokenMayReachRoute(CONTACT_ROUTE, async () => trustClass),
      ).toBe(admitted);
    },
  );

  test("a class the route does not list is refused", async () => {
    expect(
      await contactTokenMayReachRoute(
        ["guardian", "trusted_contact"],
        async () => "unverified_contact",
      ),
    ).toBe(false);
  });

  test("a resolver that throws refuses", async () => {
    expect(
      await contactTokenMayReachRoute(CONTACT_ROUTE, async () => {
        throw new Error("gateway unreachable");
      }),
    ).toBe(false);
  });
});
