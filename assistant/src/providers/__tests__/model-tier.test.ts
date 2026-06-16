import { describe, expect, test } from "bun:test";

import {
  CLAUDE_FAMILY_RANK,
  isStrictlyMoreCapable,
  parseModelCapability,
} from "../model-tier.js";

describe("parseModelCapability", () => {
  test("parses tiered Claude families with version", () => {
    expect(parseModelCapability("claude-opus-4-8")).toEqual({
      lineage: "claude",
      familyRank: CLAUDE_FAMILY_RANK.opus!,
      version: 4.8,
    });
    expect(parseModelCapability("claude-sonnet-4-6")).toEqual({
      lineage: "claude",
      familyRank: CLAUDE_FAMILY_RANK.sonnet!,
      version: 4.6,
    });
  });

  test("ignores a trailing date suffix", () => {
    expect(parseModelCapability("claude-haiku-4-5-20251001")).toEqual({
      lineage: "claude",
      familyRank: CLAUDE_FAMILY_RANK.haiku!,
      version: 4.5,
    });
  });

  test("is case-insensitive", () => {
    expect(parseModelCapability("Claude-Opus-4-8")).toEqual({
      lineage: "claude",
      familyRank: CLAUDE_FAMILY_RANK.opus!,
      version: 4.8,
    });
  });

  test("parses dotted, provider-prefixed OpenRouter ids", () => {
    expect(parseModelCapability("anthropic/claude-opus-4.8")).toEqual({
      lineage: "claude",
      familyRank: CLAUDE_FAMILY_RANK.opus!,
      version: 4.8,
    });
    expect(parseModelCapability("anthropic/claude-sonnet-4.6")).toEqual({
      lineage: "claude",
      familyRank: CLAUDE_FAMILY_RANK.sonnet!,
      version: 4.6,
    });
    expect(parseModelCapability("anthropic/claude-haiku-4.5")).toEqual({
      lineage: "claude",
      familyRank: CLAUDE_FAMILY_RANK.haiku!,
      version: 4.5,
    });
  });

  test("dashed and dotted forms of the same model encode equal capability", () => {
    expect(parseModelCapability("anthropic/claude-opus-4.8")).toEqual(
      parseModelCapability("claude-opus-4-8")!,
    );
  });

  test("parses a dotted, provider-prefixed single-tier id", () => {
    expect(parseModelCapability("anthropic/claude-fable-5")).toEqual({
      lineage: "fable",
      familyRank: 0,
      version: 5,
    });
  });

  test("parses single-tier lineages with familyRank 0", () => {
    expect(parseModelCapability("claude-fable-5")).toEqual({
      lineage: "fable",
      familyRank: 0,
      version: 5,
    });
    expect(parseModelCapability("claude-mythos-5")).toEqual({
      lineage: "mythos",
      familyRank: 0,
      version: 5,
    });
  });

  test("returns null for non-Claude and unknown ids", () => {
    expect(parseModelCapability("gpt-4o")).toBeNull();
    expect(parseModelCapability("minimax-m3")).toBeNull();
    expect(parseModelCapability("gemini-2.5-pro")).toBeNull();
    expect(parseModelCapability("")).toBeNull();
  });
});

describe("isStrictlyMoreCapable", () => {
  test("cross-family within the claude lineage: opus > sonnet > haiku", () => {
    expect(
      isStrictlyMoreCapable("claude-opus-4-8", "claude-sonnet-4-6"),
    ).toBe(true);
    expect(
      isStrictlyMoreCapable("claude-sonnet-4-6", "claude-haiku-4-5-20251001"),
    ).toBe(true);
    expect(
      isStrictlyMoreCapable("claude-opus-4-8", "claude-haiku-4-5-20251001"),
    ).toBe(true);
  });

  test("lower family is not more capable than higher family", () => {
    expect(
      isStrictlyMoreCapable("claude-sonnet-4-6", "claude-opus-4-8"),
    ).toBe(false);
    expect(
      isStrictlyMoreCapable("claude-haiku-4-5-20251001", "claude-sonnet-4-6"),
    ).toBe(false);
  });

  test("version tiebreak within the same family", () => {
    expect(
      isStrictlyMoreCapable("claude-opus-4-8", "claude-opus-4-6"),
    ).toBe(true);
    expect(
      isStrictlyMoreCapable("claude-opus-4-6", "claude-opus-4-8"),
    ).toBe(false);
  });

  test("equal models are not strictly more capable", () => {
    expect(
      isStrictlyMoreCapable("claude-opus-4-8", "claude-opus-4-8"),
    ).toBe(false);
  });

  test("cross-lineage comparisons are always false", () => {
    expect(isStrictlyMoreCapable("claude-opus-4-8", "claude-fable-5")).toBe(
      false,
    );
    expect(isStrictlyMoreCapable("claude-fable-5", "claude-opus-4-8")).toBe(
      false,
    );
    expect(isStrictlyMoreCapable("claude-opus-4-8", "claude-mythos-5")).toBe(
      false,
    );
    expect(isStrictlyMoreCapable("claude-mythos-5", "claude-opus-4-8")).toBe(
      false,
    );
  });

  test("ranks dotted, provider-prefixed OpenRouter ids", () => {
    expect(
      isStrictlyMoreCapable(
        "anthropic/claude-opus-4.8",
        "anthropic/claude-sonnet-4.6",
      ),
    ).toBe(true);
    expect(
      isStrictlyMoreCapable(
        "anthropic/claude-sonnet-4.6",
        "anthropic/claude-opus-4.8",
      ),
    ).toBe(false);
  });

  test("dashed and dotted forms of the same model are equal (neither more capable)", () => {
    expect(
      isStrictlyMoreCapable("claude-opus-4-8", "anthropic/claude-opus-4.8"),
    ).toBe(false);
    expect(
      isStrictlyMoreCapable("anthropic/claude-opus-4.8", "claude-opus-4-8"),
    ).toBe(false);
  });

  test("a dotted single-tier id is cross-lineage-false vs opus", () => {
    expect(parseModelCapability("anthropic/claude-fable-5")).not.toBeNull();
    expect(
      isStrictlyMoreCapable(
        "anthropic/claude-fable-5",
        "anthropic/claude-opus-4.8",
      ),
    ).toBe(false);
    expect(
      isStrictlyMoreCapable(
        "anthropic/claude-opus-4.8",
        "anthropic/claude-fable-5",
      ),
    ).toBe(false);
  });

  test("unknown or non-Claude model on either side is false", () => {
    expect(isStrictlyMoreCapable("gpt-4o", "claude-opus-4-8")).toBe(false);
    expect(isStrictlyMoreCapable("claude-opus-4-8", "gpt-4o")).toBe(false);
    expect(isStrictlyMoreCapable("minimax-m3", "claude-sonnet-4-6")).toBe(
      false,
    );
    expect(isStrictlyMoreCapable("claude-sonnet-4-6", "minimax-m3")).toBe(
      false,
    );
    expect(isStrictlyMoreCapable("gpt-4o", "minimax-m3")).toBe(false);
  });

  test("date-only Claude slugs do not outrank a real major.minor release", () => {
    // The release date sits where the minor would be; it must parse as
    // major-only (4.0), not minor 20250514.
    expect(parseModelCapability("claude-sonnet-4-20250514")).toEqual({
      lineage: "claude",
      familyRank: CLAUDE_FAMILY_RANK.sonnet!,
      version: 4,
    });
    // The dated 4.x build must NOT be surfaced as an upgrade over 4.6.
    expect(
      isStrictlyMoreCapable("claude-sonnet-4-20250514", "claude-sonnet-4-6"),
    ).toBe(false);
    // A higher family still upgrades over a dated lower-family build.
    expect(
      isStrictlyMoreCapable("claude-opus-4-8", "claude-sonnet-4-20250514"),
    ).toBe(true);
  });
});
