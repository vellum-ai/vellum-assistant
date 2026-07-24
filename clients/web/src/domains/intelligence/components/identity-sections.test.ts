/**
 * Gating behavior of the overview's drill-down section list: Memory only
 * appears where the memory-concept graph is available (memory v3 live),
 * Channels is always present (the surface is no longer flag-gated), and the
 * stable sections keep their order.
 */
import { describe, expect, test } from "bun:test";

import { buildIdentitySections } from "./identity-sections";

const keys = (gates: Parameters<typeof buildIdentitySections>[0]) =>
  buildIdentitySections(gates).map((s) => s.key);

describe("buildIdentitySections", () => {
  test("includes every section when the memory graph is available", () => {
    expect(keys({ showMemory: true })).toEqual([
      "personality",
      "schedules",
      "superpowers",
      "memory",
      "library",
      "workspace",
      "contacts",
      "channels",
    ]);
  });

  test("hides Memory while the memory-concept graph is unavailable", () => {
    expect(keys({ showMemory: false })).not.toContain("memory");
  });

  test("always includes Channels", () => {
    expect(keys({ showMemory: true })).toContain("channels");
    expect(keys({ showMemory: false })).toContain("channels");
  });
});
