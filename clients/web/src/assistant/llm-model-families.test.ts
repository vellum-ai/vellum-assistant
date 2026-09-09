/**
 * Invariants behind `LlmCatalogModel.family`.
 *
 * `family` is what lets a cross-provider picker offer the newest member of a
 * model line and fold its older siblings away, so what the picker leans on is
 * guarded here rather than discovered as a wrong list.
 *
 * The catalog is authored newest first, which is not a fact a test can derive
 * from a display name. What it can hold is the two things that make "first in
 * catalog order" mean "newest": the members of a line are ordered the same way
 * wherever the line appears, and the member that leads each line is the one
 * pinned below.
 */

import { describe, expect, test } from "bun:test";

import { MODELS_BY_PROVIDER } from "@/assistant/llm-model-catalog";

const entries = Object.entries(MODELS_BY_PROVIDER) as [
  string,
  readonly { id: string; displayName: string; family?: string }[],
][];

/** The member that leads each line, and so the one a picker shows. */
const NEWEST_IN_FAMILY: Record<string, string> = {
  "claude-fable": "Claude Fable 5.1",
  "claude-opus": "Claude Opus 5",
  "claude-sonnet": "Claude Sonnet 5",
  "gpt-5": "GPT-5.5",
  "gemini-flash": "Gemini 3.7 Flash",
  "gemini-flash-lite": "Gemini 3.5 Flash-Lite",
  "gemini-pro": "Gemini 3.1 Pro Preview",
  grok: "Grok 4.6",
  "kimi-k": "Kimi K3",
  "minimax-m": "MiniMax M3",
  glm: "GLM 5.3",
};

describe("model families", () => {
  test("a display name carries the same family under every provider", () => {
    const seen = new Map<string, string | undefined>();
    for (const [, models] of entries) {
      for (const model of models) {
        if (!seen.has(model.displayName)) {
          seen.set(model.displayName, model.family);
          continue;
        }
        expect(
          seen.get(model.displayName),
          `"${model.displayName}" carries two different families`,
        ).toBe(model.family);
      }
    }
  });

  test("every declared family has more than one member to fold", () => {
    const members = new Map<string, Set<string>>();
    for (const [, models] of entries) {
      for (const model of models) {
        if (!model.family) {
          continue;
        }
        const set = members.get(model.family) ?? new Set<string>();
        set.add(model.displayName);
        members.set(model.family, set);
      }
    }
    expect(members.size).toBeGreaterThan(0);
    for (const [family, displayNames] of members) {
      expect(
        displayNames.size,
        `family "${family}" has nothing to fold away`,
      ).toBeGreaterThan(1);
    }
  });

  test("every declared family is pinned to a newest member", () => {
    const declared = new Set<string>();
    for (const [, models] of entries) {
      for (const model of models) {
        if (model.family) {
          declared.add(model.family);
        }
      }
    }
    expect([...declared].sort()).toEqual(Object.keys(NEWEST_IN_FAMILY).sort());
  });

  test("a family's first member in catalog order is its newest", () => {
    for (const [providerId, models] of entries) {
      const leaders = new Map<string, string>();
      for (const model of models) {
        if (model.family && !leaders.has(model.family)) {
          leaders.set(model.family, model.displayName);
        }
      }
      for (const [family, leader] of leaders) {
        // A provider that hosts only older members leads with one of those,
        // so the pin is checked against the providers that host the newest.
        if (!models.some((m) => m.displayName === NEWEST_IN_FAMILY[family])) {
          continue;
        }
        expect(
          leader,
          `${providerId} lists family "${family}" out of newest-first order`,
        ).toBe(NEWEST_IN_FAMILY[family]);
      }
    }
  });

  test("a family's members keep one relative order across providers", () => {
    const canonicalOrder = new Map<string, string[]>();
    for (const [providerId, models] of entries) {
      const perFamily = new Map<string, string[]>();
      for (const model of models) {
        if (!model.family) {
          continue;
        }
        perFamily.set(model.family, [
          ...(perFamily.get(model.family) ?? []),
          model.displayName,
        ]);
      }
      for (const [family, names] of perFamily) {
        const canonical = canonicalOrder.get(family);
        if (!canonical) {
          canonicalOrder.set(family, names);
          continue;
        }
        // This provider's subset must read as a subsequence of the first
        // provider's order, plus any member only it hosts. A reshuffle would
        // make "the newest" depend on which provider serves the model.
        const shared = canonical.filter((name) => names.includes(name));
        const only = names.filter((name) => !canonical.includes(name));
        expect(
          names,
          `${providerId} orders family "${family}" differently`,
        ).toEqual([...shared, ...only]);
      }
    }
  });
});
