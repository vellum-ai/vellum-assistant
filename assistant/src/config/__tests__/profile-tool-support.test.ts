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

  test("reads the arm a mix expands to", () => {
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
    // Either arm is tool-less, so the seeded pick cannot change the verdict.
    expect(profileSupportsTools("blend", config)).toBe(false);
  });
});
