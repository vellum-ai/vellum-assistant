/**
 * Gating behavior of the overview's drill-down section list: Plugins only
 * appears on plugin-capable assistants, Memory only behind the
 * memory-concept-graph flag, Channels only behind the channel-trust-floors
 * flag, and the stable sections keep their order.
 */
import { describe, expect, test } from "bun:test";

import { buildIdentitySections } from "./identity-sections";

const keys = (gates: Parameters<typeof buildIdentitySections>[0]) =>
  buildIdentitySections(gates).map((s) => s.key);

describe("buildIdentitySections", () => {
  test("includes every section when all gates are open", () => {
    expect(
      keys({ supportsPlugins: true, showChannels: true, showMemory: true }),
    ).toEqual([
      "personality",
      "schedules",
      "skills",
      "memory",
      "plugins",
      "workspace",
      "contacts",
      "channels",
    ]);
  });

  test("hides Plugins on assistants without the plugin routes", () => {
    expect(
      keys({ supportsPlugins: false, showChannels: true, showMemory: false }),
    ).toEqual([
      "personality",
      "schedules",
      "skills",
      "workspace",
      "contacts",
      "channels",
    ]);
  });

  test("hides Memory while memory-concept-graph is off", () => {
    expect(
      keys({ supportsPlugins: true, showChannels: true, showMemory: false }),
    ).not.toContain("memory");
  });

  test("hides Channels while channel-trust-floors is off", () => {
    expect(
      keys({ supportsPlugins: true, showChannels: false, showMemory: false }),
    ).toEqual([
      "personality",
      "schedules",
      "skills",
      "plugins",
      "workspace",
      "contacts",
    ]);
  });
});
