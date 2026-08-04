import { describe, expect, test } from "bun:test";

import { profileSupportsTools } from "../profile-tool-support.js";
import type { AssistantConfig } from "../schema.js";
import { LLMSchema } from "../schemas/llm.js";

/** An `AssistantConfig` carrying nothing the profile lookup does not read. */
function configWithProfiles(
  profiles: Record<string, Record<string, unknown>>,
): AssistantConfig {
  return { llm: LLMSchema.parse({ profiles }) } as AssistantConfig;
}

describe("profileSupportsTools", () => {
  test("reports false only for a model the catalog declares tool-less", () => {
    const config = configWithProfiles({
      "no-tools": { provider: "openrouter", model: "minimax/minimax-01" },
    });
    expect(profileSupportsTools("no-tools", config)).toBe(false);
  });

  test("reports true for a catalog model declared tool-capable", () => {
    const config = configWithProfiles({
      "with-tools": { provider: "anthropic", model: "claude-fable-5" },
    });
    expect(profileSupportsTools("with-tools", config)).toBe(true);
  });

  test("fails open for a BYOK model the catalog has never seen", () => {
    const config = configWithProfiles({
      byok: { provider: "openrouter", model: "acme/private-llm-9" },
    });
    expect(profileSupportsTools("byok", config)).toBeUndefined();
  });

  test("fails open for a profile key that resolves to nothing", () => {
    expect(profileSupportsTools("not-a-profile", configWithProfiles({}))).toBe(
      undefined,
    );
  });

  test("verdicts a catalog default profile through the code catalog", () => {
    // `balanced` carries no workspace body, so the answer has to come from the
    // resolved default-profile catalog rather than `llm.profiles`.
    expect(profileSupportsTools("balanced", configWithProfiles({}))).toBe(true);
  });

  test("reports false for a mix whose every arm is catalog-denied", () => {
    const config = configWithProfiles({
      "no-tools": { provider: "openrouter", model: "minimax/minimax-01" },
      "no-tools-too": {
        provider: "openrouter",
        model: "minimax/minimax-m2-her",
      },
      blend: {
        mix: [
          { profile: "no-tools", weight: 1 },
          { profile: "no-tools-too", weight: 1 },
        ],
      },
    });
    // Whichever arm the child's seed lands on, it cannot call tools.
    expect(profileSupportsTools("blend", config)).toBe(false);
  });

  test("reports true for a mix whose every arm is catalog-capable", () => {
    const config = configWithProfiles({
      "tools-a": { provider: "anthropic", model: "claude-fable-5" },
      "tools-b": {
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
      },
      blend: {
        mix: [
          { profile: "tools-a", weight: 3 },
          { profile: "tools-b", weight: 1 },
        ],
      },
    });
    expect(profileSupportsTools("blend", config)).toBe(true);
  });

  test("fails open for a mix of tool-capable and tool-less arms", () => {
    const config = configWithProfiles({
      "no-tools": { provider: "openrouter", model: "minimax/minimax-01" },
      "with-tools": { provider: "anthropic", model: "claude-fable-5" },
      blend: {
        mix: [
          { profile: "no-tools", weight: 1 },
          { profile: "with-tools", weight: 1 },
        ],
      },
    });
    // The arm is picked from the child conversation's seed, and no such
    // conversation exists yet, so neither arm's verdict speaks for the mix.
    expect(profileSupportsTools("blend", config)).toBeUndefined();
  });

  test("fails open for a mix with an arm the catalog has never seen", () => {
    const config = configWithProfiles({
      "no-tools": { provider: "openrouter", model: "minimax/minimax-01" },
      byok: { provider: "openrouter", model: "acme/private-llm-9" },
      blend: {
        mix: [
          { profile: "no-tools", weight: 1 },
          { profile: "byok", weight: 1 },
        ],
      },
    });
    expect(profileSupportsTools("blend", config)).toBeUndefined();
  });

  test("answers a mixed-capability mix identically on every call", () => {
    const config = configWithProfiles({
      "no-tools": { provider: "openrouter", model: "minimax/minimax-01" },
      "with-tools": { provider: "anthropic", model: "claude-fable-5" },
      blend: {
        mix: [
          { profile: "no-tools", weight: 1 },
          { profile: "with-tools", weight: 1 },
        ],
      },
    });
    // No seed is available at probe time, so the verdict must not ride on a
    // random arm pick.
    const verdicts = new Set(
      Array.from({ length: 50 }, () => profileSupportsTools("blend", config)),
    );
    expect([...verdicts]).toEqual([undefined]);
  });
});
