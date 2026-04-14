import type { EnvironmentDefinition } from "./types.js";

/**
 * Built-in environment definitions. Mirrors Swift's
 * `clients/macos/vellum-assistant/App/VellumEnvironment.swift` enum and is
 * the TS-side source of truth for the set of known environment names.
 * Two other TS sites duplicate the name list:
 *   - `assistant/src/util/platform.ts` (`KNOWN_ENVIRONMENTS`)
 *   - `clients/chrome-extension/native-host/src/lockfile.ts`
 *     (`NON_PRODUCTION_ENVIRONMENTS`, excludes `production`)
 * Drift between these three sites is caught at test time by
 * `cli/src/__tests__/env-drift.test.ts`. Fast follow: hoist the shared
 * list into a `packages/environments` package so all three sites import
 * from one place.
 *
 * Custom environments via a user config file are a future phase — see the
 * "Coexisting environments" design doc. Until then, a call site that needs a
 * new environment must add it here and rebuild.
 */
export const SEEDS: Record<string, EnvironmentDefinition> = {
  production: {
    name: "production",
    platformUrl: "https://platform.vellum.ai",
  },
  staging: {
    name: "staging",
    platformUrl: "https://staging-platform.vellum.ai",
  },
  test: {
    name: "test",
    // Non-functional URL — used only by unit tests for URL resolution, never
    // hit in production.
    platformUrl: "https://test-platform.vellum.ai",
  },
  dev: {
    name: "dev",
    platformUrl: "https://dev-platform.vellum.ai",
  },
  local: {
    name: "local",
    platformUrl: "http://localhost:8000",
    // assistantPlatformUrl: "http://host.docker.internal:8000",
    // ^ uncomment this once dockerized hatch path is live.
    // The assistant runs in a different network namespace than the host.
  },
};
