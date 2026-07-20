/**
 * Gating behavior of the overview's drill-down section list: Memory only
 * appears behind the memory-concept-graph flag, Channels only behind the
 * channel-trust-floors flag, and the stable sections keep their order.
 */
import { describe, expect, test } from "bun:test";

import { buildIdentitySections } from "./identity-sections";

const keys = (gates: Parameters<typeof buildIdentitySections>[0]) =>
  buildIdentitySections(gates).map((s) => s.key);

describe("buildIdentitySections", () => {
  test("includes every section when all gates are open", () => {
    expect(keys({ showChannels: true, showMemory: true })).toEqual([
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

  test("hides Memory while memory-concept-graph is off", () => {
    expect(keys({ showChannels: true, showMemory: false })).not.toContain(
      "memory",
    );
  });

  test("hides Channels while channel-trust-floors is off", () => {
    expect(keys({ showChannels: false, showMemory: false })).toEqual([
      "personality",
      "schedules",
      "superpowers",
      "library",
      "workspace",
      "contacts",
    ]);
  });
});
