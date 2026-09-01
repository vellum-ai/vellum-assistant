import { describe, expect, test } from "bun:test";

import {
  orderedProfileEntries,
  pickManagedRecoveryProfile,
} from "@/domains/chat/utils/managed-recovery-profile";

const DISPATCHABLE = { requireOwnProviderAndModel: true } as const;

describe("orderedProfileEntries", () => {
  test("follows profileOrder then appends extras", () => {
    expect(
      orderedProfileEntries(
        {
          quality: { source: "managed" },
          balanced: { source: "managed" },
          custom: { source: "user" },
        },
        ["balanced", "quality"],
      ).map((entry) => entry.name),
    ).toEqual(["balanced", "quality", "custom"]);
  });
});

describe("pickManagedRecoveryProfile", () => {
  test("prefers the shipped balanced profile when it can dispatch", () => {
    const entries = orderedProfileEntries(
      {
        quality: {
          source: "managed",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
        balanced: {
          source: "managed",
          provider: "fireworks",
          model: "accounts/fireworks/models/glm-5p2",
        },
        custom: {
          source: "user",
          provider: "openai-compatible",
          model: "glm-5-2",
        },
      },
      ["quality", "custom", "balanced"],
    );

    expect(pickManagedRecoveryProfile(entries, DISPATCHABLE, "custom")).toBe(
      "balanced",
    );
  });

  test("skips the excluded profile and user-owned keys", () => {
    const entries = orderedProfileEntries(
      {
        balanced: {
          source: "user",
          provider: "openai-compatible",
          model: "glm-5-2",
        },
        quality: {
          source: "managed",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      },
      ["balanced", "quality"],
    );

    expect(pickManagedRecoveryProfile(entries, DISPATCHABLE, "balanced")).toBe(
      "quality",
    );
  });

  test("returns null when no managed profile can dispatch", () => {
    const entries = orderedProfileEntries(
      {
        custom: {
          source: "user",
          provider: "openai-compatible",
          model: "glm-5-2",
        },
        broken: { source: "managed" },
      },
      ["custom", "broken"],
    );

    expect(pickManagedRecoveryProfile(entries, DISPATCHABLE)).toBeNull();
  });

  test("returns the first dispatchable managed profile when balanced is absent", () => {
    const entries = orderedProfileEntries(
      {
        quality: {
          source: "managed",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
        fast: {
          source: "managed",
          provider: "openai",
          model: "gpt-5.4-mini",
        },
      },
      ["quality", "fast"],
    );

    expect(pickManagedRecoveryProfile(entries, DISPATCHABLE)).toBe("quality");
  });
});
