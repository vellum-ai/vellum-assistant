/**
 * `resolveTurnModelSelection` is the one place that answers "which profile and
 * which model does this turn's next provider call run on". Two callers depend
 * on it splitting those apart: the user-facing profile-change notice reads the
 * profile key, and the per-turn plugin tool gate reads the model.
 *
 * A weighted mix is where the two answers diverge. The mix is the winner and
 * carries its own name, while the call runs on one expanded arm, so a gate
 * reading the key would be told nothing about the model and a notice reading
 * the model would name an A/B arm to the user.
 */

import { describe, expect, test } from "bun:test";

import { LLMSchema } from "../config/schemas/llm.js";
import { resolveTurnModelSelection } from "../providers/inference/turn-model-selection.js";

const armProfile = {
  source: "user" as const,
  provider: "openai" as const,
  provider_connection: "openai-personal",
};

const mixLlm = LLMSchema.parse({
  profiles: {
    "text-arm": { ...armProfile, model: "gpt-5.4" },
    "vision-arm": { ...armProfile, model: "gpt-5.5" },
    experiment: {
      source: "user",
      mix: [
        { profile: "text-arm", weight: 1 },
        { profile: "vision-arm", weight: 1 },
      ],
    },
  },
  defaultProvider: { provider: "anthropic" },
});

describe("resolveTurnModelSelection", () => {
  test("a standard profile reports its own key and its own model", () => {
    const selection = resolveTurnModelSelection("mainAgent", mixLlm, {
      overrideProfile: "text-arm",
      selectionSeed: "conv-1",
    });

    expect(selection.profileKey).toBe("text-arm");
    expect(selection.model).toBe("gpt-5.4");
  });

  test("a mix reports the mix's key and the expanded arm's model", () => {
    const selection = resolveTurnModelSelection("mainAgent", mixLlm, {
      overrideProfile: "experiment",
      selectionSeed: "conv-1",
    });

    // The notice names the mix, so an A/B arm name never reaches a user.
    expect(selection.profileKey).toBe("experiment");
    // The tool gate gets a concrete model, never the mix's name.
    expect(selection.model).not.toBe("experiment");
    expect(["gpt-5.4", "gpt-5.5"]).toContain(selection.model);
  });

  test("a mix's model is stable for a seed and splits across seeds", () => {
    const models = new Set<string>();
    const seeds = Array.from({ length: 40 }, (_, i) => `conv-${i}`);
    for (const seed of seeds) {
      const first = resolveTurnModelSelection("mainAgent", mixLlm, {
        overrideProfile: "experiment",
        selectionSeed: seed,
      }).model;
      const again = resolveTurnModelSelection("mainAgent", mixLlm, {
        overrideProfile: "experiment",
        selectionSeed: seed,
      }).model;
      // Every turn of one conversation gates identically: a plugin predicate
      // is consistently right for a conversation, never flapping mid-turn.
      expect(again).toBe(first);
      models.add(first);
    }
    // Both arms are reachable, so the model a gate reads really does depend on
    // the expansion rather than being a fixed property of the mix.
    expect(models).toEqual(new Set(["gpt-5.4", "gpt-5.5"]));
  });
});
