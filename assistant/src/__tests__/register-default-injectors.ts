/**
 * Test helper: populate the injector registry with the `default-memory`
 * plugin's injectors.
 *
 * In production, `external-plugins-bootstrap.ts` registers each plugin's
 * `injectors` into the global registry at startup, before any turn runs. Tests
 * that drive the per-turn injection chain (`applyRuntimeInjections` /
 * `composeInjectorChain`) directly — without running bootstrap — must register
 * the injectors themselves, or the chain resolves empty. This mirrors the exact
 * set and order `defaultMemoryPlugin` contributes.
 *
 * This runs inside tests (after the preload has set the per-test workspace
 * override), so importing the production injector modules here carries no
 * preload-time isolation risk — the test files that call it already import
 * these modules directly. `registerPluginInjectors` replaces the plugin's set
 * on re-registration, so calling this more than once per process is a safe
 * no-op beyond the first.
 */

import { defaultInjectors } from "../plugins/defaults/memory/injectors.js";
import {
  memoryV3Injector,
  memoryV3SpotlightInjector,
} from "../plugins/defaults/memory/v3/injector.js";
import { registerPluginInjectors } from "../plugins/injector-registry.js";

export function registerDefaultInjectorsForTest(): void {
  registerPluginInjectors("default-memory", [
    ...defaultInjectors,
    memoryV3Injector,
    memoryV3SpotlightInjector,
  ]);
}
