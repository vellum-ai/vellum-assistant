/**
 * Ownership routing for `host.registries.registerTools` by host kind.
 *
 * The shared registries facet ({@link buildRegistriesFacet}) is built for two
 * host types that must project tools differently:
 *
 * - PLUGIN host (external plugins) → tools register PLUGIN-owned into the live
 *   registry the agent loop reads from, so they appear in normal conversations'
 *   base tool set and participate in the plugin disabled/refcount lifecycle.
 *   This mirrors the `Plugin.tools` path (`registerPluginTools`).
 * - SKILL host (meet-join) → tools register through the deferred
 *   `registerExternalTools` path as SKILL-owned. Skill tools are projected into
 *   conversations only through skill sessions, never the base tool set.
 *
 * The plugin path is exercised against the real registry (and a real
 * `.disabled` sentinel) so the ownership and conversation-visibility claims are
 * end-to-end. The skill path is observed via a spy on `registerExternalTools`
 * — its registrations are consumed only at `initializeTools()` boot time, so
 * they do not land in the live registry here.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { RegistriesFacet } from "../../plugin-api/types.js";
import * as registry from "../../tools/registry.js";
import type { Tool } from "../../tools/types.js";
import { buildRegistriesFacet } from "../skill-host-facets.js";

const TEST_WORKSPACE_DIR = join(
  tmpdir(),
  `vellum-plugin-host-registries-test-${process.pid}-${Date.now()}`,
);
process.env.VELLUM_WORKSPACE_DIR = TEST_WORKSPACE_DIR;

function tool(name: string): Tool {
  return {
    name,
    description: name,
    input_schema: { type: "object", properties: {}, required: [] },
  } as unknown as Tool;
}

/**
 * A `registerTools` provider returning the named tools. The contract's `Tool`
 * is structurally independent of the daemon `Tool` the registry stores (the
 * same boundary `buildRegistriesFacet` casts across), so cast at this call site.
 */
function provide(
  ...names: string[]
): Parameters<RegistriesFacet["registerTools"]>[0] {
  return (() => names.map(tool)) as unknown as Parameters<
    RegistriesFacet["registerTools"]
  >[0];
}

async function createSentinel(name: string): Promise<void> {
  const dir = join(TEST_WORKSPACE_DIR, "plugins", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".disabled"), "");
}

beforeEach(() => {
  registry.__clearRegistryForTesting();
  registry.__clearExternalToolProvidersForTesting();
});

afterEach(async () => {
  registry.__clearRegistryForTesting();
  registry.__clearExternalToolProvidersForTesting();
  const pluginsDir = join(TEST_WORKSPACE_DIR, "plugins");
  if (existsSync(pluginsDir)) {
    await rm(pluginsDir, { recursive: true, force: true });
  }
});

describe("buildRegistriesFacet — registerTools ownership by host kind", () => {
  test("PLUGIN host registers tools PLUGIN-owned and visible to the base tool set", () => {
    const facet = buildRegistriesFacet("weather-plugin", "plugin");
    facet.registerTools(provide("weather_lookup"));

    // Owned by the plugin (not skill-gated) — the conversation resolver reads
    // plugin-owned tools from the base set, unlike skill-owned tools.
    expect(registry.getToolOwner("weather_lookup")).toEqual({
      kind: "plugin",
      id: "weather-plugin",
    });

    // Present in the base tool snapshot the conversation resolver captures.
    const baseNames = registry.getAllToolDefinitions().map((t) => t.name);
    expect(baseNames).toContain("weather_lookup");

    // Participates in plugin refcount lifecycle.
    expect(registry.getPluginRefCount("weather-plugin")).toBe(1);
  });

  test("PLUGIN host tools drop out of the base set when the plugin is disabled", async () => {
    const facet = buildRegistriesFacet("weather-plugin", "plugin");
    facet.registerTools(provide("weather_lookup"));

    expect(
      registry.getAllToolDefinitions().some((t) => t.name === "weather_lookup"),
    ).toBe(true);

    // Disable via the `.disabled` sentinel — read-time filtering only, the
    // tool stays owned (lifecycle handling skill-owned tools bypass entirely).
    await createSentinel("weather-plugin");

    expect(
      registry.getAllToolDefinitions().some((t) => t.name === "weather_lookup"),
    ).toBe(false);
    expect(registry.getToolOwner("weather_lookup")).toEqual({
      kind: "plugin",
      id: "weather-plugin",
    });
  });

  test("SKILL host routes registerTools through registerExternalTools as skill-owned", () => {
    const externalSpy = spyOn(registry, "registerExternalTools");

    const facet = buildRegistriesFacet("meet-join", "skill");
    facet.registerTools(provide("meet_join"));

    // Skill registrations go through the deferred external-tools path, stamped
    // with skill ownership. They are NOT registered into the live registry here
    // (that happens at initializeTools() boot time), so no owner is recorded.
    expect(externalSpy).toHaveBeenCalledTimes(1);
    expect(externalSpy.mock.calls[0][0]).toEqual({
      kind: "skill",
      id: "meet-join",
    });
    expect(registry.getToolOwner("meet_join")).toBeUndefined();

    externalSpy.mockRestore();
  });
});
