/**
 * In-skill registry for meet-join sub-module factories.
 *
 * Waves 6+ of the skill-isolation plan convert each sub-module
 * (`audio-ingest`, `speaker-resolver`, `tts-bridge`, ...) from a
 * top-level-import module into a host-accepting factory of the shape
 * `(host: SkillHost) => T`. Every one of those conversions would
 * otherwise need to touch `register.ts` to wire its new factory into
 * the overall startup path, which turns that file into a merge-conflict
 * hotspot across the parallel PRs.
 *
 * This registry is a small name → factory map sitting next to those
 * sub-modules. Each converted sub-module registers its factory here at
 * import time via {@link registerSubModule}; consumers that need the
 * sub-module (notably the session manager in PR 17) retrieve it via
 * {@link getSubModule} and pass the host they received from the skill
 * entry point. `register.ts` is no longer a bottleneck — sub-module
 * PRs only edit their own file plus this registry.
 *
 * ## Isolation rule
 *
 * This module is dependency-free on `assistant/`. `SkillHost` comes
 * from `@vellumai/skill-host-contracts`, the neutral package the
 * skill-isolation plan set up in PR 6. Adding any `assistant/` import
 * here would defeat the purpose of the whole refactor.
 */

import type { SkillHost } from "@vellumai/skill-host-contracts";

import {
  createDockerRunner,
  DOCKER_RUNNER_MODULE,
} from "./docker-runner.js";

/**
 * Factory signature for a meet-join sub-module. Every sub-module
 * converted in Waves 6+ exposes a builder of this shape — the returned
 * value is opaque here; consumers cast it at the retrieval site.
 */
export type SubModuleFactory<T = unknown> = (host: SkillHost) => T;

const factories = new Map<string, SubModuleFactory>();

/**
 * Register a sub-module factory under `name`. Later calls with the same
 * name replace the previous entry — useful for tests that want to swap
 * in a fake builder, but a real double-register in production indicates
 * a wiring bug, so a console warning surfaces that case without
 * crashing.
 */
export function registerSubModule<T>(
  name: string,
  factory: SubModuleFactory<T>,
): void {
  if (factories.has(name)) {
    // Module-load ordering is deterministic, so a duplicate name at
    // runtime is almost always a copy-paste mistake in a new Wave-6
    // PR. Keep it soft — crashing startup here would be worse than a
    // visible warning that points at the collision.
    // eslint-disable-next-line no-console
    console.warn(
      `[meet-join/modules-registry] sub-module "${name}" re-registered; overriding previous factory`,
    );
  }
  factories.set(name, factory as SubModuleFactory);
}

/**
 * Look up a registered factory. Returns `undefined` if `name` was never
 * registered — callers decide whether that is fatal or tolerable (the
 * session manager, for example, treats a missing factory as a hard
 * configuration error because every sub-module it depends on is
 * mandatory).
 */
export function getSubModule<T>(
  name: string,
): SubModuleFactory<T> | undefined {
  return factories.get(name) as SubModuleFactory<T> | undefined;
}

/**
 * Test-only helper — drops every registration, including the built-in
 * factory registrations installed at module load. Tests that expect the
 * built-ins to still be present afterwards must re-invoke the specific
 * `registerSubModule(...)` lines at the bottom of this file (a cached
 * re-import will not re-run module-top-level side effects).
 */
export function resetSubModulesForTests(): void {
  factories.clear();
}

// ---------------------------------------------------------------------------
// Built-in registrations
// ---------------------------------------------------------------------------
//
// Each converted sub-module registers its factory here at import time.
// Placing the calls in this file (rather than at the bottom of the factory
// file) avoids the circular-import hazard of running
// `registerSubModule(...)` before `factories` has been initialized, while
// still giving every sub-module a single obvious wiring point. Each Wave 6
// PR appends its own pair (import + registerSubModule) to the lists below
// — merge conflicts are expected and are resolved by appending the
// neighbouring PR's entry before rebasing.

registerSubModule(DOCKER_RUNNER_MODULE, createDockerRunner);
