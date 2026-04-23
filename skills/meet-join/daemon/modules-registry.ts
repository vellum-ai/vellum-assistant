/**
 * In-skill registry for meet-join sub-module factories.
 *
 * Each sub-module (`audio-ingest`, `speaker-resolver`, `tts-bridge`, …)
 * exposes a host-accepting factory of the shape `(host: SkillHost) => T`
 * and registers it here at module-import time via
 * {@link registerSubModule}. The session manager resolves them back by
 * name through {@link getSubModule}, which keeps `register.ts` from
 * having to know about every sub-module's builder signature.
 *
 * ## Isolation rule
 *
 * This module is dependency-free on `assistant/`. `SkillHost` comes
 * from `@vellumai/skill-host-contracts`, the neutral package that
 * defines the host contract. Adding any `assistant/` import here
 * would defeat the purpose of the refactor.
 */

import type { SkillHost } from "@vellumai/skill-host-contracts";

import {
  createDockerRunner,
  DOCKER_RUNNER_MODULE,
} from "./docker-runner.js";

/**
 * Factory signature for a meet-join sub-module. Every sub-module
 * exposes a builder of this shape — the returned value is opaque
 * here; consumers cast it at the retrieval site.
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
    // runtime is almost always a copy-paste mistake when adding a new
    // sub-module. Keep it soft — crashing startup here would be worse
    // than a visible warning that points at the collision.
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
 * `docker-runner` entry installed at module load. Tests that expect
 * sub-modules to still be present afterwards must re-register them
 * directly (a cached re-import does not re-run module-top-level side
 * effects).
 */
export function resetSubModulesForTests(): void {
  factories.clear();
}

// ---------------------------------------------------------------------------
// Built-in registrations
// ---------------------------------------------------------------------------
//
// Most sub-modules call `registerSubModule(...)` at the bottom of
// their own file so the factory and its registration stay co-located.
// `docker-runner` is the odd one out — it exports the factory and
// module-name but leaves the registration to this file so everyone
// reading `modules-registry.ts` can see at least one registration up
// front (the pattern is otherwise invisible from here).

registerSubModule(DOCKER_RUNNER_MODULE, createDockerRunner);
