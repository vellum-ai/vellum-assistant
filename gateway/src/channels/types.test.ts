import { describe, expect, test } from "bun:test";

import {
  INTERFACE_IDS as CANONICAL_INTERFACE_IDS,
  type InterfaceId as CanonicalInterfaceId,
} from "@vellumai/service-contracts/channels";

import { INTERFACE_IDS, isInterfaceId, parseInterfaceId } from "./types.js";

const EXPECTED_INTERFACE_IDS = [
  "macos",
  "ios",
  "cli",
  "telegram",
  "phone",
  "web",
  "whatsapp",
  "slack",
  "email",
  "a2a",
] as const satisfies readonly CanonicalInterfaceId[];

describe("gateway interface IDs", () => {
  test("accepts exactly the admitted subset", () => {
    expect(INTERFACE_IDS).toEqual(EXPECTED_INTERFACE_IDS);

    for (const id of EXPECTED_INTERFACE_IDS) {
      expect(isInterfaceId(id)).toBe(true);
      expect(parseInterfaceId(id)).toBe(id);
    }
  });

  test("rejects canonical interfaces outside the admitted subset", () => {
    const admitted = new Set<string>(EXPECTED_INTERFACE_IDS);
    const rejectedCanonicalIds = CANONICAL_INTERFACE_IDS.filter(
      (id) => !admitted.has(id),
    );

    expect(rejectedCanonicalIds).toEqual([
      "chrome-extension",
      "discord",
      "route",
    ]);
    for (const id of rejectedCanonicalIds) {
      expect(isInterfaceId(id)).toBe(false);
      expect(parseInterfaceId(id)).toBeNull();
    }
  });

  test("normalizes the legacy vellum alias through the admitted parser", () => {
    expect(isInterfaceId("vellum")).toBe(false);
    expect(parseInterfaceId("vellum")).toBe("web");
  });

  test("rejects unknown and non-string values", () => {
    for (const value of ["safari-extension", "", undefined, null, 42]) {
      expect(isInterfaceId(value)).toBe(false);
      expect(parseInterfaceId(value)).toBeNull();
    }
  });
});
