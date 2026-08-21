import { describe, expect, test } from "bun:test";

import { z } from "zod";

import { DEFAULT_PROFILE_KEYS } from "../config/default-profile-names.js";
import { LLMSchema } from "../config/schemas/llm.js";

describe("LLMSchema fallbackProfile", () => {
  test("profile with a valid fallbackProfile pointer parses", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { effort: "high", fallbackProfile: "backup" },
        backup: { speed: "fast" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profiles["primary"]?.fallbackProfile).toBe("backup");
    }
  });

  test("fallbackProfile may reference an always-available default profile key", () => {
    // Code-defined default profiles resolve without being materialized in
    // llm.profiles, so they are valid reference targets (same rule as
    // call-site `profile` references).
    const defaultKey = DEFAULT_PROFILE_KEYS[0];
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: defaultKey },
      },
    });
    expect(result.success).toBe(true);
  });

  test("dangling fallbackProfile pointer fails superRefine", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "ghost" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.message.includes('fallbackProfile "ghost"'),
      );
      expect(issue?.message).toContain("is not defined in llm.profiles");
      expect(issue?.path).toEqual(["profiles", "primary", "fallbackProfile"]);
    }
  });

  test("self-referencing fallbackProfile is rejected", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "primary" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.message.includes("cannot declare itself"),
      );
      expect(issue?.path).toEqual(["profiles", "primary", "fallbackProfile"]);
    }
  });

  test("fallbackProfile pointing at a mix profile is rejected", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "blend" },
        armA: { speed: "fast" },
        armB: { effort: "high" },
        blend: {
          mix: [
            { profile: "armA", weight: 1 },
            { profile: "armB", weight: 1 },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.message.includes("is a mix profile"),
      );
      expect(issue?.path).toEqual(["profiles", "primary", "fallbackProfile"]);
    }
  });

  test("two-hop fallback chain is rejected (single hop only)", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "middle" },
        middle: { fallbackProfile: "last" },
        last: { speed: "fast" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.message.includes("chains are not allowed"),
      );
      expect(issue?.path).toEqual(["profiles", "primary", "fallbackProfile"]);
    }
  });

  test("mix profile carrying fallbackProfile is rejected", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        armA: { speed: "fast" },
        armB: { effort: "high" },
        blend: {
          mix: [
            { profile: "armA", weight: 1 },
            { profile: "armB", weight: 1 },
          ],
          fallbackProfile: "armA",
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.message.includes('cannot also set "fallbackProfile"'),
      );
      expect(issue?.path).toEqual(["profiles", "blend", "fallbackProfile"]);
    }
  });

  test("empty-string fallbackProfile is rejected at field level", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        primary: { fallbackProfile: "" },
      },
    });
    expect(result.success).toBe(false);
  });

  test("profiles without fallbackProfile still parse (back-compat)", () => {
    const result = LLMSchema.safeParse({
      profiles: {
        fast: { speed: "fast", effort: "low" },
        thorough: { effort: "high", maxTokens: 128000 },
      },
      callSites: {
        mainAgent: { profile: "thorough" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profiles["fast"]?.fallbackProfile).toBeUndefined();
    }
  });

  test("z.toJSONSchema still generates for LLMSchema (config docs/routes)", () => {
    // Same options as handleGetConfigSchema in
    // runtime/routes/conversation-query-routes.ts. The field must not
    // introduce any callback-bearing zod construct that breaks generation.
    const json = z.toJSONSchema(LLMSchema, {
      unrepresentable: "any",
      io: "input",
    });
    expect(json).toBeTruthy();
  });
});
