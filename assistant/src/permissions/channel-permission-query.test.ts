import { describe, expect, test } from "bun:test";

import {
  collapseChannelThresholdForContact,
  effectiveChannelCellThreshold,
} from "./channel-permission-query.js";

describe("collapseChannelThresholdForContact", () => {
  test.each([
    ["none", "none"],
    ["low", "low"],
    ["medium", "low"],
    ["high", "low"],
  ] as const)("%s collapses to %s", (input, expected) => {
    expect(collapseChannelThresholdForContact(input)).toBe(expected);
  });
});

describe("effectiveChannelCellThreshold", () => {
  const resolved = (threshold: "none" | "low" | "medium" | "high") => ({
    ok: true as const,
    resolved: { threshold },
  });
  const noCell = { ok: true as const, resolved: null };
  const failed = { ok: false as const };

  test("a transport failure authorizes nothing, for every contact type", () => {
    for (const contactType of [
      "guardian",
      "trusted_contact",
      "unverified_contact",
      "unknown",
    ] as const) {
      expect(
        effectiveChannelCellThreshold(failed, contactType, "low"),
      ).toBeUndefined();
    }
  });

  test("a contact's resolved cell is collapsed", () => {
    expect(
      effectiveChannelCellThreshold(resolved("high"), "trusted_contact", "low"),
    ).toBe("low");
    expect(
      effectiveChannelCellThreshold(resolved("none"), "trusted_contact", "low"),
    ).toBe("none");
  });

  test("a contact with no cell gets the caller-derived room default", () => {
    expect(
      effectiveChannelCellThreshold(noCell, "trusted_contact", "low"),
    ).toBe("low");
    expect(
      effectiveChannelCellThreshold(noCell, "trusted_contact", "none"),
    ).toBe("none");
    expect(
      effectiveChannelCellThreshold(noCell, "trusted_contact", undefined),
    ).toBeUndefined();
  });

  test("guardian queries pass through raw and ignore the room default", () => {
    expect(
      effectiveChannelCellThreshold(resolved("high"), "guardian", "low"),
    ).toBe("high");
    expect(
      effectiveChannelCellThreshold(noCell, "guardian", "low"),
    ).toBeUndefined();
  });
});
