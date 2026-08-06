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
 * Base URL of the cloud-hosted assistant SPA (the "hub") for a deployment
 * environment. The Capacitor mobile shell bakes this into native builds as
 * `server.url`, and the CLI's remote-web edge stamps it into the served
 * config as `hubUrl`, so the environment-to-hub mapping lives here exactly
 * once.
 *
 * Only the cloud deployments (production, staging) serve the hosted SPA at
 * their own web origin; every other environment (dev, test, local, unknown)
 * falls back to the dev SPA, whose host serves remote clients that cannot
 * reach a local or per-developer web URL.
 *
 * The `/assistant` suffix is deliberate: booting on the bare host lands on
 * the marketing page, whose CTA redirects to `www.vellum.ai/assistant` and
 * bounces non-prod shells off their own host.
 *
 * NOTE: this module is loaded by Capacitor's single-file TS config loader
 * (via the `@vellumai/environments/seeds` subpath), which cannot follow the
 * package index's `.js`-suffixed runtime re-exports. Keep this file's
 * imports type-only so it stays loadable on its own.
 */
export function cloudAssistantHubUrl(envName: string | undefined): string {
  const seed =
    envName === "production" || envName === "staging"
      ? SEEDS[envName]
      : SEEDS.dev;
  return `${seed.webUrl}/assistant`;
}

/**
 * Built-in environment definitions and the source of truth for the
 * set of known environment names.
 *
 * Custom environments via a user config file are a future phase — see the
 * "Coexisting environments" design doc. Until then, a call site that needs a
 * new environment must add it here and rebuild.
 */
export const SEEDS: Record<string, EnvironmentDefinition> = {
  production: {
    name: "production",
    platformUrl: "https://platform.vellum.ai",
    webUrl: "https://www.vellum.ai",
  },
  staging: {
    name: "staging",
    platformUrl: "https://staging-platform.vellum.ai",
    webUrl: "https://staging-assistant.vellum.ai",
    portsOverride: portBlock(17000),
  },
  test: {
    name: "test",
    // Non-functional URL — used only by unit tests for URL resolution, never
    // hit in production.
    platformUrl: "https://test-platform.vellum.ai",
    webUrl: "https://dev-assistant.vellum.ai",
    portsOverride: portBlock(19000),
  },
  dev: {
    name: "dev",
    platformUrl: "https://dev-platform.vellum.ai",
    webUrl: "https://dev-assistant.vellum.ai",
    portsOverride: portBlock(18000),
  },
  local: {
    name: "local",
    platformUrl: "http://localhost:8000",
    webUrl: "http://localhost:3000",
    // assistantPlatformUrl: "http://host.docker.internal:8000",
    // ^ uncomment this once dockerized hatch path is live.
    // The assistant runs in a different network namespace than the host.
    portsOverride: portBlock(20000),
  },
};
