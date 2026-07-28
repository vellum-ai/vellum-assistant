/**
 * The unavailable-graph surface's copy decision. An unavailable graph has two
 * distinct causes with two distinct fixes, and naming the wrong one is worse
 * than the bare "not available" this replaced — so the mapping is pinned here.
 */
import { describe, expect, test } from "bun:test";

import {
  describeMemoryUnavailable,
  MEMORY_ENABLE_PROMPT,
  MEMORY_STATUS_ERROR_COPY,
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

describe("MEMORY_STATUS_ERROR_COPY", () => {
  test("does not diagnose a tier it never managed to read", () => {
    // A failed stats read leaves `tier` undefined exactly as an older daemon
    // does. Borrowing the unknown-tier copy would tell the owner of a current,
    // momentarily unreachable assistant to go update it.
    expect(MEMORY_STATUS_ERROR_COPY.title).not.toBe(
      describeMemoryUnavailable(undefined).title,
    );
    expect(MEMORY_STATUS_ERROR_COPY.detail).not.toMatch(
      /update your assistant/i,
    );
    expect(MEMORY_STATUS_ERROR_COPY.detail).not.toContain("v3");
  });

  test("offers the one action that can help", () => {
    expect(MEMORY_STATUS_ERROR_COPY.action).toBe("retry");
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

describe("MEMORY_ENABLE_PROMPT", () => {
  test("asks for the memory switch, not for a migration", () => {
    // This one runs for users who can't reach the Developer page's toggle, so
    // it must stay a plain request to flip `memory.enabled` — conflating it
    // with the v3 upgrade would start a corpus rewrite nobody asked for.
    expect(MEMORY_ENABLE_PROMPT.toLowerCase()).toContain("memory back on");
    expect(MEMORY_ENABLE_PROMPT).not.toContain("v3");
  });
});
