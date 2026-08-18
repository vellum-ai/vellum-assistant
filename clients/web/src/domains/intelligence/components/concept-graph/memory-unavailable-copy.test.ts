/**
 * The unavailable-graph surface's copy decision. An unavailable graph has two
 * distinct causes with two distinct fixes, and naming the wrong one is worse
 * than the bare "not available" this replaced — so the mapping is pinned here.
 */
import { describe, expect, test } from "bun:test";

import {
  describeMemoryUnavailable,
  memoryEnablePrompt,
  memoryStatusErrorCopy,
  memoryV1UpgradePrompt,
  memoryV2UpgradePrompt,
} from "./memory-unavailable-copy";

describe("describeMemoryUnavailable", () => {
  test("memory-off points at Settings, not at an upgrade", () => {
    const copy = describeMemoryUnavailable("off");
    expect(copy.action).toBe("settings");
    expect(copy.title).toBe("Memory is turned off");
    // The owner switched memory off themselves; telling them to migrate to v3
    // would name a fix that isn't the problem.
    expect(copy.detail).not.toContain("v3");
  });

  test("memory-off does not promise the graph will appear", () => {
    // `off` masks the underlying tier: an assistant can be both memory-off and
    // pre-v3, and turning memory on restores remembering without building any
    // graph. Promise only what the toggle delivers.
    const { detail } = describeMemoryUnavailable("off");
    expect(detail).not.toMatch(/build/i);
    expect(detail).toContain("start remembering again");
  });

  test.each(["v1", "v2"] as const)(
    "legacy tier %s offers the v3 upgrade",
    (tier) => {
      const copy = describeMemoryUnavailable(tier);
      expect(copy.action).toBe("upgrade");
      expect(copy.title).toBe("Upgrade to memory v3");
    },
  );

  test("an unknown tier explains without offering a fix", () => {
    // Older daemons omit `tier`. Neutral copy, no CTA.
    const copy = describeMemoryUnavailable(undefined);
    expect(copy.action).toBe("none");
    expect(copy.title).toBe("Memory graph isn't available");
  });

  test("the unknown-tier fallback does not claim an update reaches v3", () => {
    // Updating ships the code but never flips `memory.v3.live` — existing
    // workspaces only get there through the corpus migration. What the update
    // does buy is the `tier` field, and with it a specific answer here.
    const { detail } = describeMemoryUnavailable(undefined);
    expect(detail).toContain("Update your assistant");
    expect(detail).not.toMatch(/moves it to memory v3|to memory v3\./i);
  });

  test("a v3 tier reporting no graph falls back to neutral copy", () => {
    // Contradictory (stats says v3, the graph route says unsupported) — never
    // claim an upgrade will fix what is already upgraded.
    expect(describeMemoryUnavailable("v3").action).toBe("none");
  });

  test("every branch has copy", () => {
    for (const tier of ["off", "v1", "v2", "v3", undefined] as const) {
      const copy = describeMemoryUnavailable(tier);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("memoryStatusErrorCopy", () => {
  test("does not diagnose a tier it never managed to read", () => {
    // A failed stats read leaves `tier` undefined exactly as an older daemon
    // does. Borrowing the unknown-tier copy would tell the owner of a current,
    // momentarily unreachable assistant to go update it.
    const statusError = memoryStatusErrorCopy();
    expect(statusError.title).not.toBe(
      describeMemoryUnavailable(undefined).title,
    );
    expect(statusError.detail).not.toMatch(/update your assistant/i);
    expect(statusError.detail).not.toContain("v3");
  });

  test("offers the one action that can help", () => {
    expect(memoryStatusErrorCopy().action).toBe("retry");
  });
});

describe("the upgrade seed per legacy tier", () => {
  const seeds = {
    v1: memoryV1UpgradePrompt,
    v2: memoryV2UpgradePrompt,
  } as const;

  test.each(Object.entries(seeds))(
    "%s reaches the right tier",
    (tier, seedFn) => {
      const seed = seedFn();
      expect(seed).toContain(`from ${tier} to v3`);
      expect(describeMemoryUnavailable(tier as "v1" | "v2").prompt).toBe(seed);
    },
  );

  test("v2 points at the reform skill", () => {
    expect(memoryV2UpgradePrompt()).toContain("Memory v3 Migration");
  });

  test("v1 points at both skills, in the order they have to run", () => {
    // The v2 migration backfills concepts/ from pkb/ and the buffer; the v3
    // migration reforms the result. Reaching for v3 first meets its
    // empty-corpus guard, so the order is the useful part of the hint.
    const seed = memoryV1UpgradePrompt();
    const v2At = seed.indexOf("Memory v2 Migration");
    const v3At = seed.indexOf("Memory v3 Migration");
    expect(v2At).toBeGreaterThan(-1);
    expect(v3At).toBeGreaterThan(v2At);
  });

  test.each(Object.entries(seeds))(
    "%s names the skill as a pointer, not a mandate",
    (_tier, seedFn) => {
      // Both skills carry `avoid-when` rules and some corpus shapes are
      // claimed by neither, so a seed that commits to one can hand the
      // assistant an instruction it has to refuse. The hedge is what lets it
      // deviate; it reads the skills and counts the pages, this file can't.
      const seed = seedFn();
      expect(seed).toContain("most likely");
      expect(seed.toLowerCase()).toContain("work out what");
    },
  );

  test.each(Object.entries(seeds))(
    "%s still binds the assistant to whatever it picks",
    (_tier, seedFn) => {
      // Delegating the choice is not loosening the rules: the skills' own hard
      // rules are what keep an irreversible corpus rewrite loss-proof.
      const seed = seedFn();
      expect(seed.toLowerCase()).toContain("exactly");
      // The rules themselves stay in the skills, which version separately.
      expect(seed).not.toContain("Step 10");
    },
  );

  test.each(Object.entries(seeds))(
    "%s runs in the background and reports back",
    (_tier, seedFn) => {
      const seed = seedFn();
      expect(seed.toLowerCase()).toContain("in the background");
      expect(seed.toLowerCase()).toContain("blocks");
    },
  );

  test.each(Object.entries(seeds))(
    "%s says nothing about cost or credits",
    (_tier, seedFn) => {
      const seed = seedFn();
      for (const word of ["cost", "credit", "spend", "estimate", "money"]) {
        expect(seed.toLowerCase()).not.toContain(word);
      }
    },
  );
});

describe("every seeded prompt", () => {
  const seeds = {
    v2: memoryV2UpgradePrompt,
    v1: memoryV1UpgradePrompt,
    enable: memoryEnablePrompt,
  };

  test.each(Object.entries(seeds))("%s uses no em dash", (_name, seedFn) => {
    // These land in the composer, where the assistant is forbidden from
    // writing one (SOUL.md), so a seed carrying an em dash puts words in its
    // mouth that it would never have typed. See the Em Dashes rule in
    // AGENTS.md.
    expect(seedFn()).not.toContain("—");
  });

  test.each(Object.entries(seeds))(
    "%s is reachable from a tier",
    (_n, seedFn) => {
      // Every state a user can actually land in, so a seed can't be orphaned
      // by a future routing change.
      const seed = seedFn();
      const prompts = (["off", "v1", "v2"] as const).map(
        (tier) => describeMemoryUnavailable(tier).prompt,
      );
      expect(prompts).toContain(seed);
    },
  );
});

describe("memoryEnablePrompt", () => {
  test("asks for the memory switch, not for a migration", () => {
    // This one runs for users who can't reach the Developer page's toggle, so
    // it must stay a plain request to flip `memory.enabled` — conflating it
    // with the v3 upgrade would start a corpus rewrite nobody asked for.
    const seed = memoryEnablePrompt();
    expect(seed.toLowerCase()).toContain("memory back on");
    expect(seed).not.toContain("v3");
  });
});
