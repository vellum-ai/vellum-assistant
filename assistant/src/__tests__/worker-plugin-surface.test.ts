/**
 * Tests for {@link registerWorkerPluginSurface}, the default-plugin surface
 * that sidecar worker processes install at startup.
 *
 * A worker that wakes real agent conversations shares the daemon's
 * process-global hook and injector registries, so registering the defaults is
 * what gives those conversations the same behavior as daemon conversations.
 * Registration must populate both tables and stay idempotent, and it must do so
 * without running any plugin `init` hook (the memory plugin's init starts the
 * memory jobs worker process itself).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getHookEntriesFor } from "../hooks/registry.js";
import {
  clearInjectorRegistry,
  getRegisteredInjectors,
} from "../plugins/injector-registry.js";
import { resetPluginRegistryForTests } from "../plugins/registry.js";
import { registerWorkerPluginSurface } from "../plugins/worker-plugin-surface.js";

async function hookOwnersFor(name: string): Promise<string[]> {
  const entries = await getHookEntriesFor(name);
  return entries.map((entry) => entry.owner.id);
}

describe("registerWorkerPluginSurface", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    clearInjectorRegistry();
  });

  test("serves the default plugins' hooks from the process-global registry", async () => {
    expect(await hookOwnersFor("post-model-call")).not.toContain(
      "default-image-fallback",
    );

    registerWorkerPluginSurface();

    // The vision-rejection recovery that a worker without this surface never
    // ran, plus an oversized-tool-result guard on the other hook surface.
    expect(await hookOwnersFor("post-model-call")).toContain(
      "default-image-fallback",
    );
    expect(await hookOwnersFor("post-tool-use")).toContain(
      "default-tool-result-truncate",
    );
  });

  test("registers the injector-only defaults' runtime injectors", () => {
    expect(
      getRegisteredInjectors().some((i) => i.name === "unified-turn-context"),
    ).toBe(false);

    registerWorkerPluginSurface();

    // `default-turn-context` contributes no hooks, so its injections only reach
    // a worker's conversations through the injector registry.
    expect(
      getRegisteredInjectors().some((i) => i.name === "unified-turn-context"),
    ).toBe(true);
  });

  test("is idempotent: a second call neither throws nor duplicates", async () => {
    registerWorkerPluginSurface();
    const hooksAfterFirst = await hookOwnersFor("post-model-call");
    const injectorsAfterFirst = getRegisteredInjectors().map((i) => i.name);

    expect(() => registerWorkerPluginSurface()).not.toThrow();

    expect(await hookOwnersFor("post-model-call")).toEqual(hooksAfterFirst);
    expect(getRegisteredInjectors().map((i) => i.name)).toEqual(
      injectorsAfterFirst,
    );
  });
});
