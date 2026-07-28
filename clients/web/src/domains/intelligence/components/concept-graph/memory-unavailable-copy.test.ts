/**
 * The unavailable-graph surface's copy decision. An unavailable graph has two
 * distinct causes with two distinct fixes, and naming the wrong one is worse
 * than the bare "not available" this replaced — so the mapping is pinned here.
 */
import { describe, expect, test } from "bun:test";

import {
  describeMemoryUnavailable,
  MEMORY_V3_UPGRADE_PROMPT,
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

describe("MEMORY_V3_UPGRADE_PROMPT", () => {
  test("asks the assistant to check the corpus before rewriting it", () => {
    // The seed drives a real, irreversible reform of the concept corpus; both
    // the check and the confirmation are load-bearing, not politeness.
    expect(MEMORY_V3_UPGRADE_PROMPT).toContain("v3");
    expect(MEMORY_V3_UPGRADE_PROMPT.toLowerCase()).toContain("empty");
    expect(MEMORY_V3_UPGRADE_PROMPT.toLowerCase()).toContain("before");
  });
});
