import type { EnvironmentDefinition, PortMap } from "./types.js";

/**
 * Non-prod port blocks. Each environment gets a 1000-port window in the
 * 17000–21000 band. Within a block, services are spaced 100 apart so up to
 * 100 assistants can coexist without the scan (`findAvailablePort`) running
 * one service's range into the next. Band chosen to sit below Linux's
 * default ephemeral start (32768) and macOS's (49152), and away from the
 * 3000/5000/8000/9000 dev-tool swamp. Production keeps its legacy,
 * non-contiguous port set (7821/7830/6333/8090/8080/8765): cross-env
 * collision is the only problem this change targets, prod is unaffected
 * because only one env's assistants compete on a given machine, and
 * churning it would leave existing hatches on 7821 while new ones
 * allocated elsewhere.
 */
function portBlock(base: number): PortMap {
  return {
    daemon: base,
    gateway: base + 100,
    qdrant: base + 200,
    ces: base + 300,
    outboundProxy: base + 400,
    tcp: base + 500,
  };
}

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
    portsOverride: portBlock(17000),
  },
  test: {
    name: "test",
    // Non-functional URL — used only by unit tests for URL resolution, never
    // hit in production.
    platformUrl: "https://test-platform.vellum.ai",
    portsOverride: portBlock(19000),
  },
  dev: {
    name: "dev",
    platformUrl: "https://dev-platform.vellum.ai",
    portsOverride: portBlock(18000),
  },
  local: {
    name: "local",
    platformUrl: "http://localhost:8000",
    // assistantPlatformUrl: "http://host.docker.internal:8000",
    // ^ uncomment this once dockerized hatch path is live.
    // The assistant runs in a different network namespace than the host.
    portsOverride: portBlock(20000),
  },
};
